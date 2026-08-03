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

## Mehrere Nutzer

Die Adresse der App kann man weitergeben. Wer sie öffnet und sich anmeldet,
bekommt eine **eigene, isolierte Liste** und eigene Erinnerungen. Ohne
Anmeldung läuft die App wie bisher rein lokal auf dem Gerät.

Es gibt zwei gleichwertige Wege, beide im Zahnrad-Menü unter *Konto*:

- **Mit Google** – ein Tipp, kein Passwort.
- **Mit E-Mail und Passwort** – für alle ohne Google-Konto. Registrieren,
  anmelden und Passwort zurücksetzen laufen direkt in der App.

Technisch macht das keinen Unterschied: Firebase stellt in beiden Fällen
dasselbe ID-Token aus, an dem Datenbank und Push-Worker das Konto erkennen.
Beide Methoden müssen in der Firebase-Konsole unter **Authentication →
Sign-in method** aktiviert sein.

**Wie die Trennung durchgesetzt wird.** Nicht im Frontend, sondern an zwei
Stellen serverseitig:

- **Datenbank:** Die Firestore-Regeln in [`firestore.rules`](firestore.rules)
  erlauben jedem Konto ausschliesslich `users/<uid>` und `profiles/<uid>`,
  alles andere ist gesperrt. Die Prüfung läuft bei Google – ein manipuliertes
  Frontend oder ein direkter API-Aufruf kommt trotzdem nicht an fremde Daten.
- **Push-Worker:** Jeder Aufruf verlangt ein Firebase-ID-Token. Der Worker
  prüft dessen Signatur selbst und nimmt die Benutzerkennung **aus dem Token**,
  nie aus der Anfrage. Fremde Abos sind damit technisch nicht erreichbar.

Der **Name** kommt aus dem Profil des Kontos (`profiles/<uid>`) und erscheint
im Titel, im `document.title` und in der Begrüßung: „Leas Task Tracker“.
Namen auf s/ß/x/z bekommen nach deutscher Regel nur ein Apostroph
(„Lukas’ Task Tracker“). Ohne Namen heisst die App schlicht „Task Tracker“.

> Das **PWA-Manifest** bleibt bewusst neutral („Task Tracker“). Es wird beim
> Installieren einmal gelesen und ist danach geräteweit fest – ein
> personalisierter Wert wäre für alle gleich und liesse sich später nicht mehr
> ändern. Dasselbe gilt für `apple-mobile-web-app-title` („Tasks“), den Namen
> unter dem iPhone-Symbol.

## Tägliche Erinnerung

Die App schickt morgens eine Benachrichtigung mit der Zahl der offenen
To-dos – auch wenn sie geschlossen ist. Pro Nutzer, auf allen seinen Geräten.

**Wie es zusammenhängt.** GitHub Pages liefert nur Dateien aus und kann
nichts zu einer Uhrzeit auslösen. Den Anstoss gibt deshalb ein **Cloudflare
Worker** (Ordner `worker/`) mit einem Cron-Trigger im kostenlosen Tarif. Der
Worker schickt einen **leeren** Push – ganz ohne Inhalt. Den Text baut der
Service Worker auf dem Gerät selbst, denn nur er kommt an die IndexedDB und
weiss, wie viele Tasks offen sind. Der Server erfährt nichts über die Aufgaben.

Die App meldet ihr Push-Abo samt gewünschter **Uhrzeit und Zeitzone**
automatisch beim Worker an; der speichert beides in Cloudflare Workers KV –
ein Eintrag pro Gerät, beliebig viele Geräte pro Nutzer. Der Cron-Lauf geht
alle 15 Minuten **alle Nutzer** durch, rechnet deren Uhrzeit gegen deren
Zeitzone und sendet, wenn es so weit ist – Zeitumstellung inklusive. Ein
Fehler bei einem Nutzer bricht den Lauf für die anderen nicht ab, und Abos,
die mit 404/410 antworten, fliegen aus der Datenbank.

Die Uhrzeit steht im **Profil des Kontos**, nicht am Gerät – stellt man sie am
Laptop um, gilt sie auch am iPhone.

### Der Weg zur ersten Benachrichtigung

Es wird **nicht** ungefragt beim Seitenaufruf nach Erlaubnis gefragt. Auf der
Startseite steht stattdessen eine Karte mit einem sichtbaren Knopf
**„Benachrichtigungen aktivieren“**. Sie zeigt jeweils genau den Zustand an,
in dem man gerade steckt: nicht angemeldet, vom Browser blockiert (samt
Anleitung, wie man das zurücksetzt), ausgeschaltet – oder sie verschwindet,
weil alles läuft.

**Auf dem iPhone** braucht es zwei Dinge: mindestens **iOS 16.4** und die App
muss über *Teilen → Zum Home-Bildschirm* installiert und **von dort geöffnet**
worden sein. Im normalen Safari-Tab erlaubt Apple keinen Web-Push. Erkennt die
App diesen Fall, zeigt sie an Stelle des Knopfes eine nummerierte
Schritt-für-Schritt-Anleitung.

### Server einrichten (einmalig)

Die vollständige Schritt-für-Schritt-Anleitung mit allen Befehlen steht in
**[`worker/README.md`](worker/README.md)**: Cloudflare-Konto anlegen, `wrangler`
installieren, KV-Namespace erstellen, privaten VAPID-Schlüssel als Secret
setzen, deployen und zum Schluss die Worker-Adresse als `WORKER_URL` in
`index.html` eintragen.

## Variablen und Secrets

Der **private** VAPID-Schlüssel verlässt den Server nie – er liegt als
Cloudflare-Secret, nicht im Repository. Der öffentliche Schlüssel und die
Firebase-Web-Config sind bewusst kein Geheimnis: Sie stehen im ausgelieferten
HTML und sind für jeden lesbar. Geschützt wird nicht durch Verstecken, sondern
durch die Firestore-Regeln und die Token-Prüfung im Worker.

**Cloudflare-Secret** (`wrangler secret put …`, nie committen):

| Name | Wert |
|---|---|
| `VAPID_PRIVATE_KEY` | privater VAPID-Schlüssel (`npx web-push generate-vapid-keys`) |

**Cloudflare-Variablen** (`worker/wrangler.toml`, `[vars]`):

| Name | Wert |
|---|---|
| `VAPID_PUBLIC_KEY` | öffentlicher VAPID-Schlüssel, identisch zu dem in `index.html` |
| `VAPID_SUBJECT` | `mailto:` oder `https:` als Absender-Kennung (RFC 8292) |
| `FIREBASE_PROJECT_ID` | `projectId` aus `firebaseConfig` – daran erkennt der Worker gültige Anmeldungen |
| `ALLOWED_ORIGIN` | optional: nur Anfragen von dieser Adresse zulassen |

**GitHub-Repository-Secrets** (nur für den Deploy-Workflow unter *Actions*):

| Name | Wert |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token mit *Workers Scripts Edit* + *Workers KV Storage Edit* |
| `VAPID_PRIVATE_KEY` | derselbe private Schlüssel wie oben |

**Im Code eingetragen** (`index.html`, öffentlich und unkritisch):
`WORKER_URL`, `VAPID_PUBLIC_KEY`, `firebaseConfig`.

## Inbetriebnahme und Migration

Bestehende Daten bleiben unangetastet – es gibt nichts umzuschreiben und
nichts zu löschen.

1. **Firestore-Regeln veröffentlichen.** Firebase-Konsole → *Firestore
   Database* → *Regeln* → Inhalt von [`firestore.rules`](firestore.rules)
   einfügen → *Veröffentlichen*. **Ohne diesen Schritt ist die Trennung nicht
   durchgesetzt.**
2. **Worker deployen.** Reiter *Actions* → „Worker deployen" → *Run workflow*.
   Oder im Ordner `worker/`: `wrangler deploy`.
3. **App ausrollen.** Push auf `main` genügt, GitHub Pages liefert die neue
   Fassung aus. Der Service Worker holt sie beim nächsten Öffnen selbst und
   lädt die Seite einmal neu.
4. **Erinnerung einmal aus- und wieder einschalten** (Zahnrad → *Morgens
   erinnern*). Damit wandert das Abo dieses Geräts vom alten geräte- auf den
   neuen kontogebundenen Eintrag.

**Was mit den alten Daten passiert:**

- *Aufgaben und Verlauf* lagen schon immer unter `users/<uid>` – also bereits
  deinem Konto zugeordnet. Nichts zu tun.
- *Push-Abos* lagen unter `sub:<geräte-uuid>` ohne Nutzerbezug. Diese Einträge
  werden vom Cron **weiter beliefert**, damit die Erinnerung nicht abreisst.
  Sobald sich dasselbe Gerät angemeldet neu registriert (Schritt 4), löscht der
  Worker den alten Eintrag selbst. Doppelte Meldungen kann es dadurch nicht
  geben.
- *Die Wunschuhrzeit* lag lokal auf dem Gerät und wandert beim ersten
  Speichern ins Profil.

## Manuelle Testcheckliste

**Datenisolation**

- [ ] Mit deinem Konto anmelden, Tasks anlegen und abhaken.
- [ ] Zweites Google-Konto (anderer Browser oder privates Fenster): anmelden →
      die Liste ist **leer**, nicht deine.
- [ ] Im zweiten Konto Tasks anlegen → im ersten Konto neu laden: davon ist
      **nichts** zu sehen.
- [ ] Abmelden und wieder anmelden → die eigenen Tasks sind vollständig da.
- [ ] Auf demselben Gerät Konto A abmelden, Konto B anmelden → Titel und Liste
      wechseln, kein Rest von A bleibt stehen.

**Name**

- [ ] Erster Login mit einem neuen Konto → Onboarding-Dialog erscheint,
      vorbefüllt mit dem Vornamen aus dem Google-Konto.
- [ ] Namen überschreiben → Titel, Browser-Tab und Begrüßung ziehen mit.
- [ ] Name auf s/ß/x/z enden lassen (z. B. „Lukas") → „Lukas’ Task Tracker".
- [ ] In den Einstellungen umbenennen → wirkt sofort, auch nach Neuladen.
- [ ] Namen leeren → Titel fällt auf „Task Tracker" zurück.

**iPhone**

- [ ] Adresse in Safari öffnen (nicht installiert) → Karte zeigt die
      Schritt-für-Schritt-Anleitung, keinen Aktivieren-Knopf.
- [ ] *Teilen → Zum Home-Bildschirm*, App **von dort** öffnen → Karte zeigt
      jetzt „Benachrichtigungen aktivieren".
- [ ] Antippen → iOS fragt nach Erlaubnis → erlauben.
- [ ] Zahnrad → *Test-Benachrichtigung senden* → Meldung kommt an.
- [ ] Auf die Meldung tippen → App öffnet sich bzw. kommt nach vorn und zeigt
      die Liste.
- [ ] Erlaubnis in *Einstellungen → Mitteilungen* entziehen → die App sagt
      „vom Browser blockiert" und erklärt, wie man es zurücksetzt.

**Push über mehrere Nutzer und Geräte**

- [ ] Dasselbe Konto auf einem zweiten Gerät aktivieren → in den Einstellungen
      steht „Aktiv auf 2 Geräten".
- [ ] Test-Benachrichtigung → kommt auf dem Gerät an, an dem du sie auslöst.
- [ ] Zweites Konto ebenfalls aktivieren, Uhrzeit beider Konten auf die
      nächsten Minuten stellen → beide bekommen ihre Meldung, jeder mit
      **seiner** Zahl offener To-dos.
- [ ] `wrangler tail` mitlaufen lassen → pro Versand steht eine Zeile im Log.
- [ ] Uhrzeit am Laptop ändern → am zweiten Gerät nach dem Neuladen ebenfalls
      geändert (sie hängt am Konto, nicht am Gerät).

**Bestandsschutz**

- [ ] Nach dem Ausrollen: deine bisherigen Tasks, dein Verlauf und dein
      Streak-Rekord sind unverändert da.
- [ ] *Backup speichern* → Datei enthält alles; *Backup laden* stellt es wieder
      her.

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

**Was wo liegt.** Zwei Dokumente pro Konto:

| Dokument | Inhalt |
|---|---|
| `users/<uid>` | `tasks[]`, `journal[]`, `history{}`, `bestStreak` |
| `profiles/<uid>` | `displayName`, `notifyHour`, `notifyMinute`, `tz`, `updatedAt` |

Bewusst getrennt: Der Aufgaben-Sync schreibt `users/<uid>` mit `setDoc()`
komplett neu und würde ein dort mitgeführtes Profil bei jeder Änderung
überbügeln.

**Sicherheit.** Die Regeln in [`firestore.rules`](firestore.rules) erlauben
jedem Konto nur seine beiden eigenen Dokumente (`request.auth.uid == uid`),
alles andere ist gesperrt. Geprüft wird bei Google, nicht im Browser. Der
öffentliche `apiKey` in der Web-Config ist kein Geheimnis; der Schutz kommt
über diese Regeln.

**Einrichtung in der Firebase-Konsole (einmalig):** Projekt anlegen → Web-App
hinzufügen und `firebaseConfig` in den Modul-Skript-Block unten in
`index.html` eintragen → Authentication mit Google-Anbieter aktivieren →
Firestore-Datenbank in einer EU-Region anlegen → **Regeln aus
`firestore.rules` veröffentlichen** → unter Authentication → Settings →
Authorized domains die GitHub-Pages-Adresse
(`zyklustracker-a11y.github.io`) hinzufügen.

Ältere Stände werden beim Laden automatisch migriert: Aus dem früheren Typ
„jeden Tag" werden normale Tasks, und was zu dem Zeitpunkt abgehakt war,
wandert in den Verlauf. Das gilt auch für alte Backup-Dateien, die du über
*Backup laden* zurückspielst.

## Anpassen

| Was | Wo |
|---|---|
| Titel in der App | kommt aus dem Profil – in den Einstellungen änderbar |
| Genitiv-Regel („Lukas’" vs. „Lea’s") | `possessive()` im Skript, Abschnitt 5 |
| Titel ohne Namen | `trackerTitle()` im Skript, Abschnitt 5 |
| Name unterm iPhone-Symbol | `apple-mobile-web-app-title` und `short_name` im Manifest (bewusst neutral) |
| iPhone-Anleitung | `IOS_STEPS` im Skript, Abschnitt 13 |
| Farben | `tools/tailwind.config.js`, Abschnitt `colors` |
| Feier-Sprüche | `CELEBRATIONS` im Skript, Abschnitt 7 |

Willst du statt der Rechtschreib-Regel überall die Apostroph-Form („Lea’s Task
Tracker", „Lukas’ Task Tracker"), reicht in `possessive()` eine Zeile: aus
`clean + 's'` wird `clean + '’s'`.

### Namen, die absichtlich stehen bleiben

Ein paar Bezeichner tragen noch den ursprünglichen Projektnamen. Sie sind
Infrastruktur, nicht Beschriftung – ein Umbenennen hätte Folgen und keinen
Nutzen:

| Wo | Warum es bleibt |
|---|---|
| `lucaTasks`, `lucaTasks.v3`, `lucaHabitTracker` in `index.html`/`sw.js` | Schlüssel von IndexedDB und localStorage. Umbenennen = alle Geräte finden ihre lokalen Daten nicht mehr. |
| `luca-tasklist-push` in `wrangler.toml` | Name des Workers und damit Teil seiner Adresse. Umbenennen = `WORKER_URL` wird ungültig. |
| `luca-tasklist` als `FIREBASE_PROJECT_ID` / `projectId` | Kennung des Firebase-Projekts, von Google vergeben. |
| `VAPID_SUBJECT` | Kontaktadresse des Betreibers, die Push-Dienste laut RFC 8292 verlangen. Steht als Konfigurationsvariable, nicht im Code. |

Nirgends davon steht ein Name in der Oberfläche – dort kommt er
ausschliesslich aus dem Profil des angemeldeten Kontos.

Nach jeder Änderung in `sw.js` die `CACHE_VERSION` hochzählen, sonst hält die
installierte App die alte Fassung fest.

### Achtung bei neuen Tailwind-Klassen

`tailwind.css` ist **vorkompiliert** und enthält nur die Klassen, die beim
letzten Build im HTML standen. Schreibt man später eine neue Klasse ins Markup –
besonders eine mit freiem Wert wie `z-[120]` oder `min-h-[1.25rem]` –, fehlt sie
in der fertigen Datei. Es gibt keine Fehlermeldung: die Klasse tut schlicht
nichts. Genau so blieb einmal eine Bestätigungsmeldung hinter einem Dialog
unsichtbar.

Deshalb nach Änderungen am Markup:

```bash
node tools/check-classes.js
```

Meldet es etwas, das Stylesheet neu erzeugen und den Cache-Buster `?v=N` in
`index.html` und `sw.js` hochzählen:

```bash
npx tailwindcss@3 -c tools/tailwind.config.js -i tools/input.css -o tailwind.css --minify
```
