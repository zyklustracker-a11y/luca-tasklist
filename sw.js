/* Service Worker – macht die App offline nutzbar.
   Bei Änderungen an den Dateien: CACHE_VERSION hochzählen. */
const CACHE_VERSION = 'v14';
const CACHE_NAME = 'task-tracker-' + CACHE_VERSION;

const PRECACHE = [
  './',
  './index.html',
  './tailwind.css?v=11',
  './manifest.webmanifest',
  './favicon-32.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('task-tracker-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Notausgang, falls skipWaiting beim Install einmal nicht greift: die Seite
// kann das Übernehmen ausdrücklich anstossen.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* ------------------------------------------------------------------
   Tägliche Erinnerung.

   Der Absender schickt nur einen leeren Anstoss. Den Text bauen wir hier
   selbst, weil die Tasks ausschliesslich auf diesem Gerät liegen – so
   steht die echte Zahl in der Benachrichtigung statt einer Floskel.
   ------------------------------------------------------------------ */
const DB_NAME = 'lucaTasks';
const DB_STORE = 'kv';
const STATE_KEY = 'state';

function readState() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    // Falls der Push kommt, bevor die App je lief, legen wir dieselbe Struktur
    // an wie index.html – sonst fehlt ihr später der Object Store.
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) return done(null);
        const get = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(STATE_KEY);
        get.onsuccess = () => done(get.result || null);
        get.onerror = () => done(null);
      };
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch (err) {
      done(null);
    }
    setTimeout(() => done(null), 3000);
  });
}

function reminderText(state) {
  const open = state && Array.isArray(state.tasks) ? state.tasks.length : null;
  if (open === null) {
    return { title: 'Deine To-dos', body: 'Schau kurz rein, was heute ansteht.' };
  }
  if (open === 0) {
    return { title: 'Nichts offen', body: 'Deine Liste ist leer. Geniess den Tag.' };
  }
  return {
    title: open === 1 ? '1 offenes To-do' : open + ' offene To-dos',
    body: 'Guten Morgen – nicht vergessen!',
  };
}

// Ziel eines Klicks auf die Benachrichtigung. Absolut aufgelöst, damit
// openWindow() auch unter GitHub Pages im Unterordner richtig landet.
const APP_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('push', (event) => {
  event.waitUntil(
    readState().then((state) => {
      const text = reminderText(state);
      return self.registration.showNotification(text.title, {
        body: text.body,
        icon: './icon-192.png',
        badge: './favicon-32.png',
        tag: 'daily-reminder',
        renotify: true,
        data: { url: APP_URL },
      });
    })
  );
});

/* Klick auf die Benachrichtigung: ein bereits offenes Fenster der App in den
   Vordergrund holen und zur Aufgabenliste springen; sonst eines öffnen.
   Wichtig ist der Vergleich der Adresse – sonst würde ein beliebiges Fenster
   derselben Herkunft fokussiert. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || APP_URL;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin !== new URL(target).origin) continue;
        // Die Seite selbst zur Liste scrollen lassen – der Service Worker
        // kennt das DOM nicht.
        client.postMessage({ type: 'SHOW_TASKS' });
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Firebase-Auth und Firestore niemals über den Cache leiten – der Login und
  // die Live-Synchronisation müssen immer direkt ins Netz. (Das Firebase-SDK
  // von www.gstatic.com ist bewusst NICHT ausgenommen, damit es offline aus dem
  // Cache kommt.)
  const apiUrl = new URL(req.url);
  if (/(^|\.)googleapis\.com$/.test(apiUrl.hostname) ||
      apiUrl.hostname === 'apis.google.com' ||
      apiUrl.hostname === 'accounts.google.com' ||
      apiUrl.hostname.endsWith('.firebaseapp.com') ||
      apiUrl.hostname.endsWith('.firebaseio.com')) {
    return; // der Browser holt es selbst
  }

  // HTML immer zuerst aus dem Netz holen, damit Updates sofort ankommen
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Eigene CSS/JS immer zuerst aus dem Netz, damit Style- und Logik-Updates
  // sofort greifen (sonst hält der Cache z. B. eine alte tailwind.css fest).
  // Offline fällt es auf den Cache zurück.
  const url = new URL(req.url);
  if (url.origin === self.location.origin && /\.(css|js)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Alles andere (Icons, Tailwind-CDN, Google Fonts): aus dem Cache,
  // im Hintergrund aktualisieren.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
