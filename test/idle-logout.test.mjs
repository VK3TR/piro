// Run with: node test/idle-logout.test.mjs
// The browser's idle logout (src/client/idle-logout.js) and its login
// check after failed connects (src/client/login-check.js), with a fake
// clock: no browser needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleLogout, WARN_MS } from '../src/client/idle-logout.js';
import { needsLogin, shouldCheck, checkLogin, AUTH_CHECK_URL, FAILS_BEFORE_CHECK, CHECK_INTERVAL_MS } from '../src/client/login-check.js';

function setup() {
  let t = 0;
  const log = [];
  const timers = new Set();
  const idle = new IdleLogout({
    onWarn: (s) => log.push(['warn', s]),
    onClearWarn: () => log.push(['clear']),
    onLogout: (url) => log.push(['logout', url]),
    now: () => t,
    setTimer: (fn) => {
      const id = { fn };
      timers.add(id);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    t += ms;
    for (const id of [...timers]) id.fn();
  };
  return { idle, log, timers, advance };
}

const URL = '/oauth2/sign_out?rd=%2Flogged-out.html';

test('off by default and with minutes 0: never logs out, no timer', () => {
  const { idle, log, timers, advance } = setup();
  idle.configure({ minutes: 0, url: URL });
  idle.configure(undefined);
  advance(10 * 3600000);
  idle.check();
  assert.deepEqual(log, []);
  assert.equal(timers.size, 0);
});

test('60 minutes: warns in the last minute, then logs out once', () => {
  const { idle, log, timers, advance } = setup();
  idle.configure({ minutes: 60, url: URL });
  advance(59 * 60000 - 1000);
  assert.deepEqual(log, [], 'no warning before the last minute');
  advance(1000);
  assert.deepEqual(log.at(-1), ['warn', 60]);
  advance(30000);
  assert.deepEqual(log.at(-1), ['warn', 30]);
  advance(30000);
  assert.deepEqual(log.slice(-2), [['clear'], ['logout', URL]]);
  assert.equal(timers.size, 0, 'the timer stops');
  advance(60000);
  idle.activity();
  assert.equal(log.filter((e) => e[0] === 'logout').length, 1, 'only once');
});

test('activity restarts the count and clears the warning', () => {
  const { idle, log, advance } = setup();
  idle.configure({ minutes: 60, url: URL });
  advance(59.5 * 60000);
  assert.equal(log.at(-1)[0], 'warn');
  idle.activity();
  assert.deepEqual(log.at(-1), ['clear']);
  advance(58 * 60000);
  assert.equal(log.at(-1)[0], 'clear', 'a full hour again from the tap');
  advance(2 * 60000);
  assert.equal(log.at(-1)[0], 'logout');
});

test('a phone that slept past the limit logs out at the first tick after waking', () => {
  const { idle, log, advance } = setup();
  idle.configure({ minutes: 60, url: URL });
  advance(3 * 3600000); // one tick, three hours later
  assert.deepEqual(log, [['logout', URL]]);
});

test('very short limits (tests) warn for half the time; the warning is never longer than a minute', () => {
  const { idle } = setup();
  idle.configure({ minutes: 0.1, url: URL });
  assert.equal(idle.warnMs(), 3000);
  idle.configure({ minutes: 60, url: URL });
  assert.equal(idle.warnMs(), WARN_MS);
});

test('turning it off clears a warning and stops the timer', () => {
  const { idle, log, timers, advance } = setup();
  idle.configure({ minutes: 2, url: URL });
  advance(90000);
  assert.equal(log.at(-1)[0], 'warn');
  idle.configure({ minutes: 0 });
  assert.deepEqual(log.at(-1), ['clear']);
  assert.equal(timers.size, 0);
});

test('reconfiguring (a reconnect) keeps a single timer', () => {
  const { idle, timers } = setup();
  idle.configure({ minutes: 60, url: URL });
  idle.configure({ minutes: 60, url: URL });
  assert.equal(timers.size, 1);
});

test('needsLogin: a redirect, 401 or 403 means the login proxy wants a login', () => {
  assert.equal(needsLogin({ type: 'opaqueredirect', status: 0 }), true);
  assert.equal(needsLogin({ type: 'basic', status: 401 }), true);
  assert.equal(needsLogin({ type: 'basic', status: 403 }), true);
  assert.equal(needsLogin({ type: 'basic', status: 200 }), false);
  assert.equal(needsLogin({ type: 'basic', status: 502 }), false, 'PiRO down behind the proxy: reloading would not help');
  assert.equal(needsLogin(null), false);
});

test('shouldCheck: after enough failed connects, at most every 30 s', () => {
  assert.equal(shouldCheck(FAILS_BEFORE_CHECK - 1, null, 0), false);
  assert.equal(shouldCheck(FAILS_BEFORE_CHECK, null, 0), true);
  assert.equal(shouldCheck(FAILS_BEFORE_CHECK + 3, 1000, 1000 + CHECK_INTERVAL_MS - 1), false);
  assert.equal(shouldCheck(FAILS_BEFORE_CHECK + 3, 1000, 1000 + CHECK_INTERVAL_MS), true);
});

test('checkLogin asks without following redirects, and a network error is not a login', async () => {
  let seen;
  assert.equal(
    await checkLogin(async (url, opts) => {
      seen = { url, opts };
      return { type: 'opaqueredirect', status: 0 };
    }),
    true
  );
  assert.equal(seen.url, AUTH_CHECK_URL);
  assert.equal(seen.opts.redirect, 'manual');
  assert.equal(seen.opts.cache, 'no-store');
  assert.equal(await checkLogin(async () => ({ type: 'basic', status: 200 })), false);
  assert.equal(
    await checkLogin(async () => {
      throw new TypeError('Failed to fetch');
    }),
    false
  );
});
