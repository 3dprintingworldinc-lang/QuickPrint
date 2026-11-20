'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { inspectGoo } = require('../src/slicing/goo');
const { inspectGooRaster, verifyGooPlate } = require('../src/slicing/goo-plate');

const HEADER = 195477, GLOBAL = 195310;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function run(color, count, maximum = 255) {
  const upper = []; let value = Math.floor(count / 16);
  while (value) { upper.unshift(value & 255); value = Math.floor(value / 256); }
  return [(color === 0 ? 0 : color === maximum ? 0xc0 : 0x40) | (upper.length << 4) | (count & 15), ...(color !== 0 && color !== maximum ? [color] : []), ...upper];
}
function tokensFor(pixels, maximum) {
  const tokens = [];
  for (let index = 0; index < pixels.length;) {
    let end = index + 1; while (end < pixels.length && pixels[end] === pixels[index]) end++;
    tokens.push(...run(pixels[index], end - index, maximum)); index = end;
  }
  return tokens;
}
function fixture({ width = 32, height = 24, images, bits = 8, rawTokens, mutateHeader, mutateLayer } = {}) {
  images ||= model(width, height);
  const header = Buffer.alloc(HEADER); header.write('V3.0'); Buffer.from([7,0,0,0,68,76,80,0]).copy(header, 4);
  header.write('Independent raster fixture', 12); header.write('Fixture resin machine', 92); header.write('DLP', 124); header.write('Fixture material', 156);
  header.writeUInt16BE(8, 188); header.writeUInt16BE(1, 190);
  header.writeUInt16BE(0x0d0a, 27106); header.writeUInt16BE(0x0d0a, 195308);
  let offset = GLOBAL;
  const u8 = value => { header[offset++] = value; }, u16 = value => { header.writeUInt16BE(value, offset); offset += 2; }, u32 = value => { header.writeUInt32BE(value, offset); offset += 4; }, float = value => { header.writeFloatBE(value, offset); offset += 4; };
  u32(images.length); u16(width); u16(height); u8(0); u8(1);
  [width / 10, height / 10, 30, 0.05, 2].forEach(float); u8(1);
  for (let i = 0; i < 7; i++) float(0);
  float(20); u32(1); for (let i = 0; i < 16; i++) float(i % 2 ? 100 : 5);
  u16(255); u16(255); u8(0); u32(100); [1,1,1].forEach(float); offset += 8; u32(HEADER); u8(bits === 4 ? 0 : 1); u16(0);
  assert.equal(offset, HEADER); mutateHeader?.(header);
  const parts = [header];
  images.forEach((pixels, index) => {
    const tokens = rawTokens?.[index] || tokensFor(pixels, bits === 4 ? 15 : 255), image = Buffer.from([0x55, ...tokens, tokens.reduce((sum, byte) => (sum + byte) & 255, 0) ^ 255]);
    const layer = Buffer.alloc(70); layer.writeFloatBE(30, 2); layer.writeFloatBE((index + 1) * 0.05, 6); layer.writeFloatBE(index ? 2 : 20, 10);
    for (let i = 0; i < 8; i++) layer.writeFloatBE(i % 2 ? 100 : 5, 30 + i * 4);
    layer.writeUInt16BE(255, 62); layer.writeUInt16BE(0x0d0a, 64); layer.writeUInt32BE(image.length, 66); mutateLayer?.(layer, index);
    parts.push(layer, image, Buffer.from([13,10]));
  });
  parts.push(Buffer.from([0,0,0,7,0,0,0,68,76,80,0])); return Buffer.concat(parts);
}
function model(width = 32, height = 24, maximum = 255) {
  const result = Array.from({ length: 3 }, () => new Array(width * height).fill(0));
  result[0][8 * width + 10] = maximum; result[0][8 * width + 11] = Math.floor(maximum / 2); result[0][9 * width + 10] = maximum; result[0][9 * width + 12] = Math.floor(maximum / 4);
  result[1][8 * width + 11] = maximum; result[1][9 * width + 12] = maximum;
  return result;
}
function copies(images, placements, width = 32, height = 24) {
  return images.map(source => {
    const result = new Array(width * height).fill(0);
    for (const placement of placements) for (let index = 0; index < source.length; index++) if (source[index]) {
      const x = index % width + placement.x, y = Math.floor(index / width) + placement.y;
      if (x >= 0 && x < width && y >= 0 && y < height) result[y * width + x] = source[index];
    }
    return result;
  });
}
const placements = [{ x: -6, y: -4 }, { x: 6, y: -4 }, { x: -6, y: 4 }, { x: 6, y: 4 }];

test('every layer and grayscale value must equal the exact union of all declared translated source copies', () => {
  const images = model(), reference = fixture({ images }), plate = fixture({ images: copies(images, placements) });
  const info = inspectGooRaster(reference), proof = verifyGooPlate(reference, plate, { translationsPx: placements });
  assert.deepEqual(info.boundsPx, { x: 10, y: 8, width: 3, height: 2 }); assert.equal(info.layerCount, 3);
  assert.equal(info.totalForegroundPixels, 6); assert.equal(info.sha256, digest(reference));
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.imageEquivalent, true); assert.equal(proof.copiesPerRun, 4);
  assert.equal(proof.referenceSha256, digest(reference)); assert.equal(proof.artifactSha256, digest(plate));
  assert.equal(proof.totalForegroundPixels, 24); assert.equal(proof.totalForegroundIntensity, proof.referenceForegroundIntensity * 4);
  assert.deepEqual(proof.placements[0], { x: -6, y: -4, boundsPx: { x: 4, y: 4, width: 3, height: 2 } });
  const { proofSha256, ...unsigned } = proof; assert.equal(proofSha256, digest(JSON.stringify(canonical(unsigned))));
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.placements) && Object.isFrozen(proof.placements[0].boundsPx));
  assert.deepEqual(JSON.parse(JSON.stringify(proof)), proof);
  assert.deepEqual(verifyGooPlate(reference, plate, { translationsPx: placements }), proof);
});

test('mirror-derived negative-zero offsets and gaps remain identical after JSON persistence and re-verification', () => {
  const reference = fixture(), proof = verifyGooPlate(reference, reference, { translationsPx: [{ x: -0, y: -0 }], minGapPx: -0 });
  assert.equal(Object.is(proof.placements[0].x, -0), false); assert.equal(Object.is(proof.placements[0].y, -0), false);
  assert.equal(Object.is(proof.minGapPx, -0), false);
  const persisted = JSON.parse(JSON.stringify(proof)); assert.deepEqual(persisted, proof);
  const repeated = verifyGooPlate(reference, reference, { translationsPx: persisted.placements.map(({ x, y }) => ({ x, y })), minGapPx: persisted.minGapPx });
  assert.deepEqual(repeated, proof); assert.equal(repeated.proofSha256, proof.proofSha256);
});

test('delta-run, signed grayscale differences and different RLE segmentation preserve identical pixels', () => {
  const width = 32, height = 16, pixels = new Array(width * height).fill(0), before = 4 * width + 8;
  [16,16,17,17,17,15,15,15].forEach((color, index) => { pixels[before + index] = color; });
  const tokens = [...run(0, before), 0x42,16,0x91,3,0xb2,3, ...run(0, pixels.length - before - 8)];
  const translated = [{ x: 0, y: 0 }, { x: 12, y: 6 }];
  const reference = fixture({ width, height, images: [pixels], rawTokens: [tokens] });
  const plate = fixture({ width, height, images: copies([pixels], translated, width, height) });
  const proof = verifyGooPlate(reference, plate, { translationsPx: translated }); assert.equal(proof.totalForegroundPixels, 16); assert.equal(proof.referenceForegroundIntensity, 128);
  const mono = new Array(width * height).fill(0); mono.fill(255, before, before + 5);
  const unusual = fixture({ width, height, images: [mono], rawTokens: [[...run(0, before), 0xd5,0, ...run(0, mono.length - before - 5)]] });
  assert.equal(verifyGooPlate(unusual, fixture({ width, height, images: [mono] }), { translationsPx: [{ x: 0, y: 0 }] }).imageEquivalent, true);
});

test('4-bit grayscale compares its actual levels and cannot be confused with 8-bit or changed AA settings', () => {
  const images = model(32, 24, 15), reference = fixture({ images, bits: 4 }), plate = fixture({ images: copies(images, placements), bits: 4 });
  assert.equal(verifyGooPlate(reference, plate, { translationsPx: placements }).grayscaleBits, 4);
  const eight = fixture({ images: copies(model(), placements) });
  assert.throws(() => verifyGooPlate(reference, eight, { translationsPx: placements }), { code: 'GOO_PLATE_SETTINGS_MISMATCH' });
  const aa = Buffer.from(plate); aa.writeUInt16BE(4, 188);
  assert.throws(() => verifyGooPlate(reference, aa, { translationsPx: placements }), { code: 'GOO_PLATE_SETTINGS_MISMATCH' });
  const invalid = fixture({ images, bits: 4, rawTokens: [[0x41,16, ...run(0, 767, 15)]] });
  assert.throws(() => inspectGooRaster(invalid), { code: 'INVALID_GOO' });
});

test('missing, extra, shifted and altered grayscale pixels fail even when foreground counts agree', () => {
  const images = model(), reference = fixture({ images });
  for (const kind of ['missing-copy', 'extra-pixel', 'shift-copy', 'gray', 'later-layer']) {
    const actual = copies(images, kind === 'missing-copy' ? placements.slice(1) : kind === 'shift-copy' ? placements.map((value, index) => index ? value : { x: value.x + 1, y: value.y }) : placements);
    if (kind === 'extra-pixel') actual[0][2 * 32 + 2] = 255;
    if (kind === 'gray') actual[0][4 * 32 + 4] = 254;
    if (kind === 'later-layer') actual[1].fill(0);
    assert.throws(() => verifyGooPlate(reference, fixture({ images: actual }), { translationsPx: placements }), { code: 'GOO_PLATE_IMAGE_MISMATCH' }, kind);
  }
});

test('machine, exposure, motion, PWM, mirroring and all per-layer pause/control schedules must match', () => {
  const images = model(), reference = fixture({ images });
  for (const offset of [92,124,190,192,GLOBAL + 8,195320,195336,195340,195341,195377,195441,195445,195475]) {
    const plate = fixture({ images: copies(images, placements) });
    if ([195320,195336,195341,195377].includes(offset)) plate.writeFloatBE(1.5, offset);
    else if (offset === 195445) plate[offset] = 1;
    else plate[offset] ^= 1;
    assert.throws(() => verifyGooPlate(reference, plate, { translationsPx: placements }), error => ['GOO_PLATE_SETTINGS_MISMATCH', 'INVALID_GOO'].includes(error.code), String(offset));
  }
  for (const field of [0,2,6,10,14,30,34,62]) {
    const plate = fixture({ images: copies(images, placements), mutateLayer(layer, index) {
      if (index !== 1) return;
      if (field === 0 || field === 62) layer.writeUInt16BE(field === 0 ? 1 : 200, field);
      else layer.writeFloatBE(field === 6 ? 0.11 : 1, field);
    } });
    assert.throws(() => verifyGooPlate(reference, plate, { translationsPx: placements }), { code: 'GOO_PLATE_SCHEDULE_MISMATCH' }, String(field));
  }
});

test('metadata, previews and area-dependent volume/cost/time may change while physical schedules remain identical', () => {
  const images = model(), reference = fixture({ images });
  const plate = fixture({ images: copies(images, placements), mutateHeader(header) {
    header.write('Other software', 12); header.write('2026-11-19', 68); header[200] = 123;
    header.writeUInt32BE(500, 195446); header.writeFloatBE(4, 195450); header.writeFloatBE(5, 195454); header.writeFloatBE(6, 195458);
  } });
  assert.equal(verifyGooPlate(reference, plate, { translationsPx: placements }).imageEquivalent, true);
});

test('overlapping logical copies, overlapping footprints and insufficient required gaps cannot inflate the claimed unit count', () => {
  const images = model(), reference = fixture({ images });
  for (const translations of [[{ x: 0, y: 0 }, { x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }]]) {
    assert.throws(() => verifyGooPlate(reference, fixture({ images: copies(images, translations) }), { translationsPx: translations }), { code: 'GOO_PLATE_OVERLAP' });
  }
  const touching = [{ x: 0, y: 0 }, { x: 3, y: 0 }], plate = fixture({ images: copies(images, touching) });
  assert.equal(verifyGooPlate(reference, plate, { translationsPx: touching }).copiesPerRun, 2);
  assert.throws(() => verifyGooPlate(reference, plate, { translationsPx: touching, minGapPx: 1 }), { code: 'GOO_PLATE_OVERLAP' });
  const sparse = Array.from({ length: 3 }, () => new Array(32 * 24).fill(0)); sparse[0][8 * 32 + 10] = 255; sparse[0][8 * 32 + 14] = 255;
  const translations = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  assert.throws(() => verifyGooPlate(fixture({ images: sparse }), fixture({ images: copies(sparse, translations) }), { translationsPx: translations }), { code: 'GOO_PLATE_OVERLAP' }, 'conservative whole-support footprint disjointness');
});

test('clipped references, row-wrapped foreground, out-of-frame copies and an empty source are refused', () => {
  const images = model(), reference = fixture({ images });
  for (const translation of [{ x: -10, y: 0 }, { x: 19, y: 0 }, { x: 0, y: -8 }, { x: 0, y: 14 }]) {
    assert.throws(() => verifyGooPlate(reference, fixture({ images: copies(images, [translation]) }), { translationsPx: [translation] }), { code: 'GOO_PLATE_CLIPPED' });
  }
  const wrapped = new Array(32 * 24).fill(0); wrapped.fill(255, 8 * 32 + 30, 9 * 32 + 2);
  const clipped = fixture({ images: [wrapped] });
  assert.throws(() => verifyGooPlate(clipped, clipped, { translationsPx: [{ x: 0, y: 0 }] }), { code: 'GOO_PLATE_CLIPPED' });
  const blank = fixture({ images: [new Array(32 * 24).fill(0)] });
  assert.throws(() => verifyGooPlate(blank, blank, { translationsPx: [{ x: 0, y: 0 }] }), { code: 'GOO_PLATE_EMPTY' });
  assert.throws(() => inspectGooRaster(blank), { code: 'GOO_PLATE_EMPTY' });
});

test('both files receive structural RLE/checksum validation including later-layer damage', () => {
  const images = model(), reference = fixture({ images }), plate = fixture({ images: copies(images, placements) });
  const bad = Buffer.from(plate); let offset = HEADER;
  offset += 70 + bad.readUInt32BE(offset + 66) + 2;
  bad[offset + 70 + bad.readUInt32BE(offset + 66) - 1] ^= 1;
  assert.throws(() => verifyGooPlate(reference, bad, { translationsPx: placements }), /checksum.*layer 2/i);
  assert.throws(() => verifyGooPlate(reference.subarray(0, reference.length - 1), plate, { translationsPx: placements }), { code: 'INVALID_GOO' });
  const short = fixture({ images: copies(images, placements), rawTokens: [[0xc0]] });
  assert.throws(() => verifyGooPlate(reference, short, { translationsPx: placements }), { code: 'INVALID_GOO' });
});

test('lower-only file, pixel, layer, segment, copy, operation and deadline limits bound proof work', () => {
  const images = model(), reference = fixture({ images }), plate = fixture({ images: copies(images, placements) });
  for (const lowered of [{ maxFileBytes: 1 }, { maxLayers: 2 }, { maxPixelsPerLayer: 767 }]) assert.throws(() => verifyGooPlate(reference, plate, { translationsPx: placements, limits: lowered }), { code: 'GOO_LIMIT_EXCEEDED' });
  for (const lowered of [{ maxSegmentsPerLayer: 1 }, { maxOperations: 1 }]) assert.throws(() => verifyGooPlate(reference, plate, { translationsPx: placements, limits: lowered }), { code: 'GOO_PLATE_LIMIT' });
  assert.throws(() => verifyGooPlate(reference, plate, { translationsPx: placements, limits: { maxCopies: 3 } }), { code: 'GOO_PLATE_INVALID_OPTIONS' });
  for (const invalid of [{ timeoutMs: 30001 }, { maxOperations: Infinity }, { maxPixelsPerLayer: 100000001 }, { extra: 1 }]) assert.throws(() => inspectGooRaster(reference, { limits: invalid }), { code: 'GOO_PLATE_INVALID_OPTIONS' });
  for (const options of [{ translationsPx: [] }, { translationsPx: [{ x: 0.5, y: 0 }] }, { translationsPx: [{ x: 0, y: 0, z: 0 }] }, { translationsPx: placements, marginPx: { x: 0, y: 1 } }, { translationsPx: placements, minGapPx: -1 }]) assert.throws(() => verifyGooPlate(reference, plate, options), { code: 'GOO_PLATE_INVALID_OPTIONS' });
  // Many tiny legal runs exercise the actual independent parser before the
  // deadline check; the fixture stays a small encoded file, not a native image.
  const dense = new Array(300000).fill(0).map((_, index) => index % 2 ? 1 : 0);
  const slow = fixture({ width: 1000, height: 300, images: [dense] }); inspectGoo(slow);
  assert.throws(() => inspectGooRaster(slow, { limits: { timeoutMs: 1 } }), { code: 'GOO_PLATE_LIMIT' });
});
