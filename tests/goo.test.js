'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectGoo } = require('../src/slicing/goo');

// Minimal independent format fixture: two 4x2 images, with one eight-pixel run
// per image. Offsets follow the vendor's fixed V3.0 header field ordering.
const HEADER_SIZE = 195477;
const LAYER_OFFSET = 195310;
function image(tokens) {
  const checksum = tokens.reduce((sum, byte) => (sum + byte) & 255, 0) ^ 255;
  return Buffer.from([0x55, ...tokens, checksum]);
}
function fixture({ tokens = [0xc8], layers = 2 } = {}) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('V3.0');
  Buffer.from([7, 0, 0, 0, 68, 76, 80, 0]).copy(header, 4);
  header.write('Independent fixture', 12);
  header.write('ELEGOO Test', 92);
  header.write('DLP', 124);
  header.write('Test resin', 156);
  header.writeUInt16BE(8, 188); header.writeUInt16BE(1, 190);
  header.writeUInt16BE(0x0d0a, 27106); header.writeUInt16BE(0x0d0a, 195308);
  header.writeUInt32BE(layers, LAYER_OFFSET);
  header.writeUInt16BE(4, LAYER_OFFSET + 4); header.writeUInt16BE(2, LAYER_OFFSET + 6);
  header[LAYER_OFFSET + 9] = 1;
  let offset = LAYER_OFFSET + 10;
  for (const value of [40, 20, 30, 0.05, 2]) { header.writeFloatBE(value, offset); offset += 4; }
  header[offset++] = 1;
  offset += 7 * 4;
  header.writeFloatBE(20, offset); offset += 4;
  header.writeUInt32BE(1, offset); offset += 4;
  offset += 16 * 4;
  header.writeUInt16BE(255, offset); offset += 2;
  header.writeUInt16BE(255, offset); offset += 2;
  header[offset++] = 1;
  offset += 4 * 4 + 8;
  header.writeUInt32BE(HEADER_SIZE, offset); offset += 4;
  header[offset++] = 1;
  header.writeUInt16BE(0, offset);
  const parts = [header];
  for (let layer = 0; layer < layers; layer++) {
    const definition = Buffer.alloc(70);
    definition.writeFloatBE(30, 2);
    definition.writeFloatBE((layer + 1) * 0.05, 6);
    definition.writeFloatBE(layer === 0 ? 20 : 2, 10);
    definition.writeUInt16BE(255, 62);
    definition.writeUInt16BE(0x0d0a, 64);
    const data = image(tokens);
    definition.writeUInt32BE(data.length, 66);
    parts.push(definition, data, Buffer.from([13, 10]));
  }
  parts.push(Buffer.from([0, 0, 0, 7, 0, 0, 0, 68, 76, 80, 0]));
  return Buffer.concat(parts);
}

test('GOO reader checks every layer and returns bounded metadata without expanding pixel arrays', () => {
  const result = inspectGoo(fixture(), { expected: { resolutionX: 4, resolutionY: 2, displayWidthMm: 40, displayHeightMm: 20, layerHeightMm: 0.05, mirrorY: true, machineName: 'ELEGOO Test' } });
  assert.equal(result.layerCount, 2);
  assert.equal(result.nonemptyLayerCount, 2);
  assert.equal(result.totalExposedPixels, 16);
  assert.equal(result.totalRuns, 2);
  assert.equal(result.validatedLayerData, true);
  assert.equal(result.printerCompatible, false);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.machineName, 'ELEGOO Test');
  assert.equal(result.minExposureSeconds, 2);
  assert.equal(result.maxExposureSeconds, 20);
});

test('GOO reader handles explicit grayscale, signed color differences and extended run lengths', () => {
  // Two grayscale pixels at 16, then +1 for three pixels, then -2 for three.
  assert.equal(inspectGoo(fixture({ tokens: [0x42, 16, 0x91, 3, 0xb2, 3] })).totalExposedPixels, 16);
  // Zero high-length byte is legal: the low nibble still gives eight pixels.
  assert.equal(inspectGoo(fixture({ tokens: [0xd8, 0] })).totalRuns, 2);
  assert.equal(inspectGoo(fixture({ tokens: [0x08] })).nonemptyLayerCount, 0);
});

test('native SatelLite four-bit mode respects its smaller grayscale range', () => {
  const nativeBinary = fixture(); nativeBinary[195474] = 0;
  const result = inspectGoo(nativeBinary);
  assert.equal(result.grayscaleBits, 4);
  assert.equal(result.totalExposedPixels, 16);
  const nativeGray = fixture({ tokens: [0x42, 7, 0x91, 3, 0xb2, 3] }); nativeGray[195474] = 0;
  assert.equal(inspectGoo(nativeGray).totalExposedPixels, 16);
  for (const tokens of [[0x48, 16], [0xc7, 0x81]]) {
    const overflow = fixture({ tokens }); overflow[195474] = 0;
    assert.throws(() => inspectGoo(overflow), { code: 'INVALID_GOO' });
  }
  const unknown = fixture(); unknown[195474] = 2;
  assert.throws(() => inspectGoo(unknown), { code: 'UNSUPPORTED_GOO_GRAYSCALE' });
});

test('wrong version, magic, preview delimiter, layer offset, footer and trailing bytes fail', () => {
  for (const index of [0, 4, 27106, 195308, 195470]) {
    const bytes = fixture(); bytes[index] ^= 1;
    assert.throws(() => inspectGoo(bytes), { code: index === 0 ? 'UNSUPPORTED_GOO_VERSION' : 'INVALID_GOO' });
  }
  const footer = fixture(); footer[footer.length - 1] = 1;
  assert.throws(() => inspectGoo(footer), { code: 'INVALID_GOO' });
  assert.throws(() => inspectGoo(Buffer.concat([fixture(), Buffer.from([0])])), { code: 'INVALID_GOO' });
  assert.throws(() => inspectGoo(fixture().subarray(0, 195477)), { code: 'INVALID_GOO' });
});

test('declared counts and lengths are bounded before decoding', () => {
  const layers = fixture(); layers.writeUInt32BE(1000000, LAYER_OFFSET);
  assert.throws(() => inspectGoo(layers), { code: 'GOO_LIMIT_EXCEEDED' });
  const length = fixture(); length.writeUInt32BE(0xffffffff, HEADER_SIZE + 66);
  assert.throws(() => inspectGoo(length), { code: 'GOO_LIMIT_EXCEEDED' });
  assert.throws(() => inspectGoo(fixture(), { limits: { maxPixelsPerLayer: 7 } }), { code: 'GOO_LIMIT_EXCEEDED' });
  assert.throws(() => inspectGoo(fixture(), { limits: { maxFileBytes: 10 } }), { code: 'GOO_LIMIT_EXCEEDED' });
  assert.throws(() => inspectGoo(fixture(), { limits: { maxLayers: Infinity } }), { code: 'INVALID_GOO_LIMITS' });
});

test('nonfinite and negative header/layer numeric fields fail', () => {
  for (const [offset, value] of [[195320, NaN], [195324, -1], [HEADER_SIZE + 10, Infinity], [HEADER_SIZE + 14, -1]]) {
    const bytes = fixture(); bytes.writeFloatBE(value, offset);
    assert.throws(() => inspectGoo(bytes), { code: 'INVALID_GOO' });
  }
  const positions = fixture();
  positions.writeFloatBE(0.01, HEADER_SIZE + 75 + 6);
  assert.throws(() => inspectGoo(positions), { code: 'INVALID_GOO' });
});

test('checksum corruption is detected in a later layer, including otherwise valid runs', () => {
  const bytes = fixture();
  bytes[HEADER_SIZE + 75 + 72] ^= 1;
  assert.throws(() => inspectGoo(bytes), /checksum.*layer 2/i);
});

test('RLE underruns, overruns, zero runs, truncated tokens and color overflow fail with valid checksums', () => {
  for (const tokens of [[0xc7], [0xc9], [0xc0], [0xd8], [0x42], [0x92], [0xc7, 0x81]]) {
    assert.throws(() => inspectGoo(fixture({ tokens })), { code: 'INVALID_GOO' });
  }
});

test('profile geometry, mirroring and model expectations are enforced', () => {
  for (const expected of [{ resolutionX: 5 }, { displayWidthMm: 41 }, { mirrorY: false }, { machineName: 'Other model' }]) {
    assert.throws(() => inspectGoo(fixture(), { expected }), { code: 'GOO_PROFILE_MISMATCH' });
  }
  assert.throws(() => inspectGoo(fixture(), { expected: { resolutionX: '4' } }), { code: 'INVALID_GOO_EXPECTATION' });
  assert.throws(() => inspectGoo(fixture(), { expected: { unidentified: true } }), { code: 'INVALID_GOO_EXPECTATION' });
});
