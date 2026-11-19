'use strict';
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadProfile } = require('../../src/slicing/resin-engine');
const { inspectGoo } = require('../../src/slicing/goo');
const { buildOrderMetadata } = require('../../src/connectors/layr-client');
const MODEL = readFileSync(path.join(__dirname, '..', 'fixtures', 'resin', 'verification-cube.stl'));
const CONFIRMED = { confirmedRequirements: true, confirmedOriginalSize: true };
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

async function createProfile(root) {
  const profilePath = path.join(root, 'resin-profile.json');
  const presetPath = path.join(root, 'resin-preset.ini');
  const profile = {
    schemaVersion: 1, printerId: 'fixture-printer', printerModel: 'QuickPrint Test', material: 'Synthetic fixture', presetPath,
    expected: { resolutionX: 4, resolutionY: 2, displayWidthMm: 40, displayHeightMm: 20, layerHeightMm: 0.05, mirrorX: false, mirrorY: true },
    orientationCandidates: [{ x: 0, y: 0, z: 0 }],
    uvtoolsProperties: { MachineName: 'QuickPrint Test', LayerHeight: 0.05, ExposureTime: 2, BottomExposureTime: 20, BottomLayerCount: 1, BottomLiftHeight: 5, LiftHeight: 5, BottomLiftSpeed: 100, LiftSpeed: 100, RetractSpeed: 100, BottomRetractSpeed: 100, LightPWM: 255, BottomLightPWM: 255 },
  };
  await fs.writeFile(profilePath, JSON.stringify(profile));
  await fs.writeFile(presetPath, 'printer_technology=SLA\nsla_archive_format=SL1\nhollowing_enable=0\ndisplay_pixels_x=4\ndisplay_pixels_y=2\ndisplay_width=40\ndisplay_height=20\nbed_shape=0x0,40x0,40x20,0x20\ndisplay_mirror_x=0\ndisplay_mirror_y=1\ndisplay_orientation=landscape\nsupports_enable=1\npad_enable=1\nlayer_height=0.05\ninitial_layer_height=0.05\nexposure_time=2\ninitial_exposure_time=20\nmax_print_height=30\n');
  return { prusaExecutable: path.join(root, 'prusa-console.exe'), uvtoolsExecutable: path.join(root, 'UVtoolsCmd.exe'), profilePath, timeoutMs: 10000 };
}

function goo() {
  const header = Buffer.alloc(195477); header.write('V3.0'); Buffer.from([7,0,0,0,68,76,80,0]).copy(header, 4);
  header.write('Test provider', 12); header.write('QuickPrint Test', 92); header.write('DLP', 124); header.write('Test resin', 156);
  header.writeUInt16BE(0x0d0a, 27106); header.writeUInt16BE(0x0d0a, 195308);
  let offset = 195310;
  const u8 = value => { header[offset++] = value; };
  const u16 = value => { header.writeUInt16BE(value, offset); offset += 2; };
  const u32 = value => { header.writeUInt32BE(value, offset); offset += 4; };
  const float = value => { header.writeFloatBE(value, offset); offset += 4; };
  u32(2); u16(4); u16(2); u8(0); u8(1); [40,20,30,0.05,2].forEach(float); u8(1);
  for (let index = 0; index < 7; index++) float(0);
  float(20); u32(1); [5,100,5,100,5,100,5,100,0,0,0,0,0,0,0,0].forEach(float);
  u16(255); u16(255); u8(0); u32(100); float(1); float(1); float(1); offset += 8; u32(195477); u8(1); u16(0);
  const parts = [header];
  for (let layer = 0; layer < 2; layer++) {
    const record = Buffer.alloc(70); record.writeFloatBE(30, 2); record.writeFloatBE((layer + 1) * 0.05, 6); record.writeFloatBE(layer ? 2 : 20, 10);
    [5,100,0,0,5,100,0,0].forEach((value, index) => record.writeFloatBE(value, 30 + index * 4));
    record.writeUInt16BE(255, 62); record.writeUInt16BE(0x0d0a, 64); record.writeUInt32BE(3, 66); parts.push(record, Buffer.from([0x55,0xc8,0x37,13,10]));
  }
  parts.push(Buffer.from([0,0,0,7,0,0,0,68,76,80,0])); return Buffer.concat(parts);
}

async function makeSlice(input, { issues = 0 } = {}) {
  await fs.mkdir(input.outputDir, { recursive: true });
  const directory = await fs.mkdtemp(path.join(input.outputDir, 'capture-'));
  const filePath = path.join(directory, 'prepared.goo'), bytes = goo(); await fs.writeFile(filePath, bytes);
  const loaded = await loadProfile(input.profilePath);
  const prepared = require('../../src/slicing/resin-geometry').prepareResinGeometry(await fs.readFile(input.inputPath), { format: path.extname(input.inputPath).slice(1).toLowerCase(), units: { 1: 'mm', 25.4: 'in', 1000: 'm' }[input.unitScale || 1], sizing: input.sizing || { mode: 'original' } });
  const preparedInput = path.join(directory, 'prepared-input.stl'); await fs.writeFile(preparedInput, prepared.stl, { flag: 'wx' });
  return { filePath, fileName: 'prepared.goo', bytes: bytes.length, format: 'goo', modelCopiesPerRun: 1, sizingPlan: prepared.plan, inputGeometry: { filePath: preparedInput, sha256: prepared.transformedSha256, bytes: prepared.stl.length, bounds: prepared.transformedBounds }, sha256: hash(bytes), sourceSha256: prepared.plan.sourceSha256, profileSha256: loaded.profileSha256, printerId: loaded.profile.printerId, printerModel: loaded.profile.printerModel, material: loaded.profile.material, tool: { name: 'Fixture engine', version: 'test', executableSha256: 'e'.repeat(64) }, inspection: inspectGoo(bytes), analysis: { count: issues, passed: issues === 0, checks: ['--islands', '--resin-traps', '--suction-cups', '--touching-bounds', '--print-height', '--empty-layers'], issues: Array.from({ length: issues }, (_, index) => `Island ${index + 1}`) }, attempts: [], printReady: true, printerCompatible: true };
}

async function importTicket(service, { units = 'mm', project = {}, data = MODEL, fileName = 'source.stl' } = {}) {
  const id = crypto.randomUUID(), portalUrl = 'https://printbylayr.example';
  const portalJob = { id, reference: `PBL-${id.toUpperCase()}`, version: 5, status: 'preparing', payment: { amountCents: 2000, confirmedAt: '2026-11-19T15:00:00Z' }, ticket: { model: { size: data.length, fileId: 'private-fixture' }, quote: { amountCents: 2000 }, specifications: { file: { name: fileName, format: path.extname(fileName).slice(1).toLowerCase(), sizeBytes: data.length, units }, project: { name: 'Resin study', quantity: 4, notes: 'Review geometry.', ...project }, production: { printType: 'resin', supports: 'allowed', qualityTier: 'standard', properties: 'standard', colour: 'grey' } } } };
  const order = buildOrderMetadata(portalJob, portalUrl, data);
  return (await service.submit({ source: `layr:${portalUrl}`, sourceId: `${id}:${order.ticketFingerprint}`, quantity: 1, order, files: [{ name: fileName, data }] })).jobs[0];
}

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
module.exports = { MODEL, CONFIRMED, hash, createProfile, goo, makeSlice, importTicket, deferred };
