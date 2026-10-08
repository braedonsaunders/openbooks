import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import manifest from '../web/app/manifest.ts';
import { employeeManifest } from '../web/lib/pwa-manifest.ts';
import { isPublicPath } from '../web/lib/proxy-policy.ts';

const origin = 'https://openbooks.example';
const workerSource = await readFile(new URL('../web/public/sw.js', import.meta.url), 'utf8');
const offlineDocument = await readFile(new URL('../web/public/offline.html', import.meta.url), 'utf8');

/** Emulate browser boundaries while executing the unmodified service worker. */
function worker(network = async () => new Response('live records')) {
  const listeners = new Map();
  const stored = new Map();
  const additions = [];
  const deleted = [];
  let skipWaiting = 0;
  let claimed = 0;
  const caches = {
    async open(key) {
      if (!stored.has(key)) stored.set(key, new Map());
      const assets = stored.get(key);
      return {
        async add(request) {
          additions.push(request);
          assets.set(new URL(request.url).pathname, new Response(offlineDocument, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }));
        },
        async match(url) { return assets.get(url)?.clone(); },
      };
    },
    async keys() { return [...stored.keys()]; },
    async delete(key) { deleted.push(key); return stored.delete(key); },
  };
  runInNewContext(workerSource, {
    self: {
      location: { origin },
      addEventListener(name, listener) { listeners.set(name, listener); },
      async skipWaiting() { skipWaiting += 1; },
      clients: { async claim() { claimed += 1; } },
    },
    caches, URL, Response,
    Request: class extends Request {
      constructor(url, options) { super(new URL(url, origin), options); }
    },
    fetch: network,
  });
  return {
    stored, additions, deleted,
    get skipWaiting() { return skipWaiting; },
    get claimed() { return claimed; },
    lifecycle(name) {
      let pending;
      listeners.get(name)({ waitUntil(promise) { pending = promise; } });
      return pending;
    },
    navigation(path = '/', overrides = {}) {
      let response;
      const request = { url: new URL(path, origin).href, method: 'GET', mode: 'navigate', ...overrides };
      listeners.get('fetch')({ request, respondWith(promise) { response = promise; } });
      return response;
    },
  };
}

test('app and employee installation identities retain separate authenticated launch destinations', () => {
  const app = manifest();
  const employee = employeeManifest();
  assert.equal(app.id, '/');
  assert.equal(app.start_url, '/');
  assert.equal(employee.id, '/me');
  assert.equal(employee.start_url, '/me');
  for (const metadata of [app, employee]) {
    assert.equal(metadata.display, 'standalone');
    assert.equal(metadata.scope, '/');
    assert.equal(isPublicPath(metadata.start_url), false);
    for (const icon of metadata.icons) assert.equal(isPublicPath(icon.src), true, icon.src);
  }
});

test('installation icons are opaque PNGs at their declared sizes and maskable artwork stays in the safe circle', async () => {
  for (const icon of manifest().icons) {
    const file = new URL(`../web/public${icon.src}`, import.meta.url);
    const metadata = await sharp(file.pathname).metadata();
    assert.equal(`${metadata.width}x${metadata.height}`, icon.sizes);
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.hasAlpha, false);
    if (icon.purpose !== 'maskable') continue;
    const { data, info } = await sharp(file.pathname).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const index = (y * info.width + x) * info.channels;
        if (data[index] === 255 && data[index + 1] === 255 && data[index + 2] === 255) continue;
        assert.ok(Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2) < info.width * 0.4,
          `maskable artwork at ${x},${y} must survive platform cropping`);
      }
    }
  }
  const apple = await sharp(new URL('../web/public/pwa/apple-touch-icon.png', import.meta.url).pathname).metadata();
  assert.equal(apple.width, 180);
  assert.equal(apple.height, 180);
  assert.equal(apple.hasAlpha, false);
});

test('installation caches only the public offline document without ambient credentials', async () => {
  const app = worker();
  await app.lifecycle('install');
  assert.equal(app.additions.length, 1);
  assert.equal(app.additions[0].url, `${origin}/offline.html`);
  assert.equal(app.additions[0].credentials, 'omit');
  assert.equal(app.additions[0].cache, 'reload');
  assert.equal(app.skipWaiting, 1);
  assert.deepEqual([...app.stored.values()].flatMap((assets) => [...assets.keys()]), ['/offline.html']);
});

test('activation removes only older OpenBooks offline caches', async () => {
  const app = worker();
  await app.lifecycle('install');
  app.stored.set('openbooks-offline-v0', new Map());
  app.stored.set('another-application', new Map());
  await app.lifecycle('activate');
  assert.deepEqual(app.deleted, ['openbooks-offline-v0']);
  assert.ok(app.stored.has('another-application'));
  assert.equal(app.claimed, 1);
});

test('online navigation preserves server refusals and never stores authenticated documents', async () => {
  for (const status of [200, 401, 403, 503]) {
    const response = new Response('current server response', { status });
    const app = worker(async (request, options) => {
      assert.equal(request.url, `${origin}/reports/pnl?period=2026-10`);
      assert.equal(options.cache, 'no-store');
      return response;
    });
    await app.lifecycle('install');
    assert.equal(await app.navigation('/reports/pnl?period=2026-10'), response);
    assert.equal(app.additions.length, 1);
  }
});

test('a failed navigation serves the public offline screen instead of financial data', async () => {
  const app = worker(async () => { throw new TypeError('Network unavailable'); });
  await app.lifecycle('install');
  const response = await app.navigation('/me');
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(await response.text(), offlineDocument);
  assert.equal(app.additions.length, 1);
});

test('mutations, API navigations, Flight requests, static resources and external origins are never intercepted', () => {
  const app = worker(() => { assert.fail('bypassed requests must use the browser network boundary'); });
  for (const [path, overrides] of [
    ['/', { method: 'POST' }],
    ['/api/documents', { method: 'POST' }],
    ['/api/documents/export', {}],
    ['/api/auth/oidc/callback?code=opaque', {}],
    ['/api', {}],
    ['/reports/pnl?_rsc=opaque', { mode: 'cors' }],
    ['/_next/static/chunk.js', { mode: 'no-cors' }],
    ['https://identity.example/login', {}],
  ]) assert.equal(app.navigation(path, overrides), undefined, path);
});

test('missing offline cache fails explicitly without inventing a successful response', async () => {
  const app = worker(async () => { throw new TypeError('Network unavailable'); });
  const response = await app.navigation();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
