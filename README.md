# Task Tracker

Statische Web-App, installierbar als PWA. Keine Build-Tools, kein Server nötig.
Mehrbenutzerfähig: Wer sich mit seinem Google-Konto anmeldet, bekommt eine
eigene, isolierte Liste – inklusive eigener Push-Erinnerungen. Der Titel der App
richtet sich nach dem Namen im Profil („Leas Task Tracker").

Alle Dateien der Website liegen flach nebeneinander – **keine Unterordner
anlegen.**

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

Dazu kommt ein Ordner, der **nicht** zur Website gehört – er enthält den
Cloudflare Worker, der morgens den Push anstösst:

```
worker/worker.js        Cloudflare Worker: Endpunkte + Cron-Versand
worker/wrangler.toml    Konfiguration
worker/README.md        Schritt-für-Schritt-Anleitung zum Deployen
firestore.rules         Zugriffsregeln der Datenbank (Datenisolation)
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

## Tägliche Erinnerung

Die App schickt morgens eine Benachrichtigung mit der Zahl der offenen
To-dos – auch wenn sie geschlossen ist.

**Wie es zusammenhängt.** GitHub Pages liefert nur Dateien aus und kann
nichts zu einer Uhrzeit auslösen. Den Anstoss gibt deshalb ein **Cloudflare
Worker** (Ordner `worker/`) mit einem Cron-Trigger im kostenlosen Tarif. Der
Worker schickt einen **leeren** Push – ganz ohne Inhalt. Den Text baut der
Service Worker auf dem iPhone selbst, denn nur er kommt an die IndexedDB und
weiss, wie viele Tasks offen sind. Der Server erfährt nichts über deine Daten.

Die App meldet ihr Push-Abo samt gewünschter **Uhrzeit und Zeitzone**
automatisch beim Worker an; der speichert beides in Cloudflare Workers KV. Der
Cron-Lauf rechnet die Uhrzeit gegen deine Zeitzone und sendet, wenn es so weit
ist – Zeitumstellung inklusive.

### Server einrichten (einmalig)

Die vollständige Schritt-für-Schritt-Anleitung mit allen Befehlen steht in
**[`worker/README.md`](worker/README.md)**: Cloudflare-Konto anlegen, `wrangler`
installieren, KV-Namespace erstellen, privaten VAPID-Schlüssel als Secret
setzen, deployen und zum Schluss die Worker-Adresse als `WORKER_URL` in
`index.html` eintragen.

### Bedienung in der App (Zahnrad ⚙️ oben rechts)

- **Morgens erinnern:** Schalter ein/aus. Beim Einschalten fragt iOS nach der
  Erlaubnis (nur nach echtem Tippen), danach meldet sich das Gerät automatisch
  beim Worker an. Aus = kein täglicher Push.
- **Uhrzeit:** frei wählbar. Änderungen werden sofort gespeichert und an den
  Worker geschickt.
- **Test-Benachrichtigung senden:** löst sofort einen Push aus, um die ganze
  Kette zu prüfen.
- **Google-Konto:** mit Google anmelden, um die Aufgaben geräteübergreifend zu
  synchronisieren (siehe Abschnitt „Synchronisation zwischen Geräten"). Ohne
  Anmeldung läuft alles wie gehabt nur lokal.

Alle Einstellungen bleiben auch nach dem Neuladen erhalten.

> **Wichtig:** iOS erlaubt Web-Benachrichtigungen nur, wenn die App über
> *Teilen → Zum Home-Bildschirm* installiert und von dort geöffnet wurde –
> nicht im normalen Safari-Tab.

### Betrieb

Der Cron-Trigger läuft alle 15 Minuten (in UTC) und prüft für jedes Gerät, ob
in dessen Zeitzone gerade die Wunschzeit erreicht ist. Ein „heute schon
gesendet"-Merker sorgt dafür, dass es pro Tag genau eine Meldung gibt, auch
wenn ein Lauf mal verspätet kommt.

**Wenn das Abo abläuft** (App monatelang nicht geöffnet oder neu installiert),
antwortet der Push-Dienst mit HTTP 404/410. Der Worker löscht das tote Abo
dann selbst aus KV. Abhilfe auf dem iPhone: im Zahnrad-Menü die Erinnerung
aus- und wieder einschalten – das legt ein frisches Abo an.

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

Die Daten liegen auf dem jeweiligen Gerät. Für die Synchronisation zwischen
iPhone und Laptop meldet man sich mit Google an (siehe unten) – dann spiegelt
die App den Stand zusätzlich in Cloud Firestore. Lokal-zuerst bleibt bestehen:
IndexedDB/localStorage werden weiter gepflegt, damit die Benachrichtigungen die
richtige Zahl offener To-dos anzeigen.

## Synchronisation zwischen Geräten (Google-Login + Firebase)

Optional. Ohne Anmeldung funktioniert die App unverändert nur lokal und offline.

**Wie es funktioniert.** Im Zahnrad-Menü meldet man sich mit Google an
(Firebase Authentication). Danach spiegelt die App die Aufgaben in ein privates
Dokument in **Cloud Firestore** (`users/<deine-uid>`). Änderungen auf einem
Gerät erscheinen dank Live-Verbindung schnell auf dem anderen. Kommt eine
Änderung aus der Cloud, wird sie auch wieder lokal gespeichert – so bleiben die
Benachrichtigungen korrekt. Beim ersten Anmelden werden vorhandene lokale
Aufgaben mit der Cloud **zusammengeführt** (nichts wird gelöscht).

Genutzt wird ausschließlich der kostenlose **Spark-Tarif** (Auth + Firestore),
keine Cloud Functions, kein Cloud Storage.

**Login im installierten iOS-Modus.** Verwendet wird der **Redirect-Flow**
(nicht Popup), weil Popups in der Home-Bildschirm-App von iOS meist blockiert
sind. Am zuverlässigsten testet man zuerst im normalen Safari. Falls die
Anmeldung in der installierten PWA im Einzelfall hakt (WebKit trennt
Cookies/Speicher strenger), hilft es, sich einmal im normalen Safari mit
derselben Adresse anzumelden.

**Sicherheit.** Firestore-Regeln erlauben jedem Nutzer nur Zugriff auf sein
eigenes Dokument (`request.auth.uid == userId`). Der öffentliche `apiKey` in der
Web-Config ist kein Geheimnis; der Schutz kommt über diese Regeln.

**Einrichtung in der Firebase-Konsole (einmalig):** Projekt anlegen → Web-App
hinzufügen und `firebaseConfig` in den `<script type="module">`-Block unten in
`index.html` eintragen → Authentication mit Google-Anbieter aktivieren →
Firestore-Datenbank in einer EU-Region anlegen → unter Authentication →
Settings → Authorized domains die GitHub-Pages-Adresse
(`zyklustracker-a11y.github.io`) hinzufügen.

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
