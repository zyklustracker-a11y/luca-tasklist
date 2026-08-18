# Tests für Priorisierung, Sortierung & Kategorien

Diese Tests sichern das Priorisierungs-Feature ab (Datenmodell, Migration,
Geräte-Merge, Zwei-Sektionen-Layout, Bottom Sheet, Drag & Drop, Tastatur)
sowie die Kategorien (Filter-Leiste, Zuweisung per Drag, Verwaltung,
Löschen über Geräte hinweg).
Sie laufen nur lokal – GitHub Pages liefert sie zwar als statische Dateien
aus, aber nichts in der App referenziert sie, das Deployment ändert sich
dadurch nicht.

## Unit-Tests (ohne Abhängigkeiten)

Extrahieren die Sortier- und Merge-Funktionen direkt aus der ausgelieferten
`index.html` und testen sie in Node – getestet wird also immer der echte
Code, kein Duplikat:

```bash
node tools/tests/unit-order-sync.test.js    # Sortierung, Prio, Merge
node tools/tests/unit-categories.test.js    # Kategorien: Migration, Tombstones, Filter-Einsortierung
```

Braucht nur Node.js (>= 18), keine npm-Pakete.

## Browser-Smoke-Tests (brauchen Playwright)

Starten einen lokalen Static-Server auf dem Repo, laden die echte Seite in
Chromium (iPhone-Viewport 390×844, teils mit Touch-Emulation via CDP) und
prüfen Migration, Sektionen, Sheet, Drag & Drop und Tastatur:

```bash
# einmalig, irgendwo ausserhalb des Repos oder mit npx:
npm install playwright
npx playwright install chromium     # lädt den Browser, falls nicht vorhanden

node tools/tests/smoke-phase1.js    # Migration, Anlegen, Undo, Reload
node tools/tests/smoke-phase2.js    # Zwei Sektionen, Nummerierung, Platzhalter
node tools/tests/smoke-phase3.js    # Bottom Sheet (Ja/Nein, Slots, Backdrop, Swipe)
node tools/tests/smoke-phase4.js    # Drag & Drop (Maus + Touch, Sync-Pufferung)
node tools/tests/smoke-phase5.js    # Tastatur-Fallback Alt+Pfeil
node tools/tests/smoke-phase6.js    # Kategorien: Leiste, Filter, Verwaltung, Drag auf Pill
```

Liegt Chromium an einem eigenen Pfad, diesen über die Umgebungsvariable
`CHROMIUM_PATH` angeben:

```bash
CHROMIUM_PATH=/pfad/zu/chromium node tools/tests/smoke-phase4.js
```

Jeder Smoke-Test benutzt einen eigenen Port (8791–8796) und räumt den
Server am Ende selbst wieder ab. Die Tests verändern nur den localStorage
des Test-Browsers, nie echte Daten – Firebase wird nicht kontaktiert
(die Seite läuft dabei bewusst im nicht angemeldeten, lokalen Modus).

## Was die Unit-Tests abdecken

- Migration: Altbestand bekommt `prioritized: false` + `sortKey` in
  bisheriger Reihenfolge; idempotent; nichts geht verloren
- Lückenzahl-Mathematik: oben/unten/dazwischen, Rebalancing bei Lücken
  unter 0.001 (nur die betroffene Sektion)
- Geräte-Merge: jüngeres `sortedAt` gewinnt die Ordnungsfelder, Inhalt
  folgt den bisherigen Regeln; Löschen/Abhaken vom anderen Gerät wirkt
  weiter; wieder geöffnete Tasks bleiben
- Gleichstand (z. B. zwei Geräte migrieren denselben Altbestand
  unabhängig): beide konvergieren deterministisch auf die Cloud-Fassung,
  kein dauerhaftes Auseinanderdriften; Duplikat-sortKeys rendern stabil
  per id-Tie-Break
