'use strict';

// Behind a login proxy (e.g. oauth2-proxy), an expired login makes the
// WebSocket fail over and over, and the app would sit on "Connecting…".
// After a few failed connects, the client asks for a small file. If the
// proxy answers with a redirect (to its sign-in page) or 401/403, the
// login has expired, and the page is reloaded so the proxy can show its
// sign-in page. PiRO itself never redirects or refuses that file.

export const AUTH_CHECK_URL = '/manifest.webmanifest?auth-check';
export const FAILS_BEFORE_CHECK = 2;
export const CHECK_INTERVAL_MS = 30000;

/** True when a response to AUTH_CHECK_URL means a login is needed. */
export function needsLogin(response) {
  if (!response) return false;
  return response.type === 'opaqueredirect' || response.status === 401 || response.status === 403;
}

/** True when it is time to check: enough failures, and not checked recently. */
export function shouldCheck(failures, lastCheckAt, now) {
  return failures >= FAILS_BEFORE_CHECK && (lastCheckAt == null || now - lastCheckAt >= CHECK_INTERVAL_MS);
}

/**
 * Asks the server for AUTH_CHECK_URL without following redirects. Resolves
 * true when a login is needed; false otherwise, and on a network error
 * (PiRO is down or the phone is offline: reloading wouldn't help).
 */
export async function checkLogin(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(AUTH_CHECK_URL, { redirect: 'manual', cache: 'no-store', credentials: 'same-origin' });
    return needsLogin(response);
  } catch {
    return false;
  }
}
