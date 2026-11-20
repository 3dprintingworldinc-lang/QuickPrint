'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const Zip = require('adm-zip');
const { MODEL, goo } = require('./resin-slice');
const { prepareResinGeometry } = require('../../src/slicing/resin-geometry');
const { prepareResinHollowPlan, createResinHollow3mf } = require('../../src/slicing/resin-hollow-plan');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = prepareResinGeometry(MODEL, { format: 'stl', units: 'mm', sizing: { mode: 'dimension', axis: 'z', millimeters: 20 } }).stl;
const binding = { sourceSha256: hash(MODEL), geometrySha256: hash(source), sizingSha256: hash('Owned 20 mm fixture review') };
const placement = { x: 10, y: 10, z: 0 };
function request() { return { binding: { ...binding }, orientation: { x: 0, y: 0, z: 0 }, wallThicknessMm: 2, quality: 0.75, closingDistanceMm: 0,
  drains: [6, 14].map((x, index) => ({ id: `bottom-${index}`, startMm: { x, y: 10, z: 0 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: 2, lengthMm: 5 })) }; }
function preset(hollow = false) {
  const fields = { printer_technology: 'SLA', display_orientation: 'landscape', display_mirror_x: 0, display_mirror_y: 0, display_pixels_x: 200, display_pixels_y: 200, display_width: 40, display_height: 40,
    max_print_height: 30, layer_height: 0.2, initial_layer_height: 0.2, exposure_time: 2, initial_exposure_time: 20, supports_enable: 0, pad_enable: 0, zcorrection_layers: 0,
    relative_correction: '1,1', relative_correction_x: 1, relative_correction_y: 1, relative_correction_z: 1, material_correction: '1,1,1', material_correction_x: 1, material_correction_y: 1, material_correction_z: 1,
    hollowing_enable: Number(hollow), hollowing_min_thickness: 2, hollowing_quality: 0.75, hollowing_closing_distance: 0 };
  return Buffer.from(Object.entries(fields).map(([key, value]) => `${key} = ${value}\n`).join(''));
}
function run(color, count) {
  const high = []; let n = Math.floor(count / 16);
  while (n) { high.unshift(n & 255); n = Math.floor(n / 256); }
  return [(color === 0 ? 0 : color === 255 ? 0xc0 : 0x40) | high.length << 4 | count & 15, ...(color !== 0 && color !== 255 ? [color] : []), ...high];
}
function raster(kind = 'solid') {
  const base = goo(), header = Buffer.from(base.subarray(0, 195477));
  header.writeUInt32BE(100, 195310); header.writeUInt16BE(200, 195314); header.writeUInt16BE(200, 195316);
  header[195319] = 0; header.writeFloatBE(40, 195324); header.writeFloatBE(0.2, 195332);
  const parts = [header];
  for (let z = 0; z < 100; z++) {
    const pixels = Buffer.alloc(40000), zz = (z + 0.5) * 0.2;
    for (let y = 50; y < 150; y++) for (let x = 50; x < 150; x++) {
      const xx = (x + 0.5) * 0.2 - 10, yy = 40 - (y + 0.5) * 0.2 - 10;
      const drain = [6, 14].some(center => (xx - center) ** 2 + (yy - 10) ** 2 <= 4 && zz <= 5);
      const cavity = xx >= 2 && xx < 18 && yy >= 2 && yy < 18 && zz >= 2 && zz < 18;
      let value = kind === 'solid' || (!cavity && !(drain && kind !== 'sealed')) ? 255 : 0;
      if (kind === 'half-cavity' && cavity && xx >= 10 && !drain) value = 255;
      if (kind === 'gray' && z === 50 && x === 100 && y === 100) value = 128;
      pixels[y * 200 + x] = value;
    }
    if (kind === 'outside' && z === 50) pixels[49 * 200 + 50] = 255;
    const tokens = [];
    for (let i = 0; i < pixels.length;) { let end = i + 1; while (end < pixels.length && pixels[end] === pixels[i]) end++; tokens.push(...run(pixels[i], end - i)); i = end; }
    const image = Buffer.from([0x55, ...tokens, tokens.reduce((sum, value) => (sum + value) & 255, 0) ^ 255]);
    const definition = Buffer.from(base.subarray(195477, 195547)); definition.writeFloatBE((z + 1) * 0.2, 6); definition.writeFloatBE(z ? 2 : 20, 10); definition.writeUInt32BE(image.length, 66);
    parts.push(definition, image, Buffer.from([13, 10]));
  }
  parts.push(Buffer.from([0, 0, 0, 7, 0, 0, 0, 68, 76, 80, 0])); return Buffer.concat(parts);
}
const solidBytes = raster('solid'), hollowBytes = raster('hollow');
async function fixture(t, kind = 'hollow') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-hollow-audit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const solidPath = path.join(directory, 'solid.goo'), hollowPath = path.join(directory, 'hollow.goo');
  const processed = kind === 'hollow' ? hollowBytes : raster(kind);
  await fs.writeFile(solidPath, solidBytes); await fs.writeFile(hollowPath, processed);
  const { plan } = prepareResinHollowPlan(source, request()), native = createResinHollow3mf(source, plan, binding, placement).threeMf;
  const solidZip = new Zip(native); solidZip.deleteFile(plan.native.drainMetadataPath);
  return { directory, source: Buffer.from(source), plan, expectedBinding: { ...binding }, provider: { name: 'PrusaSlicer', version: '2.9.7', sha256: hash('Owned fixture provider') }, placement: { ...placement },
    targetProperties: { MachineName: 'QuickPrint Test', LayerHeight: 0.2, ExposureTime: 2, BottomExposureTime: 20, BottomLayerCount: 1, BottomLiftHeight: 5, LiftHeight: 5, BottomLiftSpeed: 100, LiftSpeed: 100, RetractSpeed: 100, LightPWM: 255, BottomLightPWM: 255 },
    solid: { filePath: solidPath, sha256: hash(solidBytes), input3mf: solidZip.toBuffer(), effectivePreset: preset(false) },
    hollow: { filePath: hollowPath, sha256: hash(processed), input3mf: native, effectivePreset: preset(true) }, policy: { reduction: { x: 1, y: 1, z: 1 }, maximumUncertaintyMm: 0.5 } };
}
module.exports = { fixture, raster, hash, source, request, binding, preset };
