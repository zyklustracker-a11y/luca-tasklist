// Smoke-Test Phase 6: Kategorien – Leiste, Filter, Anlege-Flow, Verwaltung,
// Drag auf eine Pill (Maus + emuliertes Touch via CDP), verwaiste ids.
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
function catSeed() {
  return [
    { id: 'c-work', name: 'Arbeit', order: 1000, createdAt: NOW - 86400000, updatedAt: NOW - 86400000 },
    { id: 'c-priv', name: 'Privat', order: 2000, createdAt: NOW - 86400000, updatedAt: NOW - 86400000 },
  ];
}
function seed(overrides) {
  return Object.assign({
    version: 4, day: '2026-08-17', bestStreak: 0, celebrationsToday: 0,
    categories: catSeed(),
    tasks: [
      { id: 'p1', name: 'Prio Arbeit', createdAt: '2026-08-17', prioritized: true, sortKey: 1000, sortedAt: 1, categoryId: 'c-work', categoryAt: 1 },
      { id: 'p2', name: 'Prio ohne', createdAt: '2026-08-17', prioritized: true, sortKey: 2000, sortedAt: 1, categoryId: null, categoryAt: 0 },
      { id: 'r1', name: 'Arbeit eins', createdAt: '2026-08-17', prioritized: false, sortKey: 1000, sortedAt: 1, categoryId: 'c-work', categoryAt: 1 },
      { id: 'r2', name: 'Privat eins', createdAt: '2026-08-17', prioritized: false, sortKey: 2000, sortedAt: 1, categoryId: 'c-priv', categoryAt: 1 },
      { id: 'r3', name: 'Arbeit zwei', createdAt: '2026-08-17', prioritized: false, sortKey: 3000, sortedAt: 1, categoryId: 'c-work', categoryAt: 1 },
      { id: 'r4', name: 'Ganz ohne', createdAt: '2026-08-17', prioritized: false, sortKey: 4000, sortedAt: 1, categoryId: null, categoryAt: 0 },
    ],
    journal: [], reopened: {}, history: {},
    settings: { notifyHour: 9, notifyMinute: 0 }, profile: { displayName: '', uid: null },
  }, overrides || {});
}

async function openPage(browser, state, opts) {
  const page = await browser.newPage(Object.assign({ viewport: { width: 390, height: 844 } }, opts));
  // Ein Seitenfehler lässt den Test scheitern – auch wenn die Prüfungen
  // danach noch durchgehen. Sonst rutscht z. B. ein Fehler aus dem
  // Auto-Scroll-Intervall unbemerkt durch.
  page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); pageErrors.push(e.message); });
  await page.addInitScript(s => localStorage.setItem('lucaTasks.v3', JSON.stringify(s)), state);
  await page.goto('http://127.0.0.1:8796/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-list .habit-row', { timeout: 20000 });
  return page;
}
const pageErrors = [];
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('lucaTasks.v3')));
const labels = (page, sel) => page.$$eval(sel + ' .habit-label', els => els.map(e => e.textContent));

(async () => {
  await new Promise(r => server.listen(8796, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

  /* ---- A: Leiste, Zählung, Labels in „Alle“ ---- */
  let page = await openPage(browser, seed());
  assert.ok(await page.evaluate(() => document.body.classList.contains('has-catbar')));
  assert.strictEqual(await page.$eval('#cat-bar', el => getComputedStyle(el).position), 'sticky');
  const pills = await page.$$eval('#cat-bar-inner .cat-pill', els =>
    els.map(e => [e.dataset.catId, e.textContent.trim(), e.classList.contains('is-active')]));
  assert.deepStrictEqual(pills, [['', 'Alle', true], ['c-work', 'Arbeit3', false], ['c-priv', 'Privat1', false]]);
  // Labels: nur in „Alle“, nur bei Tasks MIT Kategorie
  assert.ok(await page.$('#prio-list li[data-id="p1"] .cat-chip'));
  assert.ok(!(await page.$('#prio-list li[data-id="p2"] .cat-chip')));
  assert.strictEqual(await page.$eval('#rest-list li[data-id="r2"] .cat-chip', e => e.textContent), 'Privat');
  console.log('ok  Leiste sticky, „Alle“ aktiv, Zählung stimmt, Labels nur in „Alle“');

  /* ---- B: Filter auf „Arbeit“: nur die Kategorie, Nummerierung sichtbar abgeleitet ---- */
  await page.click('#cat-bar-inner .cat-pill[data-cat-id="c-work"]');
  await page.waitForFunction(() => document.querySelectorAll('#rest-list .habit-row').length === 2);
  assert.deepStrictEqual(await labels(page, '#prio-list'), ['Prio Arbeit']);
  assert.deepStrictEqual(await labels(page, '#rest-list'), ['Arbeit eins', 'Arbeit zwei']);
  assert.deepStrictEqual(await page.$$eval('#prio-list .prio-num', els => els.map(e => e.textContent)), ['1']);
  assert.strictEqual(await page.$$eval('#habits-list .cat-chip', els => els.length), 0); // redundant → weg
  console.log('ok  Kategorie-Ansicht filtert, Nummerierung aus sichtbarer Position, keine Labels');

  /* ---- C: leere Kategorie-Ansicht (Prio) + Drag in gefilterter Ansicht ---- */
  await page.click('#cat-bar-inner .cat-pill[data-cat-id="c-priv"]');
  await page.waitForFunction(() => document.querySelectorAll('#rest-list .habit-row').length === 1);
  assert.ok(await page.isVisible('#prio-empty'));
  await page.click('#cat-bar-inner .cat-pill[data-cat-id="c-work"]');
  await page.waitForFunction(() => document.querySelectorAll('#rest-list .habit-row').length === 2);
  // r3 („Arbeit zwei“) per Maus VOR r1 ziehen: global muss r3 direkt vor
  // r1 (sortKey 1000) landen – r2 (2000, unsichtbar) bleibt unberührt.
  // Vorher in den Viewport scrollen – Maus-Koordinaten außerhalb wirken nicht.
  await page.$eval('#rest-list li[data-id="r3"]', el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(250);
  const b1 = await (await page.$('#rest-list li[data-id="r3"] .habit-label')).boundingBox();
  const b2 = await (await page.$('#rest-list li[data-id="r1"]')).boundingBox();
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(b1.x + b1.width / 2, b1.y + (b2.y - 20 - b1.y) * i / 14);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(250);
  await page.mouse.up();
  await page.waitForFunction(() =>
    document.querySelector('#rest-list li').dataset.id === 'r3', { timeout: 5000 });
  let s = await stored(page);
  const r3 = s.tasks.find(t => t.id === 'r3');
  assert.ok(r3.sortKey < 1000, 'r3 global vor r1');
  assert.strictEqual(s.tasks.find(t => t.id === 'r2').sortKey, 2000, 'unsichtbare Task unberührt');
  console.log('ok  Drag in gefilterter Ansicht: sortKey aus sichtbaren Nachbarn, global konsistent');

  /* ---- D: Anlege-Flow in Kategorie-Ansicht – Kategorie vorausgewählt, 2 Taps ---- */
  await page.click('#show-add-habit-btn');
  await page.fill('#new-habit-input', 'Neue Arbeits-Task');
  await page.click('#confirm-add-habit-btn');
  await page.waitForSelector('#add-sheet-panel.sheet-open');
  assert.ok(await page.isVisible('#add-sheet-cats'), 'Kategorie-Zeile sichtbar');
  const preselected = await page.$$eval('#add-sheet-cat-pills .cat-pill', els =>
    els.filter(e => e.classList.contains('is-active')).map(e => e.dataset.cat));
  assert.deepStrictEqual(preselected, ['c-work'], 'aktive Ansicht vorausgewählt');
  await page.click('#add-sheet-no');
  await page.waitForFunction(() => document.querySelectorAll('#rest-list .habit-row').length === 3);
  s = await stored(page);
  const added = s.tasks.find(t => t.name === 'Neue Arbeits-Task');
  assert.strictEqual(added.categoryId, 'c-work');
  assert.ok(added.categoryAt > 0);
  assert.strictEqual(added.prioritized, false);
  console.log('ok  Anlege-Flow: Vorauswahl = aktive Ansicht, zwei Taps, Kategorie gesetzt');
  await page.close();

  /* ---- E: Migration – Altbestand ohne Kategorien bleibt vollständig, Leiste aus ---- */
  page = await openPage(browser, seed({ categories: undefined, tasks: [
    { id: 'alt1', name: 'Alte Task', createdAt: '2026-08-14', prioritized: true, sortKey: 1000, sortedAt: 1, note: 'Notiz', noteAt: '2026-08-15T10:00:00.000Z' },
    { id: 'alt2', name: 'Noch eine', createdAt: '2026-08-15' },
  ] }));
  assert.ok(!(await page.evaluate(() => document.body.classList.contains('has-catbar'))), 'ohne Kategorien keine Leiste');
  await page.waitForFunction(() => {
    const st = JSON.parse(localStorage.getItem('lucaTasks.v3'));
    return st.tasks.every(t => 'categoryId' in t);
  }, { timeout: 5000 });
  s = await stored(page);
  assert.deepStrictEqual(s.categories, []);
  assert.deepStrictEqual(s.tasks.map(t => [t.id, t.categoryId, t.categoryAt]),
    [['alt1', null, 0], ['alt2', null, 0]]);
  assert.strictEqual(s.tasks[0].note, 'Notiz');
  assert.strictEqual(s.tasks[0].prioritized, true);
  console.log('ok  Migration: categoryId:null idempotent, nichts verloren, Leiste ausgeblendet');

  /* ---- F: Menü-Sheet – Kategorie anlegen, umbenennen, löschen (Tasks bleiben) ---- */
  await page.click('#menu-btn');
  await page.waitForSelector('#menu-sheet-panel.sheet-open');
  await page.click('#menu-categories');
  await page.waitForSelector('#menu-step-cats:not([hidden])');
  await page.fill('#cat-new-name', 'Uni');
  await page.click('#cat-add-btn');
  await page.waitForSelector('#cat-manage-list .cat-row[data-cat-id]');
  assert.ok(await page.evaluate(() => document.body.classList.contains('has-catbar')), 'Leiste erscheint');
  s = await stored(page);
  const uni = s.categories.find(c => c.name === 'Uni');
  assert.ok(uni && uni.order === 1000 && uni.updatedAt > 0);
  // Umbenennen
  await page.click('.cat-row [data-cat-action="rename"]');
  await page.fill('.cat-rename-input', 'Studium');
  await page.click('[data-cat-action="rename-save"]');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lucaTasks.v3')).categories.some(c => c.name === 'Studium'));
  s = await stored(page);
  assert.ok(s.categories.find(c => c.name === 'Studium').updatedAt > uni.updatedAt - 1);
  // Löschen mit Rückfrage → Tombstone, Tasks bleiben, Leiste verschwindet
  await page.click('.cat-row [data-cat-action="delete"]');
  await page.waitForSelector('#cat-confirm:not(.hidden)');
  const confirmText = await page.$eval('#cat-confirm', e => e.textContent);
  assert.ok(confirmText.includes('„Studium“ löschen?'), confirmText);
  await page.click('[data-cat-action="delete-confirm"]');
  await page.waitForFunction(() => !document.body.classList.contains('has-catbar'));
  s = await stored(page);
  assert.strictEqual(s.tasks.length, 2, 'keine Task gelöscht');
  const dead = s.categories.find(c => c.id === uni.id);
  assert.strictEqual(dead.deleted, true, 'Tombstone statt echtem Löschen');
  console.log('ok  Verwaltung: anlegen/umbenennen/löschen, Tombstone, letzte Kategorie → Leiste weg');
  await page.close();

  /* ---- G: verwaiste categoryId (anderes Gerät hat gelöscht) ---- */
  page = await openPage(browser, seed({
    categories: [{ id: 'c-work', name: 'Arbeit', order: 1000, createdAt: NOW, updatedAt: NOW }],
    tasks: [
      { id: 'x1', name: 'Verwaist', createdAt: '2026-08-17', prioritized: false, sortKey: 1000, sortedAt: 1, categoryId: 'c-geloescht', categoryAt: 5 },
      { id: 'x2', name: 'Intakt', createdAt: '2026-08-17', prioritized: false, sortKey: 2000, sortedAt: 1, categoryId: 'c-work', categoryAt: 5 },
    ],
  }));
  assert.strictEqual(await page.$$eval('#rest-list .habit-row', els => els.length), 2, 'nichts verschwindet');
  await page.waitForFunction(() => {
    const st = JSON.parse(localStorage.getItem('lucaTasks.v3'));
    return st.tasks.find(t => t.id === 'x1').categoryId === null;
  }, { timeout: 5000 });
  assert.ok(!(await page.$('#rest-list li[data-id="x1"] .cat-chip')), 'verwaist = ohne Label');
  assert.ok(await page.$('#rest-list li[data-id="x2"] .cat-chip'));
  console.log('ok  Verwaiste categoryId: Task bleibt, wird zu null normalisiert, kein Fehler');
  await page.close();

  /* ---- H: Menü-Knopf – Scroll-Verhalten ---- */
  page = await openPage(browser, seed({ tasks: seed().tasks.concat(
    Array.from({ length: 14 }, (_, i) => ({ id: 'f' + i, name: 'Füller ' + i, createdAt: '2026-08-17', prioritized: false, sortKey: 9000 + i * 1000, sortedAt: 1, categoryId: null, categoryAt: 0 }))
  ) }));
  assert.ok(!(await page.evaluate(() => document.getElementById('menu-btn').classList.contains('menu-btn-hidden'))));
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForFunction(() => document.getElementById('menu-btn').classList.contains('menu-btn-hidden'));
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.waitForFunction(() => !document.getElementById('menu-btn').classList.contains('menu-btn-hidden'));
  console.log('ok  Menü-Knopf: beim Runterscrollen weg, beim Hochscrollen zurück');
  await page.close();

  /* ---- I: Touch – Long-Press-Drag auf eine Pill weist die Kategorie zu ---- */
  page = await openPage(browser, seed(), { hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  await page.$eval('#rest-list li[data-id="r4"]', el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(250);
  // Auf den Text zielen, nicht auf die Zeilenmitte: dort sitzen Knöpfe
  // (Anmerkung/Bearbeiten), die bewusst KEINEN Drag starten.
  const srcBox = await (await page.$('#rest-list li[data-id="r4"] .habit-label')).boundingBox();
  const pillBox = await (await page.$('#cat-bar-inner .cat-pill[data-cat-id="c-priv"]')).boundingBox();
  const src = { x: srcBox.x + srcBox.width / 2, y: srcBox.y + srcBox.height / 2 };
  const dst = { x: pillBox.x + pillBox.width / 2, y: pillBox.y + pillBox.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: src.x, y: src.y }] });
  await page.waitForFunction(() => document.body.classList.contains('is-dragging'), { timeout: 5000 }); // Long-Press
  assert.ok(await page.evaluate(() => document.getElementById('menu-btn').classList.contains('menu-btn-hidden') || getComputedStyle(document.getElementById('menu-btn')).opacity === '0'), 'Menü-Knopf beim Drag weg');
  for (let i = 1; i <= 20; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: [{ x: src.x + (dst.x - src.x) * i / 20, y: src.y + (dst.y - src.y) * i / 20 }] });
    await page.waitForTimeout(16);
  }
  // Über der Leiste: Kategorie-Modus an, Sortier-Lücke unsichtbar
  assert.ok(await page.evaluate(() => document.getElementById('cat-bar').classList.contains('cat-drop-mode')), 'Leiste im Zuweisungs-Modus');
  assert.ok(await page.evaluate(() => {
    const g = document.querySelector('li.drag-ghost');
    return !g || getComputedStyle(g).display === 'none';
  }), 'Sortier-Lücke verschwindet');
  // ~400 ms verweilen → Pill leuchtet als aktives Ziel
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => document.querySelector('.cat-pill[data-cat-id="c-priv"]').classList.contains('cat-drop-armed')), 'Dwell-Highlight nach ~400 ms');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lucaTasks.v3')).tasks.find(t => t.id === 'r4').categoryId === 'c-priv', { timeout: 5000 });
  s = await stored(page);
  const r4 = s.tasks.find(t => t.id === 'r4');
  assert.strictEqual(r4.prioritized, false, 'Priorisierung unverändert');
  assert.strictEqual(r4.sortKey, 4000, 'Reihenfolge unverändert – zugewiesen statt sortiert');
  assert.ok(!(await page.evaluate(() => document.getElementById('cat-bar').classList.contains('cat-drop-mode'))));
  // Undo über den Toast
  assert.ok(await page.isVisible('#toast-action'));
  await page.click('#toast-action');
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lucaTasks.v3')).tasks.find(t => t.id === 'r4').categoryId === null, { timeout: 5000 });
  console.log('ok  Touch: Drag auf Pill weist zu (Prio/Reihenfolge bleiben), Undo funktioniert');

  /* ---- J: Loslassen in der Leiste NEBEN einer Pill – nichts passiert ---- */
  await page.$eval('#rest-list li[data-id="r4"]', el => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(250);
  const src2Box = await (await page.$('#rest-list li[data-id="r4"] .habit-label')).boundingBox();
  const barBox = await (await page.$('#cat-bar')).boundingBox();
  const src2 = { x: src2Box.x + src2Box.width / 2, y: src2Box.y + src2Box.height / 2 };
  const before = await stored(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: src2.x, y: src2.y }] });
  await page.waitForFunction(() => document.body.classList.contains('is-dragging'), { timeout: 5000 });
  const gap = { x: barBox.x + barBox.width - 8, y: barBox.y + barBox.height / 2 };  // rechts neben den Pills
  for (let i = 1; i <= 16; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
      touchPoints: [{ x: src2.x + (gap.x - src2.x) * i / 16, y: src2.y + (gap.y - src2.y) * i / 16 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
  s = await stored(page);
  assert.deepStrictEqual(
    s.tasks.map(t => [t.id, t.categoryId, t.sortKey, t.prioritized]),
    before.tasks.map(t => [t.id, t.categoryId, t.sortKey, t.prioritized]),
    'Loslassen neben einer Pill ändert nichts');
  assert.deepStrictEqual(await page.$$eval('#rest-list li', els => els.map(e => e.dataset.id)),
    ['r1', 'r2', 'r3', 'r4'], 'Task springt an ihren Platz zurück');
  console.log('ok  Loslassen neben einer Pill: kein State-Change, Task springt zurück');
  await page.close();

  await browser.close();
  server.close();
  assert.deepStrictEqual(pageErrors, [], 'keine Seitenfehler während des Tests');
  console.log('\nPhase-6-Smoke bestanden.');
})().catch(e => { console.error(e); process.exit(1); });
