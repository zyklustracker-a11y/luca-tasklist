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

Dazu kommen zwei Dateien, die **nicht** zur Website gehören und von GitHub
Pages ignoriert werden – sie steuern nur die tägliche Erinnerung:

```
.github/workflows/daily-reminder.yml   Zeitplan, der morgens anstösst
scripts/send-reminder.mjs              Absender, ohne Fremdbibliotheken
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

## Tägliche Erinnerung um 9 Uhr

Die App schickt morgens eine Benachrichtigung mit der Zahl der offenen
To-dos – auch wenn sie geschlossen ist.

**Wie es zusammenhängt.** GitHub Pages liefert nur Dateien aus und kann
nichts zu einer Uhrzeit auslösen. Den Anstoss gibt deshalb ein Zeitplan
unter GitHub Actions (`.github/workflows/daily-reminder.yml`), der
`scripts/send-reminder.mjs` startet. Das Skript schickt einen **leeren**
Push – ganz ohne Inhalt. Den Text baut der Service Worker auf dem iPhone
selbst, denn nur er kommt an die IndexedDB und weiss, wie viele Tasks offen
sind. Der Absender erfährt nichts über deine Daten.

### Einrichtung, einmalig

1. **App vom Home-Bildschirm öffnen.** iOS erlaubt Web-Benachrichtigungen
   ausschliesslich installierten Web-Apps, nicht im Safari-Tab.
2. Unten bei **Morgens erinnern** auf **Erinnerung aktivieren** tippen und
   die Rückfrage von iOS erlauben.
3. Auf **Abo-Code kopieren** tippen.
4. Im Repository unter *Settings → Secrets and variables → Actions* zwei
   Secrets anlegen:
   - `PUSH_SUBSCRIPTION` – der eben kopierte Abo-Code
   - `VAPID_PRIVATE_KEY` – der private Schlüssel zum öffentlichen, der in
     `index.html` und `scripts/send-reminder.mjs` steht
5. Zum Testen unter *Actions → Tägliche Erinnerung → Run workflow* sofort
   auslösen, statt bis morgen früh zu warten.

### Betrieb

Der Zeitplan läuft um 07:00 und 08:00 UTC. Das Skript sendet nur bei dem
Lauf, bei dem es in `Europe/Zurich` gerade 9 Uhr ist – so stimmt die Zeit
auch nach der Zeitumstellung, ohne dass etwas angepasst werden muss.

Zwei Dinge können den Betrieb stoppen:

- **Das Abo läuft ab.** Wird die App monatelang nicht geöffnet oder neu
  installiert, verwirft Apple das Abo. Der Lauf schlägt dann mit HTTP 410
  fehl. Abhilfe: App öffnen, Erinnerung erneut aktivieren, das Secret
  `PUSH_SUBSCRIPTION` durch den neuen Code ersetzen.
- **GitHub schaltet den Zeitplan ab**, wenn 60 Tage lang niemand etwas ins
  Repository schiebt. Ein beliebiger Commit reicht, um ihn zu reaktivieren.

Ausserdem feuert der Zeitplan bei GitHub oft 5 bis 30 Minuten später als
eingetragen. Die Meldung kommt also nicht auf die Minute genau.

## Wie die Tage funktionieren

Es gibt nur eine Art von Task. Sie bleibt stehen, bis du sie abhakst – über
Tage und Wochen hinweg.

- **Offene Tasks** werden beim Tageswechsel nie zurückgesetzt und nie
  gelöscht. Ab dem zweiten Tag tragen sie ein „seit X Tagen"-Label.
- **Abgehakte Tasks** verlassen die Liste sofort: kurze Bestätigung, dann
  wandern sie in den Verlauf und bleiben dort dauerhaft. Unmittelbar danach
  kannst du das über den Toast rückgängig machen.
- Der Tageswechsel passiert automatisch um Mitternacht, auch wenn die App
  offen liegt. Gelöscht wird dabei nichts.
- Die Konfetti-Animation kommt, wenn die letzte offene Task abgehakt ist und
  die Liste leer wird. Neue Task hinzufügen und abhaken → neue Animation.

## Fortschritt und Streak

- **Fortschritt** zeigt das Tagespensum: `3/7` heisst drei heute erledigt,
  vier noch offen. Der Balken zeigt denselben Anteil.
- **Der Streak** zählt aufeinanderfolgende Tage mit mindestens einer
  erledigten Task. Heute zählt mit, sobald du etwas abhakst – bis dahin hält
  der gestrige Stand, damit er nicht um Mitternacht abreisst.

Beide Werte werden bei jedem Rendern frisch aus dem Verlauf berechnet und
nirgends fortgeschrieben. Dadurch heilen sie sich selbst, falls ein Gerät mal
tagelang nicht geöffnet wurde.

## Wo die Daten liegen

Primär in **IndexedDB**, zusätzlich gespiegelt in `localStorage`. Fällt eines
aus, übernimmt das andere. Über *Backup speichern* bekommst du eine JSON-Datei,
*Backup laden* spielt sie zurück.

Die Daten liegen auf dem jeweiligen Gerät. Für echte Synchronisation zwischen
iPhone und Laptop bräuchte es einen Server (z. B. Supabase); die Speicherschicht
in `index.html` (Abschnitt 1) ist so gebaut, dass dafür nur `save()` und
`loadState()` ausgetauscht werden müssten.

Ältere Stände werden beim Laden automatisch migriert: Aus dem früheren Typ
„jeden Tag" werden normale Tasks, und was zu dem Zeitpunkt abgehakt war,
wandert in den Verlauf. Das gilt auch für alte Backup-Dateien, die du über
*Backup laden* zurückspielst.

## Anpassen

| Was | Wo |
|---|---|
| Titel in der App | `<h1>` in `index.html` |
| Name unterm iPhone-Symbol | `apple-mobile-web-app-title` und `short_name` im Manifest |
| Farben | `tailwind.config` in `index.html`, Abschnitt `colors` |
| Feier-Sprüche | `CELEBRATIONS` im Skript, Abschnitt 7 |

Nach jeder Änderung in `sw.js` die `CACHE_VERSION` hochzählen, sonst hält die
installierte App die alte Fassung fest.
