// Smoke-Test Phase 2: Zwei-Sektionen-Layout, Nummerierung, Platzhalter.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = require('path').join(__dirname, '..', '..');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

function mkState(tasks) {
  return { version: 4, day: '2026-08-17', bestStreak: 0, celebrationsToday: 0,
    tasks, journal: [], reopened: {}, history: {},
    settings: { notifyHour: 9, notifyMinute: 0 }, profile: { displayName: '', uid: null } };
}

(async () => {
  await new Promise(r => server.listen(8792, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  /* ---- A: 4 priorisierte + 2 normale Tasks ---- */
  let page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });
  await page.addInitScript(s => localStorage.setItem('lucaTasks.v3', JSON.stringify(s)), mkState([
    { id: 'p1', name: 'Rechnung schreiben', createdAt: '2026-08-17', prioritized: true, sortKey: 1000, sortedAt: 1 },
    { id: 'p2', name: 'Angebot prüfen', createdAt: '2026-08-17', prioritized: true, sortKey: 2000, sortedAt: 1 },
    { id: 'p3', name: 'Mail an Kunde', createdAt: '2026-08-17', prioritized: true, sortKey: 3000, sortedAt: 1 },
    { id: 'p4', name: 'Termin bestätigen', createdAt: '2026-08-17', prioritized: true, sortKey: 4000, sortedAt: 1 },
    { id: 'r1', name: 'Einkaufen', createdAt: '2026-08-17', prioritized: false, sortKey: 1000, sortedAt: 0 },
    { id: 'r2', name: 'Auto waschen', createdAt: '2026-08-17', prioritized: false, sortKey: 2000, sortedAt: 0 },
  ]));
  await page.goto('http://127.0.0.1:8792/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#prio-list .habit-row', { timeout: 20000 });

  assert.deepStrictEqual(
    await page.$$eval('#prio-list .habit-label', els => els.map(e => e.textContent)),
    ['Rechnung schreiben', 'Angebot prüfen', 'Mail an Kunde', 'Termin bestätigen']);
  assert.deepStrictEqual(
    await page.$$eval('#rest-list .habit-label', els => els.map(e => e.textContent)),
    ['Einkaufen', 'Auto waschen']);
  console.log('ok  Sektionen korrekt aufgeteilt');

  assert.deepStrictEqual(
    await page.$$eval('#prio-list .prio-num', els => els.map(e => e.textContent)),
    ['1', '2', '3', '4']);
  assert.deepStrictEqual(
    await page.$$eval('#prio-list .prio-num', els => els.map(e => e.classList.contains('prio-num-hot'))),
    [true, true, true, false]);
  assert.strictEqual(await page.$$eval('#prio-list .habit-row.prio-top', els => els.length), 3);
  assert.strictEqual(await page.$$eval('#rest-list .prio-num', els => els.length), 0);
  console.log('ok  Nummerierung 1..4, Top 3 hervorgehoben, ab 4 dezent, unten ohne Nummern');

  // Beide Titel sichtbar, Platzhalter NICHT sichtbar (Prio-Liste voll)
  assert.ok(await page.isVisible('#prio-title'));
  assert.ok(await page.isVisible('#rest-title'));
  assert.ok(!(await page.isVisible('#prio-empty')));

  // Abhaken der Nr. 1: Nummerierung schließt die Lücke (1..3)
  await page.check('.habit-checkbox[data-id="p1"]');
  await page.waitForFunction(() => document.querySelectorAll('#prio-list .habit-row').length === 3, { timeout: 5000 });
  assert.deepStrictEqual(
    await page.$$eval('#prio-list .prio-num', els => els.map(e => e.textContent)),
    ['1', '2', '3']);
  console.log('ok  Abhaken: Nummerierung lückenlos neu abgeleitet');
  await page.close();

  /* ---- B: leere Prio-Sektion -> Titel + Platzhalter + Drop-Zone >= 60px ---- */
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });
  await page.addInitScript(s => localStorage.setItem('lucaTasks.v3', JSON.stringify(s)), mkState([
    { id: 'r1', name: 'Einkaufen', createdAt: '2026-08-17' },
  ]));
  await page.goto('http://127.0.0.1:8792/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#rest-list .habit-row', { timeout: 20000 });

  assert.ok(await page.isVisible('#prio-title'), 'Prio-Titel muss immer sichtbar sein');
  assert.ok(await page.isVisible('#prio-empty'), 'Platzhalter sichtbar bei leerer Prio-Sektion');
  const h = await page.$eval('#prio-list', el => el.getBoundingClientRect().height);
  assert.ok(h >= 60, 'Drop-Zone mindestens 60px hoch, ist ' + h);
  console.log('ok  Leere Prio-Sektion: Titel + Platzhalter, Drop-Zone ' + Math.round(h) + 'px');
  await page.close();

  await browser.close();
  server.close();
  console.log('\nPhase-2-Smoke bestanden.');
})().catch(e => { console.error(e); process.exit(1); });
