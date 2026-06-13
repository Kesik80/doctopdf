// sw.js — минимальный Service Worker
// Файл нужен чтобы браузер разрешил установку PWA

const CACHE = 'pwa-cache-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  clients.claim();
});

// Проксируем запросы (сеть сначала, потом кэш)
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});