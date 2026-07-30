# Luca's Task Tracker

Statische Web-App, installierbar als PWA. Keine Build-Tools, kein Server nötig.
Alle Dateien liegen flach nebeneinander – **keine Unterordner anlegen.**

```
index.html                Die App
manifest.webmanifest      Name, Farben, Icons für die Installation
sw.js                     Service Worker (Offline-Betrieb)
favicon-32.png            Symbol im Browser-Tab
apple-touch-icon.png      Symbol auf dem iPhone-Homescreen
icon-192.png              Android / PWA
icon-512.png              Android / PWA
icon-512-maskable.png     Android (randloses Symbol)
README.md                 Diese Datei
```

## Auf GitHub veröffentlichen

**Vorher prüfen:** Beim Herunterladen hängt der Browser bei gleichnamigen
Dateien eine Nummer an – aus `index.html` wird dann `index (2).html`. Solche
Dateien ignoriert GitHub Pages stillschweigend. Also erst im Finder
kontrollieren, dass alle neun Dateien exakt so heissen wie oben, und
gegebenenfalls umbenennen.

1. Neues Repository anlegen, öffentlich.
2. **Add file → Upload files**, alle neun Dateien auf einmal hineinziehen.
3. Nach unten scrollen und auf den grünen Button **Commit changes** klicken.
   Ohne diesen Klick passiert nichts.
4. **Settings → Pages**: Source auf *Deploy from a branch*, Branch `main`,
   Ordner `/ (root)`. Speichern.
5. Unter **Actions** läuft „pages build and deployment". Sobald der Haken grün
   ist, ist die Seite unter `https://DEINNAME.github.io/REPONAME/` erreichbar.

Prüf danach im Repo, dass alle Dateien auf der obersten Ebene liegen und keine
in einem Unterordner gelandet ist.

## Aufs iPhone legen

Safari öffnen → Teilen → *Zum Home-Bildschirm*. Das Symbol kommt aus
`apple-touch-icon.png`, der Name darunter aus dem Meta-Tag
`apple-mobile-web-app-title` in der `index.html`.

## Wie die Tage funktionieren

- **Einmalige Tasks** bleiben stehen, bis du sie abhakst. Beim Tageswechsel
  wandern nur die abgehakten in den Verlauf – offene bleiben in der Liste und
  bekommen ein „seit X Tagen"-Label.
- **Tägliche Tasks** kommen jeden Morgen unabgehakt zurück.
- Der Tageswechsel passiert automatisch um Mitternacht, auch wenn die App
  offen liegt. Gelöscht wird dabei nichts.
- Die Konfetti-Animation kommt jedes Mal, wenn die Liste wieder komplett
  abgehakt ist. Neue Task am selben Tag erledigen → neue Animation.
- Der Streak zählt einen Tag, sobald du an dem Tag mindestens einmal alles
  abgehakt hattest.

## Wo die Daten liegen

Primär in **IndexedDB**, zusätzlich gespiegelt in `localStorage`. Fällt eines
aus, übernimmt das andere. Über *Backup speichern* bekommst du eine JSON-Datei,
*Backup laden* spielt sie zurück.

Die Daten liegen auf dem jeweiligen Gerät. Für echte Synchronisation zwischen
iPhone und Laptop bräuchte es einen Server (z. B. Supabase); die Speicherschicht
in `index.html` (Abschnitt 1) ist so gebaut, dass dafür nur `save()` und
`loadState()` ausgetauscht werden müssten.

## Anpassen

| Was | Wo |
|---|---|
| Titel in der App | `<h1>` in `index.html` |
| Name unterm iPhone-Symbol | `apple-mobile-web-app-title` und `short_name` im Manifest |
| Farben | `tailwind.config` in `index.html`, Abschnitt `colors` |
| Feier-Sprüche | `CELEBRATIONS` im Skript, Abschnitt 7 |

Nach jeder Änderung in `sw.js` die `CACHE_VERSION` hochzählen, sonst hält die
installierte App die alte Fassung fest.
