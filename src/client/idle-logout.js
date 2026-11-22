'use strict';

// Idle logout (the server's IDLE_LOGOUT_MINUTES): after that many minutes
// with no tap, click or key, the page logs out. A warning shows first, for
// up to a minute; any input clears it. Time is measured by the clock, not
// by counting timer ticks, so a phone that slept with the page open logs
// out as soon as it wakes.

export const WARN_MS = 60000;

export class IdleLogout {
  /**
   * @param {object} opts
   * @param {(secondsLeft: number) => void} opts.onWarn  called each tick while the warning shows
   * @param {() => void} opts.onClearWarn
   * @param {(url: string) => void} opts.onLogout  called once
   * @param {() => number} [opts.now]
   * @param {number} [opts.tickMs]
   */
  constructor({ onWarn, onClearWarn, onLogout, now = () => Date.now(), tickMs = 1000, setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (id) => clearInterval(id) }) {
    Object.assign(this, { onWarn, onClearWarn, onLogout, now, tickMs, setTimer, clearTimer });
    this.limitMs = 0;
    this.url = null;
    this.lastActivity = now();
    this.warning = false;
    this.done = false;
    this.timer = null;
  }

  /** From the server's snapshot: { minutes, url }. minutes 0 turns it off. */
  configure(setting) {
    const minutes = Number(setting?.minutes) || 0;
    this.limitMs = minutes > 0 ? minutes * 60000 : 0;
    this.url = setting?.url || null;
    if (!this.limitMs || !this.url) {
      this._stopTimer();
      this._clearWarning();
      return;
    }
    if (!this.timer && !this.done) this.timer = this.setTimer(() => this.check(), this.tickMs);
    this.check();
  }

  /** A tap, click or key: restart the count. */
  activity() {
    if (this.done) return;
    this.lastActivity = this.now();
    this._clearWarning();
  }

  /** How long the warning shows: a minute, or less for very short limits (tests). */
  warnMs() {
    return Math.min(WARN_MS, this.limitMs / 2);
  }

  check() {
    if (!this.limitMs || this.done) return;
    const left = this.limitMs - (this.now() - this.lastActivity);
    if (left <= 0) {
      this.done = true;
      this._stopTimer();
      this._clearWarning();
      this.onLogout(this.url);
    } else if (left <= this.warnMs()) {
      this.warning = true;
      this.onWarn(Math.ceil(left / 1000));
    } else {
      this._clearWarning();
    }
  }

  stop() {
    this._stopTimer();
  }

  _stopTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  _clearWarning() {
    if (!this.warning) return;
    this.warning = false;
    this.onClearWarn();
  }
}
