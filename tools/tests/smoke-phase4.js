// Smoke-Test Phase 4: Drag & Drop (Maus + emuliertes Touch via CDP).
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

function seed(prioNames, restNames) {
  const tasks = [];
  prioNames.forEach((n, i) => tasks.push({ id: 'p' + (i + 1), name: n, createdAt: '2026-08-17', prioritized: true, sortKey: (i + 1) * 1000, sortedAt: 1 }));
  restNames.forEach((n, i) => tasks.push({ id: 'r' + (i + 1), name: n, createdAt: '2026-08-17', prioritized: false, sortKey: (i + 1) * 1000, sortedAt: 1 }));
  return { version: 4, day: '2026-08-17', bestStreak: 0, celebrationsToday: 0,
    tasks, journal: [], reopened: {}, history: {},
    settings: { notifyHour: 9, notifyMinute: 0 }, profile: { displayName: '', uid: null } };
}

async function openPage(browser, state, opts) {
  const page = await browser.newPage(Object.assign({ viewport: { width: 390, height: 844 } }, opts));
  page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });
  await page.addInitScript(s => localStorage.setItem('lucaTasks.v3', JSON.stringify(s)), state);
  await page.goto('http://127.0.0.1:8795/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-list .habit-row', { timeout: 20000 });
  return page;
}
const center = async (page, sel) => {
  const h = await page.$(sel);
  await h.scrollIntoViewIfNeeded();          // Koordinaten müssen im Viewport liegen
  await page.waitForTimeout(80);
  const b = await h.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
};
async function mouseDrag(page, from, to, steps) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= (steps || 14); i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / (steps || 14), from.y + (to.y - from.y) * i / (steps || 14));
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('lucaTasks.v3')));

(async () => {
  await new Promise(r => server.listen(8795, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  /* ---- A: Maus-Drag von unten in die Prio-Sektion (Platz 1) ---- */
  let page = await openPage(browser, seed(['Angebot prüfen', 'Mail an Kunde'], ['Einkaufen', 'Auto waschen']));
  let from = await center(page, '#rest-list li[data-id="r1"] .habit-label');
  let to = await center(page, '#prio-list li[data-id="p1"]');
  await mouseDrag(page, from, { x: to.x, y: to.y - 30 });
  await page.waitForFunction(() => document.querySelectorAll('#prio-list .habit-row').length === 3, { timeout: 5000 });
  let s = await stored(page);
  let moved = s.tasks.find(t => t.id === 'r1');
  assert.strictEqual(moved.prioritized, true);
  assert.strictEqual(moved.sortKey, 0);                       // vor 1000
  assert.ok(moved.sortedAt > 1);
  assert.deepStrictEqual(
    await page.$$eval('#prio-list .habit-label', els => els.map(e => e.textContent)),
    ['Einkaufen', 'Angebot prüfen', 'Mail an Kunde']);
  assert.deepStrictEqual(
    await page.$$eval('#prio-list .prio-num', els => els.map(e => e.textContent)),
    ['1', '2', '3']);
  console.log('ok  Maus: rest → Prio Platz 1, Nummerierung neu, sortKey/sortedAt gesetzt');

  /* ---- B: Maus-Drag aus der Prio-Sektion nach unten (verliert Nummer) ---- */
  from = await center(page, '#prio-list li[data-id="p2"] .habit-label');
  to = await center(page, '#rest-list li[data-id="r2"]');
  await mouseDrag(page, from, { x: to.x, y: to.y + 30 });
  await page.waitForFunction(() => document.querySelectorAll('#prio-list .habit-row').length === 2, { timeout: 5000 });
  s = await stored(page);
  assert.strictEqual(s.tasks.find(t => t.id === 'p2').prioritized, false);
  assert.deepStrictEqual(
    await page.$$eval('#rest-list .habit-label', els => els.map(e => e.textContent)),
    ['Auto waschen', 'Mail an Kunde']);
  assert.strictEqual(await page.$$eval('#rest-list .prio-num', els => els.length), 0);
  console.log('ok  Maus: Prio → unten, verliert Nummer, Sektion stimmt');
  await page.close();

  /* ---- C: Drop in die LEERE Prio-Sektion ---- */
  page = await openPage(browser, seed([], ['Einkaufen', 'Auto waschen']));
  assert.ok(await page.isVisible('#prio-empty'));
  from = await center(page, '#rest-list li[data-id="r2"] .habit-label');
  const zone = await center(page, '#prio-list');
  await mouseDrag(page, from, zone);
  await page.waitForFunction(() => document.querySelectorAll('#prio-list .habit-row').length === 1, { timeout: 5000 });
  s = await stored(page);
  assert.strictEqual(s.tasks.find(t => t.id === 'r2').prioritized, true);
  assert.ok(!(await page.isVisible('#prio-empty')));
  console.log('ok  Drop in leere Prio-Zone funktioniert, Platzhalter verschwindet');
  await page.close();

  /* ---- D: Touch – kurzes Wischen scrollt, KEIN Drag ---- */
  page = await openPage(browser, seed(['Angebot prüfen'],
    ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']), { hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  const p1 = await center(page, '#rest-list li[data-id="r2"]');
  const before = await stored(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p1.x, y: p1.y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p1.x, y: p1.y - i * 30 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => window.scrollY) > 0, 'Seite muss gescrollt haben');
  assert.ok(!(await page.evaluate(() => document.body.classList.contains('is-dragging'))));
  assert.deepStrictEqual((await stored(page)).tasks, before.tasks, 'kein State-Change durch Wischen');
  console.log('ok  Touch: schnelles Wischen scrollt normal, kein Drag, kein State-Change');

  await page.close();

  /* ---- E: Touch – Long-Press (~500 ms) nimmt auf und verschiebt ----
     Eigene, kurze Seite: alles im Viewport, damit kein Auto-Scroll die
     Zielkoordinaten verschiebt. */
  page = await openPage(browser, seed(['Angebot prüfen'], ['Einkaufen']), { hasTouch: true });
  const cdp2 = await page.context().newCDPSession(page);
  // Quelle mittig in den Viewport: startet der Finger zu nah am unteren
  // Rand, greift das (funktionierende) Auto-Scroll und verschiebt die fest
  // vermessenen Zielkoordinaten unter dem Testfinger.
  await page.$eval('#rest-list li[data-id="r1"]', el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const rawCenter = async sel => {
    const b = await (await page.$(sel)).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const src = await rawCenter('#rest-list li[data-id="r1"]');
  const dst = await rawCenter('#prio-list li[data-id="p1"]');
  await cdp2.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: src.x, y: src.y }] });
  await page.waitForTimeout(550);                              // Long-Press abwarten
  const pickedUp = await page.evaluate(() => document.body.classList.contains('is-dragging'));
  for (let i = 1; i <= 16; i++) {
    await cdp2.send('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: [{ x: src.x + (dst.x - src.x) * i / 16, y: src.y + (dst.y - 30 - src.y) * i / 16 }] });
    await page.waitForTimeout(16);
  }
  await cdp2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => document.querySelectorAll('#prio-list .habit-row').length === 2, { timeout: 5000 });
  assert.ok(pickedUp, 'nach 550 ms Halten muss die Task aufgenommen sein');
  s = await stored(page);
  assert.strictEqual(s.tasks.find(t => t.id === 'r1').prioritized, true);
  assert.ok(!(await page.evaluate(() => document.body.classList.contains('is-dragging'))));
  console.log('ok  Touch: Long-Press nimmt auf, Drag über die Trennlinie priorisiert');
  await page.close();

  /* ---- F: Sync-Update während des Drags wird gepuffert ---- */
  page = await openPage(browser, seed(['Angebot prüfen', 'Mail an Kunde'], ['Einkaufen']));
  await page.$eval('#prio-list li[data-id="p2"]', el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  from = await (async () => {
    const b = await (await page.$('#prio-list li[data-id="p2"] .habit-label')).boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })();
  const p1box = await (await page.$('#prio-list li[data-id="p1"]')).boundingBox();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(from.x, from.y - i * 8); await page.waitForTimeout(16); }
  assert.ok(await page.evaluate(() => document.body.classList.contains('is-dragging')));
  // „Anderes Gerät“: Task-Text geändert, neue Task dazu, ALTE Reihenfolge für p2
  const domBefore = await page.$$eval('#prio-list li', els => els.map(e => e.dataset.id));
  await page.evaluate(() => {
    window.__taskApp.applySyncPayload({
      tasks: [
        { id: 'p1', name: 'Angebot prüfen (edit)', createdAt: '2026-08-17', prioritized: true, sortKey: 1000, sortedAt: 1 },
        { id: 'p2', name: 'Mail an Kunde', createdAt: '2026-08-17', prioritized: true, sortKey: 2000, sortedAt: 1 },
        { id: 'r1', name: 'Einkaufen', createdAt: '2026-08-17', prioritized: false, sortKey: 1000, sortedAt: 1 },
        { id: 'neu', name: 'Vom anderen Gerät', createdAt: '2026-08-17', prioritized: false, sortKey: 2000, sortedAt: 1 },
      ],
      journal: [], reopened: {}, history: {}, bestStreak: 0,
    });
  });
  await page.waitForTimeout(120);
  const domDuring = await page.$$eval('#prio-list li', els => els.map(e => e.dataset.id));
  assert.deepStrictEqual(domDuring, domBefore, 'kein Re-Render während des Drags');
  assert.ok(!(await page.evaluate(() => document.querySelector('#rest-list li[data-id="neu"]'))), 'neue Task noch nicht sichtbar');
  // Drop: p2 an Platz 1 – bis über das obere Viertel von p1 ziehen, damit
  // die Einsortier-Schwelle sicher überschritten ist.
  const targetY = p1box.y + p1box.height * 0.25;
  let curY = from.y - 64;
  while (curY > targetY) { curY -= 8; await page.mouse.move(from.x, curY); await page.waitForTimeout(20); }
  await page.waitForTimeout(300);          // dragover-Intervall + Ausweich-Animation
  await page.mouse.up();
  await page.waitForSelector('#rest-list li[data-id="neu"]', { timeout: 5000 });
  assert.deepStrictEqual(
    await page.$$eval('#prio-list li', els => els.map(e => e.dataset.id)),
    ['p2', 'p1'], 'Drop-Reihenfolge überlebt den gepufferten Sync');
  assert.ok((await page.$$eval('#prio-list .habit-label', els => els.map(e => e.textContent)))[1].includes('(edit)'),
    'Inhaltsänderung vom anderen Gerät kommt trotzdem an');
  console.log('ok  Sync während Drag: gepuffert, nach Drop angewendet, Drop-Reihenfolge bleibt');
  await page.close();

  await browser.close();
  server.close();
  console.log('\nPhase-4-Smoke bestanden.');
})().catch(e => { console.error(e); process.exit(1); });
