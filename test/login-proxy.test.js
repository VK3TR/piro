'use strict';

// Run with: node test/login-proxy.test.js
// Running behind a login proxy (oauth2-proxy): the listen address
// (WS_HOST), the idle logout setting in the connect snapshot, the
// logged-out page and the login check's file served by PiRO, and the
// service worker's rules (page loads go to the network first; the
// proxy's /oauth2/ paths are never handled).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { ControlServer } = require('../src/server/ws-server');

const CLIENT_DIR = path.join(__dirname, '..', 'src', 'client');

function stubCiv() {
  const civ = new EventEmitter();
  civ.radioAddr = 0x94;
  return civ;
}

async function startServer(t, opts = {}) {
  const cs = new ControlServer({ civ: stubCiv(), port: 0, heartbeatMs: 0, staticDir: CLIENT_DIR, ...opts });
  const port = await cs.listen();
  t.after(() => cs.close());
  return { cs, port };
}

function snapshot(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(raw);
      if (msg.type === 'connected') {
        ws.close();
        resolve(msg.data);
      }
    });
    ws.on('error', reject);
  });
}

function get(port, urlPath, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    http
      .get({ host, port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      })
      .on('error', reject);
  });
}

/** A non-loopback IPv4 address of this machine, if it has one. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

test('WS_HOST unset: listens on every address (the default)', async (t) => {
  const { cs, port } = await startServer(t);
  assert.ok(['::', '0.0.0.0'].includes(cs.boundAddress), `bound to ${cs.boundAddress}`);
  assert.equal((await get(port, '/manifest.webmanifest')).status, 200);
});

test('WS_HOST=127.0.0.1: listens on loopback only', async (t) => {
  const { cs, port } = await startServer(t, { host: '127.0.0.1' });
  assert.equal(cs.boundAddress, '127.0.0.1');
  assert.equal((await get(port, '/manifest.webmanifest')).status, 200, 'reachable on loopback');
  const lan = lanAddress();
  if (!lan) return t.diagnostic('no LAN address here: skipped the outside check');
  await assert.rejects(get(port, '/manifest.webmanifest', lan), /ECONNREFUSED/, `not reachable on ${lan}`);
});

test('snapshot: idleLogout off by default', async (t) => {
  const { port } = await startServer(t);
  assert.deepEqual((await snapshot(port)).idleLogout, { minutes: 0, url: null });
});

test('snapshot: idleLogout as set', async (t) => {
  const idleLogout = { minutes: 60, url: '/oauth2/sign_out?rd=%2Flogged-out.html' };
  const { port } = await startServer(t, { idleLogout });
  assert.deepEqual((await snapshot(port)).idleLogout, idleLogout);
});

test('PiRO serves the logged-out page and answers the login check with 200', async (t) => {
  const { port } = await startServer(t);
  const page = await get(port, '/logged-out.html');
  assert.equal(page.status, 200);
  assert.match(page.body, /Log in again/);
  assert.match(page.body, /href="\/"/);
  assert.doesNotMatch(page.body, /<script|<link rel="stylesheet"/, 'standalone: it loads nothing that needs a login');
  const check = await get(port, '/manifest.webmanifest?auth-check');
  assert.equal(check.status, 200, 'only the login proxy redirects or refuses it');
});

// --- The service worker, run in a vm with fake caches and fetch. ---

function loadServiceWorker({ online = true } = {}) {
  const listeners = {};
  const cache = new Map([['/', 'cached /'], ['/index.html', 'cached index'], ['/app.js', 'cached app.js']]);
  const fetched = [];
  const self = {
    location: { origin: 'https://radio.example.net' },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting() {},
    clients: { claim() {} },
  };
  const key = (req) => new URL(typeof req === 'string' ? req : req.url, self.location.origin).pathname;
  const sandbox = {
    self,
    URL,
    caches: {
      match: async (req) => cache.get(key(req)),
      open: async () => ({ put: async () => {}, addAll: async () => {} }),
      keys: async () => [],
    },
    fetch: async (req) => {
      fetched.push(key(req));
      if (!online) throw new TypeError('Failed to fetch');
      return { ok: true, body: `network ${key(req)}`, clone() { return this; } };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(CLIENT_DIR, 'sw.js'), 'utf8'), sandbox);
  const request = (urlPath, mode = 'no-cors', method = 'GET') => {
    let responded = null;
    listeners.fetch({
      request: { url: `${self.location.origin}${urlPath}`, mode, method },
      respondWith: (p) => (responded = Promise.resolve(p)),
    });
    return responded;
  };
  return { request, fetched };
}

test('service worker: a page load goes to the network first', async () => {
  const sw = loadServiceWorker();
  const res = await sw.request('/', 'navigate');
  assert.equal(res.body, 'network /');
  assert.deepEqual(sw.fetched, ['/']);
});

test('service worker: offline, a page load uses the cached page', async () => {
  const sw = loadServiceWorker({ online: false });
  assert.equal(await sw.request('/', 'navigate'), 'cached /');
  assert.equal(await sw.request('/?x=1', 'navigate'), 'cached /');
});

test("service worker: the login proxy's paths, the logged-out page and the login check are never handled", async () => {
  const sw = loadServiceWorker();
  for (const p of ['/oauth2/sign_in', '/oauth2/sign_out?rd=%2Flogged-out.html', '/oauth2/callback?code=x', '/logged-out.html', '/manifest.webmanifest?auth-check']) {
    assert.equal(sw.request(p, p.startsWith('/oauth2') || p === '/logged-out.html' ? 'navigate' : 'cors'), null, p);
  }
  assert.deepEqual(sw.fetched, []);
});

test('service worker: app files still come from the cache first', async () => {
  const sw = loadServiceWorker();
  assert.equal(await sw.request('/app.js', 'no-cors'), 'cached app.js');
  assert.deepEqual(sw.fetched, []);
});

test('service worker: the new client modules are precached', () => {
  const src = fs.readFileSync(path.join(CLIENT_DIR, 'sw.js'), 'utf8');
  for (const f of ['/login-check.js', '/idle-logout.js']) assert.ok(src.includes(`'${f}'`), f);
});
