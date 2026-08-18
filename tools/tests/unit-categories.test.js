// Testet die Kategorie-Funktionen der AUSGELIEFERTEN index.html (per
// Extraktion, kein Duplikat): Migration, verwaiste ids, Merge mit
// Tombstones, Zuweisungs-Stempel und Einsortieren in gefilterter Ansicht.
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

/* ---- Block A: Kategorie-Helfer aus dem Hauptskript ---- */
const catBlock = slice('const CAT_NAME_MAX', '/**\n     * Migration. Bringt').code;
const makeCatApi = new Function('normalizeText', 'state', catBlock + `
  return { sanitizeCategories, liveCategories, categoryById, ensureTaskCategories,
           carryCategory, setTaskCategory, catStamp,
           setState: function (s) { state = s; } };
`);
const normText = s => String(s == null ? '' : s).replace(/�/g, '').trim();
const catApi = (state) => makeCatApi(normText, state || { categories: [], tasks: [] });

/* ---- Block B: Ordnungs- und Filter-Helfer aus dem Hauptskript ---- */
const orderBlock = slice('const MIN_SORT_GAP', '/* ------------------------------------------------------------\n       Wieder geöffnete Aufgaben').code;
// categoryById kommt aus Block A und wird hier hineingereicht: der
// Filter-Block ruft es auf, um verwaiste Verweise im Verlauf zu erkennen.
const makeOrderApi = new Function('state', 'categoryById', orderBlock + `
  return { ensureTaskOrder, sectionTasks, orderKeyAt, placeTask,
           visibleSectionTasks, keyBetweenVisible, placeTaskVisible,
           entryCategoryId, visibleJournal,
           setFilter: function (id) { activeCategoryId = id; } };
`);
/** Order-API mit einem Kategorien-Bestand, wie ihn die App zur Laufzeit hätte. */
function orderApiWith(state, categories) {
  const catState = { categories: categories || [], tasks: state.tasks || [] };
  const api = catApi(catState);
  return makeOrderApi(state, api.categoryById);
}

/* ---- Block C: Merge-Strecke aus dem Firebase-Modul ---- */
const moduleStart = html.lastIndexOf('const MAX_REOPENED = 300;');
const mergeBlock = html.slice(moduleStart, html.indexOf('let userRef = null;', moduleStart));
const mergeApi = new Function(mergeBlock + `
  return { loginMerge, reconcileRemote, mergeCategories, withNewerCategory, withNewerMeta };
`)();

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  ' + name); }

const DAY = 24 * 60 * 60 * 1000;
const base = { journal: [], reopened: {}, history: {}, bestStreak: 0 };

/* ============ sanitizeCategories ============ */
t('sanitizeCategories: gültige bleiben, Müll fällt raus, order wird aufgefüllt', () => {
  const api = catApi();
  const out = api.sanitizeCategories([
    { id: 'c1', name: 'Arbeit', order: 1000, createdAt: 5, updatedAt: 10 },
    { id: 'c2', name: '  Privat  ' },                      // ohne order → hinten einreihen
    { id: 'c1', name: 'Doppelt' },                          // doppelte id → weg
    { id: '', name: 'ohne id' },                            // ungültig
    { name: 'ganz ohne id' },                               // ungültig
    null, 42, 'x',                                          // Müll
    { id: 'c3', name: '' },                                 // leerer Name, nicht gelöscht → weg
  ]);
  assert.deepStrictEqual(out.map(c => [c.id, c.name, c.order]), [['c1', 'Arbeit', 1000], ['c2', 'Privat', 2000]]);
});

t('sanitizeCategories ist idempotent', () => {
  const api = catApi();
  const once = api.sanitizeCategories([{ id: 'c1', name: 'Arbeit' }, { id: 'c2', name: 'Uni', order: 500 }]);
  const twice = api.sanitizeCategories(JSON.parse(JSON.stringify(once)));
  assert.deepStrictEqual(twice, once);
});

t('sanitizeCategories: frischer Tombstone bleibt, abgelaufener (>90 Tage) wird weggeräumt', () => {
  const api = catApi();
  const now = Date.now();
  const out = api.sanitizeCategories([
    { id: 'del-neu', name: 'Weg', deleted: true, updatedAt: now - DAY },
    { id: 'del-alt', name: 'Uralt', deleted: true, updatedAt: now - 91 * DAY },
    { id: 'c1', name: 'Arbeit', order: 1000, updatedAt: 1 },
  ]);
  assert.deepStrictEqual(out.map(c => c.id).sort(), ['c1', 'del-neu']);
  assert.strictEqual(out.find(c => c.id === 'del-neu').deleted, true);
});

t('liveCategories/categoryById: Tombstones zählen als „gibt es nicht“, Reihenfolge nach order', () => {
  const api = catApi({ categories: [
    { id: 'b', name: 'B', order: 2000 },
    { id: 'a', name: 'A', order: 1000 },
    { id: 'x', name: 'X', order: 500, deleted: true, updatedAt: Date.now() },
  ], tasks: [] });
  assert.deepStrictEqual(api.liveCategories().map(c => c.id), ['a', 'b']);
  assert.strictEqual(api.categoryById('x'), null);
  assert.strictEqual(api.categoryById('a').name, 'A');
});

/* ============ ensureTaskCategories (Migration + verwaiste ids) ============ */
t('Migration: Altbestand bekommt idempotent categoryId:null und categoryAt:0', () => {
  const api = catApi();
  const tasks = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', categoryId: 7 }];
  api.ensureTaskCategories(tasks, []);
  assert.deepStrictEqual(tasks.map(x => [x.categoryId, x.categoryAt]), [[null, 0], [null, 0]]);
  const snap = JSON.stringify(tasks);
  api.ensureTaskCategories(tasks, []);
  assert.strictEqual(JSON.stringify(tasks), snap);
});

t('Verwaiste categoryId (Kategorie weg/gelöscht) fällt auf null zurück, Stempel bleibt', () => {
  const api = catApi();
  const cats = [
    { id: 'c1', name: 'Arbeit', order: 1000 },
    { id: 'c2', name: 'Weg', order: 2000, deleted: true, updatedAt: Date.now() },
  ];
  const tasks = [
    { id: 'a', categoryId: 'c1', categoryAt: 5 },   // lebt → bleibt
    { id: 'b', categoryId: 'c2', categoryAt: 7 },   // Tombstone → null
    { id: 'c', categoryId: 'nie-gesehen', categoryAt: 9 },
  ];
  api.ensureTaskCategories(tasks, cats);
  assert.deepStrictEqual(tasks.map(x => [x.categoryId, x.categoryAt]),
    [['c1', 5], [null, 7], [null, 9]]);
});

t('carryCategory: Kategorie wandert ins Journal und zurück (Wiederöffnen)', () => {
  const api = catApi();
  const entry = api.carryCategory({ categoryId: 'c1', categoryAt: 42 }, { id: 'x', name: 'X' });
  assert.deepStrictEqual([entry.categoryId, entry.categoryAt], ['c1', 42]);
  const plain = api.carryCategory({ categoryId: null }, { id: 'y' });
  assert.ok(!('categoryId' in plain));
});

/* ============ Merge: Kategorien (Tombstone/LWW) ============ */
t('mergeCategories: Vereinigung, je id gewinnt der jüngere Stand', () => {
  const a = [{ id: 'c1', name: 'Arbeit', order: 1000, updatedAt: 100 }];
  const b = [
    { id: 'c1', name: 'Job', order: 1000, updatedAt: 200 },
    { id: 'c2', name: 'Privat', order: 2000, updatedAt: 50 },
  ];
  const out = mergeApi.mergeCategories(a, b);
  assert.strictEqual(out.find(c => c.id === 'c1').name, 'Job');
  assert.strictEqual(out.length, 2);
});

t('mergeCategories: Löschen auf Gerät A setzt sich gegen älteren Stand auf B durch', () => {
  const now = Date.now();
  const deviceA = [{ id: 'c1', name: 'Arbeit', order: 1000, updatedAt: now, deleted: true }];
  const deviceB = [{ id: 'c1', name: 'Arbeit', order: 1000, updatedAt: now - DAY }];
  const out = mergeApi.mergeCategories(deviceB, deviceA);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].deleted, true);
});

t('mergeCategories: abgelaufener Tombstone (>90 Tage) wird beim Merge weggeräumt', () => {
  const out = mergeApi.mergeCategories(
    [{ id: 'alt', name: 'Uralt', order: 1000, updatedAt: Date.now() - 91 * DAY, deleted: true }], []);
  assert.deepStrictEqual(out, []);
});

t('mergeCategories: späteres Umbenennen gewinnt gegen früheres Löschen (LWW)', () => {
  const now = Date.now();
  const del = [{ id: 'c1', name: 'Arbeit', order: 1000, updatedAt: now - DAY, deleted: true }];
  const ren = [{ id: 'c1', name: 'Beruf', order: 1000, updatedAt: now }];
  const out = mergeApi.mergeCategories(del, ren);
  assert.strictEqual(out[0].name, 'Beruf');
  assert.ok(!out[0].deleted);
});

t('loginMerge/reconcileRemote: categories laufen durch dieselbe Merge-Strecke', () => {
  const local = Object.assign({}, base, { tasks: [], categories: [
    { id: 'c1', name: 'Arbeit', order: 1000, updatedAt: 100 },
  ] });
  const remote = Object.assign({}, base, { tasks: [], categories: [
    { id: 'c2', name: 'Privat', order: 2000, updatedAt: 100 },
  ] });
  assert.deepStrictEqual(mergeApi.loginMerge(local, remote).categories.map(c => c.id).sort(), ['c1', 'c2']);
  assert.deepStrictEqual(mergeApi.reconcileRemote(local, remote).categories.map(c => c.id).sort(), ['c1', 'c2']);
});

t('reconcileRemote: Cloud-Stand ohne categories-Feld (alte App-Version) löscht nichts', () => {
  const local = Object.assign({}, base, { tasks: [], categories: [
    { id: 'c1', name: 'Arbeit', order: 1000, updatedAt: 100 },
  ] });
  const remote = Object.assign({}, base, { tasks: [] });   // kein categories
  assert.deepStrictEqual(mergeApi.reconcileRemote(local, remote).categories.map(c => c.id), ['c1']);
});

/* ============ Merge: Kategorie-Zuweisung je Task (categoryAt) ============ */
t('reconcileRemote: frische LOKALE Zuweisung überlebt älteren Cloud-Stand', () => {
  const local = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A', prioritized: false, sortKey: 1000, sortedAt: 1, categoryId: 'c1', categoryAt: 200 },
  ], categories: [] });
  const remote = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A (edit)', prioritized: false, sortKey: 1000, sortedAt: 1, categoryId: null, categoryAt: 100 },
  ], categories: [] });
  const x = mergeApi.reconcileRemote(local, remote).tasks[0];
  assert.strictEqual(x.name, 'A (edit)');                  // Inhalt: Cloud gewinnt wie bisher
  assert.strictEqual(x.categoryId, 'c1');                  // Zuweisung: lokal ist jünger
  assert.strictEqual(x.categoryAt, 200);
});

t('reconcileRemote: jüngere CLOUD-Zuweisung gewinnt (auch das Entfernen auf null)', () => {
  const local = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A', prioritized: false, sortKey: 1000, sortedAt: 1, categoryId: 'c1', categoryAt: 100 },
  ] });
  const remote = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A', prioritized: false, sortKey: 1000, sortedAt: 1, categoryId: null, categoryAt: 300 },
  ] });
  const x = mergeApi.reconcileRemote(local, remote).tasks[0];
  assert.strictEqual(x.categoryId, null);
  assert.strictEqual(x.categoryAt, 300);
});

t('reconcileRemote: Cloud-Task ohne Kategoriefelder (altes Gerät) – lokale Zuweisung bleibt', () => {
  const local = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'A', prioritized: true, sortKey: 500, sortedAt: 5, categoryId: 'c1', categoryAt: 100 },
  ] });
  const remote = Object.assign({}, base, { tasks: [{ id: 'x', name: 'A umbenannt' }] });
  const x = mergeApi.reconcileRemote(local, remote).tasks[0];
  assert.strictEqual(x.name, 'A umbenannt');
  assert.strictEqual(x.categoryId, 'c1');
  assert.strictEqual(x.prioritized, true);                 // Ordnung unabhängig davon
});

t('withNewerMeta: Ordnung und Kategorie kommen unabhängig von der jeweils jüngeren Seite', () => {
  const winner = { id: 'x', prioritized: false, sortKey: 1000, sortedAt: 100, categoryId: null, categoryAt: 300 };
  const other = { id: 'x', prioritized: true, sortKey: 500, sortedAt: 200, categoryId: 'c1', categoryAt: 100 };
  const out = mergeApi.withNewerMeta(winner, other);
  assert.strictEqual(out.prioritized, true);               // Ordnung: other jünger
  assert.strictEqual(out.sortKey, 500);
  assert.strictEqual(out.categoryId, null);                // Kategorie: winner jünger
  assert.strictEqual(out.categoryAt, 300);
});

t('loginMerge: Zuweisung von der jüngeren Seite, Inhalt lokal führend (wie bisher)', () => {
  const local = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'lokal', prioritized: false, sortKey: 1000, sortedAt: 1, categoryId: null, categoryAt: 100 },
  ], categories: [] });
  const remote = Object.assign({}, base, { tasks: [
    { id: 'x', name: 'cloud', prioritized: false, sortKey: 1000, sortedAt: 1, categoryId: 'c9', categoryAt: 250 },
  ], categories: [] });
  const x = mergeApi.loginMerge(local, remote).tasks[0];
  assert.strictEqual(x.name, 'lokal');
  assert.strictEqual(x.categoryId, 'c9');
});

/* ============ Einsortieren in gefilterter Ansicht ============ */
function filteredState() {
  // Globale Rest-Reihenfolge: a(c1) 1000, b(c2) 2000, c(c1) 3000, d(c2) 4000
  return { tasks: [
    { id: 'a', prioritized: false, sortKey: 1000, sortedAt: 0, categoryId: 'c1', categoryAt: 0 },
    { id: 'b', prioritized: false, sortKey: 2000, sortedAt: 0, categoryId: 'c2', categoryAt: 0 },
    { id: 'c', prioritized: false, sortKey: 3000, sortedAt: 0, categoryId: 'c1', categoryAt: 0 },
    { id: 'd', prioritized: false, sortKey: 4000, sortedAt: 0, categoryId: 'c2', categoryAt: 0 },
  ] };
}

t('visibleSectionTasks: ohne Filter alles, mit Filter nur die Kategorie', () => {
  const api = makeOrderApi(filteredState());
  assert.deepStrictEqual(api.visibleSectionTasks(false).map(x => x.id), ['a', 'b', 'c', 'd']);
  api.setFilter('c1');
  assert.deepStrictEqual(api.visibleSectionTasks(false).map(x => x.id), ['a', 'c']);
});

t('keyBetweenVisible: zwischen sichtbaren Nachbarn = Mittelwert (unsichtbare dazwischen ok)', () => {
  const api = makeOrderApi(filteredState());
  api.setFilter('c1');
  // zwischen a(1000) und c(3000) – b(2000) liegt unsichtbar dazwischen
  assert.strictEqual(api.keyBetweenVisible(false, 1), 2000);
});

t('keyBetweenVisible: ganz oben der gefilterten Liste = global DIREKT vor dem Anker', () => {
  const state = filteredState();
  const api = makeOrderApi(state);
  api.setFilter('c2');
  // vor b(2000): globaler Vorgänger ist a(1000) → Mittelwert 1500, KEIN Sprung vor a
  assert.strictEqual(api.keyBetweenVisible(false, 0), 1500);
});

t('keyBetweenVisible: ganz unten der gefilterten Liste = global direkt hinter den Anker', () => {
  const state = filteredState();
  const api = makeOrderApi(state);
  api.setFilter('c1');
  // hinter c(3000): globaler Nachfolger ist d(4000) → 3500
  assert.strictEqual(api.keyBetweenVisible(false, Infinity), 3500);
});

t('keyBetweenVisible: leere gefilterte Liste = global ans Ende der Sektion', () => {
  const api = makeOrderApi(filteredState());
  api.setFilter('leer');
  assert.strictEqual(api.keyBetweenVisible(false, 0), 5000);
});

t('placeTaskVisible: Drop in gefilterter Ansicht hält die globale Reihenfolge widerspruchsfrei', () => {
  const state = filteredState();
  const api = makeOrderApi(state);
  api.setFilter('c1');
  const c = state.tasks.find(x => x.id === 'c');
  api.placeTaskVisible(c, false, 0);            // c in „c1“ an Platz 1 (vor a)
  assert.ok(c.sortKey < 1000);
  assert.ok(c.sortedAt > 0);
  // Globale Reihenfolge: c, a, b, d – für c2-Sicht ändert sich nichts.
  const globalOrder = state.tasks.slice().sort((x, y) => x.sortKey - y.sortKey).map(x => x.id);
  assert.deepStrictEqual(globalOrder, ['c', 'a', 'b', 'd']);
});

t('placeTaskVisible: ohne Filter identisch zum bisherigen Verhalten (Mitte = Mittelwert)', () => {
  const state = filteredState();
  const api = makeOrderApi(state);
  const d = state.tasks.find(x => x.id === 'd');
  api.placeTaskVisible(d, false, 1);            // zwischen a(1000) und b(2000)
  assert.strictEqual(d.sortKey, 1500);
});

t('keyBetweenVisible: zu kleine Lücke rebalanciert die GANZE Sektion einmalig', () => {
  const state = { tasks: [
    { id: 'a', prioritized: false, sortKey: 1000, sortedAt: 0, categoryId: 'c1', categoryAt: 0 },
    { id: 'b', prioritized: false, sortKey: 1000.0004, sortedAt: 0, categoryId: 'c2', categoryAt: 0 },
    { id: 'c', prioritized: false, sortKey: 1000.0008, sortedAt: 0, categoryId: 'c1', categoryAt: 0 },
  ] };
  const api = makeOrderApi(state);
  api.setFilter('c1');
  const key = api.keyBetweenVisible(false, 1);  // zwischen a und c (b unsichtbar)
  // Nach Rebalance: a=1000, b=2000, c=3000 → Mittelwert von a und c = 2000
  assert.strictEqual(key, 2000);
  assert.deepStrictEqual(state.tasks.map(x => x.sortKey), [1000, 2000, 3000]);
});

/* ============ Verlauf folgt dem Kategorie-Filter ============ */
function journalState() {
  return { tasks: [], journal: [
    { id: 'j1', name: 'Arbeit erledigt', date: '2026-08-18', categoryId: 'c1', categoryAt: 5 },
    { id: 'j2', name: 'Privat erledigt', date: '2026-08-18', categoryId: 'c2', categoryAt: 5 },
    { id: 'j3', name: 'Ohne Kategorie', date: '2026-08-17' },
    { id: 'j4', name: 'Noch was aus Arbeit', date: '2026-08-17', categoryId: 'c1', categoryAt: 5 },
    { id: 'j5', name: 'Verwaist', date: '2026-08-17', categoryId: 'c-weg', categoryAt: 5 },
  ] };
}
const LIVE_CATS = [
  { id: 'c1', name: 'Arbeit', order: 1000, updatedAt: 1 },
  { id: 'c2', name: 'Privat', order: 2000, updatedAt: 1 },
];

t('Verlauf in „Alle“: wirklich alle erledigten Aufgaben, quer über die Kategorien', () => {
  const st = journalState();
  const api = orderApiWith(st, LIVE_CATS);
  assert.deepStrictEqual(api.visibleJournal().map(e => e.id), ['j1', 'j2', 'j3', 'j4', 'j5']);
});

t('Verlauf in einer Kategorie: nur deren erledigte Aufgaben', () => {
  const st = journalState();
  const api = orderApiWith(st, LIVE_CATS);
  api.setFilter('c1');
  assert.deepStrictEqual(api.visibleJournal().map(e => e.id), ['j1', 'j4']);
  api.setFilter('c2');
  assert.deepStrictEqual(api.visibleJournal().map(e => e.id), ['j2']);
});

t('Verlauf: frisch angelegte Kategorie ist leer, die anderen bleiben unberührt', () => {
  const st = journalState();
  const api = orderApiWith(st, LIVE_CATS.concat([{ id: 'c-neu', name: 'Geschäftlich', order: 3000, updatedAt: 1 }]));
  api.setFilter('c-neu');
  assert.deepStrictEqual(api.visibleJournal(), []);
  api.setFilter(null);
  assert.strictEqual(api.visibleJournal().length, 5);
});

t('Verlauf: Eintrag ohne und mit verwaister Kategorie zählt als „ohne“ – nur unter „Alle“', () => {
  const st = journalState();
  const api = orderApiWith(st, LIVE_CATS);
  assert.strictEqual(api.entryCategoryId(st.journal[2]), null);   // nie eine gehabt
  assert.strictEqual(api.entryCategoryId(st.journal[4]), null);   // Kategorie gelöscht
  api.setFilter('c1');
  assert.ok(!api.visibleJournal().some(e => e.id === 'j5'), 'verwaister Eintrag taucht nicht in einer Kategorie auf');
  api.setFilter(null);
  assert.ok(api.visibleJournal().some(e => e.id === 'j5'), 'unter „Alle“ ist er sichtbar');
});

t('Verlauf: Tombstone-Kategorie wird wie gelöscht behandelt', () => {
  const st = journalState();
  const api = orderApiWith(st, LIVE_CATS.concat([
    { id: 'c-weg', name: 'Weg', order: 3000, updatedAt: Date.now(), deleted: true },
  ]));
  assert.strictEqual(api.entryCategoryId(st.journal[4]), null);
  api.setFilter('c-weg');
  assert.deepStrictEqual(api.visibleJournal(), []);
});

console.log('\n' + passed + ' Tests bestanden.');
