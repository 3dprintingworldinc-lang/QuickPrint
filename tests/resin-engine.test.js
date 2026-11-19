'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { prepareResin, loadProfile, parseIni, parseIssueReport, inspectSl1, parameterScript, assertTargetProperties } = require('../src/slicing/resin-engine');
const { measureResinGeometry, prepareResinGeometry, float32Tolerance } = require('../src/slicing/resin-geometry');

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const HEADER_SIZE = 195477;
const PRESET = {
  printer_technology: 'SLA', sla_archive_format: 'SL1', hollowing_enable: '0',
  display_pixels_x: '4', display_pixels_y: '2', display_width: '40', display_height: '20',
  bed_shape: '0x0,40x0,40x20,0x20',
  display_mirror_x: '0', display_mirror_y: '1', display_orientation: 'landscape',
  supports_enable: '1', pad_enable: '1', layer_height: '0.05', initial_layer_height: '0.05',
  exposure_time: '2', initial_exposure_time: '20', max_print_height: '30',
};
const ini = values => Object.entries(values).map(([key, value]) => `${key} = ${value}`).join('\n') + '\n';

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width = 4, height = 2) {
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length);
    const suffix = Buffer.alloc(4); suffix.writeUInt32BE(crc32(bytes));
    return Buffer.concat([prefix, bytes, suffix]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8;
  const raw = Buffer.alloc((width + 1) * height, 255);
  for (let row = 0; row < height; row++) raw[row * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function sl1({ effective = {}, config = {}, gap = false, dimensions = [4, 2], missingPreset = false } = {}) {
  const zip = new AdmZip();
  if (!missingPreset) zip.addFile('prusaslicer.ini', Buffer.from(ini({ ...PRESET, ...effective })));
  zip.addFile('config.ini', Buffer.from(ini({ layerHeight: '0.05', numFast: '1', numSlow: '1', ...config })));
  zip.addFile('prepared00000.png', png(...dimensions));
  zip.addFile(gap ? 'prepared00002.png' : 'prepared00001.png', png(...dimensions));
  return zip.toBuffer();
}

function goo() {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('V3.0'); Buffer.from([7,0,0,0,68,76,80,0]).copy(header, 4);
  header.write('Test provider', 12); header.write('QuickPrint Test', 92); header.write('DLP', 124); header.write('Test resin', 156);
  header.writeUInt16BE(0x0d0a, 27106); header.writeUInt16BE(0x0d0a, 195308);
  let offset = 195310;
  const u8 = value => { header[offset++] = value; };
  const u16 = value => { header.writeUInt16BE(value, offset); offset += 2; };
  const u32 = value => { header.writeUInt32BE(value, offset); offset += 4; };
  const float = value => { header.writeFloatBE(value, offset); offset += 4; };
  u32(2); u16(4); u16(2); u8(0); u8(1);
  [40,20,30,0.05,2].forEach(float); u8(1);
  for (let i = 0; i < 7; i++) float(0);
  float(20); u32(1);
  [5,100,5,100,5,100,5,100,0,0,0,0,0,0,0,0].forEach(float);
  u16(255); u16(255); u8(0); u32(100); float(1); float(1); float(1); offset += 8;
  u32(HEADER_SIZE); u8(1); u16(0);
  assert.equal(offset, HEADER_SIZE);
  const parts = [header];
  for (let layer = 0; layer < 2; layer++) {
    const record = Buffer.alloc(70); record.writeFloatBE(30, 2); record.writeFloatBE((layer + 1) * 0.05, 6);
    record.writeFloatBE(layer ? 2 : 20, 10);
    [5,100,0,0,5,100,0,0].forEach((value, index) => record.writeFloatBE(value, 30 + index * 4));
    record.writeUInt16BE(255, 62); record.writeUInt16BE(0x0d0a, 64); record.writeUInt32BE(3, 66);
    parts.push(record, Buffer.from([0x55,0xc8,0x37,13,10]));
  }
  parts.push(Buffer.from([0,0,0,7,0,0,0,68,76,80,0]));
  return Buffer.concat(parts);
}

async function fixture(t, changes = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = await fs.readFile(path.join(__dirname, 'fixtures', 'resin', 'verification-cube.stl'));
  const profile = {
    schemaVersion: 1, printerId: 'fixture-printer', printerModel: 'QuickPrint Test', material: 'Synthetic fixture', presetPath: 'preset.ini',
    expected: { resolutionX: 4, resolutionY: 2, displayWidthMm: 40, displayHeightMm: 20, layerHeightMm: 0.05, mirrorX: false, mirrorY: true },
    orientationCandidates: [{ x: 0, y: 0, z: 0 }, { x: 30, y: 15, z: 0 }, { x: 45, y: 45, z: 0 }],
    uvtoolsProperties: { MachineName: 'QuickPrint Test', LayerHeight: 0.05, ExposureTime: 2, BottomExposureTime: 20, BottomLayerCount: 1, BottomLiftHeight: 5, LiftHeight: 5, BottomLiftSpeed: 100, LiftSpeed: 100, RetractSpeed: 100, BottomRetractSpeed: 100, LightPWM: 255, BottomLightPWM: 255 },
    ...changes,
  };
  const options = { inputPath: path.join(root, 'original model.stl'), outputDir: path.join(root, 'output'), profilePath: path.join(root, 'profile.json'), prusaExecutable: path.join(root, 'prusa.exe'), uvtoolsExecutable: path.join(root, 'uvtools.exe') };
  await fs.writeFile(options.inputPath, original); await fs.writeFile(options.profilePath, JSON.stringify(profile));
  await fs.writeFile(path.join(root, 'preset.ini'), ini(PRESET));
  await fs.writeFile(options.prusaExecutable, 'prusa binary fixture'); await fs.writeFile(options.uvtoolsExecutable, 'uvtools binary fixture');
  await fs.writeFile(path.join(root, 'PrusaSlicer.dll'), 'prusa core fixture');
  await fs.writeFile(path.join(root, 'UVtools.Core.dll'), 'uvtools core fixture');
  await fs.writeFile(path.join(root, 'UVtoolsCmd.dll'), 'uvtools command fixture');
  return { root, options, profile, original };
}

function provider({ version = '7.1.2', issues = [0], archiveOptions, noGoo = false, noReceipt = false, wrongReceipt = false, mutateProperties, error, mutateOnAnalysis, mutateSource, inspectInput, exitOne = false } = {}) {
  const calls = [];
  const run = async (executable, args, options) => {
    calls.push({ executable, args, options });
    options.signal?.throwIfAborted();
    if (args[0] === '--help') return 'PrusaSlicer-2.9.7\n --export-sla\n';
    if (args[0] === '--core-version') return version;
    if (error) throw error;
    if (args.includes('--export-sla')) {
      assert.equal(path.basename(args.at(-1)), 'prepared-input.stl');
      assert.equal(args[args.indexOf('--scale') + 1], '1', 'all unit and sizing transforms must be embodied in input bytes');
      if (inspectInput) await inspectInput(args.at(-1), args);
      const output = args[args.indexOf('--output') + 1];
      await fs.writeFile(output, sl1(archiveOptions));
      if (mutateSource) await mutateSource();
      return 'Sliced fixture';
    }
    if (exitOne && !options.acceptedExitCodes?.includes(1)) throw Object.assign(new Error('Exit 1'), { code: 'SLICER_FAILED' });
    if (args[1] === 'convert') { if (!noGoo) await fs.writeFile(args[4], goo()); return 'Converted fixture'; }
    if (args[1] === 'run') {
      assert.equal(path.basename(args[3]), 'target-parameters.cs');
      const script = await fs.readFile(args[3], 'utf8');
      assert.match(script, /QuickPrintParameters : ScriptGlobals/);
      const receipt = /File\.WriteAllText\(\s*("(?:\\.|[^"\\])*"),\s*("(?:\\.|[^"\\])*")\s*\)/.exec(script);
      assert.ok(receipt, 'the generated trusted script must contain the application receipt');
      if (!noReceipt) await fs.writeFile(JSON.parse(receipt[1]), wrongReceipt ? 'wrong profile fingerprint' : JSON.parse(receipt[2]));
      if (mutateProperties) await mutateProperties(args[2]);
      return 'Properties updated';
    }
    if (args[1] === 'print-issues') {
      if (mutateOnAnalysis) await mutateOnAnalysis(args[2]);
      const index = Number(/attempt-(\d+)/.exec(args[2])[1]) - 1;
      const count = issues[Math.min(index, issues.length - 1)];
      return `Issues: ${count}\n` + Array.from({ length: count }, (_, i) => `Island fixture ${i + 1}`).join('\n');
    }
    throw new Error(`Unexpected command ${args.join(' ')}`);
  };
  return { run, calls };
}

test('standalone resin profile validates metadata, explicit geometry and hashed preset snapshot', async t => {
  const f = await fixture(t);
  const loaded = await loadProfile(f.options.profilePath);
  assert.equal(loaded.profile.printerId, 'fixture-printer');
  assert.match(loaded.profileSha256, /^[a-f0-9]{64}$/);
  assert.equal(loaded.ini.supports_enable, '1');
  await fs.writeFile(path.join(f.root, 'preset.ini'), ini({ ...PRESET, display_pixels_x: '8' }));
  await assert.rejects(loadProfile(f.options.profilePath), { code: 'RESIN_PROFILE_INVALID' });
  assert.throws(() => parseIni('[printer]\nlayer_height=0.05'), { code: 'RESIN_PROFILE_INVALID' });
  assert.throws(() => parseIni('a=1\na=2'), { code: 'RESIN_PROFILE_INVALID' });
});

test('profile rejects inherited/unsafe hollow presets and invalid orientation candidates', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'preset.ini'), ini({ ...PRESET, hollowing_enable: '1' }));
  await assert.rejects(loadProfile(f.options.profilePath), { code: 'RESIN_DRAIN_PLAN_REQUIRED' });
  await fs.writeFile(path.join(f.root, 'preset.ini'), ini({ ...PRESET, inherits: 'Some machine' }));
  await assert.rejects(loadProfile(f.options.profilePath), { code: 'RESIN_PROFILE_INVALID' });
  await fs.writeFile(path.join(f.root, 'preset.ini'), ini(PRESET));
  await fs.writeFile(f.options.profilePath, JSON.stringify({ ...f.profile, orientationCandidates: [{ x: NaN, y: 0, z: 0 }] }));
  await assert.rejects(loadProfile(f.options.profilePath), { code: 'RESIN_PROFILE_INVALID' });
});

test('profile bed follows a reviewed zero-origin rectangle and explicitly bounds machine height', async t => {
  const f = await fixture(t);
  for (const bed_shape of ['0x0,40x0,40x20,0x20', '40x20,40x0,0x0,0x20,40x20', '0x20,0x0,40x0,40x20', '0.0000001x0,40x0,40x20,0x20']) {
    await fs.writeFile(path.join(f.root, 'preset.ini'), ini({ ...PRESET, bed_shape }));
    assert.equal((await loadProfile(f.options.profilePath)).ini.bed_shape, bed_shape);
  }
  for (const bed_shape of [undefined, '', '0x0,39x0,39x20,0x20', '0x0,41x0,41x20,0x20', '1x0,41x0,41x20,1x20', '0x0,40x20,40x0,0x20', '0x0,40x0,40x20,0x20,1x0', '0x0,40x0,40x20,0x0', '0x0,40x0,40x20', '0x0,Infinityx0,40x20,0x20']) {
    const preset = { ...PRESET, bed_shape }; if (bed_shape === undefined) delete preset.bed_shape;
    await fs.writeFile(path.join(f.root, 'preset.ini'), ini(preset));
    const mock = provider();
    await assert.rejects(prepareResin(f.options, mock), { code: 'RESIN_PROFILE_INVALID' });
    assert.equal(mock.calls.length, 0);
  }
  for (const max_print_height of [undefined, '', 'NaN', 'Infinity', '0', '-1', '10001']) {
    const preset = { ...PRESET, max_print_height }; if (max_print_height === undefined) delete preset.max_print_height;
    await fs.writeFile(path.join(f.root, 'preset.ini'), ini(preset));
    await assert.rejects(loadProfile(f.options.profilePath), { code: 'RESIN_PROFILE_INVALID' });
  }
  await fs.writeFile(path.join(f.root, 'preset.ini'), ini(PRESET));
  for (const machineZMm of [29, '30', null]) {
    await fs.writeFile(f.options.profilePath, JSON.stringify({ ...f.profile, expected: { ...f.profile.expected, machineZMm } }));
    await assert.rejects(loadProfile(f.options.profilePath), { code: 'RESIN_PROFILE_INVALID' });
  }
  await fs.writeFile(f.options.profilePath, JSON.stringify({ ...f.profile, expected: { ...f.profile.expected, machineZMm: 30 } }));
  assert.equal((await loadProfile(f.options.profilePath)).profile.expected.machineZMm, 30);
});

test('a credential-bearing preset is rejected before providers run or a job snapshot is written', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'preset.ini'), ini({ ...PRESET, printhost_apikey: 'private-fixture-key' }));
  let calls = 0;
  await assert.rejects(prepareResin(f.options, { run: async () => { calls++; return ''; } }), { code: 'RESIN_PROFILE_CREDENTIALS' });
  assert.equal(calls, 0);
  const entries = await fs.readdir(f.options.outputDir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.equal(entries.length, 0);
});

test('SLA archive checks effective layer counts, PNG dimensions, technology, height and sequence', () => {
  const expected = { resolutionX: 4, resolutionY: 2, displayWidthMm: 40, displayHeightMm: 20, machineZMm: 30, layerHeightMm: 0.05, mirrorX: false, mirrorY: true };
  assert.equal(inspectSl1(sl1(), expected).layerCount, 2);
  for (const options of [{ gap: true }, { dimensions: [8, 2] }, { config: { numFast: '3' } }, { effective: { printer_technology: 'FFF' } }, { config: { layerHeight: '0.1' } }, { missingPreset: true }]) {
    assert.throws(() => inspectSl1(sl1(options), expected), { code: 'RESIN_ARCHIVE_INVALID' });
  }
  for (const effective of [{ display_width: '41' }, { display_pixels_x: '8' }, { display_mirror_y: '0' }, { display_orientation: 'portrait' }, { bed_shape: '0x0,39x0,39x20,0x20' }, { bed_shape: '0x0,40x20,40x0,0x20' }, { max_print_height: '29' }, { max_print_height: 'NaN' }]) {
    assert.throws(() => inspectSl1(sl1({ effective }), expected), { code: 'RESIN_EFFECTIVE_PROFILE_MISMATCH' });
  }
});

test('issue report must be complete and rejects progress noise, duplicate summaries or missing details', () => {
  assert.equal(parseIssueReport('Issues: 0\n').passed, true);
  assert.equal(parseIssueReport('Issues: 2\nIsland first\nResin trap second\n').count, 2);
  for (const report of ['', 'Progress\nIssues: 0', 'Issues: 2\nOnly one detail', 'Issues: 0\nUnexpected detail', 'Issues: 1\nIssues: 0']) {
    assert.throws(() => parseIssueReport(report), { code: 'RESIN_ANALYSIS_INVALID' });
  }
});

test('orientation search stops at first issue-free artifact and preserves source/preset/evidence hashes', async t => {
  const f = await fixture(t); const mock = provider({ issues: [2, 0, 0] });
  const result = await prepareResin(f.options, mock);
  assert.equal(result.status, 'sliced_pending_qualification');
  assert.equal(result.printReady, false); assert.equal(result.printerCompatible, false);
  assert.equal(result.modelCopiesPerRun, 1);
  assert.deepEqual(result.orientation, f.profile.orientationCandidates[1]);
  assert.equal(result.attempts.length, 2);
  assert.equal(mock.calls.filter(call => call.args.includes('--export-sla')).length, 2);
  assert.equal(result.sourceSha256, sha(f.original));
  assert.equal(result.sha256, sha(await fs.readFile(result.filePath)));
  assert.equal(result.inspection.validatedLayerData, true);
  assert.deepEqual(await fs.readFile(f.options.inputPath), f.original);
  const evidence = JSON.parse(await fs.readFile(path.join(path.dirname(result.filePath), 'evidence.json'), 'utf8'));
  assert.equal(evidence.sha256, result.sha256);
  assert.equal(evidence.profileSha256, result.profileSha256);
  assert.equal(evidence.modelCopiesPerRun, 1);
  assert.ok(mock.calls.filter(call => call.args.includes('--export-sla')).every(call =>
    !call.args.some(argument => /^--duplicate(?:-grid)?(?:=|$)/.test(argument))),
  'single-instance evidence must never invoke Prusa duplication or grid duplication');
  const slice = mock.calls.find(call => call.args.includes('--export-sla'));
  assert.notEqual(slice.args.at(-1), f.options.inputPath);
  assert.equal(slice.args.at(-1), result.inputGeometry.filePath);
  assert.deepEqual(await fs.readFile(path.join(path.dirname(result.inputGeometry.filePath), 'source.stl')), f.original);
  assert.equal(result.inputGeometry.sha256, sha(await fs.readFile(slice.args.at(-1))));
  assert.equal(result.sizingPlan.sourceSha256, sha(f.original));
  assert.deepEqual(result.sizingPlan.dimensionsMm, { x: 3, y: 3, z: 3 });
  assert.deepEqual(evidence.inputGeometry, result.inputGeometry);
  assert.deepEqual(evidence.sizingPlan, result.sizingPlan);
  assert.ok(result.tool.binaryManifest.some(item => item.name === 'quickprint-resin-geometry'));
});

test('all failing orientations remain analysis_failed and select the fewest reported issues', async t => {
  const f = await fixture(t); const result = await prepareResin(f.options, provider({ issues: [3, 1, 2] }));
  assert.equal(result.status, 'analysis_failed'); assert.equal(result.analysis.count, 1);
  assert.equal(result.attempts.length, 3); assert.equal(result.printReady, false);
});

test('unit conversion and requested uniform sizing are measurable in the exact STL supplied to every SLA candidate', async t => {
  const f = await fixture(t);
  for (const [unitScale, sizing, millimeters] of [
    [1, { mode: 'scale', factor: 2 }, 6],
    [25.4, { mode: 'scale', factor: 0.1 }, 7.62],
    [1000, { mode: 'scale', factor: 0.001 }, 3],
  ]) {
    let checked = 0;
    const mock = provider({ issues: [1, 0], inspectInput: async filename => {
      checked++;
      const measured = measureResinGeometry(await fs.readFile(filename), { format: 'stl', units: 'mm' });
      for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(measured.sourceDimensionsMm[axis] - millimeters) <= float32Tolerance(millimeters));
    } });
    const result = await prepareResin({ ...f.options, unitScale, sizing }, mock);
    assert.equal(checked, 2);
    assert.deepEqual(result.sizingPlan.requestedSizing, sizing);
    assert.equal(result.sizingPlan.unitScale, unitScale);
    assert.equal(result.sizingPlan.uniformScale, sizing.factor);
    assert.equal(result.inputGeometry.bytes, 84 + 12 * 50);
    assert.notEqual(result.sourceSha256, result.inputGeometry.sha256);
    assert.deepEqual(await fs.readFile(f.options.inputPath), f.original);
  }
});

test('dimension sizing uses source axes before rotations and preserves all components with one global origin translation', async t => {
  const f = await fixture(t);
  const original = Buffer.from(f.original.toString().replace(/vertex ([^\s]+) ([^\s]+) ([^\s]+)/g, (_, x, y, z) => `vertex ${Number(x) + 120} ${Number(y) * 2 - 25} ${Number(z) * 3 + 9}`));
  await fs.writeFile(f.options.inputPath, original);
  const sizing = { mode: 'dimension', axis: 'y', millimeters: 12 };
  const expected = prepareResinGeometry(original, { format: 'stl', units: 'mm', sizing });
  const result = await prepareResin({ ...f.options, sizing }, provider({ issues: [1, 0], inspectInput: async filename => {
    assert.deepEqual(await fs.readFile(filename), expected.stl);
  } }));
  assert.deepEqual(result.sizingPlan.sourceBounds, { min: { x: 120, y: -25, z: 9 }, max: { x: 123, y: -19, z: 18 } });
  assert.deepEqual(result.sizingPlan.sourceDimensionsMm, { x: 3, y: 6, z: 9 });
  assert.deepEqual(result.sizingPlan.dimensionsMm, { x: 6, y: 12, z: 18 });
  assert.deepEqual(result.inputGeometry.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 12, z: 18 } });
  assert.equal(result.sizingPlan.uniformScale, 2);
  assert.deepEqual(await fs.readFile(f.options.inputPath), original);
});

test('triangulated OBJ is normalized to measured STL and malformed source or sizing is rejected before provider calls', async t => {
  const f = await fixture(t);
  const vertices = [...f.original.toString().matchAll(/vertex ([^\s]+) ([^\s]+) ([^\s]+)/g)].map(match => match.slice(1).join(' '));
  const obj = Buffer.from(vertices.map(vertex => `v ${vertex}`).join('\n') + '\n' + Array.from({ length: vertices.length / 3 }, (_, index) => `f ${index * 3 + 1} ${index * 3 + 2} ${index * 3 + 3}`).join('\n'));
  const inputPath = path.join(f.root, 'original.obj'); await fs.writeFile(inputPath, obj);
  const result = await prepareResin({ ...f.options, inputPath, sizing: { mode: 'dimension', axis: 'z', millimeters: 9 } }, provider({ inspectInput: async filename => {
    assert.equal(path.extname(filename), '.stl');
    assert.deepEqual(measureResinGeometry(await fs.readFile(filename), { format: 'stl', units: 'mm' }).sourceDimensionsMm, { x: 9, y: 9, z: 9 });
  } }));
  assert.equal(result.sourceSha256, sha(obj));
  assert.deepEqual(await fs.readFile(inputPath), obj);
  for (const sizing of [null, {}, { mode: 'scale', factor: 0 }, { mode: 'dimension', axis: 'w', millimeters: 5 }, { mode: 'original', factor: 2 }]) {
    const mock = provider();
    await assert.rejects(prepareResin({ ...f.options, sizing }, mock), { code: 'RESIN_SIZING_INVALID' });
    assert.equal(mock.calls.length, 0);
  }
  await fs.writeFile(f.options.inputPath, 'solid empty\nendsolid empty\n');
  const mock = provider();
  await assert.rejects(prepareResin(f.options, mock), { code: 'RESIN_GEOMETRY_INVALID' });
  assert.equal(mock.calls.length, 0);
});

test('a changed prepared mesh is refused before a later candidate and before the final result', async t => {
  const f = await fixture(t);
  for (const [issues, mutation] of [[[1, 0], 'coordinate'], [[0], 'coordinate'], [[0], 'length']]) {
    let inputPath;
    const mock = provider({ issues, inspectInput: async filename => { inputPath = filename; }, mutateOnAnalysis: async () => {
      const bytes = await fs.readFile(inputPath);
      if (mutation === 'coordinate') { bytes.writeFloatLE(bytes.readFloatLE(96) + 0.5, 96); await fs.writeFile(inputPath, bytes); }
      else await fs.appendFile(inputPath, Buffer.from([0]));
    } });
    await assert.rejects(prepareResin(f.options, mock), { code: 'RESIN_INPUT_GEOMETRY_CHANGED' });
    assert.equal(mock.calls.filter(call => call.args.includes('--export-sla')).length, 1);
  }
});

test('rotated whole-source extents reject clipping candidates while allowing a fitting alternative', async t => {
  const f = await fixture(t, { orientationCandidates: [{ x: 0, y: 0, z: 90 }, { x: 0, y: 0, z: 0 }] });
  const original = Buffer.from(f.original.toString().replace(/vertex ([^\s]+) ([^\s]+) ([^\s]+)/g, (_, x, y, z) => `vertex ${Number(x) * 10} ${y} ${z}`));
  await fs.writeFile(f.options.inputPath, original);
  const mock = provider(); const result = await prepareResin(f.options, mock);
  assert.equal(mock.calls.filter(call => call.args.includes('--export-sla')).length, 1);
  assert.deepEqual(result.orientation, { x: 0, y: 0, z: 0 });
  assert.equal(result.rejectedOrientations.length, 1);
  assert.equal(result.rejectedOrientations[0].reason, 'RESIN_MODEL_OUT_OF_BOUNDS');
  assert.ok(Math.abs(result.rejectedOrientations[0].sourceOrientationGeometry.dimensionsMm.y - 30) < 0.000001);
  assert.deepEqual(result.sourceOrientationGeometry.dimensionsMm, { x: 30, y: 3, z: 3 });
  assert.equal(result.sourceOrientationGeometry.sourceSha256, result.inputGeometry.sha256);
  const evidence = JSON.parse(await fs.readFile(path.join(path.dirname(result.filePath), 'evidence.json'), 'utf8'));
  assert.deepEqual(evidence.sourceOrientationGeometry, result.sourceOrientationGeometry);
});

test('no provider export can omit oversized source geometry merely because the output raster would have valid dimensions', async t => {
  const f = await fixture(t, { orientationCandidates: [{ x: 0, y: 0, z: 0 }] });
  for (const multiplier of [{ x: 14, y: 1, z: 1 }, { x: 1, y: 7, z: 1 }, { x: 1, y: 1, z: 11 }]) {
    await fs.writeFile(f.options.inputPath, Buffer.from(f.original.toString().replace(/vertex ([^\s]+) ([^\s]+) ([^\s]+)/g, (_, x, y, z) => `vertex ${Number(x) * multiplier.x} ${Number(y) * multiplier.y} ${Number(z) * multiplier.z}`)));
    const mock = provider();
    await assert.rejects(prepareResin(f.options, mock), { code: 'RESIN_MODEL_OUT_OF_BOUNDS' });
    assert.equal(mock.calls.filter(call => call.args.includes('--export-sla')).length, 0);
    assert.equal(mock.calls.filter(call => call.args[0] === '--quiet').length, 0);
  }
});

test('only known UVtools 4.4.3 receives legacy exit-one acceptance and still needs real outputs', async t => {
  const f = await fixture(t); const legacy = provider({ version: '4.4.3', exitOne: true });
  const result = await prepareResin(f.options, legacy);
  assert.equal(result.analysis.passed, true);
  assert.ok(legacy.calls.filter(call => call.args[0] === '--quiet').every(call => call.options.acceptedExitCodes.includes(1)));
  await assert.rejects(prepareResin(f.options, provider({ version: '7.1.2', exitOne: true })), { code: 'SLICER_FAILED' });
  await assert.rejects(prepareResin(f.options, provider({ version: '4.4.3', exitOne: true, noGoo: true })));
});

test('native process cancellation and timeout failures propagate and receive bounded options', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareResin({ ...f.options, signal: controller.signal }, provider()), { name: 'AbortError' });
  const timeout = Object.assign(new Error('Fixture timeout'), { code: 'SLICER_TIMEOUT' });
  await assert.rejects(prepareResin(f.options, provider({ error: timeout })), { code: 'SLICER_TIMEOUT' });
  const mock = provider(); await prepareResin({ ...f.options, timeoutMs: 3210 }, mock);
  assert.ok(mock.calls.every(call => call.options.timeoutMs === (call.args[0] === '--help' || call.args[0] === '--core-version' ? 15000 : 3210)));
});

test('invalid timeouts fail before invoking a provider', async t => {
  const f = await fixture(t);
  for (const timeoutMs of [0, 999, -1000, 1000.5, NaN, Infinity, '3210', 3600001]) {
    const mock = provider();
    await assert.rejects(prepareResin({ ...f.options, timeoutMs }, mock), { code: 'RESIN_ENGINE_CONFIGURATION' });
    assert.equal(mock.calls.length, 0);
  }
});

test('custom per-layer exposure/movement mode requires separate qualification', async t => {
  const f = await fixture(t);
  const mock = provider({ mutateProperties: async file => {
    const bytes = await fs.readFile(file); bytes[195445] = 1; await fs.writeFile(file, bytes);
  } });
  await assert.rejects(prepareResin(f.options, mock), { code: 'RESIN_PER_LAYER_PROFILE_UNSUPPORTED' });
  assert.equal(mock.calls.filter(call => call.args[1] === 'print-issues').length, 0);
});

test('source changes during slicing are detected before returning an artifact', async t => {
  const f = await fixture(t);
  const mock = provider({ mutateSource: () => fs.writeFile(f.options.inputPath, 'changed original') });
  await assert.rejects(prepareResin(f.options, mock), { code: 'ORIGINAL_CHANGED' });
});

test('an output that fails independent GOO checks cannot reach issue analysis', async t => {
  const f = await fixture(t); const mock = provider();
  const run = async (...args) => {
    const result = await mock.run(...args);
    if (args[1][1] === 'run') { const file = args[1][2]; const bytes = await fs.readFile(file); bytes[HEADER_SIZE + 72] ^= 1; await fs.writeFile(file, bytes); }
    return result;
  };
  await assert.rejects(prepareResin(f.options, { run }), { code: 'INVALID_GOO' });
  assert.equal(mock.calls.filter(call => call.args[1] === 'print-issues').length, 0);
});

test('regression: effective pad policy changes must fail', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareResin(f.options, provider({ archiveOptions: { effective: { pad_enable: '0' } } })), { code: 'RESIN_EFFECTIVE_PROFILE_MISMATCH' });
});

test('regression: changing GOO bytes during issue analysis must invalidate the inspected artifact', async t => {
  const f = await fixture(t);
  const mock = provider({ mutateOnAnalysis: async file => { const bytes = await fs.readFile(file); bytes[HEADER_SIZE + 72] ^= 1; await fs.writeFile(file, bytes); } });
  await assert.rejects(prepareResin(f.options, mock), { code: 'RESIN_ARTIFACT_CHANGED' });
});

test('regression: later orientations cannot change the selected earlier artifact unnoticed', async t => {
  const f = await fixture(t);
  const mock = provider({ issues: [1, 2, 3] });
  let firstArtifact;
  const run = async (...args) => {
    const output = await mock.run(...args);
    if (args[1][1] === 'print-issues') {
      if (!firstArtifact) firstArtifact = args[1][2];
      else if (args[1][2].includes('attempt-3')) {
        const bytes = await fs.readFile(firstArtifact);
        bytes[HEADER_SIZE + 72] ^= 1;
        await fs.writeFile(firstArtifact, bytes);
      }
    }
    return output;
  };
  await assert.rejects(prepareResin(f.options, { run }), { code: 'RESIN_ARTIFACT_CHANGED' });
});

test('regression: cancellation after final analysis cannot return a selected resin artifact', async t => {
  const f = await fixture(t);
  const mock = provider();
  const controller = new AbortController();
  const run = async (...args) => {
    const output = await mock.run(...args);
    if (args[1][1] === 'print-issues') controller.abort(Object.assign(new Error('Fixture late cancellation'), { code: 'PREPARATION_CANCELLED' }));
    return output;
  };
  await assert.rejects(prepareResin({ ...f.options, signal: controller.signal }, { run }), { code: 'PREPARATION_CANCELLED' });
});

test('property execution requires a matching receipt and unchanged target values', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareResin(f.options, provider({ noReceipt: true })));
  await assert.rejects(prepareResin(f.options, provider({ wrongReceipt: true })), { code: 'RESIN_CONVERSION_MISMATCH' });
  await assert.rejects(prepareResin(f.options, provider({ mutateProperties: async file => {
    const bytes = await fs.readFile(file); bytes.writeUInt16BE(100, 195443); await fs.writeFile(file, bytes);
  } })), { code: 'RESIN_CONVERSION_MISMATCH' });
});

test('trusted property script quotes values and target checks include movement, timing and light PWM', () => {
  const script = parameterScript({ MachineName: 'Printer "A" \\ sample' }, path.resolve('folder with spaces', 'receipt.txt'), 'profile-hash');
  assert.match(script, /Set\("MachineName", "Printer \\"A\\" \\\\ sample"\)/);
  assert.ok(script.includes('Convert.ChangeType(value, property.PropertyType, CultureInfo.InvariantCulture)'));
  const actual = { machineName: 'Printer', layerHeightMm: 0.05, lightPwm: 255, motion: { liftDistanceMm: 5 }, timing: { waitAfterRetractSeconds: 1.2 } };
  assertTargetProperties(actual, { MachineName: 'Printer', LayerHeight: 0.05, LiftHeight: 5, WaitTimeBeforeCure: 1.2, LightPWM: 255 });
  for (const properties of [{ LiftHeight: 6 }, { WaitTimeBeforeCure: 0 }, { LightPWM: 100 }]) {
    assert.throws(() => assertTargetProperties(actual, properties), { code: 'RESIN_CONVERSION_MISMATCH' });
  }
});

test('verification CLI documents sizing and refuses conflicting or unsafe sizing before touching providers', () => {
  const script = path.join(__dirname, '..', 'scripts', 'verify-resin-engine.js');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /source axes before orientation/);
  assert.match(help.stdout, /--sizing-scale/);
  const required = ['--model', 'nonexistent.stl', '--profile', 'nonexistent.json', '--prusa', 'nonexistent-prusa.exe', '--uvtools', 'nonexistent-uvtools.exe', '--output', 'nonexistent-output'];
  for (const [args, message] of [
    [['--sizing-scale', '2', '--dimension-z', '3'], /Choose only one/],
    [['--dimension-x', '2', '--dimension-y', '3'], /Choose only one/],
    [['--sizing-scale', '0.00001'], /Sizing must be positive/],
    [['--dimension-z', 'NaN'], /Sizing must be positive/],
  ]) {
    const result = spawnSync(process.execPath, [script, ...required, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});
