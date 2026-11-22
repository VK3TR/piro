'use strict';

/**
 * Login through a proxy (LOGIN_PROXY). Off by default: PiRO works without
 * any login, as it always has. When on, the login is mandatory:
 *
 * - PiRO listens on loopback only (WS_HOST may only be a loopback address),
 *   so nothing on the network can reach it except through the proxy on
 *   the same Pi.
 * - Every web request and WebSocket must come from a loopback address and
 *   carry the user the proxy signed in (oauth2-proxy sends X-Forwarded-User
 *   and X-Forwarded-Email). Anything else gets 401.
 * - The only page served without a login is the one shown after an idle
 *   logout, and the WebSocket is only accepted on "/", so a proxy that lets
 *   that page through without a login can't be used to reach the radio.
 * - The rigctl port, which has no login, must stay on loopback. The Icom
 *   LAN server has its own username and password.
 *
 * A setting that would break this stops PiRO at startup (loginConfigErrors)
 * rather than running with the login open.
 */

const PUBLIC_PATHS = new Set(['/logged-out.html']);
const USER_HEADERS = ['x-forwarded-user', 'x-forwarded-email'];

/** True for 127.0.0.0/8, ::1 and their IPv4-mapped forms, and "localhost". */
function isLoopback(address) {
  if (!address) return false;
  let a = String(address).trim().toLowerCase();
  if (a === 'localhost' || a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  if (a === '::1') return true;
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** The signed-in user the proxy passed on, or null. */
function loginUser(req) {
  for (const h of USER_HEADERS) {
    const v = req.headers?.[h];
    const s = (Array.isArray(v) ? v[0] : v || '').trim();
    if (s) return s;
  }
  return null;
}

function pathOf(req) {
  try {
    return new URL(req.url || '/', 'http://x').pathname;
  } catch {
    return null;
  }
}

/**
 * Whether a request may go ahead with the login on.
 * @param {import('http').IncomingMessage} req
 * @param {{websocket?: boolean}} [opts]
 * @returns {{ok: true, user: string|null} | {ok: false, reason: string}}
 */
function checkLogin(req, { websocket = false } = {}) {
  if (!isLoopback(req.socket?.remoteAddress)) return { ok: false, reason: `not from this Pi (${req.socket?.remoteAddress})` };
  const path = pathOf(req);
  if (path == null) return { ok: false, reason: 'bad URL' };
  if (websocket) {
    if (path !== '/') return { ok: false, reason: `WebSocket on ${path}` };
  } else if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_PATHS.has(path)) {
    return { ok: true, user: loginUser(req) };
  }
  const user = loginUser(req);
  if (!user) return { ok: false, reason: 'no signed-in user from the login proxy' };
  return { ok: true, user };
}

/**
 * Settings that would leave a way round the login. Empty when the login is
 * off, or on and safe.
 */
function loginConfigErrors({ loginProxy, wsHost, rigctlPort, rigctlHost }) {
  if (!loginProxy) return [];
  const errors = [];
  if (wsHost && !isLoopback(wsHost)) {
    errors.push(`WS_HOST=${wsHost}: with LOGIN_PROXY on, PiRO must listen on this Pi only (127.0.0.1, or leave WS_HOST unset).`);
  }
  if (rigctlPort && !isLoopback(rigctlHost)) {
    errors.push(`RIGCTL_HOST=${rigctlHost}: the rigctl port has no login, so with LOGIN_PROXY on it must stay on this Pi (127.0.0.1).`);
  }
  return errors;
}

module.exports = { isLoopback, loginUser, checkLogin, loginConfigErrors, PUBLIC_PATHS };
