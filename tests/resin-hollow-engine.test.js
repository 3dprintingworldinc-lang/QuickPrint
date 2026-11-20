'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { expandedSlaPreset } = require('./helpers/resin-hollow-preset');
const { prepareResinGeometry } = require('../src/slicing/resin-geometry');
const { prepareControlledResinHollow, verifyControlledResinHollowPreparation, inspectControlledResinHollowBindings, isVerifiedControlledHollowPreparation } = require('../src/slicing/resin-hollow-engine');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const SOURCE = path.join(__dirname, 'fixtures', 'resin', 'verification-cube.stl');
const baseRequest = root => ({ inputPath: path.join(root, 'source.stl'), outputDir: path.join(root, 'captures'), profilePath: path.join(root, 'profile.json'), prusaExecutable: path.join(root, 'missing-prusa.exe'), uvtoolsExecutable: path.join(root, 'missing-uvtools.exe'),
  hollowRequest: { orientation: { x: 0, y: 0, z: 0 }, wallThicknessMm: 1, quality: .75, closingDistanceMm: 0, drains: [{ id: 'bottom', startMm: { x: 1.5, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: .5, lengthMm: 2 }] },
  supportRequest: { mode: 'none', clearanceMm: 0, points: [], regions: [] }, resolutionRequest: { maximumUncertaintyMm: .16 } });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-hollow-engine-'));
  await fs.copyFile(SOURCE, path.join(root, 'source.stl'));
  const preset = await fs.readFile(path.join(__dirname, 'fixtures/resin/verification.ini'));
  await fs.writeFile(path.join(root, 'profile.ini'), preset);
  const profile = JSON.parse(await fs.readFile(path.join(__dirname, 'fixtures/resin/verification-profile.json'))); profile.presetPath = 'profile.ini';
  await fs.writeFile(path.join(root, 'profile.json'), JSON.stringify(profile));
  return { root, options: baseRequest(root), async absentOutput() { await assert.rejects(fs.lstat(path.join(root, 'captures')), { code: 'ENOENT' }); } };
}

test('strict request/path/unit/resource schemas reject before files or providers are touched', async () => {
  const options = baseRequest(path.resolve('unused-hollow-test'));
  for (const patch of [{ inputPath: 'relative.stl' }, { inputPath: path.resolve('owned.step') }, { unitScale: 2 }, { timeoutMs: 0 }, { timeoutMs: 3600001 }, { timeoutMs: 1.5 }, { signal: {} }, { boundaryPolicy: 'relaxed' }, { run() {} }, { plate: { copies: 2 } }, { resolutionRequest: { maximumUncertaintyMm: NaN } }, { resolutionRequest: { maximumUncertaintyMm: .2, maxCells: 20000001 } }, { resolutionRequest: { maximumUncertaintyMm: .2, minimumPitchMm: { x: 1, y: 1, z: 0 } } }, { resolutionRequest: { maximumUncertaintyMm: .2, reduction: { x: 1, y: 0, z: 1 } } }, { resolutionRequest: { maximumUncertaintyMm: .2, reduction: { x: 1, y: 1, z: 1 }, minimumPitchMm: { x: 1, y: 1, z: 1 } } }, { supportRequest: { mode: 'script', clearanceMm: 1, points: [], regions: [] } }, { supportRequest: { mode: 'points', clearanceMm: 1, points: [], regions: [] } }]) await assert.rejects(prepareControlledResinHollow({ ...options, ...patch }));
});

test('already-cancelled requests do not start profile/model work', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareControlledResinHollow({ ...baseRequest(path.resolve('absent-cancelled-test')), signal: controller.signal }), { code: 'ABORTED' });
});

test('the managed profile retains the solid-only baseline guard before any native probe', async () => {
  const f = await fixture(), presetPath = path.join(f.root, 'profile.ini');
  await fs.writeFile(presetPath, (await fs.readFile(presetPath, 'utf8')).replace('hollowing_enable = 0', 'hollowing_enable = 1'));
  await assert.rejects(prepareControlledResinHollow(f.options), { code: 'RESIN_DRAIN_PLAN_REQUIRED' });
  await f.absentOutput();
});

test('isolated source triangles are held by the independent mesh audit before any native probe', async () => {
  const f = await fixture(), original = prepareResinGeometry(await fs.readFile(f.options.inputPath), { format: 'stl', units: 'mm', sizing: { mode: 'original' } }).stl, damaged = Buffer.alloc(original.length + 50); original.copy(damaged); damaged.writeUInt32LE(original.readUInt32LE(80) + 1, 80);
  for (const [index, point] of [[0, [8, 0, 0]], [1, [9, 0, 0]], [2, [8, 1, 0]]]) point.forEach((value, axis) => damaged.writeFloatLE(value, original.length + 12 + index * 12 + axis * 4));
  await fs.writeFile(f.options.inputPath, damaged);
  await assert.rejects(prepareControlledResinHollow(f.options), error => /^RESIN_MESH_/.test(error.code));
  assert.deepEqual(await fs.readFile(f.options.inputPath), damaged); await f.absentOutput();
});

test('invalid source-bound drain geometry and sizing fail before managed output/native initialization', async () => {
  const f = await fixture();
  for (const patch of [{ sizing: { mode: 'scale', factor: 0 } }, { hollowRequest: { ...f.options.hollowRequest, drains: [{ ...f.options.hollowRequest.drains[0], direction: { x: 0, y: 0, z: .5 } }] } }, { hollowRequest: { ...f.options.hollowRequest, quality: 2 } }]) await assert.rejects(prepareControlledResinHollow({ ...f.options, ...patch }));
  await f.absentOutput();
});

test('host/post-processing directives are rejected before even a profile-only native action', async () => {
  const f = await fixture(), presetPath = path.join(f.root, 'profile.ini'), original = await fs.readFile(presetPath);
  for (const directive of ['post_process =\n', 'post_process = anything\n', 'print_host = 192.0.2.1\n']) { await fs.writeFile(presetPath, Buffer.concat([original, Buffer.from(directive)])); await assert.rejects(prepareControlledResinHollow(f.options), { code: 'RESIN_PROFILE_CREDENTIALS' }); }
  await f.absentOutput();
});

test('JSON claims cannot mint the private successful-verification capability', async () => {
  const forged = { schemaVersion: 1, method: 'controlled-source-bound-resin-hollow-v1', controlledExecution: true, finalAuditReverified: true, productionEligible: false, sha256: '0'.repeat(64) };
  assert.equal(isVerifiedControlledHollowPreparation(forged, '0'.repeat(64)), false);
  assert.equal(isVerifiedControlledHollowPreparation(JSON.parse(JSON.stringify(forged)), '0'.repeat(64)), false);
  await assert.rejects(inspectControlledResinHollowBindings(forged, { source: Buffer.from('owned'), directory: path.resolve('.') }), { code: 'RESIN_HOLLOW_PREPARATION_CHANGED' });
  await assert.rejects(verifyControlledResinHollowPreparation(forged, { source: Buffer.from('owned'), directory: path.resolve('.') }), { code: 'RESIN_HOLLOW_PREPARATION_CHANGED' });
  await assert.rejects(verifyControlledResinHollowPreparation(forged, { source: Buffer.from('owned'), directory: path.resolve('.'), timeoutMs: -1 }));
});

const native = process.platform === 'win32' && process.env.QUICKPRINT_NATIVE_HOLLOW_TEST === '1';
test('owned native controlled hollow: immutable recipes, all six checks, full audit, restart replay and tamper holds', { skip: !native, timeout: 360000 }, async () => {
  const root = await fs.mkdtemp(path.resolve('artifacts/hollow-engine-native-')), inputPath = path.join(root, 'source.stl'), original = await fs.readFile(SOURCE); await fs.writeFile(inputPath, original);
  const profile = JSON.parse(await fs.readFile(path.join(__dirname, 'fixtures/resin/verification-profile.json')));
  profile.presetPath = 'profile.ini'; profile.expected = { resolutionX: 512, resolutionY: 512, displayWidthMm: 40, displayHeightMm: 40, layerHeightMm: .1, mirrorX: false, mirrorY: false };
  profile.uvtoolsProperties.LayerHeight = .1;
  await fs.writeFile(path.join(root, 'profile.ini'), expandedSlaPreset({ hollowing_enable: '0', supports_enable: '0', pad_enable: '0' })); await fs.writeFile(path.join(root, 'profile.json'), JSON.stringify(profile));
  const result = await prepareControlledResinHollow({ inputPath, outputDir: path.join(root, 'captures'), profilePath: path.join(root, 'profile.json'), prusaExecutable: path.resolve(process.env.QUICKPRINT_PRUSA_EXE || '.cache/prusa/PrusaSlicer-2.9.7/prusa-slicer-console.exe'), uvtoolsExecutable: path.resolve(process.env.QUICKPRINT_UVTOOLS_EXE || '.cache/uvtools/UVtoolsCmd.exe'), sizing: { mode: 'dimension', axis: 'z', millimeters: 10 },
    hollowRequest: { orientation: { x: -0, y: 0, z: 0 }, wallThicknessMm: 2, quality: .75, closingDistanceMm: 0, drains: [3, 7].map(x => ({ id: 'bottom-' + x, startMm: { x, y: 5, z: 0 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: 1.25, lengthMm: 3 })) }, supportRequest: { mode: 'none', clearanceMm: 0, points: [], regions: [] }, resolutionRequest: { maximumUncertaintyMm: .16 }, timeoutMs: 300000 });
  assert.deepEqual(await fs.readFile(inputPath), original); assert.equal(result.sourceSha256, hash(original)); assert.equal(result.printReady, false); assert.equal(result.printerCompatible, false); assert.equal(result.modelCopiesPerRun, 1);
  const record = result.hollowPreparation; assert.equal(record.invocations.length, 15); assert.equal(record.commandPlan.commands.length, 12); assert.equal(record.finalAudit.disposition, 'conforming'); assert.equal(record.finalAudit.nativeInvocationAttested, false); assert.equal(record.effectiveResolutionRequest.maxCells, 12000000); assert.equal(Object.hasOwn(record.request.resolutionRequest, 'maxCells'), false); assert.equal(result.analysis.count, 0); assert.equal(result.analysis.checks.length, 6);
  for (const limits of [record.finalAudit.limits, record.finalAudit.limits.reference]) { assert.equal(limits.scan.maxCells, 12000000); assert.equal(limits.grid.maxVoxels, 12000000); assert.equal(limits.grid.maxWorkingBytes, record.resolution.request.maxWorkingBytes); assert.equal(limits.grid.maxTimeMs, 180000); }
  assert.equal(record.finalAudit.limits.timeoutMs, 300000); assert.equal(record.nativeBounds.perCommandMaximumMs, 300000); assert.equal(record.nativeBounds.overallTimeoutMs, 300000);
  assert.equal(record.nativeBounds.auditGridTimeoutMs, 180000); assert.deepEqual(JSON.parse(await fs.readFile(record.nativePolicyFile.filePath)), record.nativeBounds);
  assert.equal(JSON.parse(await fs.readFile(record.priorRequest.filePath)).nativeBounds.auditGridTimeoutMs, 180000);
  assert.ok(record.commandPlan.commands.every(command => command.timeoutMs === 300000)); assert.equal(record.normalization.command.timeoutMs, 300000);
  const progress = (await fs.readFile(record.progressLog.filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(progress.filter(event => event.status === 'completed' && /-(slice|convert|parameters|issues)$/.test(event.stage)).length, 12);
  const options = { source: original, directory: path.join(root, 'captures'), timeoutMs: 300000 }, light = await inspectControlledResinHollowBindings(record, options); assert.equal(isVerifiedControlledHollowPreparation(record, light.bindingHash), true);
  const restarted = JSON.parse(JSON.stringify(record)); assert.equal(isVerifiedControlledHollowPreparation(restarted, light.bindingHash), false);
  const verified = await verifyControlledResinHollowPreparation(restarted, options); assert.equal(verified.bindingHash, light.bindingHash); assert.equal(isVerifiedControlledHollowPreparation(restarted, verified.bindingHash), true);
  await assert.rejects(inspectControlledResinHollowBindings(record, { ...options, source: Buffer.concat([original, Buffer.from('changed')]) }), { code: 'RESIN_HOLLOW_SOURCE_CHANGED' });
  const script = record.roles.final.parameterScript.filePath, before = await fs.readFile(script); await fs.appendFile(script, '\n// changed');
  await assert.rejects(inspectControlledResinHollowBindings(record, options), { code: 'RESIN_HOLLOW_CHANGED' }); await fs.writeFile(script, before);
  const resealed = structuredClone(record); resealed.commandPlan.commands[3].argv.pop(); const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const planBytes = Buffer.from(JSON.stringify(resealed.commandPlan, null, 2)); await fs.writeFile(record.commandPlanFile.filePath, planBytes); resealed.commandPlanFile.bytes = planBytes.length; resealed.commandPlanFile.sha256 = hash(planBytes); resealed.commandPlanSha256 = hash(JSON.stringify(canonical(resealed.commandPlan))); delete resealed.sha256; resealed.sha256 = hash(JSON.stringify(canonical(resealed))); await fs.writeFile(record.recordPath, JSON.stringify(resealed, null, 2));
  await assert.rejects(inspectControlledResinHollowBindings(resealed, options), { code: 'RESIN_HOLLOW_EXECUTION_CHANGED' });
  await fs.writeFile(record.commandPlanFile.filePath, JSON.stringify(record.commandPlan, null, 2)); await fs.writeFile(record.recordPath, JSON.stringify(record, null, 2));
  assert.equal((await inspectControlledResinHollowBindings(record, options)).bindingHash, light.bindingHash);
  await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ researchOnly: true, physicalPrintTested: false, root, result, restartHeavyVerified: true, scriptTamperHeld: true, resealedCommandPlanHeld: true, restoredBindingsVerified: true, bindingHash: light.bindingHash }, null, 2), { flag: 'wx' });
});
