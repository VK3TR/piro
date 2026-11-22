'use strict';

// Run with: node test/login-proxy.test.js
// Running behind a login proxy (oauth2-proxy). Off by default: no login
// at all. With LOGIN_PROXY on, the login is mandatory: loopback only, a
// signed-in user on every request and WebSocket, startup refused for
// settings that leave a way round it. Also the listen address (WS_HOST),
// the idle logout setting in the connect snapshot, the logged-out page,
// and the service worker's rules (page loads go to the network first; the
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
const { isLoopback, loginUser, checkLogin, loginConfigErrors } = require('../src/server/login-proxy');

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

function get(port, urlPath, host = '127.0.0.1', headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host, port, path: urlPath, headers }, (res) => {
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

// --- LOGIN_PROXY: the login is mandatory once it is on. ---

const SIGNED_IN = { 'X-Forwarded-User': 'vk3abc', 'X-Forwarded-Email': 'vk3abc@example.net' };

/** Opens a WebSocket; resolves 'open' or the refusal's HTTP status. */
function tryWs(port, urlPath = '/', headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('error', (err) => resolve(err.message));
  });
}

test('isLoopback', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '[::1]', 'localhost']) assert.equal(isLoopback(a), true, a);
  for (const a of ['0.0.0.0', '::', '192.168.1.10', '::ffff:192.168.1.10', '10.0.0.1', '', null, '128.0.0.1']) assert.equal(isLoopback(a), false, String(a));
});

test('loginUser: X-Forwarded-User, else X-Forwarded-Email, else none', () => {
  assert.equal(loginUser({ headers: { 'x-forwarded-user': 'vk3abc', 'x-forwarded-email': 'a@b' } }), 'vk3abc');
  assert.equal(loginUser({ headers: { 'x-forwarded-email': 'a@b' } }), 'a@b');
  assert.equal(loginUser({ headers: { 'x-forwarded-user': '  ' } }), null);
  assert.equal(loginUser({ headers: {} }), null);
});

test('checkLogin: loopback and a user; only the logged-out page without one; WebSocket only on /', () => {
  const req = (url, { addr = '127.0.0.1', user, method = 'GET' } = {}) => ({ url, method, socket: { remoteAddress: addr }, headers: user ? { 'x-forwarded-user': user } : {} });
  assert.deepEqual(checkLogin(req('/', { user: 'vk3abc' })), { ok: true, user: 'vk3abc' });
  assert.equal(checkLogin(req('/')).ok, false, 'no user');
  assert.equal(checkLogin(req('/', { user: 'vk3abc', addr: '192.168.1.20' })).ok, false, 'not from this Pi, even with a user');
  assert.equal(checkLogin(req('/logged-out.html')).ok, true, 'the logged-out page needs no login');
  assert.equal(checkLogin(req('/logged-out.html?x=1')).ok, true);
  assert.equal(checkLogin(req('/logged-out.html', { method: 'POST' })).ok, false, 'GET only');
  assert.equal(checkLogin(req('/logged-out.html', { addr: '192.168.1.20' })).ok, false, 'still only from this Pi');
  assert.equal(checkLogin(req('/app.js')).ok, false);
  assert.equal(checkLogin(req('/', { user: 'vk3abc' }), { websocket: true }).ok, true);
  assert.equal(checkLogin(req('/'), { websocket: true }).ok, false, 'WebSocket without a user');
  assert.equal(checkLogin(req('/logged-out.html', { user: 'forged' }), { websocket: true }).ok, false, 'no WebSocket on the page the proxy lets through');
});

test('loginConfigErrors: nothing with the login off; open listeners refused with it on', () => {
  assert.deepEqual(loginConfigErrors({ loginProxy: false, wsHost: '0.0.0.0', rigctlPort: 4532, rigctlHost: '0.0.0.0' }), []);
  assert.deepEqual(loginConfigErrors({ loginProxy: true, wsHost: '127.0.0.1', rigctlPort: 4532, rigctlHost: '127.0.0.1' }), []);
  assert.deepEqual(loginConfigErrors({ loginProxy: true, wsHost: '127.0.0.1', rigctlPort: null, rigctlHost: '0.0.0.0' }), [], 'rigctl off');
  const errors = loginConfigErrors({ loginProxy: true, wsHost: '0.0.0.0', rigctlPort: 4532, rigctlHost: '0.0.0.0' });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /WS_HOST=0\.0\.0\.0/);
  assert.match(errors[1], /RIGCTL_HOST=0\.0\.0\.0/);
});

test('login off (the default): no login needed for pages or the WebSocket', async (t) => {
  const { cs, port } = await startServer(t);
  assert.equal(cs.requireLogin, false);
  assert.equal((await get(port, '/')).status, 200);
  assert.equal(await tryWs(port), 'open');
});

test('login on: loopback only, even with no host given', async (t) => {
  const { cs } = await startServer(t, { requireLogin: true });
  assert.equal(cs.boundAddress, '127.0.0.1');
  assert.throws(() => new ControlServer({ civ: stubCiv(), port: 0, requireLogin: true, host: '0.0.0.0' }), /loopback/);
});

test('login on: pages need a signed-in user; the logged-out page does not', async (t) => {
  const { port } = await startServer(t, { requireLogin: true });
  for (const p of ['/', '/index.html', '/app.js', '/manifest.webmanifest?auth-check', '/nope']) {
    const r = await get(port, p);
    assert.equal(r.status, 401, `${p} without a login`);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  assert.equal((await get(port, '/', '127.0.0.1', SIGNED_IN)).status, 200, 'with a login');
  assert.equal((await get(port, '/app.js', '127.0.0.1', { 'X-Forwarded-Email': 'vk3abc@example.net' })).status, 200, 'the email alone will do');
  assert.equal((await get(port, '/logged-out.html')).status, 200, 'the logged-out page without a login');
});

test('login on: the WebSocket needs a signed-in user, and only on /', async (t) => {
  const { cs, port } = await startServer(t, { requireLogin: true });
  assert.equal(await tryWs(port), 401, 'no user: refused');
  assert.equal(await tryWs(port, '/logged-out.html', SIGNED_IN), 401, 'a user forged on the page the proxy lets through: refused');
  assert.equal(await tryWs(port, '/?x=1', SIGNED_IN), 'open', 'a query string is fine');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: SIGNED_IN });
  await new Promise((r) => ws.on('open', r));
  t.after(() => ws.close());
  await new Promise((r) => setTimeout(r, 50));
  assert.equal([...cs.clients][0].loginUser, 'vk3abc', 'the server knows who it is');
});
