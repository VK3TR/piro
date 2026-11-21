'use strict';

// Run with: node test/tx-echo.test.js
// TX echo (TX_AUDIO_ECHO, on by default): in a voice mode, a browser's mic
// audio is also sent to every other browser, in each one's own format, so
// people sharing the radio hear each other transmit. The talker isn't sent
// its own voice; the radio's received audio is held back while the echo
// flows; nothing is echoed in data modes or with the setting off.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { AudioBridge, tagAudio, ECHO_HOLD_MS } = require('../src/server/audio-bridge');
const { BINARY_TYPE } = require('../src/server/protocol');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeCapture extends EventEmitter {
  start() {}
  stop() {}
}
class FakePlayback extends EventEmitter {
  constructor() {
    super();
    this.written = [];
  }
  start() {}
  write(b) {
    this.written.push(b);
  }
  stop() {}
}

/** A browser: records every binary frame it is sent. */
function browser(name) {
  return { name, readyState: 1, OPEN: 1, frames: [], send(f) { this.frames.push(Buffer.from(f)); } };
}

async function setup(t, { mode = 'USB', dataMode = false, txEcho, state = {} } = {}) {
  const cs = new EventEmitter();
  cs.state = { mode: { mode, filter: 1 }, dataMode, ...state };
  cs.broadcastJsonEvent = () => {};
  const a = browser('A');
  const b = browser('B');
  const c = browser('C');
  cs.clients = new Set([a, b, c]);
  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const bridge = new AudioBridge({ controlServer: cs, capture, playback, maximizeVolumeOnStart: false, ...(txEcho === undefined ? {} : { txEcho }) });
  await bridge.start();
  t.after(() => bridge.stop());
  // A's mic: one 20 ms packet of raw PCM at 48 kHz.
  const mic = Buffer.alloc(1920);
  for (let i = 0; i < 960; i++) mic.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 48000)), i * 2);
  const talk = () => cs.emit('binary-message', a, tagAudio(mic));
  return { cs, a, b, c, capture, playback, bridge, mic, talk };
}

const audioFrames = (ws, type = BINARY_TYPE.AUDIO) => ws.frames.filter((f) => f[0] === type);

test('in USB: the other browsers hear the talker; the talker does not hear itself', async (t) => {
  const { a, b, c, playback, mic, talk } = await setup(t);
  talk();
  assert.equal(playback.written.length, 1, 'the mic audio still goes to the radio');
  for (const ws of [b, c]) {
    const f = audioFrames(ws);
    assert.equal(f.length, 1, `${ws.name} gets the echo`);
    assert.ok(f[0].subarray(1).equals(mic), `${ws.name} gets it byte for byte (raw PCM)`);
  }
  assert.equal(audioFrames(a).length, 0, 'the talker is not sent its own voice');
});

test("while echoing, the radio's received audio is held back, then flows again", async (t) => {
  const { b, capture, talk } = await setup(t);
  const rx = Buffer.alloc(1920, 1);
  talk();
  capture.emit('data', rx);
  assert.equal(audioFrames(b).length, 1, 'only the echo, no received audio mid-over');
  talk();
  assert.equal(audioFrames(b).length, 2);
  await sleep(ECHO_HOLD_MS + 50);
  capture.emit('data', rx);
  assert.equal(audioFrames(b).length, 3, `${ECHO_HOLD_MS} ms after the last mic packet, received audio flows again`);
  assert.ok(audioFrames(b)[2].subarray(1).equals(rx));
});

test('voice modes echo; data modes and CW do not', async (t) => {
  const cases = [
    [{ mode: 'LSB' }, true],
    [{ mode: 'AM' }, true],
    [{ mode: 'FM' }, true],
    [{ mode: 'USB', dataMode: true }, false],
    [{ mode: 'CW' }, false],
    [{ mode: 'RTTY' }, false],
    [{ mode: 'USB', state: { ft8Active: true } }, false],
    [{ mode: 'USB', state: { sstvActive: true } }, false],
    [{ mode: 'USB', state: { varaActive: true } }, false],
    // FreeDV is digital voice: the mic audio is the speech, even in USB-D.
    [{ mode: 'USB', dataMode: true, state: { freeDvActive: true } }, true],
  ];
  for (const [opts, echoes] of cases) {
    await t.test(`${opts.mode}${opts.dataMode ? '-D' : ''} ${JSON.stringify(opts.state || {})}`, async (t) => {
      const { b, talk, playback } = await setup(t, opts);
      talk();
      assert.equal(playback.written.length, 1, 'the radio still gets the mic audio');
      assert.equal(audioFrames(b).length, echoes ? 1 : 0, echoes ? 'echoed' : 'not echoed');
    });
  }
});

test('TX_AUDIO_ECHO off: nothing is echoed', async (t) => {
  const { b, c, talk, playback } = await setup(t, { txEcho: false });
  talk();
  assert.equal(playback.written.length, 1);
  assert.equal(audioFrames(b).length + audioFrames(c).length, 0);
});

test('each browser gets the echo in its own format (Opus, ADPCM, raw PCM)', async (t) => {
  const { a, b, c, bridge, talk } = await setup(t);
  bridge.setClientCodec(b, 'opus');
  bridge.setClientCodec(c, 'adpcm');
  for (let i = 0; i < 5; i++) talk(); // 100 ms: enough for whole Opus and ADPCM frames
  assert.ok(audioFrames(b, BINARY_TYPE.AUDIO_OPUS).length >= 3, 'Opus frames to the Opus browser');
  assert.ok(audioFrames(c, BINARY_TYPE.AUDIO_ADPCM).length >= 3, 'ADPCM frames to the ADPCM browser');
  assert.equal(a.frames.length, 0, 'still nothing to the talker');
});

test('two people talking: each hears the other, neither hears itself', async (t) => {
  const { cs, a, b, mic } = await setup(t);
  cs.emit('binary-message', a, tagAudio(mic));
  cs.emit('binary-message', b, tagAudio(mic));
  assert.equal(audioFrames(a).length, 1, 'A hears B');
  assert.equal(audioFrames(b).length, 1, 'B hears A');
});

test('end to end: a real ControlServer and two real browsers over WebSocket', async (t) => {
  const WebSocket = require('ws');
  const { ControlServer } = require('../src/server/ws-server');
  const civ = new EventEmitter();
  civ.radioAddr = 0x94;
  const cs = new ControlServer({ civ, port: 0, heartbeatMs: 0 });
  cs.state.mode = { mode: 'LSB', filter: 1 };
  cs.state.dataMode = false;
  const port = await cs.listen();
  const playback = new FakePlayback();
  const bridge = new AudioBridge({ controlServer: cs, capture: new FakeCapture(), playback, maximizeVolumeOnStart: false });
  await bridge.start();
  const open = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.binary = [];
      ws.on('message', (raw, isBinary) => {
        if (isBinary) ws.binary.push(Buffer.from(raw));
      });
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  const a = await open();
  const b = await open();
  t.after(async () => {
    a.close();
    b.close();
    bridge.stop();
    await cs.close();
  });
  await sleep(100);
  const mic = Buffer.alloc(1920, 7);
  a.send(tagAudio(mic));
  const end = Date.now() + 2000;
  while (!b.binary.length && Date.now() < end) await sleep(10);
  assert.ok(b.binary.length >= 1 && b.binary[0][0] === BINARY_TYPE.AUDIO && b.binary[0].subarray(1).equals(mic), "B hears A's mic audio");
  assert.equal(a.binary.length, 0, 'A is not sent its own voice');
  assert.equal(playback.written.length, 1, 'and it went to the radio');
});
