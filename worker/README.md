# Push-Worker (Cloudflare)

Dieser Ordner gehört **nicht** zur Website. Er enthält den Cloudflare Worker,
der morgens den leeren Push-Anstoss verschickt – die Aufgabe, die GitHub Pages
selbst nicht kann.

```
worker/worker.js       Der Worker: HTTP-Endpunkte + Cron-Versand
worker/wrangler.toml    Konfiguration (Name, KV, Cron, VAPID-Public-Key)
```

Alles läuft im **kostenlosen** Cloudflare-Tarif (Workers + KV + Cron Triggers).

---

## Einmalige Einrichtung

Du brauchst **Node.js** auf dem Rechner (nicht am iPhone). Alle Befehle im
Terminal, im Ordner `worker/`.

### 1. Cloudflare-Konto anlegen

Auf <https://dash.cloudflare.com/sign-up> ein kostenloses Konto erstellen.
Keine Kreditkarte nötig.

### 2. Wrangler installieren und anmelden

`wrangler` ist Cloudflares Kommandozeilen-Werkzeug.

```bash
npm install -g wrangler
wrangler login
```

`wrangler login` öffnet den Browser – dort einmal „Allow" klicken.

### 3. VAPID-Schlüssel

Wir verwenden **denselben** Schlüssel, der schon in der App steckt.

- **Öffentlicher Schlüssel:** steht bereits in `wrangler.toml` (`VAPID_PUBLIC_KEY`)
  und in `index.html`. Nichts zu tun.
- **Privater Schlüssel:** den hast du schon – es ist der Wert, den du bei GitHub
  als Secret `VAPID_PRIVATE_KEY` hinterlegt hattest. Den setzen wir gleich in
  Schritt 5 bei Cloudflare.

> Falls du ihn nicht mehr hast oder lieber ein frisches Paar willst:
> ```bash
> npx web-push generate-vapid-keys
> ```
> Dann den neuen **Public Key** in `wrangler.toml` **und** in `index.html`
> (Konstante `VAPID_PUBLIC_KEY`) eintragen und in der App die Erinnerung neu
> aktivieren. Sonst passt das alte Abo nicht mehr zum neuen Schlüssel.

### 4. KV-Namespace

Hier speichert der Worker deine Abos und Einstellungen. Dein bestehender
Namespace ist bereits in `wrangler.toml` eingetragen
(`id = "dfbab15d410c46978b67765115a509fc"`), ebenso deine Account-ID. **Hier
ist also nichts zu tun.**

> Falls du doch einen neuen anlegen willst:
> ```bash
> wrangler kv namespace create SUBS
> ```
> Die ausgegebene `id = "..."` dann in `wrangler.toml` bei `[[kv_namespaces]]`
> eintragen.

### 5. Privaten VAPID-Schlüssel als Secret setzen

```bash
wrangler secret put VAPID_PRIVATE_KEY
```

Der Befehl fragt nach dem Wert – dort den privaten Schlüssel einfügen und
Enter drücken. Er landet verschlüsselt bei Cloudflare, nicht im Code.

### 6. Deployen

```bash
wrangler deploy
```

Am Ende zeigt die Ausgabe die Adresse des Workers, etwa:

```
https://luca-tasklist-push.DEINNAME.workers.dev
```

**Diese Adresse kopieren.**

### 7. Adresse in die App eintragen

In `index.html` die Konstante `WORKER_URL` (ganz oben im Erinnerungs-Abschnitt)
auf genau diese Adresse setzen – **ohne** Schrägstrich am Ende:

```js
const WORKER_URL = 'https://luca-tasklist-push.DEINNAME.workers.dev';
```

Ändern committen und pushen, damit GitHub Pages die neue Fassung ausliefert.

Fertig. Ab jetzt meldet sich die App beim Aktivieren automatisch beim Worker an
– kein Copy-Paste von Codes mehr.

---

## Prüfen, ob es läuft

- Adresse im Browser öffnen → es sollte „Luca Tasklist Push Worker läuft."
  erscheinen.
- Live-Protokoll während eines Tests ansehen:
  ```bash
  wrangler tail
  ```
- Cron-Läufe und Fehler stehen im Cloudflare-Dashboard unter
  **Workers & Pages → luca-tasklist-push → Logs** bzw. **Triggers**.

## Später etwas ändern

- **Worker-Code angepasst?** Erneut `wrangler deploy`.
- **Uhrzeit / an-aus:** macht die App selbst, kein Deploy nötig.
- **Cron-Takt ändern** (z. B. auf stündlich): in `wrangler.toml` unter
  `[triggers]` `crons` anpassen, dann `wrangler deploy`.

## Was der Worker mit ungültigen Abos macht

Antwortet ein Push-Dienst mit **HTTP 404 oder 410**, ist das Abo tot (App neu
installiert oder monatelang nicht geöffnet). Der Worker löscht es dann selbst
aus KV. Auf dem iPhone einfach die Erinnerung in den Einstellungen aus- und
wieder einschalten – das legt ein frisches Abo an.
