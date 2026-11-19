'use strict';

// Native rasterization is the only synthetic boundary. The real plate helper
// writes and independently verifies the source STL, shared-mesh 3MF instances,
// layout, full GOO raster replication and persisted preparation descriptors.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const AdmZip = require('adm-zip');
const { createProfile } = require('./resin-slice');
const { prepareResinGeometry } = require('../../src/slicing/resin-geometry');
const { loadProfile } = require('../../src/slicing/resin-engine');
const { inspectGoo } = require('../../src/slicing/goo');
const { preparePackedResinAttempt } = require('../../src/slicing/resin-plate-engine');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const CHECKS = ['--islands', '--resin-traps', '--suction-cups', '--touching-bounds', '--print-height', '--empty-layers'];
function encodedRun(color, count) {
  const upper = []; let value = Math.floor(count / 16);
  while (value) { upper.unshift(value & 255); value = Math.floor(value / 256); }
  return [(color === 0 ? 0 : color === 255 ? 0xc0 : 0x40) | (upper.length << 4) | (count & 15), ...(color && color !== 255 ? [color] : []), ...upper];
}
function image(pixels) {
  const tokens = [];
  for (let index = 0; index < pixels.length;) {
    let end = index + 1; while (end < pixels.length && pixels[end] === pixels[index]) end++;
    tokens.push(...encodedRun(pixels[index], end - index)); index = end;
  }
  return Buffer.from([0x55, ...tokens, tokens.reduce((sum, byte) => (sum + byte) & 255, 0) ^ 255]);
}
function gooForInstances({ placements, dimensions, profile, ini, omitLast = false }) {
  const expected = profile.expected, props = profile.uvtoolsProperties, width = expected.resolutionX, height = expected.resolutionY;
  const pitch = { x: expected.displayWidthMm / width, y: expected.displayHeightMm / height };
  const lift = (ini.supports_enable === '1' ? Number(ini.support_object_elevation ?? 5) : 0) + (ini.pad_enable === '1' ? Number(ini.pad_wall_thickness ?? 2) : 0);
  const layers = Math.round((dimensions.z + lift) / expected.layerHeightMm), header = Buffer.alloc(195477);
  header.write('V3.0'); Buffer.from([7,0,0,0,68,76,80,0]).copy(header, 4); header.write('Owned native-boundary fixture', 12);
  header.write(profile.printerModel, 92); header.write('DLP', 124); header.write('Fixture resin', 156);
  header.writeUInt16BE(8, 188); header.writeUInt16BE(1, 190); header.writeUInt16BE(0x0d0a, 27106); header.writeUInt16BE(0x0d0a, 195308);
  let offset = 195310;
  const u8 = value => { header[offset++] = value; }, u16 = value => { header.writeUInt16BE(value, offset); offset += 2; }, u32 = value => { header.writeUInt32BE(value, offset); offset += 4; }, float = value => { header.writeFloatBE(value, offset); offset += 4; };
  u32(layers); u16(width); u16(height); u8(Number(expected.mirrorX)); u8(Number(expected.mirrorY));
  [expected.displayWidthMm, expected.displayHeightMm, Number(ini.max_print_height), expected.layerHeightMm, props.ExposureTime].forEach(float); u8(1);
  for (let i = 0; i < 7; i++) float(0);
  float(props.BottomExposureTime); u32(props.BottomLayerCount);
  [props.BottomLiftHeight,props.BottomLiftSpeed,props.LiftHeight,props.LiftSpeed,props.BottomLiftHeight,props.BottomRetractSpeed,props.LiftHeight,props.RetractSpeed,0,0,0,0,0,0,0,0].forEach(float);
  u16(props.BottomLightPWM); u16(props.LightPWM); u8(0); u32(100); [placements.length,1,1].forEach(float); offset += 8; u32(195477); u8(1); u16(0);
  const parts = [header], actual = omitLast ? placements.slice(0, -1) : placements;
  for (let layer = 0; layer < layers; layer++) {
    const pixels = new Uint8Array(width * height);
    for (const placement of actual) {
      const sx = expected.mirrorX ? width - Math.ceil((placement.x + dimensions.x) / pitch.x - 1e-8) : Math.round(placement.x / pitch.x);
      const sy = expected.mirrorY ? Math.round(placement.y / pitch.y) : height - Math.ceil((placement.y + dimensions.y) / pitch.y - 1e-8);
      const columns = Math.ceil(dimensions.x / pitch.x - 1e-8), rows = Math.ceil(dimensions.y / pitch.y - 1e-8);
      for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
        if (sx + x < 0 || sy + y < 0 || sx + x >= width || sy + y >= height) throw new Error('Synthetic native image would be clipped.');
        const index = (sy + y) * width + sx + x;
        if (pixels[index]) throw new Error('Synthetic native instances overlap.');
        pixels[index] = x === 0 || y === 0 || x === columns - 1 || y === rows - 1 ? 127 + layer % 2 : 255;
      }
    }
    const data = image(pixels), definition = Buffer.alloc(70); definition.writeFloatBE(30, 2); definition.writeFloatBE((layer + 1) * expected.layerHeightMm, 6);
    definition.writeFloatBE(layer < props.BottomLayerCount ? props.BottomExposureTime : props.ExposureTime, 10);
    [props.LiftHeight,props.LiftSpeed,0,0,props.LiftHeight,props.RetractSpeed,0,0].forEach((value, index) => definition.writeFloatBE(value, 30 + index * 4));
    definition.writeUInt16BE(props.LightPWM, 62); definition.writeUInt16BE(0x0d0a, 64); definition.writeUInt32BE(data.length, 66);
    parts.push(definition, data, Buffer.from([13,10]));
  }
  parts.push(Buffer.from([0,0,0,7,0,0,0,68,76,80,0])); return Buffer.concat(parts);
}

async function createPlateSliceFixture(root) {
  await fs.mkdir(root, { recursive: true });
  const settings = await createProfile(root), profile = JSON.parse(await fs.readFile(settings.profilePath, 'utf8'));
  profile.expected.resolutionX = 64; profile.expected.resolutionY = 32;
  await fs.writeFile(settings.profilePath, JSON.stringify(profile));
  let preset = await fs.readFile(profile.presetPath, 'utf8'); preset = preset.replace('display_pixels_x=4\n', 'display_pixels_x=64\n').replace('display_pixels_y=2\n', 'display_pixels_y=32\n');
  await fs.writeFile(profile.presetPath, preset);
  const calls = [], renderCalls = [], faults = { omitLastCopy: false, removeProof: false, claimedCopies: null, issues: 0 };
  const prepareResin = async input => {
    calls.push(input); input.signal?.throwIfAborted();
    if (!input.plate) throw new Error('The packed fixture requires an explicit reviewed plate request.');
    const loaded = await loadProfile(input.profilePath), original = await fs.readFile(input.inputPath);
    const normalized = prepareResinGeometry(original, { format: path.extname(input.inputPath).slice(1).toLowerCase(), units: { 1: 'mm', 25.4: 'in', 1000: 'm' }[input.unitScale || 1], sizing: input.sizing || { mode: 'original' } });
    await fs.mkdir(input.outputDir, { recursive: true }); const directory = await fs.mkdtemp(path.join(input.outputDir, 'packed-fixture-'));
    const preparedInput = path.join(directory, 'prepared-input.stl'); await fs.writeFile(preparedInput, normalized.stl, { flag: 'wx' });
    const render = async (filename, targetDirectory, _packed, context = {}) => {
      input.signal?.throwIfAborted();
      const xml = new AdmZip(await fs.readFile(filename)).readAsText('3D/3dmodel.model');
      const points = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map(match => match.slice(1).map(Number));
      const dimensions = Object.fromEntries(['x','y','z'].map((axis, index) => [axis, Math.max(...points.map(point => point[index])) - Math.min(...points.map(point => point[index]))]));
      const placements = [...xml.matchAll(/<item objectid="1" transform="([^"]+)"\/>/g)].map(match => { const values = match[1].split(' ').map(Number); return { x: values[9], y: values[10], z: values[11] }; });
      const bytes = gooForInstances({ placements, dimensions, profile: loaded.profile, ini: loaded.ini, omitLast: faults.omitLastCopy && placements.length > 1 });
      const filePath = path.join(targetDirectory, 'prepared.goo'); await fs.writeFile(filePath, bytes, { flag: 'wx' });
      const effectivePreset = context.presetPath ? await fs.readFile(context.presetPath) : loaded.preset;
      renderCalls.push({ filename, targetDirectory, placements, dimensions, filePath, presetPath: context.presetPath });
      return { filePath, fileName: 'prepared.goo', bytes: bytes.length, sha256: hash(bytes), inspection: inspectGoo(bytes, { limits: { maxFileBytes: 512 * 1024 * 1024 } }),
        analysis: { count: faults.issues, passed: faults.issues === 0, checks: [...CHECKS], issues: Array.from({ length: faults.issues }, () => 'Owned synthetic issue') }, sl1Sha256: hash(Buffer.from(xml)), effectivePresetSha256: hash(effectivePreset), attempts: [] };
    };
    const result = await preparePackedResinAttempt({ sourceNormalizedSTL: normalized.stl, orientation: loaded.profile.orientationCandidates[0], requested: input.plate, profile: loaded.profile, ini: loaded.ini, preset: loaded.preset, directory, render, signal: input.signal });
    const captured = { ...result, sizingPlan: normalized.plan, inputGeometry: { filePath: preparedInput, sha256: normalized.transformedSha256, bytes: normalized.stl.length, bounds: normalized.transformedBounds },
      format: 'goo', sourceSha256: hash(original), profileSha256: loaded.profileSha256, printerId: loaded.profile.printerId, printerModel: loaded.profile.printerModel, material: loaded.profile.material,
      tool: { name: 'Owned injected packed native boundary', version: 'fixture', executableSha256: hash(Buffer.from('Owned injected packed native boundary fixture v1')) }, printReady: false, printerCompatible: false, attempts: [] };
    if (faults.removeProof) delete captured.platePreparation;
    if (faults.claimedCopies !== null) captured.modelCopiesPerRun = faults.claimedCopies;
    return captured;
  };
  return { settings, engine: { prepareResin }, prepareResin, calls, renderCalls, faults,
    async bindPrinter(id) { const updated = JSON.parse(await fs.readFile(settings.profilePath, 'utf8')); updated.printerId = id; await fs.writeFile(settings.profilePath, JSON.stringify(updated)); } };
}

module.exports = { createPlateSliceFixture, gooForInstances };
