/* Bump VERSION whenever a deployed app, catalog, font, icon, or PDF changes. */
const VERSION = 'a23ff0155f5aa1d7';
const BASE = new URL('./', self.location.href);
const CACHE_PREFIX = `songhub:${encodeURIComponent(BASE.href)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const REQUIRED_ASSETS = [
  'index.html',
  'styles.css',
  'app.js',
  'search-core.js',
  'search-worker.js',
  'data/songs.json',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'fonts/instrument-sans.ttf',
  'downloads/SongHub-Songbook.pdf',
].map((path) => new URL(path, BASE).href);
const INDEX_URL = new URL('index.html', BASE).href;
const PDF_URL = new URL('downloads/SongHub-Songbook.pdf', BASE).href;

async function prepareOffline() {
  const cache = await caches.open(CACHE_NAME);
  // addAll commits the group together; a failed download never declares it ready.
  await cache.addAll(REQUIRED_ASSETS.map((url) => new Request(url, { cache: 'reload' })));
}

async function offlineStatus() {
  const cache = await caches.open(CACHE_NAME);
  const assets = await Promise.all(REQUIRED_ASSETS.map((url) => cache.match(url)));
  return { ready: assets.every((response) => response?.ok), version: VERSION };
}

async function notifyReady() {
  const status = await offlineStatus();
  if (!status.ready) return;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    if (client.url.startsWith(BASE.href)) {
      client.postMessage({ type: 'OFFLINE_READY', ...status });
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(prepareOffline());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
    await notifyReady();
  })());
});

self.addEventListener('message', (event) => {
  if (event.source?.url && !event.source.url.startsWith(BASE.href)) return;
  const type = event.data?.type;
  if (type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  } else if (type === 'GET_OFFLINE_STATUS') {
    event.waitUntil(offlineStatus()
      .then((status) => event.ports[0]?.postMessage(status))
      .catch(() => event.ports[0]?.postMessage({ ready: false, version: VERSION })));
  } else if (type === 'RETRY_OFFLINE_PREPARATION') {
    event.waitUntil((async () => {
      try {
        await prepareOffline();
        const status = await offlineStatus();
        event.ports[0]?.postMessage(status);
        await notifyReady();
      } catch {
        event.ports[0]?.postMessage({ ready: false, version: VERSION });
      }
    })());
  }
});

async function pdfRange(response, rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  // Servers may ignore unsupported multi-range requests and return the full file.
  if (!match || (!match[1] && !match[2])) return response;
  const bytes = await response.arrayBuffer();
  const size = bytes.byteLength;
  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  } else {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start >= size || start > end || end < 0) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    });
  }
  end = Math.min(end, size - 1);
  const headers = new Headers(response.headers);
  headers.delete('Content-Encoding');
  headers.set('Content-Type', 'application/pdf');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin
      || !url.pathname.startsWith(BASE.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Ignore query strings only for known application assets.
    const assetURL = new URL(url);
    assetURL.search = '';
    assetURL.hash = '';
    const canonical = assetURL.href;
    const isIndex = canonical === BASE.href || canonical === INDEX_URL;
    const cached = await cache.match(isIndex ? INDEX_URL : canonical);
    if (cached) {
      if (canonical === PDF_URL && request.headers.has('Range')) {
        return pdfRange(cached, request.headers.get('Range'));
      }
      return cached;
    }
    try {
      return await fetch(request);
    } catch {
      // A missing JSON, script, or PDF must never become an HTML page.
      return new Response('This file is not available offline. Reconnect and try again.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
