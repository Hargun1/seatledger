import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { ticketQr } from '../apps/web/src/bookings/ticket-qr.js';
import { softwareReader } from '../apps/web/src/checkins/software-reader.js';

const credential = 'sl1.90000000-0000-4000-8000-000000000005.' + 'aB9_-'.repeat(8) + 'abc';
function raster(symbol, scale = 5) {
  const width = symbol.size * scale, pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  const runs = [...symbol.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)];
  assert.equal(runs.map(value => value[0]).join(''), symbol.path);
  for (const [, x, y, length] of runs) {
    assert.ok(+x >= 4 && +y >= 4 && +x + +length <= symbol.size - 4 && +y < symbol.size - 4);
    for (let row = +y * scale; row < (+y + 1) * scale; row++) {
      for (let col = +x * scale; col < (+x + +length) * scale; col++) pixels.fill(0, (row * width + col) * 4, (row * width + col) * 4 + 3);
    }
  }
  return { pixels, width };
}

test('rendered QR geometry independently decodes to the exact credential, with a clear quiet zone', () => {
  for (const code of [credential, credential.replaceAll('a', 'Z').replace('90000000', 'f0000000')]) {
    const symbol = ticketQr(code), { pixels, width } = raster(symbol);
    assert.equal(jsQR(pixels, width, width)?.data, code);
    assert.equal(symbol.path.includes(code), false);
  }
  for (const invalid of ['', null, 'https://example.com/' + credential, credential + '\n', credential.slice(1)]) assert.throws(() => ticketQr(invalid));
});

test('software camera reader decodes the rendered ticket without native detection, then clears its canvas', () => {
  const { pixels, width } = raster(ticketQr(credential));
  let drawn = false;
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => { drawn = true; }, getImageData: () => ({ data: pixels }) }) };
  const reader = softwareReader(canvas);
  assert.deepEqual(reader.detect({ videoWidth: width, videoHeight: width }), [{ rawValue: credential }]);
  assert.ok(drawn); assert.equal(canvas.width, width);
  reader.clear(); assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
});

test('software camera frames are bounded and blank or unready frames produce no ticket', () => {
  let size;
  const canvas = { getContext: () => ({ drawImage: (_video, _x, _y, w, h) => { size = [w, h]; },
    getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }) }) };
  const reader = softwareReader(canvas);
  assert.deepEqual(reader.detect({ videoWidth: 0, videoHeight: 0 }), []); assert.equal(size, undefined);
  assert.deepEqual(reader.detect({ videoWidth: 1920, videoHeight: 1080 }), []); assert.deepEqual(size, [960, 540]);
  reader.clear();
});
