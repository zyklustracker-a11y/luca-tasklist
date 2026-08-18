// Smoke-Test Phase 7: Verlauf folgt dem Kategorie-Filter, und der Feinschliff
// am Drag zur Leiste (sanftes Hochgleiten, Treffertoleranz, kein Layout-Sprung).
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

const NOW = Date.now();
const pageErrors = [];
function seed(overrides) {
  return Object.assign({
    version: 4, day: '2026-08-18', bestStreak: 0, celebrationsToday: 0,
    categories: [
      { id: 'c-work', name: 'Arbeit', order: 1000, createdAt: NOW - 86400000, updatedAt: NOW - 86400000 },
      { id: 'c-priv', name: 'Privat', order: 2000, createdAt: NOW - 86400000, updatedAt: NOW - 86400000 },
    ],
    tasks: [
      { id: 'r1', name: 'Arbeit offen', createdAt: '2026-08-18', prioritized: false, sortKey: 1000, sortedAt: 1, categoryId: 'c-work', categoryAt: 1 },
      { id: 'r2', name: 'Privat offen', createdAt: '2026-08-18', prioritized: false, sortKey: 2000, sortedAt: 1, categoryId: 'c-priv', categoryAt: 1 },
      { id: 'r3', name: 'Ganz ohne', createdAt: '2026-08-18', prioritized: false, sortKey: 3000, sortedAt: 1, categoryId: null, categoryAt: 0 },
    ],
    // Erledigtes aus allen Ecken: zwei Arbeit, eins Privat, eins ohne Kategorie.
    journal: [
      { id: 'j1', name: 'Arbeit erledigt A', date: '2026-08-18', createdAt: '2026-08-17', doneTs: NOW - 3600000, categoryId: 'c-work', categoryAt: 1 },
      { id: 'j2', name: 'Arbeit erledigt B', date: '2026-08-17', createdAt: '2026-08-16', doneTs: NOW - 90000000, categoryId: 'c-work', categoryAt: 1 },
      { id: 'j3', name: 'Privat erledigt', date: '2026-08-18', createdAt: '2026-08-17', doneTs: NOW - 7200000, categoryId: 'c-priv', categoryAt: 1 },
      { id: 'j4', name: 'Ohne Kategorie erledigt', date: '2026-08-17', createdAt: '2026-08-16', doneTs: NOW - 95000000 },
    ],
    reopened: {}, history: {},
    settings: { notifyHour: 9, notifyMinute: 0 }, profile: { displayName: '', uid: null },
  }, overrides || {});
}

async function openPage(browser, state, opts) {
  const page = await browser.newPage(Object.assign({ viewport: { width: 390, height: 844 } }, opts));
  page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); pageErrors.push(e.message); });
  await page.addInitScript(s => localStorage.setItem('lucaTasks.v3', JSON.stringify(s)), state);
  await page.goto('http://127.0.0.1:8798/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-list .habit-row', { timeout: 20000 });
  return page;
}
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('lucaTasks.v3')));
/** id einer Task, die gerade sichtbar in der unteren Bildhälfte steht. */
const visibleTaskId = page => page.evaluate(() => {
  const hit = [...document.querySelectorAll('#rest-list li')].find(li => {
    const r = li.getBoundingClientRect();
    // vollständig im Bild und klar unterhalb der Leiste
    return r.top > 120 && r.bottom < innerHeight - 10;
  });
  return hit ? hit.dataset.id : null;
});
/** Namen der im Verlauf sichtbaren Einträge. */
const historyNames = page => page.$$eval('#history-panel li .task-text', els => els.map(e => e.textContent));
const pick = (page, id) => page.click('#cat-bar-inner .cat-pill[data-cat-id="' + (id || '') + '"]');

(async () => {
  await new Promise(r => server.listen(8798, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  /* ---- A: „Alle“ zeigt den vollständigen Verlauf ---- */
  let page = await openPage(browser, seed());
  await page.click('#history-toggle');
  await page.waitForSelector('#history-panel li .task-text');
  assert.deepStrictEqual((await historyNames(page)).sort(),
    ['Arbeit erledigt A', 'Arbeit erledigt B', 'Ohne Kategorie erledigt', 'Privat erledigt']);
  console.log('ok  Verlauf unter „Alle“: alle erledigten Aufgaben quer über die Kategorien');

  /* ---- B: In einer Kategorie nur deren Verlauf ---- */
  await pick(page, 'c-work');
  await page.waitForFunction(() => document.querySelectorAll('#history-panel li .task-text').length === 2);
  assert.deepStrictEqual((await historyNames(page)).sort(), ['Arbeit erledigt A', 'Arbeit erledigt B']);
  await pick(page, 'c-priv');
  await page.waitForFunction(() => document.querySelectorAll('#history-panel li .task-text').length === 1);
  assert.deepStrictEqual(await historyNames(page), ['Privat erledigt']);
  // Der Eintrag ohne Kategorie taucht in KEINER Kategorie auf …
  assert.ok(!(await historyNames(page)).includes('Ohne Kategorie erledigt'));
  // … und unter „Alle“ ist wieder alles da.
  await pick(page, null);
  await page.waitForFunction(() => document.querySelectorAll('#history-panel li .task-text').length === 4);
  console.log('ok  Verlauf in einer Kategorie: nur deren Einträge, „Ohne“ bleibt unter „Alle“');

  /* ---- C: Frisch angelegte Kategorie hat einen leeren Verlauf ---- */
  await page.click('#menu-btn');
  await page.waitForSelector('#menu-sheet-panel.sheet-open');
  await page.click('#menu-categories');
  await page.waitForSelector('#menu-step-cats:not([hidden])');
  await page.fill('#cat-new-name', 'Geschäftlich');
  await page.click('#cat-add-btn');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lucaTasks.v3')).categories.some(c => c.name === 'Geschäftlich'));
  await page.click('#menu-sheet-backdrop', { position: { x: 10, y: 10 } });
  await page.waitForTimeout(420);
  const newId = (await stored(page)).categories.find(c => c.name === 'Geschäftlich').id;
  await pick(page, newId);
  await page.waitForFunction(() => document.querySelectorAll('#history-panel li .task-text').length === 0);
  assert.ok((await page.$eval('#history-panel', e => e.textContent)).includes('Geschäftlich'),
    'leerer Kategorie-Verlauf nennt die Kategorie beim Namen');
  await pick(page, null);
  await page.waitForFunction(() => document.querySelectorAll('#history-panel li .task-text').length === 4,
    { timeout: 5000 });
  console.log('ok  Neue Kategorie: eigener Verlauf leer, „Alle“ unverändert vollständig');

  /* ---- D: Abhaken in einer Kategorie landet in deren Verlauf ---- */
  await pick(page, 'c-priv');
  await page.waitForFunction(() => document.querySelectorAll('#rest-list .habit-row').length === 1);
  await page.click('#rest-list li[data-id="r2"] .habit-checkbox');
  await page.waitForFunction(() => document.querySelectorAll('#history-panel li .task-text').length === 2, { timeout: 8000 });
  assert.ok((await historyNames(page)).includes('Privat offen'), 'frisch abgehakt im Kategorie-Verlauf');
  await pick(page, 'c-work');
  await page.waitForFunction(() => document.querySelectorAll('#history-panel li .task-text').length === 2);
  assert.ok(!(await historyNames(page)).includes('Privat offen'), 'nicht im Verlauf einer anderen Kategorie');
  await pick(page, null);
  await page.waitForFunction(() => document.querySelectorAll('#history-panel li .task-text').length === 5);
  console.log('ok  Abhaken: Eintrag im Verlauf seiner Kategorie und unter „Alle“');

  /* ---- E: Kategorie löschen – Verlauf bleibt erhalten, wandert zu „Alle“ ---- */
  await page.click('#menu-btn');
  await page.waitForSelector('#menu-sheet-panel.sheet-open');
  await page.click('#menu-categories');
  await page.waitForSelector('#menu-step-cats:not([hidden])');
  await page.click('.cat-row[data-cat-id="c-priv"] [data-cat-action="delete"]');
  await page.waitForSelector('#cat-confirm:not(.hidden)');
  await page.click('[data-cat-action="delete-confirm"]');
  await page.waitForFunction(() => !document.querySelector('#cat-bar-inner .cat-pill[data-cat-id="c-priv"]'));
  await page.click('#menu-sheet-backdrop', { position: { x: 10, y: 10 } });
  await page.waitForTimeout(420);
  let s = await stored(page);
  assert.strictEqual(s.journal.length, 5, 'kein Verlaufseintrag gelöscht');
  assert.ok(s.journal.filter(e => e.categoryId === 'c-priv').length === 0, 'Einträge von der Kategorie gelöst');
  await page.waitForFunction(() => document.querySelectorAll('#history-panel li .task-text').length === 5);
  assert.ok((await historyNames(page)).includes('Privat erledigt'), 'unter „Alle“ weiterhin sichtbar');
  console.log('ok  Kategorie löschen: Verlauf vollständig erhalten, steht danach unter „Alle“');
  await page.close();

  /* ---- F: Ziehen zur Leiste gleitet sanft ganz nach oben ---- */
  page = await openPage(browser, seed({ tasks: Array.from({ length: 16 }, (_, i) => ({
    id: 't' + i, name: 'Task ' + i, createdAt: '2026-08-18', prioritized: false,
    sortKey: (i + 1) * 1000, sortedAt: 1, categoryId: null, categoryAt: 0,
  })) }), { hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(200);
  const startY = await page.evaluate(() => window.scrollY);
  assert.ok(startY > 300, 'Test startet weit unten (' + startY + ')');
  const dragId = await visibleTaskId(page);
  assert.ok(dragId, 'eine sichtbare Task als Quelle gefunden');
  const srcBox = await (await page.$('#rest-list li[data-id="' + dragId + '"] .habit-label')).boundingBox();
  const src = { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: src.x, y: src.y }] });
  await page.waitForFunction(() => document.body.classList.contains('is-dragging'), { timeout: 5000 });
  // Bis in die Leiste ziehen und dort ruhig halten – die Seite soll von
  // selbst nach ganz oben gleiten, statt an Ort und Stelle stehenzubleiben.
  const barBottom = await page.evaluate(() => document.getElementById('cat-bar').getBoundingClientRect().bottom);
  for (let i = 1; i <= 18; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: [{ x: src.x, y: src.y + (barBottom / 2 - src.y) * i / 18 }] });
    await page.waitForTimeout(16);
  }
  await page.waitForFunction(() => window.scrollY === 0, { timeout: 4000 });
  assert.ok(await page.evaluate(() => document.getElementById('cat-bar').classList.contains('cat-drop-mode')));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  console.log('ok  Ziehen zur Leiste: Seite gleitet von selbst ganz nach oben');

  /* ---- G: Treffertoleranz – knapp neben der Pill zählt als Treffer ---- */
  await page.evaluate(() => window.scrollTo(0, 350));
  await page.waitForTimeout(200);
  const dragId2 = await visibleTaskId(page);
  assert.ok(dragId2, 'sichtbare Quell-Task für den Toleranz-Test');
  const src2Box = await (await page.$('#rest-list li[data-id="' + dragId2 + '"] .habit-label')).boundingBox();
  // Bewusst die LETZTE Pill: rechts daneben ist frei. Neben einer Pill in
  // der Reihe gewinnt sonst zu Recht die tatsächlich nähere Nachbar-Pill.
  const pillBox = await (await page.$('#cat-bar-inner .cat-pill[data-cat-id="c-priv"]')).boundingBox();
  const src2 = { x: src2Box.x + src2Box.width / 2, y: src2Box.y + src2Box.height / 2 };
  // Bewusst 22 px RECHTS neben die Pill zielen – pixelgenau trifft auf dem
  // Handy niemand, und genau das soll die Toleranz auffangen.
  const near = { x: pillBox.x + pillBox.width + 22, y: pillBox.y + pillBox.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: src2.x, y: src2.y }] });
  await page.waitForFunction(() => document.body.classList.contains('is-dragging'), { timeout: 5000 });
  for (let i = 1; i <= 18; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: [{ x: src2.x + (near.x - src2.x) * i / 18, y: src2.y + (near.y - src2.y) * i / 18 }] });
    await page.waitForTimeout(16);
  }
  await page.waitForFunction(() =>
    document.querySelector('.cat-pill[data-cat-id="c-priv"]').classList.contains('cat-drop-hover'),
    { timeout: 3000 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(id =>
    JSON.parse(localStorage.getItem('lucaTasks.v3')).tasks.find(t => t.id === id).categoryId === 'c-priv',
    dragId2, { timeout: 5000 });
  console.log('ok  Treffertoleranz: knapp neben der Pill losgelassen weist trotzdem zu');

  /* ---- H: Weit daneben bleibt weiterhin folgenlos ---- */
  await page.evaluate(() => window.scrollTo(0, 350));
  await page.waitForTimeout(200);
  const before = await stored(page);
  const dragId3 = await visibleTaskId(page);
  assert.ok(dragId3, 'sichtbare Quell-Task für den Daneben-Test');
  const src3Box = await (await page.$('#rest-list li[data-id="' + dragId3 + '"] .habit-label')).boundingBox();
  const bar = await page.evaluate(() => {
    const r = document.getElementById('cat-bar').getBoundingClientRect();
    const pills = [...document.querySelectorAll('#cat-bar-inner .cat-pill')];
    const last = pills[pills.length - 1].getBoundingClientRect();
    return { right: r.right, midY: (r.top + r.bottom) / 2, lastRight: last.right };
  });
  const src3 = { x: src3Box.x + src3Box.width / 2, y: src3Box.y + src3Box.height / 2 };
  const far = { x: Math.min(bar.right - 4, bar.lastRight + 90), y: bar.midY };
  assert.ok(far.x - bar.lastRight > 40, 'Zielpunkt liegt ausserhalb der Toleranz');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: src3.x, y: src3.y }] });
  await page.waitForFunction(() => document.body.classList.contains('is-dragging'), { timeout: 5000 });
  for (let i = 1; i <= 18; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: [{ x: src3.x + (far.x - src3.x) * i / 18, y: src3.y + (far.y - src3.y) * i / 18 }] });
    await page.waitForTimeout(16);
  }
  assert.ok(await page.evaluate(() => !document.querySelector('.cat-pill.cat-drop-hover')), 'kein Ziel weit daneben');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
  const after = await stored(page);
  assert.deepStrictEqual(
    after.tasks.map(t => [t.id, t.categoryId, t.sortKey]),
    before.tasks.map(t => [t.id, t.categoryId, t.sortKey]),
    'weit neben den Pills losgelassen ändert nichts');
  console.log('ok  Weit neben den Pills: weiterhin folgenlos, nichts verrutscht');
  await page.close();

  await browser.close();
  server.close();
  if (pageErrors.length) { console.error('\nSeitenfehler:', pageErrors); process.exit(1); }
  console.log('\nPhase-7-Smoke bestanden.');
})().catch(e => { console.error(e); process.exit(1); });
