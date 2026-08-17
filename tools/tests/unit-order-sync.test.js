// Testet die in index.html AUSGELIEFERTEN Funktionen (per Extraktion, kein Duplikat).
'use strict';
const fs = require('fs');
const assert = require('assert');
const html = fs.readFileSync(require('path').join(__dirname, '..', '..', 'index.html'), 'utf8');

function slice(startMarker, endMarker, fromIndex) {
  const s = html.indexOf(startMarker, fromIndex || 0);
  if (s === -1) throw new Error('start marker not found: ' + startMarker);
  const e = html.indexOf(endMarker, s);
  if (e === -1) throw new Error('end marker not found: ' + endMarker);
  return { code: html.slice(s, e), end: e };
}

/* ---- Block 1: Ordnungs-Helfer aus dem Hauptskript ---- */
const orderBlock = slice('const MIN_SORT_GAP', '/* ------------------------------------------------------------\n       Wieder geöffnete Aufgaben').code;
const makeOrderApi = new Function('state', orderBlock + `
  return { ensureTaskOrder, sectionTasks, orderedTasks, orderKeyAt, rebalanceSection, placeTask,
           setState: function (s) { state = s; } };
`);

/* ---- Block 2: Merge-Strecke aus dem Firebase-Modul ---- */
const moduleStart = html.lastIndexOf('const MAX_REOPENED = 300;');
const mergeBlock = html.slice(moduleStart, html.indexOf('let userRef = null;', moduleStart));
const mergeApi = new Function(mergeBlock + `
  return { loginMerge, reconcileRemote, withNewerOrder, orderStamp };
`)();

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  ' + name); }

/* ============ Migration (ensureTaskOrder) ============ */
t('Migration: Altbestand bekommt prioritized:false + sortKey in bisheriger Reihenfolge', () => {
  const api = makeOrderApi({ tasks: [] });
  const tasks = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
  api.ensureTaskOrder(tasks);
  assert.deepStrictEqual(tasks.map(x => [x.prioritized, x.sortKey, x.sortedAt]),
    [[false, 1000, 0], [false, 2000, 0], [false, 3000, 0]]);
});

t('Migration ist idempotent', () => {
  const api = makeOrderApi({ tasks: [] });
  const tasks = [{ id: 'a' }, { id: 'b' }];
  api.ensureTaskOrder(tasks);
  const snapshot = JSON.stringify(tasks);
  api.ensureTaskOrder(tasks);
  assert.strictEqual(JSON.stringify(tasks), snapshot);
});

t('Migration: vorhandene Felder bleiben unangetastet, fehlende reihen sich hinten ein', () => {
  const api = makeOrderApi({ tasks: [] });
  const tasks = [
    { id: 'p', prioritized: true, sortKey: 500, sortedAt: 42 },
    { id: 'x' },                                    // alt, ohne Felder
    { id: 'r', prioritized: false, sortKey: 7000, sortedAt: 10 },
    { id: 'y' },                                    // alt, ohne Felder
  ];
  api.ensureTaskOrder(tasks);
  assert.deepStrictEqual(tasks.find(t2 => t2.id === 'p'), { id: 'p', prioritized: true, sortKey: 500, sortedAt: 42 });
  assert.deepStrictEqual(tasks.find(t2 => t2.id === 'x'), { id: 'x', prioritized: false, sortKey: 8000, sortedAt: 0 });
  assert.deepStrictEqual(tasks.find(t2 => t2.id === 'y'), { id: 'y', prioritized: false, sortKey: 9000, sortedAt: 0 });
});

/* ============ orderKeyAt / Einfügen ============ */
function seeded() {
  const state = { tasks: [
    { id: 'a', prioritized: false, sortKey: 1000, sortedAt: 0 },
    { id: 'b', prioritized: false, sortKey: 2000, sortedAt: 0 },
    { id: 'c', prioritized: false, sortKey: 3000, sortedAt: 0 },
  ] };
  return { api: makeOrderApi(state), state };
}

t('orderKeyAt: leer=1000, oben=min-1000, unten=max+1000, dazwischen=Mittelwert', () => {
  const { api } = seeded();
  assert.strictEqual(api.orderKeyAt(true, 0), 1000);        // leere Prio-Sektion
  assert.strictEqual(api.orderKeyAt(false, 0), 0);          // ganz nach oben
  assert.strictEqual(api.orderKeyAt(false, Infinity), 4000);// ans Ende
  assert.strictEqual(api.orderKeyAt(false, 1), 1500);       // zwischen a und b
});

t('orderKeyAt: excludeId lässt die bewegte Task aussen vor', () => {
  const { api } = seeded();
  // c vor b schieben: Nachbarn sind a(1000) und b(2000)
  assert.strictEqual(api.orderKeyAt(false, 1, 'c'), 1500);
});

t('Rebalancing greift, wenn die Lücke unter 0.001 fällt – nur die Sektion, ein Durchlauf', () => {
  const state = { tasks: [
    { id: 'a', prioritized: false, sortKey: 1000, sortedAt: 0 },
    { id: 'b', prioritized: false, sortKey: 1000.0005, sortedAt: 0 },
    { id: 'p', prioritized: true, sortKey: 111, sortedAt: 5 },
  ] };
  const api = makeOrderApi(state);
  const key = api.orderKeyAt(false, 1);                     // zwischen a und b
  assert.strictEqual(key, 1500);                            // nach Rebalance: 1000/2000
  assert.deepStrictEqual(state.tasks.filter(x => !x.prioritized).map(x => x.sortKey), [1000, 2000]);
  assert.ok(state.tasks.filter(x => !x.prioritized).every(x => x.sortedAt > 0)); // Rebalance stempelt
  assert.strictEqual(state.tasks.find(x => x.id === 'p').sortKey, 111);          // Prio-Sektion unberührt
});

t('placeTask: setzt Sektion, sortKey und frisches sortedAt', () => {
  const { api, state } = seeded();
  const task = state.tasks[2];                              // c
  const before = Date.now();
  api.placeTask(task, true, 0);
  assert.strictEqual(task.prioritized, true);
  assert.strictEqual(task.sortKey, 1000);                   // leere Prio-Sektion
  assert.ok(task.sortedAt >= before);
});

t('orderedTasks: Prio-Sektion zuerst, je Sektion nach sortKey', () => {
  const state = { tasks: [
    { id: 'r2', prioritized: false, sortKey: 2000, sortedAt: 0 },
    { id: 'p1', prioritized: true, sortKey: 900, sortedAt: 0 },
    { id: 'r1', prioritized: false, sortKey: 1000, sortedAt: 0 },
    { id: 'p2', prioritized: true, sortKey: 1800, sortedAt: 0 },
  ] };
  const api = makeOrderApi(state);
  assert.deepStrictEqual(api.orderedTasks().map(x => x.id), ['p1', 'p2', 'r1', 'r2']);
});

/* ============ Merge: lokale Umsortierung überlebt älteren Cloud-Stand ============ */
const base = { journal: [], reopened: {}, history: {}, bestStreak: 0 };

t('reconcileRemote: jüngere LOKALE Ordnung überlebt, Inhalt kommt aus der Cloud', () => {
  const local = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'alt', prioritized: true, sortKey: 500, sortedAt: 200 },
  ] });
  const remote = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'neu (anderes Gerät)', note: 'n', prioritized: false, sortKey: 3000, sortedAt: 100 },
  ] });
  const merged = mergeApi.reconcileRemote(local, remote);
  const x = merged.tasks[0];
  assert.strictEqual(x.name, 'neu (anderes Gerät)');        // Inhalt: Cloud gewinnt (wie bisher)
  assert.strictEqual(x.note, 'n');
  assert.strictEqual(x.prioritized, true);                  // Ordnung: lokal ist jünger
  assert.strictEqual(x.sortKey, 500);
  assert.strictEqual(x.sortedAt, 200);
});

t('reconcileRemote: jüngere CLOUD-Ordnung gewinnt weiterhin', () => {
  const local = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A', prioritized: true, sortKey: 500, sortedAt: 100 },
  ] });
  const remote = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A', prioritized: false, sortKey: 3000, sortedAt: 200 },
  ] });
  const x = mergeApi.reconcileRemote(local, remote).tasks[0];
  assert.strictEqual(x.prioritized, false);
  assert.strictEqual(x.sortKey, 3000);
});

t('reconcileRemote: Cloud-Task ohne Ordnungsfelder (altes Gerät) – lokale Ordnung bleibt', () => {
  const local = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A', prioritized: true, sortKey: 500, sortedAt: 200 },
  ] });
  const remote = Object.assign({}, base, { tasks: [ { id: 'x', name: 'A umbenannt' } ] });
  const x = mergeApi.reconcileRemote(local, remote).tasks[0];
  assert.strictEqual(x.name, 'A umbenannt');
  assert.strictEqual(x.prioritized, true);
  assert.strictEqual(x.sortKey, 500);
});

t('reconcileRemote: Löschen/Abhaken auf anderem Gerät wirkt weiterhin (Cloud-only-Menge)', () => {
  const local = Object.assign({}, base, { tasks: [
    { id: 'gone', name: 'lokal noch da', prioritized: false, sortKey: 1000, sortedAt: 50 },
  ] });
  const remote = Object.assign({}, base, { tasks: [] });
  assert.deepStrictEqual(mergeApi.reconcileRemote(local, remote).tasks, []);
});

t('reconcileRemote: frisch wieder geöffnete Task bleibt (Bestandsverhalten unverändert)', () => {
  const now = Date.now();
  const local = Object.assign({}, base, {
    tasks: [{ id: 'ro', name: 'wieder offen', prioritized: false, sortKey: 1000, sortedAt: now }],
    reopened: { ro: now },
  });
  const remote = Object.assign({}, base, { tasks: [] });
  const merged = mergeApi.reconcileRemote(local, remote);
  assert.strictEqual(merged.tasks.length, 1);
  assert.strictEqual(merged.tasks[0].id, 'ro');
});

t('loginMerge: Inhalt lokal führend (wie bisher), Ordnung von der jüngeren Seite', () => {
  const local = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'lokal', note: 'meine Notiz', prioritized: false, sortKey: 1000, sortedAt: 100 },
  ] });
  const remote = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'cloud', prioritized: true, sortKey: 500, sortedAt: 300 },
    { id: 'nur-cloud', name: 'B', prioritized: false, sortKey: 2000, sortedAt: 0 },
  ] });
  const merged = mergeApi.loginMerge(local, remote);
  const x = merged.tasks.find(t2 => t2.id === 'x');
  assert.strictEqual(x.name, 'lokal');
  assert.strictEqual(x.note, 'meine Notiz');
  assert.strictEqual(x.prioritized, true);                  // Cloud-Ordnung ist jünger
  assert.strictEqual(x.sortKey, 500);
  assert.strictEqual(merged.tasks.length, 2);               // Vereinigung wie bisher
});

t('withNewerOrder: Gleichstand (z. B. beide migriert, sortedAt 0) ändert nichts', () => {
  const winner = { id: 'x', prioritized: false, sortKey: 1000, sortedAt: 0 };
  const other = { id: 'x', prioritized: true, sortKey: 1, sortedAt: 0 };
  assert.strictEqual(mergeApi.withNewerOrder(winner, other), winner);
});

/* ============ Gleichstand: zwei Geräte migrieren denselben Altbestand ============ */

t('Gleichstand-Konvergenz: beide Geräte landen bei der Cloud-Reihenfolge', () => {
  // Beide Geräte haben unabhängig migriert (sortedAt überall 0), aber mit
  // unterschiedlicher Array-Reihenfolge -> unterschiedliche sortKeys.
  const deviceA = Object.assign({}, base, { tasks: [
    { id: 't1', name: 'Eins', prioritized: false, sortKey: 1000, sortedAt: 0 },
    { id: 't2', name: 'Zwei', prioritized: false, sortKey: 2000, sortedAt: 0 },
  ] });
  const deviceB = Object.assign({}, base, { tasks: [
    { id: 't2', name: 'Zwei', prioritized: false, sortKey: 1000, sortedAt: 0 },
    { id: 't1', name: 'Eins', prioritized: false, sortKey: 2000, sortedAt: 0 },
  ] });
  // Gerät A hat zuerst geschrieben – sein Stand IST die Cloud.
  const cloud = JSON.parse(JSON.stringify(deviceA));

  const onA = mergeApi.reconcileRemote(deviceA, cloud);
  const onB = mergeApi.reconcileRemote(deviceB, cloud);
  const orderOf = m => m.tasks.slice().sort((a, b) => (a.sortKey - b.sortKey) || String(a.id).localeCompare(String(b.id))).map(x => x.id);
  assert.deepStrictEqual(orderOf(onA), ['t1', 't2']);
  assert.deepStrictEqual(orderOf(onB), ['t1', 't2']);       // B übernimmt die Cloud-Keys
  assert.deepStrictEqual(
    onB.tasks.map(x => [x.id, x.sortKey]).sort(),
    onA.tasks.map(x => [x.id, x.sortKey]).sort()            // identische Keys, kein Drift
  );
});

t('Gleichstand-Konvergenz: loginMerge lässt lokal einmal gewinnen, danach zieht das andere Gerät nach', () => {
  const cloudVonA = Object.assign({}, base, { tasks: [
    { id: 't1', name: 'Eins', prioritized: false, sortKey: 1000, sortedAt: 0 },
    { id: 't2', name: 'Zwei', prioritized: false, sortKey: 2000, sortedAt: 0 },
  ] });
  const lokalB = Object.assign({}, base, { tasks: [
    { id: 't2', name: 'Zwei', prioritized: false, sortKey: 1000, sortedAt: 0 },
    { id: 't1', name: 'Eins', prioritized: false, sortKey: 2000, sortedAt: 0 },
  ] });
  // B meldet sich an: bei Gleichstand gewinnt lokal (B), Ergebnis geht in die Cloud …
  const neueCloud = mergeApi.loginMerge(lokalB, cloudVonA);
  const t1 = neueCloud.tasks.find(x => x.id === 't1');
  assert.strictEqual(t1.sortKey, 2000);
  // … und A übernimmt diese Reihenfolge beim nächsten Snapshot (Cloud gewinnt Gleichstand).
  const onA = mergeApi.reconcileRemote(cloudVonA, neueCloud);
  assert.deepStrictEqual(
    onA.tasks.map(x => [x.id, x.sortKey]).sort(),
    neueCloud.tasks.map(x => [x.id, x.sortKey]).sort()
  );
});

t('Gleichstand mit identischem sortedAt != 0: Cloud-Fassung steht, deterministisch', () => {
  const stamp = 1755400000000;
  const local = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A', prioritized: true, sortKey: 500, sortedAt: stamp },
  ] });
  const remote = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A', prioritized: false, sortKey: 3000, sortedAt: stamp },
  ] });
  const x = mergeApi.reconcileRemote(local, remote).tasks[0];
  assert.strictEqual(x.prioritized, false);                 // Cloud steht bei Gleichstand
  assert.strictEqual(x.sortKey, 3000);
});

t('Duplikat-sortKey (beide Geräte offline angehängt): Render-Reihenfolge stabil per id-Tie-Break', () => {
  const state = { tasks: [
    { id: 'task-b', prioritized: false, sortKey: 4000, sortedAt: 10 },
    { id: 'task-a', prioritized: false, sortKey: 4000, sortedAt: 20 },
  ] };
  const api = makeOrderApi(state);
  assert.deepStrictEqual(api.orderedTasks().map(x => x.id), ['task-a', 'task-b']);
  // Einfügen zwischen zwei identische Keys: Lücke 0 < MIN_SORT_GAP -> Rebalance statt Duplikat.
  const key = api.orderKeyAt(false, 1);
  assert.strictEqual(key, 1500);
  assert.deepStrictEqual(state.tasks.map(x => x.sortKey).sort((a, b) => a - b), [1000, 2000]);
});

console.log('\n' + passed + ' Tests bestanden.');
