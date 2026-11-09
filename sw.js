'use strict';
// 온라인이면 새 파일을, 오프라인이면 마지막으로 받아 둔 파일을 쓴다
const CACHE = 'othello-score-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'othello.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html'))));
});
