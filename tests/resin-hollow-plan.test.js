'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const Zip = require('adm-zip');
const { prepareResinGeometry } = require('../src/slicing/resin-geometry');
const { prepareResinHollowPlan, verifyResinHollowPlan, createResinHollow3mf } = require('../src/slicing/resin-hollow-plan');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original = readFileSync(require('node:path').join(__dirname, 'fixtures/resin/verification-cube.stl'));
const source = prepareResinGeometry(original, { format: 'stl', units: 'mm', sizing: { mode: 'dimension', axis: 'z', millimeters: 20 } }).stl;
function request() {
  return { binding: { sourceSha256: hash(original), geometrySha256: hash(source), sizingSha256: hash('owned 20 mm sizing review') },
    orientation: { x: 0, y: 0, z: 0 }, wallThicknessMm: 2, quality: 0.5, closingDistanceMm: 0,
    drains: [6, 14].map((x, index) => ({ id: `bottom-${index + 1}`, startMm: { x, y: 10, z: 0 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: 2, lengthMm: 5 })) };
}

test('source-bound native hollow request reproduces the independently observed cube drain metadata and cannot qualify production', () => {
  const input = request(), before = Buffer.from(source), { stl, drainMetadata, plan } = prepareResinHollowPlan(source, input);
  assert.deepEqual(source, before);
  assert.equal(drainMetadata.toString(), 'drain_holes_format_version=1\nobject_id=1|-4 0 -11 0 0 1 2 6 4 0 -11 0 0 1 2 6\n');
  assert.equal(plan.canonical.sha256, hash(stl)); assert.equal(plan.native.drainMetadataSha256, hash(drainMetadata));
  assert.deepEqual(plan.canonical.nativeObjectCenterMm, { x: 10, y: 10, z: 10 });
  assert.deepEqual(plan.native.presetOverrides, { hollowing_enable: '1', hollowing_min_thickness: '2', hollowing_quality: '0.5', hollowing_closing_distance: '0' });
  assert.deepEqual(plan.verification, { status: 'request-only', geometryVerified: false, drainConnectivityVerified: false, wallThicknessVerified: false, productionEligible: false });
  assert.equal(Object.isFrozen(plan.request.drains[0].startMm), true);
  input.drains[0].startMm.x = 99;
  assert.equal(plan.request.drains[0].startMm.x, 6);
  assert.deepEqual(verifyResinHollowPlan(source, plan, request().binding).plan, plan);
});

test('drain starts and directions follow canonical orientation before native object centering; translations affect instances only', () => {
  const input = request(); input.orientation.x = 90;
  const { plan } = prepareResinHollowPlan(source, input), first = plan.native.drains[0];
  for (const [axis, expected] of Object.entries({ x: 6, y: 20, z: 10 })) assert.ok(Math.abs(first.requestedCanonicalStartMm[axis] - expected) < 1e-12);
  for (const [axis, expected] of Object.entries({ x: -4, y: 10, z: 0 })) assert.ok(Math.abs(first.requestedObjectLocalStartMm[axis] - expected) < 1e-12);
  assert.equal(first.serializedDirection.x, 0); assert.equal(first.serializedDirection.y, -1); assert.ok(Math.abs(first.serializedDirection.z) < 1e-15);
  assert.equal(first.serializedPositionMm.y, 11);
  const a = createResinHollow3mf(source, plan, input.binding, { x: 10, y: 15, z: 0 });
  const b = createResinHollow3mf(source, plan, input.binding, { x: 30, y: 45, z: 2 });
  const za = new Zip(a.threeMf), zb = new Zip(b.threeMf), name = plan.native.drainMetadataPath;
  assert.deepEqual(za.readFile(name), zb.readFile(name)); assert.notEqual(a.sha256, b.sha256);
  assert.match(za.readAsText('3D/3dmodel.model'), /<metadata name="slic3rpe:Version3mf">1<\/metadata>/);
  assert.match(za.readAsText('3D/3dmodel.model'), /transform="1 0 0 0 1 0 0 0 1 10 15 0"/);
  assert.equal(a.productionEligible, false);
});

test('noncommuting Z then X then Y rotations transform a known cube point and drain direction together', () => {
  const input = request(); input.orientation = { x: 90, y: 90, z: 90 };
  const { plan } = prepareResinHollowPlan(source, input), first = plan.native.drains[0];
  // (6,10,0) -> (-10,6,0) -> (-10,0,6) -> (6,0,10),
  // and the rotated cube has minima (0,-20,0).
  for (const [axis, expected] of Object.entries({ x: 6, y: 20, z: 10 })) assert.ok(Math.abs(first.requestedCanonicalStartMm[axis] - expected) < 1e-12);
  for (const [axis, expected] of Object.entries({ x: 0, y: -1, z: 0 })) assert.ok(Math.abs(first.serializedDirection[axis] - expected) < 1e-12);
});

test('arbitrary rotations generate finite float32 metadata and deterministic complete 3MF bytes', () => {
  const input = request(); input.orientation = { x: 30, y: 15, z: 27 };
  const prepared = prepareResinHollowPlan(source, input), placement = { x: 1, y: 2, z: 0 };
  for (const drain of prepared.plan.native.drains) {
    for (const vector of [drain.serializedPositionMm, drain.serializedDirection]) for (const value of Object.values(vector)) assert.equal(value, Math.fround(value));
    assert.ok(Math.abs(Math.hypot(...Object.values(drain.serializedDirection)) - 1) < 1e-7);
  }
  const a = createResinHollow3mf(source, prepared.plan, input.binding, placement), b = createResinHollow3mf(source, prepared.plan, input.binding, placement);
  assert.deepEqual(a, b); assert.equal(a.planSha256, prepared.plan.sha256); assert.equal(a.sha256, hash(a.threeMf));
  const zip = new Zip(a.threeMf);
  assert.equal(zip.getEntries().length, 4); assert.deepEqual(zip.readFile(prepared.plan.native.drainMetadataPath), prepared.drainMetadata);
});

test('every stored request, native artifact descriptor and qualification field is rederived under the expected source/sizing binding', () => {
  const input = request(), { plan } = prepareResinHollowPlan(source, input);
  const mutations = [p => p.request.wallThicknessMm++, p => p.request.orientation.y++, p => p.request.drains[0].startMm.x++, p => p.canonical.nativeObjectCenterMm.x++, p => p.native.drains[0].serializedHeightMm++, p => p.native.objectOrdinal++, p => p.native.drainMetadataSha256 = '0'.repeat(64), p => p.native.presetOverrides.hollowing_enable = '0', p => p.verification.productionEligible = true, p => p.sha256 = 'f'.repeat(64), p => p.extra = true];
  for (const mutate of mutations) { const changed = structuredClone(plan); mutate(changed); assert.throws(() => verifyResinHollowPlan(source, changed, input.binding), { code: 'RESIN_HOLLOW_PLAN_CHANGED' }); }
  for (const key of Object.keys(input.binding)) assert.throws(() => verifyResinHollowPlan(source, plan, { ...input.binding, [key]: '0'.repeat(64) }), { code: 'RESIN_HOLLOW_SOURCE_CHANGED' });
  const changed = Buffer.from(source); changed[0] ^= 1;
  assert.throws(() => verifyResinHollowPlan(changed, plan, input.binding), { code: 'RESIN_HOLLOW_SOURCE_CHANGED' });
});

test('strict native option limits reject unsupported shapes, units, nonfinite values, duplicate drains and precision loss', () => {
  const mutations = [p => p.units = 'in', p => p.binding.sourceSha256 = 'not-a-hash', p => p.orientation.x = NaN, p => p.orientation.extra = 1,
    p => p.wallThicknessMm = 0.99, p => p.wallThicknessMm = 10.01, p => p.quality = -0.01, p => p.quality = 1.01, p => p.closingDistanceMm = 10.01,
    p => p.drains = [], p => p.drains = Array.from({ length: 65 }, (_, i) => ({ ...p.drains[0], id: `d${i}` })),
    p => p.drains[1].id = p.drains[0].id, p => p.drains[0].id = '../bad', p => p.drains[0].startMm.x = Infinity,
    p => p.drains[0].direction = { x: 0, y: 0, z: 0 }, p => p.drains[0].direction.z = 2, p => p.drains[0].radiusMm = 0, p => p.drains[0].lengthMm = 10001];
  for (const mutate of mutations) { const input = request(); mutate(input); assert.throws(() => prepareResinHollowPlan(source, input), { code: 'RESIN_HOLLOW_PLAN_INVALID' }); }
  const duplicate = request(); duplicate.drains[1] = { ...structuredClone(duplicate.drains[0]), id: 'distinct-id' };
  assert.throws(() => prepareResinHollowPlan(source, duplicate), { code: 'RESIN_HOLLOW_PLAN_DUPLICATE' });
  duplicate.drains[1].startMm.x += 1e-9;
  assert.throws(() => prepareResinHollowPlan(source, duplicate), { code: 'RESIN_HOLLOW_PLAN_DUPLICATE' });
  const changed = request(); changed.binding.geometrySha256 = '0'.repeat(64);
  assert.throws(() => prepareResinHollowPlan(source, changed), { code: 'RESIN_HOLLOW_SOURCE_CHANGED' });
  assert.throws(() => createResinHollow3mf(source, prepareResinHollowPlan(source, request()).plan, request().binding, { x: 1, y: 1, z: -1 }), { code: 'RESIN_HOLLOW_PLAN_INVALID' });
});

test('hollow input must already be sized in zero-origin millimetres and supplied as an owned bounded STL', () => {
  const shifted = Buffer.from(source);
  for (let i = 0; i < shifted.readUInt32LE(80); i++) for (let j = 0; j < 3; j++) { const offset = 84 + i * 50 + 12 + j * 12; shifted.writeFloatLE(shifted.readFloatLE(offset) + 1, offset); }
  const input = request(); input.binding.geometrySha256 = hash(shifted);
  assert.throws(() => prepareResinHollowPlan(shifted, input), { code: 'RESIN_HOLLOW_PLAN_INVALID' });
  assert.throws(() => prepareResinHollowPlan('not a buffer', request()), { code: 'RESIN_HOLLOW_PLAN_LIMIT' });
});

test('different sidecar rows that collapse to the same cylinder during native float32 compensation are rejected', () => {
  const input = request(); input.drains = [11.999999940395355, 12].map((x, index) => ({ id: `d${index}`, startMm: { x, y: 10, z: 0 }, direction: { x: 1, y: 0, z: 0 }, radiusMm: 1, lengthMm: 5 }));
  const a = Math.fround(input.drains[0].startMm.x - 10 - 1), b = Math.fround(input.drains[1].startMm.x - 10 - 1);
  assert.notEqual(a, b); assert.equal(Math.fround(a + 1), Math.fround(b + 1));
  assert.throws(() => prepareResinHollowPlan(source, input), { code: 'RESIN_HOLLOW_PLAN_DUPLICATE' });
  input.drains[1].startMm.x = 12.02;
  assert.equal(prepareResinHollowPlan(source, input).plan.native.drains.length, 2);
});

test('headless CLI writes a complete hash-bound request, refuses overwrite and rejects stale geometry before creating output', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), { spawnSync } = require('node:child_process');
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'quickprint-hollow-request-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const model = path.join(directory, 'sized.stl'), json = path.join(directory, 'request.json'), output = path.join(directory, 'output');
  const envelope = { schemaVersion: 1, request: request(), placement: { x: 10, y: 10, z: 0 } };
  await fs.writeFile(model, source); await fs.writeFile(json, JSON.stringify(envelope));
  const execute = destination => spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/prepare-resin-hollow.js'), '--model', model, '--request', json, '--output', destination], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const result = execute(output); assert.equal(result.status, 0, result.stderr);
  const reported = JSON.parse(result.stdout), manifestBytes = await fs.readFile(path.join(output, 'manifest.json')), manifest = JSON.parse(manifestBytes);
  assert.equal(reported.productionEligible, false); assert.deepEqual(manifest.sourceBinding, envelope.request.binding);
  for (const [filename, descriptor] of Object.entries(manifest.files)) { const bytes = await fs.readFile(path.join(output, filename)); assert.equal(hash(bytes), descriptor.sha256); assert.equal(bytes.length, descriptor.sizeBytes); }
  assert.equal(reported.threeMfSha256, manifest.files['input.3mf'].sha256);
  assert.equal(execute(output).status, 1); assert.deepEqual(await fs.readFile(path.join(output, 'manifest.json')), manifestBytes);
  envelope.request.binding.geometrySha256 = '0'.repeat(64); await fs.writeFile(json, JSON.stringify(envelope));
  const rejected = execute(path.join(directory, 'stale'));
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /RESIN_HOLLOW_SOURCE_CHANGED/);
  await assert.rejects(fs.stat(path.join(directory, 'stale')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(model), source);
});
