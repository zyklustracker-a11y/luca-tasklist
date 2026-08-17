// Smoke-Test Phase 5: Tastatur-Fallback (Alt + Pfeil), Fokus-Verhalten.
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

const seedState = { version: 4, day: '2026-08-17', bestStreak: 0, celebrationsToday: 0,
  tasks: [
    { id: 'p1', name: 'Angebot prüfen', createdAt: '2026-08-17', prioritized: true, sortKey: 1000, sortedAt: 1 },
    { id: 'p2', name: 'Mail an Kunde', createdAt: '2026-08-17', prioritized: true, sortKey: 2000, sortedAt: 1 },
    { id: 'r1', name: 'Einkaufen', createdAt: '2026-08-17', prioritized: false, sortKey: 1000, sortedAt: 1 },
    { id: 'r2', name: 'Auto waschen', createdAt: '2026-08-17', prioritized: false, sortKey: 2000, sortedAt: 1 },
  ], journal: [], reopened: {}, history: {},
  settings: { notifyHour: 9, notifyMinute: 0 }, profile: { displayName: '', uid: null } };

const prioIds = page => page.$$eval('#prio-list li', els => els.map(e => e.dataset.id));
const restIds = page => page.$$eval('#rest-list li', els => els.map(e => e.dataset.id));
const focusedId = page => page.evaluate(() => document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null);

(async () => {
  await new Promise(r => server.listen(8799, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });
  await page.addInitScript(s => localStorage.setItem('lucaTasks.v3', JSON.stringify(s)), seedState);
  await page.goto('http://127.0.0.1:8799/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#prio-list .habit-row', { timeout: 20000 });

  // Zeile ist fokussierbar
  await page.focus('.habit-row[data-id="r1"]');
  assert.strictEqual(await focusedId(page), 'r1');

  // Alt+Up: erste „weitere“ Task wandert über die Trennlinie ans Prio-Ende
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('#prio-list li').length === 3, { timeout: 5000 });
  assert.deepStrictEqual(await prioIds(page), ['p1', 'p2', 'r1']);
  assert.strictEqual(await focusedId(page), 'r1', 'Fokus bleibt auf der Zeile');
  console.log('ok  Alt+Up über die Trennlinie: priorisiert ans Ende, Fokus bleibt');

  // Alt+Up innerhalb der Sektion
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('#prio-list li')[1].dataset.id === 'r1', { timeout: 5000 });
  assert.deepStrictEqual(await prioIds(page), ['p1', 'r1', 'p2']);
  console.log('ok  Alt+Up innerhalb der Prio-Sektion');

  // Alt+Down zweimal: zurück ans Prio-Ende, dann über die Trennlinie an den Rest-Anfang
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForFunction(() => document.querySelectorAll('#rest-list li')[0] && document.querySelectorAll('#rest-list li')[0].dataset.id === 'r1', { timeout: 5000 });
  assert.deepStrictEqual(await prioIds(page), ['p1', 'p2']);
  assert.deepStrictEqual(await restIds(page), ['r1', 'r2']);
  assert.strictEqual(await focusedId(page), 'r1');
  console.log('ok  Alt+Down: zurück und über die Trennlinie an den Rest-Anfang');

  // Ränder: ganz oben / ganz unten passiert nichts
  await page.focus('.habit-row[data-id="p1"]');
  await page.keyboard.press('Alt+ArrowUp');
  await page.focus('.habit-row[data-id="r2"]');
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForTimeout(200);
  assert.deepStrictEqual(await prioIds(page), ['p1', 'p2']);
  assert.deepStrictEqual(await restIds(page), ['r1', 'r2']);
  console.log('ok  Ränder: kein Wrap-Around, nichts verloren');

  // Ein Move = genau ein Zustands-Write mit frischem sortedAt
  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('lucaTasks.v3')));
  assert.ok(s.tasks.find(t => t.id === 'r1').sortedAt > 1);
  await browser.close();
  server.close();
  console.log('\nPhase-5-Smoke bestanden.');
})().catch(e => { console.error(e); process.exit(1); });
