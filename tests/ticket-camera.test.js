import test from 'node:test';
import assert from 'node:assert/strict';
import { createTicketCamera } from '../apps/web/src/checkins/camera.js';

const id = '90000000-0000-4000-8000-000000000005', credential = 'sl1.' + id + '.' + 'a'.repeat(43);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function media() {
  const listeners = new Map(); let stops = 0;
  const track = { stop: () => { stops++; }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  return { stream: { getTracks: () => [track], getVideoTracks: () => [track] }, listeners, stops: () => stops };
}
function fixture(options = {}) {
  const m = media(), frames = new Map(), codes = [], states = [], requests = []; let seq = 0;
  const video = { readyState: 2, srcObject: null, play: async () => {}, pause: () => {} };
  class Detector { static async getSupportedFormats() { return ['qr_code']; } async detect() { return [{ rawValue: credential }]; } }
  const camera = createTicketCamera({ video, onCode: value => codes.push(value), onState: value => states.push(value),
    secure: true, Detector, mediaDevices: { getUserMedia: async value => { requests.push(value); return m.stream; } },
    schedule: fn => { frames.set(++seq, fn); return seq; }, cancel: key => frames.delete(key), ...options });
  async function frame() { const [key, fn] = frames.entries().next().value; frames.delete(key); await fn(); }
  return { camera, m, video, codes, states, requests, frames, frame };
}

test('explicit start is single-flight; one decoded ticket stops all tracks and fills once without admission', async () => {
  const f = fixture(); assert.equal(f.requests.length, 0);
  await Promise.all([f.camera.start(), f.camera.start()]); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].audio, false); assert.equal(f.states.at(-1).status, 'scanning');
  await f.frame(); assert.deepEqual(f.codes, [credential]); assert.equal(f.m.stops(), 1);
  assert.equal(f.frames.size, 0); assert.equal(f.video.srcObject, null); assert.equal(f.states.at(-1).status, 'read');
  f.camera.dispose();
});

test('stop during a permission prompt releases a late grant and never plays or fills it', async () => {
  const grant = deferred(), m = media(); let requested = false;
  const f = fixture({ mediaDevices: { getUserMedia: () => { requested = true; return grant.promise; } } });
  const started = f.camera.start(); await Promise.resolve(); assert.ok(requested);
  f.camera.stop(); grant.resolve(m.stream); await started;
  assert.equal(m.stops(), 1); assert.equal(f.video.srcObject, null); assert.equal(f.frames.size, 0); assert.deepEqual(f.codes, []);
});

test('a late detection cannot fill after stop/restart or stop the newer stream', async () => {
  const detected = deferred(), second = media(); let scans = 0, captures = 0;
  class Detector { static async getSupportedFormats() { return ['qr_code']; } detect() { scans++; return detected.promise; } }
  const first = media(), f = fixture({ Detector, mediaDevices: { getUserMedia: async () => (++captures === 1 ? first.stream : second.stream) } });
  await f.camera.start(); const oldFrame = f.frame(); assert.equal(scans, 1);
  f.camera.stop(); await f.camera.start(); detected.resolve([{ rawValue: credential }]); await oldFrame;
  assert.deepEqual(f.codes, []); assert.equal(first.stops(), 1); assert.equal(second.stops(), 0); assert.equal(f.video.srcObject, second.stream);
  f.camera.dispose(); assert.equal(second.stops(), 1);
});

test('unrelated, multiple and wrong pending-ticket codes do not fill; an exact pending ticket can fill', async () => {
  const other = credential.replace(id, '90000000-0000-4000-8000-000000000006'); let results = [{ rawValue: 'https://example.com/' + credential }];
  class Detector { static async getSupportedFormats() { return ['qr_code']; } async detect() { return results; } }
  const f = fixture({ Detector, expectedTicketId: id }); await f.camera.start();
  await f.frame(); assert.deepEqual(f.codes, []);
  results = [{ rawValue: other }]; await f.frame(); assert.deepEqual(f.codes, []);
  results = [{ rawValue: credential }, { rawValue: other }]; await f.frame(); assert.deepEqual(f.codes, []);
  results = [{ rawValue: credential }]; await f.frame(); assert.deepEqual(f.codes, [credential]);
});

test('secure context, permission, playback and disconnected-camera failures preserve paste fallback and release tracks', async () => {
  const insecure = fixture({ secure: false }); await insecure.camera.start(); assert.equal(insecure.requests.length, 0); assert.equal(insecure.states.at(-1).status, 'unavailable');
  const denied = fixture({ mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error('private device details'), { name: 'NotAllowedError' }); } } });
  await denied.camera.start(); assert.equal(denied.states.at(-1).status, 'error'); assert.equal(JSON.stringify(denied.states).includes('private device'), false);
  const playback = fixture(); playback.video.play = async () => { throw new Error(); }; await playback.camera.start(); assert.equal(playback.m.stops(), 1);
  const disconnected = fixture(); await disconnected.camera.start(); disconnected.m.listeners.get('ended')();
  assert.equal(disconnected.states.at(-1).status, 'error'); assert.equal(disconnected.m.stops(), 1); assert.equal(disconnected.frames.size, 0);
});

test('native absence uses the local reader; stopping before reader loading never captures a frame', async () => {
  let cleared = 0, loaded = 0;
  const f = fixture({ Detector: null, createCanvas: () => ({}), loadReader: async () => ({ softwareReader: () => {
    loaded++; return { detect: () => [{ rawValue: credential }], clear: () => { cleared++; } };
  } }) });
  await f.camera.start(); await f.frame(); assert.deepEqual(f.codes, [credential]); assert.equal(loaded, 1); assert.equal(cleared, 1);
  const pending = deferred(), stale = fixture({ Detector: null, loadReader: () => pending.promise });
  const start = stale.camera.start(); await Promise.resolve(); stale.camera.dispose();
  pending.resolve({ softwareReader: () => { throw new Error('must not initialize after stop'); } }); await start;
  assert.equal(stale.requests.length, 0); assert.deepEqual(stale.codes, []);
});
