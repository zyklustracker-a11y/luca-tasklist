/*
 * Cloudflare Worker – täglicher Morgen-Push für Luca's Task Tracker.
 *
 * Zwei Aufgaben:
 *   1. HTTP-Endpunkte, mit denen sich die App an- und abmeldet und einen
 *      Test auslöst (/save, /test, /unsubscribe).
 *   2. Ein Cron-Trigger, der regelmässig nachsieht, für wen es gerade Zeit
 *      für den Morgen-Push ist, und ihn dann verschickt.
 *
 * Bewusst OHNE Nutzdaten (payloadless): Der Worker schickt nur einen leeren
 * Anstoss. Den sichtbaren Text baut der Service Worker auf dem iPhone selbst,
 * weil nur er die IndexedDB lesen und damit die echte Zahl offener Tasks
 * nennen kann. Das spart uns hier die komplette Payload-Verschlüsselung –
 * es braucht kein npm-Paket, nur die eingebaute WebCrypto-API.
 *
 * Gespeichert wird alles in Workers KV (Binding "SUBS"):
 *   Schlüssel:  sub:<geräte-id>
 *   Wert (JSON): { subscription, hour, minute, tz, enabled, lastSent }
 */

// So lange nach der Wunschzeit darf der Cron-Lauf noch anschlagen. Fängt ab,
// dass ein verspäteter oder ausgefallener Lauf die Meldung ganz verschluckt,
// ohne dass eine Stunden später „nachgereichte" Erinnerung kommt.
const WINDOW_MIN = 90;

// Kontakt für den VAPID-Nachweis (RFC 8292). Push-Dienste verlangen ein
// mailto: oder https: als Absender-Kennung.
const VAPID_SUBJECT = 'mailto:luca.toriellolt@gmail.com';

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

/* ---------- VAPID: JWT je Push-Dienst signieren -------------------------- */

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

async function vapidToken(audience, key) {
  const header = b64urlFromString(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64urlFromString(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  }));
  const signingInput = new TextEncoder().encode(header + '.' + payload);
  // WebCrypto liefert die ECDSA-Signatur bereits als r||s (IEEE P-1363) –
  // genau das Format, das Push-Dienste erwarten, kein DER-Auspacken nötig.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput);
  return header + '.' + payload + '.' + b64urlFromBytes(new Uint8Array(sig));
}

/** Schickt einen leeren Anstoss an ein Abo. Gibt die HTTP-Antwort zurück. */
async function sendPush(subscription, env) {
  const endpoint = new URL(subscription.endpoint);
  const key = await importVapidKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const token = await vapidToken(endpoint.origin, key);
  return fetch(subscription.endpoint, {
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
    'Access-Control-Allow-Headers': 'Content-Type',
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
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/* ---------- HTTP-Endpunkte ----------------------------------------------- */

// Legt ein Abo an oder aktualisiert es (Uhrzeit, Zeitzone, an/aus).
async function handleSave(request, env, headers) {
  const data = await request.json().catch(() => null);
  const id = data && typeof data.id === 'string' ? data.id : '';
  if (!id || !data.subscription || !data.subscription.endpoint) {
    return json({ error: 'id und subscription erforderlich' }, 400, headers);
  }
  const existing = await env.SUBS.get('sub:' + id, 'json');
  const record = {
    subscription: data.subscription,
    hour: clampInt(data.hour, 0, 23, 9),
    minute: clampInt(data.minute, 0, 59, 0),
    tz: typeof data.tz === 'string' && data.tz ? data.tz : 'UTC',
    enabled: data.enabled !== false,
    // Den „heute schon gesendet"-Merker vom Vorgänger übernehmen, damit eine
    // reine Zeit-Änderung nicht sofort einen zweiten Push für heute freigibt.
    lastSent: existing ? existing.lastSent : null,
  };
  await env.SUBS.put('sub:' + id, JSON.stringify(record));
  return json({ ok: true }, 200, headers);
}

// Schickt sofort einen Test-Push an das hinterlegte Abo.
async function handleTest(request, env, headers) {
  const data = await request.json().catch(() => null);
  const id = data && typeof data.id === 'string' ? data.id : '';
  const record = id ? await env.SUBS.get('sub:' + id, 'json') : null;
  if (!record) return json({ error: 'Kein Abo gefunden – erst aktivieren.' }, 404, headers);

  const res = await sendPush(record.subscription, env);
  if (res.status === 404 || res.status === 410) {
    await env.SUBS.delete('sub:' + id);
    return json({ error: 'Abo abgelaufen', status: res.status }, 410, headers);
  }
  return json({ ok: res.ok, status: res.status }, res.ok ? 200 : 502, headers);
}

// Meldet ein Gerät wieder ab.
async function handleUnsubscribe(request, env, headers) {
  const data = await request.json().catch(() => null);
  const id = data && typeof data.id === 'string' ? data.id : '';
  if (id) await env.SUBS.delete('sub:' + id);
  return json({ ok: true }, 200, headers);
}

/* ---------- Cron: prüfen, für wen es Zeit ist ---------------------------- */

async function handleScheduled(env) {
  let cursor;
  do {
    const list = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const entry of list.keys) {
      const record = await env.SUBS.get(entry.name, 'json');
      if (!record || !record.enabled || !record.subscription) continue;

      const now = localParts(record.tz);
      if (record.lastSent === now.date) continue;         // heute schon erledigt

      const target = record.hour * 60 + record.minute;
      const current = now.hour * 60 + now.minute;
      if (current < target || current >= target + WINDOW_MIN) continue;

      const res = await sendPush(record.subscription, env);
      if (res.status === 404 || res.status === 410) {
        await env.SUBS.delete(entry.name);                // Abo tot → weg damit
        continue;
      }
      if (res.ok) {
        record.lastSent = now.date;
        await env.SUBS.put(entry.name, JSON.stringify(record));
      }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
}

/* ---------- Einstieg ----------------------------------------------------- */

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env.ALLOWED_ORIGIN || '*');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/save') return handleSave(request, env, headers);
      if (request.method === 'POST' && url.pathname === '/test') return handleTest(request, env, headers);
      if (request.method === 'POST' && url.pathname === '/unsubscribe') return handleUnsubscribe(request, env, headers);
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response('Luca Tasklist Push Worker läuft.', { status: 200, headers });
      }
      return new Response('Not found', { status: 404, headers });
    } catch (err) {
      return json({ error: String((err && err.message) || err) }, 500, headers);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
