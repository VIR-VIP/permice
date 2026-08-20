/**
 * sw.js — service worker. Díky němu appka naběhne i bez signálu.
 *
 * Statické soubory: cache-first (appka se nemění během zápasu).
 * Volání na Apps Script: nikdy se necachují — jdou přes síť, nebo se vstup
 * uloží do fronty v app.js.
 *
 * Po každé změně souborů ve scanner/ zvyš VERZE — jinak si telefony nechají
 * starou verzi donekonečna.
 */

const VERZE = 'permanentky-v17';

const SOUBORY = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './api.js',
  './store.js',
  './scan.js',
  './verdikt.js',
  './sprava.js',
  './tisk.js',
  './lib/jsQR.js',
  './lib/qrcode.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERZE)
      .then((c) => Promise.all(SOUBORY.map(function (cesta) {
        // `cache: 'reload'` obejde HTTP cache prohlížeče. Bez toho si nová verze
        // klidně uloží staré soubory, které v cache ještě leží, a v telefonu
        // vznikne míchanice půlky staré a půlky nové aplikace.
        return fetch(new Request(cesta, {cache: 'reload'}))
          .then(function (odpoved) {
            if (!odpoved.ok) throw new Error('Nepovedlo se stáhnout ' + cesta);
            return c.put(cesta, odpoved);
          });
      })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((klice) => Promise.all(klice.filter((k) => k !== VERZE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/**
 * Cachují se JEN soubory ze seznamu SOUBORY. Cokoli jiného — hlavně volání API —
 * jde vždy na síť. (V ostrém provozu je API na doméně Googlu, ale při zkoušení
 * proti tools/mock_server.py leží na stejném původu, a jeho odpovědi by se
 * z cache vracely jako zastaralé.)
 */
const CACHOVANE = new Set(SOUBORY.map((s) => new URL(s, self.location).pathname));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.search) return;                       // dotazy s parametry = API
  if (!CACHOVANE.has(url.pathname)) return;

  e.respondWith(
    caches.match(e.request).then((zCache) => {
      if (zCache) {
        // na pozadí si stáhneme čerstvou verzi pro příště
        fetch(e.request)
          .then((r) => r.ok && caches.open(VERZE).then((c) => c.put(e.request, r.clone())))
          .catch(() => {});
        return zCache;
      }

      return fetch(e.request)
        .then((r) => {
          if (r.ok) {
            const kopie = r.clone();
            caches.open(VERZE).then((c) => c.put(e.request, kopie));
          }
          return r;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
