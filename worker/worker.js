/*
 * Cloudflare Worker – tägliche Push-Erinnerung für ALLE Nutzer des Task Trackers.
 *
 * Zwei Aufgaben:
 *   1. HTTP-Endpunkte, mit denen sich ein angemeldetes Gerät an- und abmeldet,
 *      seine Wunschzeit setzt und einen Test auslöst.
 *   2. Ein Cron-Trigger, der über alle Nutzer läuft und jedem, für den es
 *      gerade Zeit ist, einen Anstoss an ALLE seine Geräte schickt.
 *
 * Sicherheit: Jeder Endpunkt verlangt ein gültiges Firebase-ID-Token im
 * Authorization-Header. Der Worker prüft die Signatur selbst (RS256 gegen
 * Googles öffentliche Schlüssel) und nimmt die Benutzerkennung AUS DEM TOKEN –
 * niemals aus dem Anfragekörper. Ein Nutzer kommt dadurch technisch nicht an
 * die Abos eines anderen heran, auch nicht mit manipuliertem Frontend.
 *
 * Bewusst OHNE Nutzdaten (payloadless): Der Worker schickt nur einen leeren
 * Anstoss. Den sichtbaren Text baut der Service Worker auf dem Gerät selbst,
 * weil nur er die IndexedDB lesen und damit die echte Zahl offener Tasks
 * nennen kann. Der Server erfährt nichts über die Aufgaben.
 *
 * Gespeichert wird alles in Workers KV (Binding "SUBS"):
 *   sub:<uid>:<endpoint-hash>  { uid, endpoint, p256dh, auth, userAgent,
 *                                createdAt, lastSeen }   – ein Gerät
 *   ep:<endpoint-hash>         "<uid>"                   – macht endpoint eindeutig
 *   user:<uid>                 { hour, minute, tz, enabled, lastSent }
 *   jwks:securetoken           zwischengespeicherte Google-Schlüssel
 *
 * Altbestand aus der Einzelnutzer-Fassung (sub:<geräte-uuid> ohne uid) wird
 * weiter beliefert, bis sich das Gerät neu anmeldet – siehe runLegacyReminders.
 */

// So lange nach der Wunschzeit darf der Cron-Lauf noch anschlagen. Fängt ab,
// dass ein verspäteter oder ausgefallener Lauf die Meldung ganz verschluckt,
// ohne dass eine Stunden später „nachgereichte“ Erinnerung kommt.
const WINDOW_MIN = 90;

// Wie viele Nutzer gleichzeitig beliefert werden. Klein gehalten, damit ein
// Lauf unter dem Subrequest-Limit von Cloudflare bleibt.
const USER_BATCH = 5;

// Öffentliche Schlüssel, mit denen Firebase seine ID-Token signiert.
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const JWKS_CACHE_KEY = 'jwks:securetoken';

/* ---------- Base64url-Helfer (WebCrypto liefert/erwartet rohe Bytes) ------ */

function b64urlFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(str) {
  return b64urlFromBytes(new TextEncoder().encode(str));
}

function bytesFromB64url(b64url) {
  const padded = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonFromB64url(b64url) {
  return JSON.parse(new TextDecoder().decode(bytesFromB64url(b64url)));
}

/* ---------- Firebase-ID-Token prüfen ------------------------------------- */

/** Googles Signaturschlüssel, in KV zwischengespeichert (sonst pro Anfrage ein Abruf). */
async function fetchJwks(env) {
  const now = Math.floor(Date.now() / 1000);
  const cached = await env.SUBS.get(JWKS_CACHE_KEY, 'json');
  if (cached && Array.isArray(cached.keys) && cached.expires > now) return cached.keys;

  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('Signaturschlüssel nicht erreichbar (' + res.status + ')');
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];

  // Gültigkeitsdauer aus dem Cache-Control-Header übernehmen, mindestens 10 Minuten.
  const match = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const ttl = Math.max(600, match ? Number(match[1]) : 3600);
  await env.SUBS.put(
    JWKS_CACHE_KEY,
    JSON.stringify({ keys: keys, expires: now + ttl }),
    { expirationTtl: ttl + 60 }
  );
  return keys;
}

async function jwkFor(env, kid) {
  let keys = await fetchJwks(env);
  let jwk = keys.find(function (k) { return k.kid === kid; });
  if (jwk) return jwk;
  // Schlüsselrotation: einmal den Zwischenspeicher verwerfen und neu holen.
  await env.SUBS.delete(JWKS_CACHE_KEY);
  keys = await fetchJwks(env);
  return keys.find(function (k) { return k.kid === kid; }) || null;
}

/**
 * Prüft ein Firebase-ID-Token vollständig: Signatur, Aussteller, Zielprojekt
 * und Laufzeit. Gibt die Benutzerkennung zurück oder wirft.
 */
async function verifyIdToken(token, env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID fehlt in der Worker-Konfiguration');

  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Token unlesbar');

  const header = jsonFromB64url(parts[0]);
  const payload = jsonFromB64url(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Token: falsches Signaturverfahren');

  const jwk = await jwkFor(env, header.kid);
  if (!jwk) throw new Error('Token: unbekannter Signaturschlüssel');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    bytesFromB64url(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1])
  );
  if (!valid) throw new Error('Token: Signatur ungültig');

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error('Token: falsches Projekt');
  if (payload.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('Token: falscher Aussteller');
  if (!payload.sub || typeof payload.sub !== 'string') throw new Error('Token: keine Benutzerkennung');
  if (!(Number(payload.exp) > now - 60)) throw new Error('Token abgelaufen – bitte neu anmelden');
  if (!(Number(payload.iat) < now + 300)) throw new Error('Token aus der Zukunft');

  return { uid: payload.sub };
}

/* ---------- VAPID: JWT je Push-Dienst signieren -------------------------- */

// Kontakt für den VAPID-Nachweis (RFC 8292). Push-Dienste verlangen ein
// mailto: oder https: als Absender-Kennung. Kommt aus der Konfiguration,
// damit hier keine Adresse fest verdrahtet ist.
function vapidSubject(env) {
  return (env && env.VAPID_SUBJECT) || 'https://github.com/';
}

/**
 * Importiert das VAPID-Schlüsselpaar als signierfähigen ECDSA-Schlüssel.
 * Der private Anteil ("d") kommt als Secret, die Koordinaten x/y werden aus
 * dem öffentlichen Schlüssel (65 Bytes: 0x04 || x || y) abgeleitet.
 */
async function importVapidKey(publicKeyB64, privateKeyB64) {
  const pub = bytesFromB64url(publicKeyB64);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlFromBytes(pub.subarray(1, 33)),
    y: b64urlFromBytes(pub.subarray(33, 65)),
    d: privateKeyB64,
    ext: true,
  };
  return crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
}

async function vapidToken(audience, key, env) {
  const header = b64urlFromString(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64urlFromString(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapidSubject(env),
  }));
  const signingInput = new TextEncoder().encode(header + '.' + payload);
  // WebCrypto liefert die ECDSA-Signatur bereits als r||s (IEEE P-1363) –
  // genau das Format, das Push-Dienste erwarten, kein DER-Auspacken nötig.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput);
  return header + '.' + payload + '.' + b64urlFromBytes(new Uint8Array(sig));
}

/** Schickt einen leeren Anstoss an einen Endpoint. Gibt die HTTP-Antwort zurück. */
async function sendPush(endpoint, env) {
  const url = new URL(endpoint);
  const key = await importVapidKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const token = await vapidToken(url.origin, key, env);
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}`,
      TTL: '10800',            // drei Stunden – danach ist die Erinnerung überholt
      Urgency: 'normal',
    },
    // Kein Body: payloadless Push.
  });
}

/* ---------- Kleine Helfer ------------------------------------------------ */

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** Aktuelle lokale Zeit in einer IANA-Zeitzone, zerlegt in Datum/Std/Min. */
function localParts(tz) {
  let zone = tz || 'UTC';
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  } catch (err) {
    // Unbekannte Zeitzone (Tippfehler, veraltete Kennung): auf UTC zurückfallen,
    // statt den ganzen Cron-Lauf scheitern zu lassen.
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  }
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

async function endpointHash(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return b64urlFromBytes(new Uint8Array(digest)).slice(0, 32);
}

function subKey(uid, hash) { return 'sub:' + uid + ':' + hash; }
function epKey(hash) { return 'ep:' + hash; }
function userKey(uid) { return 'user:' + uid; }

/** Alle Schlüssel zu einem Präfix, über alle Seiten hinweg. */
async function listAll(env, prefix) {
  const names = [];
  let cursor;
  do {
    const page = await env.SUBS.list({ prefix: prefix, cursor: cursor });
    for (const entry of page.keys) names.push(entry.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return names;
}

/** Ein Gerät samt Eindeutigkeits-Verweis entfernen. */
async function removeSubscription(env, key, record) {
  await env.SUBS.delete(key);
  if (record && record.endpoint) {
    const hash = await endpointHash(record.endpoint);
    const owner = await env.SUBS.get(epKey(hash));
    if (!owner || owner === record.uid) await env.SUBS.delete(epKey(hash));
  }
}

/* ---------- Einstellungen pro Nutzer ------------------------------------- */

async function saveUserSettings(env, uid, data) {
  const existing = await env.SUBS.get(userKey(uid), 'json');
  const record = {
    hour: clampInt(data.hour, 0, 23, existing ? existing.hour : 9),
    minute: clampInt(data.minute, 0, 59, existing ? existing.minute : 0),
    tz: (typeof data.tz === 'string' && data.tz) ? data.tz.slice(0, 64) : (existing ? existing.tz : 'UTC'),
    enabled: typeof data.enabled === 'boolean' ? data.enabled : (existing ? existing.enabled !== false : true),
    // Den „heute schon gesendet“-Merker vom Vorgänger übernehmen, damit eine
    // reine Zeit-Änderung nicht sofort einen zweiten Push für heute freigibt.
    lastSent: existing ? existing.lastSent : null,
  };
  await env.SUBS.put(userKey(uid), JSON.stringify(record));
  return record;
}

async function countDevices(env, uid) {
  return (await listAll(env, 'sub:' + uid + ':')).length;
}

/* ---------- HTTP-Endpunkte ----------------------------------------------- */

async function readBody(request) {
  const data = await request.json().catch(function () { return null; });
  return (data && typeof data === 'object') ? data : {};
}

/**
 * Meldet DIESES Gerät für den angemeldeten Nutzer an. Ein Nutzer kann beliebig
 * viele Geräte haben; jedes bekommt einen eigenen Eintrag.
 */
async function handleSubscribe(request, env, headers, auth) {
  const data = await readBody(request);
  const sub = data.subscription;
  const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
  if (!/^https:\/\//.test(endpoint)) {
    return json({ error: 'Gültige subscription mit endpoint erforderlich' }, 400, headers);
  }

  const hash = await endpointHash(endpoint);

  // Eindeutigkeit des Endpoints: Hat sich vorher ein anderes Konto auf diesem
  // Gerät angemeldet, ohne sich abzumelden, wird dessen Eintrag entfernt –
  // sonst bekäme der Vorgänger weiter Push auf ein fremdes Gerät.
  const previousOwner = await env.SUBS.get(epKey(hash));
  if (previousOwner && previousOwner !== auth.uid) {
    await env.SUBS.delete(subKey(previousOwner, hash));
  }

  const existing = await env.SUBS.get(subKey(auth.uid, hash), 'json');
  const now = new Date().toISOString();
  const record = {
    uid: auth.uid,
    endpoint: endpoint,
    p256dh: (sub.keys && sub.keys.p256dh) || null,
    auth: (sub.keys && sub.keys.auth) || null,
    userAgent: String(data.userAgent || request.headers.get('user-agent') || '').slice(0, 200),
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    lastSeen: now,
  };
  await env.SUBS.put(subKey(auth.uid, hash), JSON.stringify(record));
  await env.SUBS.put(epKey(hash), auth.uid);
  await dropLegacyByEndpoint(env, endpoint);

  const settings = await saveUserSettings(env, auth.uid, data);
  console.log(`[subscribe] ${auth.uid} geraet=${hash.slice(0, 8)} zeit=${settings.hour}:${settings.minute} tz=${settings.tz}`);
  return json({ ok: true, devices: await countDevices(env, auth.uid) }, 200, headers);
}

/** Uhrzeit, Zeitzone und An/Aus des Nutzers setzen (ohne Geräte anzufassen). */
async function handleSettings(request, env, headers, auth) {
  const data = await readBody(request);
  const settings = await saveUserSettings(env, auth.uid, data);
  return json({ ok: true, settings: settings, devices: await countDevices(env, auth.uid) }, 200, headers);
}

/** Meldet ein Gerät ab – oder alle Geräte des Nutzers, wenn kein endpoint kommt. */
async function handleUnsubscribe(request, env, headers, auth) {
  const data = await readBody(request);
  const endpoint = typeof data.endpoint === 'string' ? data.endpoint : '';

  if (endpoint) {
    const hash = await endpointHash(endpoint);
    const key = subKey(auth.uid, hash);
    const record = await env.SUBS.get(key, 'json');
    await removeSubscription(env, key, record || { uid: auth.uid, endpoint: endpoint });
    await dropLegacyByEndpoint(env, endpoint);
  } else {
    const keys = await listAll(env, 'sub:' + auth.uid + ':');
    for (const key of keys) {
      const record = await env.SUBS.get(key, 'json');
      await removeSubscription(env, key, record);
    }
  }

  const left = await countDevices(env, auth.uid);
  // Ohne Geräte hat der Zeitplan keinen Zweck mehr.
  if (left === 0) await env.SUBS.delete(userKey(auth.uid));
  console.log(`[unsubscribe] ${auth.uid} verbleibende geraete=${left}`);
  return json({ ok: true, devices: left }, 200, headers);
}

/** Schickt sofort einen Test-Push – an dieses Gerät, sonst an alle des Nutzers. */
async function handleTest(request, env, headers, auth) {
  const data = await readBody(request);
  const endpoint = typeof data.endpoint === 'string' ? data.endpoint : '';

  const keys = endpoint
    ? [subKey(auth.uid, await endpointHash(endpoint))]
    : await listAll(env, 'sub:' + auth.uid + ':');

  if (!keys.length) {
    return json({ error: 'Kein Gerät angemeldet – erst Benachrichtigungen aktivieren.' }, 404, headers);
  }

  const results = await Promise.allSettled(keys.map(function (key) {
    return deliver(env, key, auth.uid);
  }));
  const outcomes = results.map(function (r) { return r.status === 'fulfilled' ? r.value : 'failed'; });
  const sent = outcomes.filter(function (o) { return o === 'sent'; }).length;
  const gone = outcomes.filter(function (o) { return o === 'gone'; }).length;

  console.log(`[test] ${auth.uid} gesendet=${sent} abgelaufen=${gone} gesamt=${keys.length}`);
  if (sent > 0) return json({ ok: true, sent: sent, devices: keys.length }, 200, headers);
  if (gone > 0) return json({ error: 'Abo abgelaufen – bitte aus- und wieder einschalten.', gone: gone }, 410, headers);
  return json({ error: 'Der Push-Dienst hat den Versand abgelehnt.' }, 502, headers);
}

/** Wie viele Geräte hängen an diesem Konto? Für die Anzeige in den Einstellungen. */
async function handleDevices(request, env, headers, auth) {
  const settings = await env.SUBS.get(userKey(auth.uid), 'json');
  return json({ ok: true, devices: await countDevices(env, auth.uid), settings: settings || null }, 200, headers);
}

/* ---------- Versand ------------------------------------------------------ */

/**
 * Ein Gerät beliefern. Tote Abos (404/410) werden aus der Datenbank entfernt.
 * Wirft nie – der Rückgabewert sagt, was passiert ist.
 */
async function deliver(env, key, label) {
  let record = null;
  try {
    record = await env.SUBS.get(key, 'json');
    if (!record || !record.endpoint) {
      await env.SUBS.delete(key);
      console.log(`[push] ${label} ${key}: leerer Eintrag entfernt`);
      return 'gone';
    }
    const res = await sendPush(record.endpoint, env);
    if (res.status === 404 || res.status === 410) {
      await removeSubscription(env, key, record);
      console.log(`[push] ${label} ${key}: Abo abgelaufen (${res.status}), entfernt`);
      return 'gone';
    }
    console.log(`[push] ${label} ${key}: status=${res.status} ${res.ok ? 'ok' : 'fehlgeschlagen'}`);
    return res.ok ? 'sent' : 'failed';
  } catch (err) {
    console.log(`[push] ${label} ${key}: Ausnahme ${String((err && err.message) || err)}`);
    return 'failed';
  }
}

/** Alle Geräte eines Nutzers gleichzeitig beliefern. */
async function pushToUser(env, uid) {
  const keys = await listAll(env, 'sub:' + uid + ':');
  if (!keys.length) return { sent: 0, total: 0 };
  const results = await Promise.allSettled(keys.map(function (key) { return deliver(env, key, uid); }));
  const sent = results.filter(function (r) {
    return r.status === 'fulfilled' && r.value === 'sent';
  }).length;
  return { sent: sent, total: keys.length };
}

/* ---------- Cron: prüfen, für wen es Zeit ist ---------------------------- */

/** Ein Nutzer. Wirft nur nach oben, wenn wirklich etwas kaputt ist. */
async function runUserReminder(env, key) {
  const uid = key.slice('user:'.length);
  const record = await env.SUBS.get(key, 'json');
  if (!record || record.enabled === false) return { due: false, sent: 0 };

  const now = localParts(record.tz);
  if (record.lastSent === now.date) return { due: false, sent: 0 };   // heute schon erledigt

  const target = clampInt(record.hour, 0, 23, 9) * 60 + clampInt(record.minute, 0, 59, 0);
  const current = now.hour * 60 + now.minute;
  if (current < target || current >= target + WINDOW_MIN) return { due: false, sent: 0 };

  const result = await pushToUser(env, uid);
  console.log(`[cron] ${uid}: ${result.sent}/${result.total} Geraete beliefert`);

  if (result.sent > 0) {
    record.lastSent = now.date;
    await env.SUBS.put(key, JSON.stringify(record));
  } else if (result.total === 0) {
    // Kein Gerät mehr übrig – Zeitplan aufräumen, damit KV nicht zuwächst.
    await env.SUBS.delete(key);
  }
  return { due: true, sent: result.sent };
}

/** Legacy-Schlüssel der Einzelnutzer-Fassung: sub:<uuid> (zwei Teile statt drei). */
function isLegacyKey(name) {
  return name.split(':').length === 2;
}

/**
 * Altbestand aus der Einzelnutzer-Fassung. Läuft unverändert weiter, damit
 * niemandem die Erinnerung abreisst, bevor sein Gerät sich neu angemeldet hat.
 * Sobald das passiert, entfernt dropLegacyByEndpoint den alten Eintrag.
 */
async function runLegacyReminders(env) {
  const keys = (await listAll(env, 'sub:')).filter(isLegacyKey);
  for (const key of keys) {
    try {
      const record = await env.SUBS.get(key, 'json');
      if (!record || !record.subscription || !record.subscription.endpoint) continue;
      if (record.enabled === false) continue;

      const now = localParts(record.tz);
      if (record.lastSent === now.date) continue;
      const target = clampInt(record.hour, 0, 23, 9) * 60 + clampInt(record.minute, 0, 59, 0);
      const current = now.hour * 60 + now.minute;
      if (current < target || current >= target + WINDOW_MIN) continue;

      const res = await sendPush(record.subscription.endpoint, env);
      if (res.status === 404 || res.status === 410) {
        await env.SUBS.delete(key);
        console.log(`[cron] legacy ${key}: Abo abgelaufen (${res.status}), entfernt`);
        continue;
      }
      console.log(`[cron] legacy ${key}: status=${res.status}`);
      if (res.ok) {
        record.lastSent = now.date;
        await env.SUBS.put(key, JSON.stringify(record));
      }
    } catch (err) {
      console.log(`[cron] legacy ${key} fehlgeschlagen: ${String((err && err.message) || err)}`);
    }
  }
}

/** Sucht einen Altbestands-Eintrag mit diesem Endpoint und entfernt ihn. */
async function dropLegacyByEndpoint(env, endpoint) {
  try {
    const keys = (await listAll(env, 'sub:')).filter(isLegacyKey);
    for (const key of keys) {
      const record = await env.SUBS.get(key, 'json');
      if (record && record.subscription && record.subscription.endpoint === endpoint) {
        await env.SUBS.delete(key);
        console.log(`[migration] Altbestand ${key} durch nutzergebundenes Abo ersetzt`);
      }
    }
  } catch (err) {
    // Nicht schlimm: im schlimmsten Fall kommt einmal eine doppelte Meldung.
    console.log(`[migration] Altbestand nicht aufgeraeumt: ${String((err && err.message) || err)}`);
  }
}

async function handleScheduled(env) {
  const started = Date.now();
  const userKeys = await listAll(env, 'user:');
  let due = 0, delivered = 0, failed = 0;

  // Nutzer in kleinen Gruppen parallel: schnell, aber unter dem
  // Subrequest-Limit. Promise.allSettled sorgt dafür, dass ein Fehler bei
  // einem Nutzer den Lauf für alle anderen NICHT abbricht.
  for (let i = 0; i < userKeys.length; i += USER_BATCH) {
    const batch = userKeys.slice(i, i + USER_BATCH);
    const outcomes = await Promise.allSettled(batch.map(function (key) {
      return runUserReminder(env, key);
    }));
    outcomes.forEach(function (outcome, idx) {
      if (outcome.status === 'rejected') {
        failed++;
        console.log(`[cron] ${batch[idx]} fehlgeschlagen: ${String((outcome.reason && outcome.reason.message) || outcome.reason)}`);
        return;
      }
      if (outcome.value && outcome.value.due) { due++; delivered += outcome.value.sent; }
    });
  }

  await runLegacyReminders(env);
  console.log(`[cron] fertig: ${userKeys.length} Nutzer geprueft, ${due} faellig, ${delivered} Push gesendet, ${failed} Fehler, ${Date.now() - started}ms`);
}

/* ---------- Einstieg ----------------------------------------------------- */

const ROUTES = {
  '/subscribe': handleSubscribe,
  '/settings': handleSettings,
  '/unsubscribe': handleUnsubscribe,
  '/test': handleTest,
  '/devices': handleDevices,
};

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env.ALLOWED_ORIGIN || '*');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response('Task Tracker Push Worker läuft.', { status: 200, headers });
      }

      const handler = request.method === 'POST' ? ROUTES[url.pathname] : null;
      if (!handler) return new Response('Not found', { status: 404, headers });

      // Ab hier gilt: ohne gültiges Firebase-ID-Token geht nichts. Die
      // Benutzerkennung stammt ausschliesslich aus dem geprüften Token.
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
      if (!bearer) return json({ error: 'Anmeldung erforderlich' }, 401, headers);

      let auth;
      try {
        auth = await verifyIdToken(bearer[1].trim(), env);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 401, headers);
      }

      return await handler(request, env, headers, auth);
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500, headers);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
