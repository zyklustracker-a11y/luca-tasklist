// Smoke-Test Phase 3: Bottom Sheet (Ja/Nein, Slots, Backdrop, Swipe, Undo).
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

const seed = { version: 4, day: '2026-08-17', bestStreak: 0, celebrationsToday: 0,
  tasks: [
    { id: 'p1', name: 'Angebot prüfen', createdAt: '2026-08-17', prioritized: true, sortKey: 1000, sortedAt: 1 },
    { id: 'p2', name: 'Mail an Kunde', createdAt: '2026-08-17', prioritized: true, sortKey: 2000, sortedAt: 1 },
    { id: 'r1', name: 'Einkaufen', createdAt: '2026-08-17', prioritized: false, sortKey: 1000, sortedAt: 0 },
  ], journal: [], reopened: {}, history: {},
  settings: { notifyHour: 9, notifyMinute: 0 }, profile: { displayName: '', uid: null } };

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });
  await page.addInitScript(s => localStorage.setItem('lucaTasks.v3', JSON.stringify(s)), seed);
  await page.goto('http://127.0.0.1:8793/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#prio-list .habit-row', { timeout: 20000 });
  return page;
}
async function typeNew(page, text) {
  // Das Formular bleibt nach dem Anlegen offen (Bestandsverhalten) – den
  // „+“-Button nur klicken, wenn er gerade sichtbar ist.
  if (await page.isVisible('#show-add-habit-btn')) await page.click('#show-add-habit-btn');
  await page.fill('#new-habit-input', text);
  await page.click('#confirm-add-habit-btn');
  await page.waitForSelector('#add-sheet:not(.hidden)', { timeout: 5000 });
}
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('lucaTasks.v3')));

(async () => {
  await new Promise(r => server.listen(8793, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  /* A: „Nein, ans Ende“ */
  let page = await newPage(browser);
  await typeNew(page, 'Auto waschen');
  assert.ok((await page.textContent('#add-sheet-title')).includes('Auto waschen'));
  await page.click('#add-sheet-no');
  await page.waitForFunction(() => document.querySelectorAll('#rest-list .habit-row').length === 2, { timeout: 5000 });
  let s = await stored(page);
  let neu = s.tasks.find(t => t.name === 'Auto waschen');
  assert.strictEqual(neu.prioritized, false);
  assert.strictEqual(neu.sortKey, 2000);
  assert.strictEqual(await page.inputValue('#new-habit-input'), '');
  console.log('ok  „Nein, ans Ende“: unpriorisiert ganz unten, Eingabe geleert');

  /* B: „Ja, priorisieren“ auf Platz 1 – alles rutscht runter */
  await typeNew(page, 'Rechnung schreiben');
  await page.click('#add-sheet-yes');
  await page.waitForSelector('#add-sheet-step2:not([hidden])', { timeout: 5000 });
  const slots = await page.$$eval('#add-sheet-slots .slot-btn span', els => els.map(e => e.textContent));
  assert.deepStrictEqual(slots, ['Platz 1', 'Platz 2', 'Platz 3']);   // n+1 Slots
  const slotTasks = await page.$$eval('#add-sheet-slots .slot-task-name', els => els.map(e => e.textContent));
  assert.deepStrictEqual(slotTasks, ['Angebot prüfen', 'Mail an Kunde']);
  await page.click('.slot-btn[data-slot="0"]');
  await page.waitForFunction(() => document.querySelectorAll('#prio-list .habit-row').length === 3, { timeout: 5000 });
  assert.deepStrictEqual(
    await page.$$eval('#prio-list .habit-label', els => els.map(e => e.textContent)),
    ['Rechnung schreiben', 'Angebot prüfen', 'Mail an Kunde']);
  assert.deepStrictEqual(
    await page.$$eval('#prio-list .prio-num', els => els.map(e => e.textContent)),
    ['1', '2', '3']);
  s = await stored(page);
  neu = s.tasks.find(t => t.name === 'Rechnung schreiben');
  assert.strictEqual(neu.prioritized, true);
  assert.strictEqual(neu.sortKey, 0);              // kleinster - 1000
  assert.ok((await page.textContent('#toast-text')).includes('Platz 1'));
  console.log('ok  „Ja“ + Platz 1: ganz oben, Rest rutscht runter, Toast mit Platz');

  /* C: Undo-Toast macht das Anlegen rückgängig */
  await page.click('#toast-action');
  await page.waitForFunction(() => document.querySelectorAll('#prio-list .habit-row').length === 2, { timeout: 5000 });
  s = await stored(page);
  assert.ok(!s.tasks.some(t => t.name === 'Rechnung schreiben'));
  console.log('ok  Rückgängig entfernt die Task wieder');

  /* D: Backdrop-Tap = „Nein“ – Task wird trotzdem angelegt */
  await typeNew(page, 'Blumen giessen');
  await page.mouse.click(195, 60);                  // weit oben, sicher ausserhalb des Panels
  await page.waitForFunction(() => {
    const st = JSON.parse(localStorage.getItem('lucaTasks.v3'));
    return st.tasks.some(t => t.name === 'Blumen giessen' && t.prioritized === false);
  }, { timeout: 5000 });
  await page.waitForSelector('#add-sheet.hidden', { state: 'attached', timeout: 5000 });
  console.log('ok  Backdrop-Tap: Sheet zu, Task trotzdem angelegt (unpriorisiert)');

  /* E: Wisch nach unten = „Nein“ */
  await typeNew(page, 'Keller aufräumen');
  await page.waitForTimeout(400);                   // Einfahr-Animation abwarten
  const panel = await page.$('#add-sheet-panel');
  const box = await panel.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + 18;      // am Grabber ansetzen
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx, cy + i * 16);
  await page.mouse.up();
  await page.waitForFunction(() => {
    const st = JSON.parse(localStorage.getItem('lucaTasks.v3'));
    return st.tasks.some(t => t.name === 'Keller aufräumen' && t.prioritized === false);
  }, { timeout: 5000 });
  await page.waitForSelector('#add-sheet.hidden', { state: 'attached', timeout: 5000 });
  console.log('ok  Wisch nach unten: Sheet zu, Task trotzdem angelegt');

  /* F: Safe-Area + 44px-Targets */
  const pad = await page.$eval('#add-sheet-panel', el => getComputedStyle(el).paddingBottom);
  assert.ok(parseFloat(pad) >= 16, 'padding-bottom mit safe-area, ist ' + pad);
  await typeNew(page, 'Messen');
  for (const sel of ['#add-sheet-no', '#add-sheet-yes']) {
    const b = await (await page.$(sel)).boundingBox();
    assert.ok(b.height >= 44, sel + ' Höhe ' + b.height);
  }
  await page.click('#add-sheet-yes');
  await page.waitForSelector('#add-sheet-step2:not([hidden])', { timeout: 5000 });
  for (const b of await page.$$('#add-sheet-slots .slot-btn')) {
    const r = await b.boundingBox();
    assert.ok(r.height >= 44, 'Slot-Höhe ' + r.height);
  }
  await page.click('.slot-btn[data-slot="2"]');     // irgendwo einsortieren, nicht verlieren
  console.log('ok  Safe-Area-Padding + alle Buttons/Slots >= 44px');

  await page.close();
  await browser.close();
  server.close();
  console.log('\nPhase-3-Smoke bestanden.');
})().catch(e => { console.error(e); process.exit(1); });
