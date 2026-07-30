#!/usr/bin/env node
/**
 * Stupst das hinterlegte Push-Abo an – einmal morgens.
 *
 * Bewusst ohne Nutzdaten: Den Text der Benachrichtigung baut der Service
 * Worker auf dem Gerät selbst, weil nur er die IndexedDB lesen und damit die
 * echte Zahl offener Tasks nennen kann. Dieses Skript weiss davon nichts.
 *
 * Keine Abhängigkeiten, nur Node-Bordmittel (crypto + fetch).
 */
import crypto from 'node:crypto';

// Öffentlicher VAPID-Schlüssel – steht identisch in index.html und ist
// per Definition nicht geheim.
const PUBLIC_KEY = 'BE9fLq3HvD6izUe-EjJBPnLK2AGoKN41v16z_5bRfeqjP1bj5rDpG6vLSl9ZT2D1Yt-a32Eg9WNg02lt63Y1v40';
const CONTACT = 'mailto:luca.toriellolt@gmail.com';
const TIMEZONE = 'Europe/Zurich';
const SEND_HOUR = 9;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function localHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: 'numeric', hour12: false,
  }).format(new Date()));
}

/** VAPID-Nachweis nach RFC 8292: ein ES256-signiertes JWT je Push-Dienst. */
function vapidToken(audience, privateD) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: CONTACT,
  }));
  const signingInput = Buffer.from(header + '.' + payload);

  const pub = Buffer.from(PUBLIC_KEY, 'base64url');
  const key = crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: privateD,
    },
  });

  // Push-Dienste erwarten die Signatur als r||s, nicht DER-verpackt.
  const signature = crypto.sign(null, signingInput, { key, dsaEncoding: 'ieee-p1363' });
  return header + '.' + payload + '.' + b64url(signature);
}

async function main() {
  const privateD = process.env.VAPID_PRIVATE_KEY;
  const raw = process.env.PUSH_SUBSCRIPTION;
  const force = process.env.FORCE === 'true';

  if (!privateD) {
    console.error('VAPID_PRIVATE_KEY fehlt. Secret im Repository hinterlegen.');
    process.exit(1);
  }
  if (!raw) {
    console.error('PUSH_SUBSCRIPTION fehlt. Abo-Code aus der App als Secret hinterlegen.');
    process.exit(1);
  }

  const hour = localHour();
  if (!force && hour !== SEND_HOUR) {
    console.log(`Ortszeit ${hour} Uhr in ${TIMEZONE}, gesendet wird um ${SEND_HOUR} – nichts zu tun.`);
    return;
  }

  let subscription;
  try {
    subscription = JSON.parse(raw);
  } catch {
    console.error('PUSH_SUBSCRIPTION ist kein gültiges JSON.');
    process.exit(1);
  }
  if (!subscription || !subscription.endpoint) {
    console.error('PUSH_SUBSCRIPTION enthält kein Feld "endpoint".');
    process.exit(1);
  }

  const endpoint = new URL(subscription.endpoint);
  const token = vapidToken(endpoint.origin, privateD);

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${token}, k=${PUBLIC_KEY}`,
      TTL: '10800',           // drei Stunden – danach ist die Erinnerung ohnehin überholt
      Urgency: 'normal',
      'Content-Length': '0',
    },
  });

  if (response.status === 404 || response.status === 410) {
    console.error(
      `Der Push-Dienst kennt dieses Abo nicht mehr (HTTP ${response.status}). ` +
      'Das passiert, wenn die App länger nicht geöffnet wurde oder neu installiert ' +
      'wurde. Öffne die App, aktiviere die Erinnerung erneut und ersetze das ' +
      'Secret PUSH_SUBSCRIPTION durch den neuen Abo-Code.'
    );
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`Push-Dienst antwortete mit HTTP ${response.status}: ${await response.text()}`);
    process.exit(1);
  }

  console.log(`Anstoss verschickt (HTTP ${response.status}) an ${endpoint.host}.`);
}

main().catch((err) => {
  console.error('Unerwarteter Fehler:', err);
  process.exit(1);
});
