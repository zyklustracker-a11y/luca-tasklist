// Browser-Smoke-Test Phase 1: Migration + Sortierung + Anlegen in der echten Seite.
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

// Alt-Zustand wie vor dem Update: Tasks OHNE prioritized/sortKey/sortedAt.
const legacyState = {
  version: 4,
  day: '2026-08-16',
  bestStreak: 3,
  celebrationsToday: 0,
  tasks: [
    { id: 'task-old-1', name: 'Rechnung schreiben', createdAt: '2026-08-14' },
    { id: 'task-old-2', name: 'Angebot prüfen', createdAt: '2026-08-15', note: 'Rabatt klären', noteAt: '2026-08-15T10:00:00.000Z' },
    { id: 'task-old-3', name: 'Auto waschen', createdAt: '2026-08-16' },
  ],
  journal: [{ id: 'task-done-1', name: 'Mail an Kunde', date: '2026-08-15', createdAt: '2026-08-15', doneTs: 1786000000000 }],
  reopened: {},
  history: {},
  settings: { notifyHour: 9, notifyMinute: 0 },
  profile: { displayName: 'Luca', uid: null },
};

(async () => {
  await new Promise(r => server.listen(8791, r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });

  await page.addInitScript(state => {
    localStorage.setItem('lucaTasks.v3', JSON.stringify(state));
  }, legacyState);

  await page.goto('http://127.0.0.1:8791/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-list .habit-row', { timeout: 20000 });

  // 1) Reihenfolge nach Migration unverändert
  const names = await page.$$eval('#habits-list .habit-label', els => els.map(e => e.textContent));
  assert.deepStrictEqual(names, ['Rechnung schreiben', 'Angebot prüfen', 'Auto waschen']);
  console.log('ok  Reihenfolge nach Migration unverändert');

  // 2) Migration im gespeicherten Zustand (save() läuft beim Laden)
  await page.waitForFunction(() => {
    const s = JSON.parse(localStorage.getItem('lucaTasks.v3') || '{}');
    return Array.isArray(s.tasks) && s.tasks.length && s.tasks.every(t => typeof t.sortKey === 'number');
  }, { timeout: 5000 });
  let stored = JSON.parse(await page.evaluate(() => localStorage.getItem('lucaTasks.v3')));
  assert.deepStrictEqual(stored.tasks.map(t => [t.id, t.prioritized, t.sortKey, t.sortedAt]), [
    ['task-old-1', false, 1000, 0],
    ['task-old-2', false, 2000, 0],
    ['task-old-3', false, 3000, 0],
  ]);
  assert.strictEqual(stored.tasks[1].note, 'Rabatt klären');   // Anmerkung überlebt
  assert.strictEqual(stored.journal.length, 1);                // Verlauf unangetastet
  console.log('ok  Migration idempotent gespeichert, nichts verloren');

  // 3) Neue Task landet ganz unten mit sortKey max+1000 und frischem sortedAt
  await page.click('#show-add-habit-btn');
  await page.fill('#new-habit-input', 'Einkaufen');
  await page.click('#confirm-add-habit-btn');
  // Seit Phase 3 fragt ein Bottom Sheet nach der Priorisierung.
  await page.waitForSelector('#add-sheet:not(.hidden)', { timeout: 5000 });
  await page.click('#add-sheet-no');
  await page.waitForFunction(() => {
    const s = JSON.parse(localStorage.getItem('lucaTasks.v3') || '{}');
    return s.tasks && s.tasks.length === 4;
  }, { timeout: 5000 });
  stored = JSON.parse(await page.evaluate(() => localStorage.getItem('lucaTasks.v3')));
  const neu = stored.tasks.find(t => t.name === 'Einkaufen');
  assert.strictEqual(neu.prioritized, false);
  assert.strictEqual(neu.sortKey, 4000);
  assert.ok(neu.sortedAt > 0);
  const names2 = await page.$$eval('#habits-list .habit-label', els => els.map(e => e.textContent));
  assert.deepStrictEqual(names2, ['Rechnung schreiben', 'Angebot prüfen', 'Auto waschen', 'Einkaufen']);
  console.log('ok  Neue Task: unpriorisiert, ganz unten, sortKey 4000');

  // 4) Abhaken + Rückgängig: Task kommt an dieselbe Position zurück
  await page.check('.habit-checkbox[data-id="task-old-2"]');
  // Nicht den noch sichtbaren „hinzugefügt“-Undo-Toast erwischen – erst auf
  // den „erledigt“-Toast warten.
  await page.waitForFunction(() => document.getElementById('toast-text').textContent.includes('erledigt'), { timeout: 5000 });
  await page.click('#toast-action'); // Rückgängig
  await page.waitForFunction(() => document.querySelectorAll('#habits-list .habit-row').length === 4, { timeout: 5000 });
  const names3 = await page.$$eval('#habits-list .habit-label', els => els.map(e => e.textContent));
  assert.deepStrictEqual(names3, ['Rechnung schreiben', 'Angebot prüfen', 'Auto waschen', 'Einkaufen']);
  console.log('ok  Abhaken + Rückgängig: Position bleibt erhalten');

  // 5) Reload: alles noch da, Reihenfolge stabil.
  // Kurz warten, bis der entprellte IndexedDB-Write (120 ms) durch ist –
  // in der echten App übernimmt das flushSave() bei pagehide.
  await page.waitForTimeout(600);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#habits-list .habit-row', { timeout: 20000 });
  const names4 = await page.$$eval('#habits-list .habit-label', els => els.map(e => e.textContent));
  assert.deepStrictEqual(names4, ['Rechnung schreiben', 'Angebot prüfen', 'Auto waschen', 'Einkaufen']);
  console.log('ok  Reload: Reihenfolge stabil');

  await browser.close();
  server.close();
  console.log('\nSmoke-Test bestanden.');
})().catch(e => { console.error(e); process.exit(1); });
