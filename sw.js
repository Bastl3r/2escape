/*
 * 2Escape service worker.
 *
 * The app is a single HTML file plus icons, so the shell is small: cache it on
 * install, keep it fresh on navigation, and cache the two remaining third-party
 * requests (PeerJS + Google Fonts) at runtime so an installed copy starts offline.
 *
 * Bump CACHE_VERSION whenever index.html or the icons change, so clients do not
 * keep serving a stale shell.
 */
const CACHE_VERSION = 'v1';
const SHELL_CACHE = `2escape-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `2escape-runtime-${CACHE_VERSION}`;

const SHELL_ASSETS = [
    './',
    './index.html',
    './offline.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/maskable-512.png',
    './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys
                .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
                .map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (!url.protocol.startsWith('http')) return;

    // Navigations: network first, so a new deploy is picked up; fall back to the
    // cached shell on network failures and 5xx gateway errors, and finally to the
    // offline notice.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(async (response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(SHELL_CACHE)
                            .then((cache) => cache.put('./index.html', copy))
                            .catch(() => { });
                        return response;
                    }
                    if (response.status >= 500) {
                        return (await caches.match('./index.html')) || response;
                    }
                    return response;
                })
                .catch(async () => (await caches.match('./index.html'))
                    || (await caches.match('./offline.html'))
                    || Response.error())
        );
        return;
    }

    // Same-origin assets (icons, manifest, offline page): cache first, refresh behind the scenes.
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(request).then((cached) => {
                const network = fetch(request)
                    .then((response) => {
                        if (response.ok) {
                            const copy = response.clone();
                            caches.open(SHELL_CACHE)
                                .then((cache) => cache.put(request, copy))
                                .catch(() => { });
                        }
                        return response;
                    })
                    .catch(() => cached);
                return cached || network;
            })
        );
        return;
    }

    // Third-party libraries and fonts: stale-while-revalidate. First online visit
    // populates the cache, later visits start without a network round trip.
    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request)
                .then((response) => {
                    if (response.ok || response.type === 'opaque') {
                        const copy = response.clone();
                        caches.open(RUNTIME_CACHE)
                            .then((cache) => cache.put(request, copy))
                            .catch(() => { });
                    }
                    return response;
                })
                .catch(() => cached);
            return cached || network;
        })
    );
});
