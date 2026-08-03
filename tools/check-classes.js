/*
 * Prüft, ob jede in index.html verwendete CSS-Klasse auch wirklich definiert
 * ist – entweder in der vorkompilierten tailwind.css oder im eigenen
 * <style>-Block.
 *
 *   node tools/check-classes.js
 *
 * Warum es das braucht: Tailwind erzeugt beim Build nur die Klassen, die es zu
 * diesem Zeitpunkt im HTML findet. Schreibt man später eine neue Klasse ins
 * Markup – besonders eine mit freiem Wert wie z-[120] oder min-h-[1.25rem] –,
 * bleibt sie in der fertigen Datei einfach aus. Es gibt keine Fehlermeldung,
 * nichts wird rot: die Klasse tut schlicht nichts, und man sucht den Fehler an
 * der falschen Stelle. Genau so blieb einmal eine Bestätigungsmeldung hinter
 * einem Dialog unsichtbar und ein Dialog ohne Innenabstand.
 *
 * Meldet das Skript etwas, ist die Antwort fast immer:
 *   npx tailwindcss@3 -c tools/tailwind.config.js -i tools/input.css -o tailwind.css --minify
 * Danach den Cache-Buster ?v=N in index.html und sw.js hochzählen.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'tailwind.css'), 'utf8');

// Eigene Regeln aus dem <style>-Block zählen genauso als Definition.
const own = (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n');
const haystack = css + '\n' + own;

// Skripte getrennt behandeln: Im Markup steht in class="…" ein fertiger Wert,
// im JavaScript dagegen oft eine Zusammensetzung wie
//   '<div class="' + rowClasses + '" …'
// Würde man die gleich behandeln, landeten Variablennamen in der Liste.
const scripts = (html.match(/<script[^>]*>[\s\S]*?<\/script>/g) || []).join('\n');
const markup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');

const used = new Set();
const addAll = (value) => { for (const token of value.split(/\s+/)) if (token) used.add(token); };

for (const m of markup.matchAll(/class="([^"]*)"/g)) addAll(m[1]);

// Aus dem JavaScript nur eindeutig Wörtliches: class="…" ohne Anführungszeichen
// oder Pluszeichen darin (also keine Zusammensetzung) …
for (const m of scripts.matchAll(/class="([^"'+]*)"/g)) addAll(m[1]);
// … und die Zeichenketten in classList.add/remove/toggle/contains.
// Bei add/remove sind alle Argumente Klassennamen, bei toggle/contains nur das
// erste – das zweite ist eine Bedingung, etwa toggle('hidden', kind !== 'on').
for (const m of scripts.matchAll(/classList\.(add|remove|toggle|contains)\(([^)]*)\)/g)) {
  const literals = [...m[2].matchAll(/'([^']+)'/g)].map((q) => q[1]);
  const names = m[1] === 'add' || m[1] === 'remove' ? literals : literals.slice(0, 1);
  for (const name of names) addAll(name);
}

// Klassennamen, die nur als Haken für JS oder CSS-Selektoren dienen und
// bewusst keine eigene Regel haben.
const HOOKS = new Set(['task-edit-input']);

/** Tailwind maskiert Sonderzeichen im Selektor – und Kommas als \2c. */
function selectorVariants(name) {
  const escaped = [...name].map((c) => (/[\w-]/.test(c) ? c : '\\' + c)).join('');
  return [escaped, escaped.replace(/\\,/g, '\\2c ')];
}

function isDefined(name) {
  return selectorVariants(name).some((variant) => haystack.includes('.' + variant));
}

// Aus zusammengesetzten Klassenstrings im JavaScript entstehen Bruchstücke wie
// "(enter" oder "rowClasses.replace('flex" – die sind keine Klassennamen.
const looksLikeClass = (name) => /^[a-zA-Z][\w:/[\].,%!-]*$/.test(name);

const missing = [...used]
  .filter((name) => name && looksLikeClass(name) && !HOOKS.has(name) && !isDefined(name))
  .sort();

if (missing.length === 0) {
  console.log('Alle verwendeten Klassen sind definiert.');
  process.exit(0);
}

console.error('Diese Klassen werden verwendet, sind aber nirgends definiert:\n');
for (const name of missing) console.error('  ' + name);
console.error('\ntailwind.css neu erzeugen:');
console.error('  npx tailwindcss@3 -c tools/tailwind.config.js -i tools/input.css -o tailwind.css --minify');
process.exit(1);
