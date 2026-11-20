'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { prepareResinGeometry, measureResinGeometry, forEachResinTriangle } = require('../src/slicing/resin-geometry');
const { auditResinMesh } = require('../src/slicing/resin-mesh');
const { planResinPlate, prepareResinPlate, prepareResinPlateSource, verifyResinPlate, RESIN_PLATE_LIMITS } = require('../src/slicing/resin-plate');
const { binaryStl, boxTriangles } = require('./helpers/resin-cad');

const hash = value => createHash('sha256').update(value).digest('hex');
const baseOptions = () => ({ orientation: { x: 0, y: 0, z: 0 }, bed: { widthMm: 20, heightMm: 20, maxHeightMm: 10 }, copies: 5, gapMm: 2, marginMm: 1, supportEnvelopeMm: 0.5, supportHeightMm: 2 });
const normalized = triangles => prepareResinGeometry(binaryStl(triangles), { format: 'stl', units: 'mm', sizing: { mode: 'original' } }).stl;
const source = () => normalized(boxTriangles([0,0,0], [3,3,3]));
const close = (actual, expected, tolerance = 0.00001) => assert.ok(Math.abs(actual-expected) <= tolerance, `${actual} differs from ${expected}`);
function mutable(record) { return { ...record, plan: structuredClone(record.plan), stl: Buffer.from(record.stl), bounds: structuredClone(record.bounds) }; }
function rehashPlan(plan) { const { layoutSha256, ...base } = plan; plan.layoutSha256 = hash(JSON.stringify(base)); }
function triangles(bytes) { const result = []; forEachResinTriangle(bytes, { format: 'stl', units: 'mm' }, triangle => result.push(triangle)); return result; }
function octahedron() {
  const vertices = [[1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]];
  return [[4,0,2], [4,2,1], [4,1,3], [4,3,0], [5,2,0], [5,1,2], [5,3,1], [5,0,3]].map(face => face.map(index => [...vertices[index]]));
}

test('a deterministic centered plate emits every requested source instance and immutable source-bound proof', () => {
  const input = source(), before = Buffer.from(input), options = baseOptions(), originalOptions = structuredClone(options);
  const result = prepareResinPlate(input, options), plan = planResinPlate(input, options);
  assert.deepEqual(result.plan, plan); assert.deepEqual(options, originalOptions); assert.deepEqual(input, before);
  assert.equal(plan.sourceSha256, hash(input)); assert.equal(plan.copiesRequested, 5); assert.equal(plan.copiesPlaced, 5); assert.equal(plan.remainingCopies, 0); assert.equal(plan.complete, true);
  assert.equal(plan.capacity, 9); assert.equal(plan.bedCapacity, 9); assert.equal(plan.columnsCapacity, 3); assert.equal(plan.rowsCapacity, 3); assert.deepEqual([plan.columns,plan.rows], [3,2]);
  assert.deepEqual(plan.placements.map(placement => placement.offsetMm), [{ x: 2.5, y: 5.5, z: 0 }, { x: 8.5, y: 5.5, z: 0 }, { x: 14.5, y: 5.5, z: 0 }, { x: 2.5, y: 11.5, z: 0 }, { x: 8.5, y: 11.5, z: 0 }]);
  assert.deepEqual(result.bounds, { min: { x: 2.5, y: 5.5, z: 0 }, max: { x: 17.5, y: 14.5, z: 3 } });
  assert.equal(plan.outputTriangleCount, 60); assert.equal(result.stl.readUInt32LE(80), 60); assert.equal(result.stl.length, 84+60*50);
  assert.equal(hash(result.stl), result.sha256); assert.equal(plan.outputSha256, result.sha256); assert.match(plan.layoutSha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.minimumReservedGapMm, 2); assert.ok(Object.isFrozen(plan.placements[0].boundsMm.max));
  assert.throws(() => { plan.copiesPlaced = 999; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  const audit = auditResinMesh(result.stl, { format: 'stl', units: 'mm' }); assert.equal(audit.componentCount, 5); assert.equal(audit.signedShellVolumeMm3, 135);
});

test('bed capacity is explicit when an order needs more instances than one plate can contain', () => {
  const input = source(), options = { ...baseOptions(), copies: 12 }, result = prepareResinPlate(input, options), { plan } = result;
  assert.equal(plan.copiesRequested, 12); assert.equal(plan.copiesPlaced, 9); assert.equal(plan.capacity, 9); assert.equal(plan.remainingCopies, 3); assert.equal(plan.complete, false);
  assert.deepEqual(plan.limitingReasons, ['bed_capacity']); assert.equal(result.stl.readUInt32LE(80), 12*9);
  assert.equal(auditResinMesh(result.stl, { format: 'stl', units: 'mm' }).componentCount, 9);
  assert.equal(verifyResinPlate(input, result, options).triangleCount, 108);
});

test('triangle and byte budgets lower capacity without truncating or misreporting placed copies', () => {
  const input = source();
  for (const [limits, reason] of [[{ maxTriangles: 24 }, 'triangle_limit'], [{ maxBytes: 84+24*50 }, 'byte_limit']]) {
    const result = prepareResinPlate(input, { ...baseOptions(), limits });
    assert.equal(result.plan.copiesPlaced, 2); assert.equal(result.plan.remainingCopies, 3); assert.equal(result.plan.complete, false);
    assert.ok(result.plan.limitingReasons.includes(reason)); assert.equal(result.stl.length, 84+24*50); assert.equal(result.stl.readUInt32LE(80), 24);
    assert.equal(result.plan[reason === 'triangle_limit' ? 'triangleCapacity' : 'byteCapacity'], 2);
  }
});

test('zero capacity has an explicit reason and preparation never emits an empty or clipped STL', () => {
  const input = source();
  for (const [patch, reason] of [[{ marginMm: 11 }, 'bed_footprint'], [{ supportEnvelopeMm: 20 }, 'bed_footprint'], [{ supportHeightMm: 8 }, 'height_limit'], [{ bed: { widthMm: 2, heightMm: 2, maxHeightMm: 10 } }, 'bed_footprint']]) {
    const options = { ...baseOptions(), ...patch }, plan = planResinPlate(input, options);
    assert.equal(plan.capacity, 0); assert.equal(plan.copiesPlaced, 0); assert.equal(plan.remainingCopies, 5); assert.equal(plan.complete, false); assert.equal(plan.zeroCapacityReason, reason);
    assert.equal(plan.outputBytes, 0); assert.equal(plan.outputSha256, null); assert.deepEqual(plan.placements, []);
    assert.throws(() => prepareResinPlate(input, options), error => error.code === 'RESIN_PLATE_NO_CAPACITY' && error.plan.copiesPlaced === 0);
  }
});

test('support reservation distinguishes XY expansion from explicit extra Z height', () => {
  const input = source(), options = { ...baseOptions(), copies: 1, bed: { widthMm: 20, heightMm: 20, maxHeightMm: 3 }, supportEnvelopeMm: 4, supportHeightMm: 0 };
  const plan = planResinPlate(input, options); assert.equal(plan.heightFits, true); assert.equal(plan.copiesPlaced, 1); assert.deepEqual(plan.footprintMm, { width: 11, height: 11 });
  assert.equal(planResinPlate(input, { ...options, supportHeightMm: 0.01 }).zeroCapacityReason, 'height_limit');
  const { supportHeightMm, ...defaultHeight } = options; assert.equal(planResinPlate(input, defaultHeight).supportHeightMm, 0);
});

test('orientation is applied Z then X then Y to each vertex before common-origin normalization and copy placement', () => {
  const input = normalized(boxTriangles([0,0,0], [2,4,6]));
  const options = { orientation: { x: 90, y: 90, z: 90 }, bed: { widthMm: 20, heightMm: 20, maxHeightMm: 10 }, copies: 2, gapMm: 1, marginMm: 1, supportEnvelopeMm: 0 };
  const result = prepareResinPlate(input, options), original = triangles(input), placed = triangles(result.stl);
  // For these three rotations the composed map is (x,y,z)->(x,-z,y).
  const bounds = result.plan.rotatedBoundsMm;
  close(bounds.min.x, 0); close(bounds.min.y, -6); close(bounds.min.z, 0);
  close(bounds.max.x, 2); close(bounds.max.y, 0); close(bounds.max.z, 4);
  for (const placement of result.plan.placements) for (let face = 0; face < original.length; face++) for (let vertex = 0; vertex < 3; vertex++) {
    const [x,y,z] = original[face][vertex], expected = [x,-z+6,y].map((value, axis) => Math.fround(value+placement.offsetMm[['x','y','z'][axis]]));
    for (let axis = 0; axis < 3; axis++) close(placed[placement.startTriangle+face][vertex][axis], expected[axis]);
  }
  const audit = auditResinMesh(result.stl, { format: 'stl', units: 'mm' }); assert.equal(audit.componentCount, 2); close(audit.signedShellVolumeMm3, 96);
});

test('arbitrary triangulated geometry receives recomputed normals and the same explicit instance count', () => {
  const input = normalized(octahedron());
  for (let offset = 84; offset < input.length; offset += 50) { input.writeFloatLE(-9, offset); input.writeFloatLE(9, offset+4); input.writeFloatLE(2, offset+8); }
  const result = prepareResinPlate(input, { ...baseOptions(), copies: 4, orientation: { x: 25, y: 15, z: 35 } });
  const actual = triangles(result.stl); assert.equal(actual.length, 8*4); assert.equal(result.plan.copiesPlaced, 4);
  for (let index = 0; index < actual.length; index++) {
    const [a,b,c] = actual[index], ab = b.map((value, axis) => value-a[axis]), ac = c.map((value, axis) => value-a[axis]);
    const cross = [ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]], length = Math.hypot(...cross);
    for (let axis = 0; axis < 3; axis++) close(result.stl.readFloatLE(84+index*50+axis*4), cross[axis]/length, 0.000001);
  }
  const audit = auditResinMesh(result.stl, { format: 'stl', units: 'mm' }); assert.equal(audit.componentCount, 4); assert.ok(audit.components.every(component => component.winding === 'positive'));
});

test('whole-source instances preserve relative disconnected geometry and are not inferred from mesh component count', () => {
  const input = normalized([...boxTriangles([0,0,0], [1,1,1]), ...boxTriangles([3,0,0], [1,1,1])]);
  const result = prepareResinPlate(input, { ...baseOptions(), copies: 2 });
  assert.equal(result.plan.sourceTriangleCount, 24); assert.equal(result.plan.copiesPlaced, 2); assert.equal(result.plan.outputTriangleCount, 48);
  const audit = auditResinMesh(result.stl, { format: 'stl', units: 'mm' }); assert.equal(audit.componentCount, 4); assert.equal(audit.signedShellVolumeMm3, 4);
  for (const placement of result.plan.placements) close(placement.boundsMm.max.x-placement.boundsMm.min.x, 4);
});

test('canonical oriented source is the exact shared base used by every placed instance', () => {
  const input = normalized([...boxTriangles([0,0,0], [1,1,1]), ...boxTriangles([3,0,0], [1,1,1])]);
  const options = { ...baseOptions(), copies: 2, orientation: { x: 15, y: 10, z: 35 } };
  const canonical = prepareResinPlateSource(input, { orientation: options.orientation }), result = prepareResinPlate(input, options);
  assert.equal(canonical.sourceSha256, hash(input)); assert.equal(canonical.sha256, hash(canonical.stl)); assert.equal(canonical.sha256, result.plan.canonicalSourceSha256);
  assert.deepEqual(canonical.bounds.min, { x: 0, y: 0, z: 0 }); assert.deepEqual(canonical.dimensionsMm, result.plan.instanceDimensionsMm);
  assert.equal(canonical.triangleCount, 24); assert.equal(auditResinMesh(canonical.stl, { format: 'stl', units: 'mm' }).componentCount, 2);
  const base = triangles(canonical.stl), emitted = triangles(result.stl);
  for (const placement of result.plan.placements) for (let face = 0; face < base.length; face++) for (let vertex = 0; vertex < 3; vertex++) {
    assert.deepEqual(emitted[placement.startTriangle+face][vertex], base[face][vertex].map((value, axis) => Math.fround(value+placement.offsetMm[['x','y','z'][axis]])));
  }
});

test('pixel-aligned anchors and grid steps stay exact integers while conservatively rounding margins and spacing', () => {
  const input = source(), options = { ...baseOptions(), copies: 10, gapMm: 0.1, marginMm: 0.11, pixelPitchMm: { x: 0.3, y: 0.4 } };
  const result = prepareResinPlate(input, options), { plan } = result;
  assert.equal(plan.copiesPlaced, 10); assert.deepEqual(plan.gridPitchPixels, { x: 14, y: 11 });
  close(plan.gridPitchMm.x, 4.2); close(plan.gridPitchMm.y, 4.4);
  assert.deepEqual(plan.anchorPixelRange, { x: { first: 3, last: 54 }, y: { first: 2, last: 40 } });
  assert.deepEqual(plan.placements[0].anchorPixels, { x: 7, y: 10 });
  for (const placement of plan.placements) for (const axis of ['x','y']) {
    assert.ok(Number.isSafeInteger(placement.anchorPixels[axis]));
    assert.equal(placement.offsetMm[axis], placement.anchorPixels[axis]*options.pixelPitchMm[axis]);
    const dimension = plan.instanceDimensionsMm[axis], limit = axis === 'x' ? options.bed.widthMm : options.bed.heightMm;
    assert.ok(placement.offsetMm[axis] >= options.marginMm+options.supportEnvelopeMm-1e-12);
    assert.ok(placement.offsetMm[axis]+dimension <= limit-options.marginMm-options.supportEnvelopeMm+1e-12);
  }
  for (let index = 1; index < plan.placements.length; index++) {
    const current = plan.placements[index], previous = plan.placements[index-1];
    for (const axis of ['x','y']) assert.ok(Number.isSafeInteger(current.anchorPixels[axis]-previous.anchorPixels[axis]));
  }
  assert.equal(verifyResinPlate(input, result, options).sha256, result.sha256);
});

test('pixel quantization can reduce continuous bed capacity but never rounds a copy outside its safe anchor interval', () => {
  const input = source(), options = { ...baseOptions(), copies: 1, gapMm: 0, marginMm: 0.05, supportEnvelopeMm: 0, supportHeightMm: 0, bed: { widthMm: 3.2, heightMm: 3.2, maxHeightMm: 3 } };
  assert.equal(planResinPlate(input, options).copiesPlaced, 1);
  const plan = planResinPlate(input, { ...options, pixelPitchMm: { x: 1, y: 1 } });
  assert.equal(plan.copiesPlaced, 0); assert.equal(plan.capacity, 0); assert.equal(plan.zeroCapacityReason, 'bed_footprint');
  assert.throws(() => prepareResinPlate(input, { ...options, pixelPitchMm: { x: 1, y: 1 } }), { code: 'RESIN_PLATE_NO_CAPACITY' });
});

test('pixel-grid policy refuses malformed pitches and anchors outside exact integer precision', () => {
  const input = source();
  for (const pixelPitchMm of [{ x: 0, y: 1 }, { x: -1, y: 1 }, { x: '0.1', y: 0.1 }, { x: 0.1 }, { x: 0.1, y: 0.1, z: 0.1 }]) assert.throws(() => planResinPlate(input, { ...baseOptions(), pixelPitchMm }), { code: 'RESIN_PLATE_INVALID' });
  assert.throws(() => planResinPlate(input, { ...baseOptions(), pixelPitchMm: { x: 1e-40, y: 1e-40 } }), { code: 'RESIN_PLATE_PIXEL_GRID_INVALID' });
});

test('the upper explicit copy count is emitted exactly under bounded resources', () => {
  const input = normalized(boxTriangles([0,0,0], [1,1,1]));
  const result = prepareResinPlate(input, { ...baseOptions(), copies: 500, bed: { widthMm: 10000, heightMm: 10000, maxHeightMm: 10 } });
  assert.equal(result.plan.copiesPlaced, 500); assert.equal(result.plan.remainingCopies, 0); assert.equal(result.plan.placements.length, 500);
  assert.equal(result.stl.readUInt32LE(80), 6000); assert.equal(result.stl.length, 84+6000*50);
});

test('float32 placement cannot silently collapse triangles that were valid near the source origin', () => {
  const tiny = [[[0,0,0],[0,1e-7,0],[1e-7,0,0]], [[0,0,0],[1e-7,0,0],[0,0,1e-7]], [[0,0,0],[0,0,1e-7],[0,1e-7,0]], [[1e-7,0,0],[0,1e-7,0],[0,0,1e-7]]];
  const input = normalized([...tiny, ...boxTriangles([100,0,0], [1,1,1])]);
  assert.throws(() => prepareResinPlate(input, { ...baseOptions(), copies: 1, bed: { widthMm: 200, heightMm: 20, maxHeightMm: 10 } }), { code: 'RESIN_PLATE_PRECISION' });
});

test('verification reconstructs actual bytes and the canonical proof from independent source and options', () => {
  const input = source(), options = { ...baseOptions(), copies: 12 }, result = prepareResinPlate(input, options);
  assert.equal(verifyResinPlate(input, result, options).sha256, result.sha256);
  for (const mutate of [
    record => { record.plan.copiesPlaced = 12; record.plan.complete = true; rehashPlan(record.plan); },
    record => { record.plan.placements[0].offsetMm.x++; rehashPlan(record.plan); },
    record => { record.stl[84] ^= 1; record.sha256 = hash(record.stl); record.plan.outputSha256 = record.sha256; rehashPlan(record.plan); },
    record => { record.bounds.max.x++; }, record => { record.plan.sourceSha256 = '0'.repeat(64); rehashPlan(record.plan); },
  ]) {
    const changed = mutable(result); mutate(changed);
    assert.throws(() => verifyResinPlate(input, changed, options), { code: 'RESIN_PLATE_CHANGED' });
  }
  assert.throws(() => verifyResinPlate(input, result, { ...options, copies: 1 }), { code: 'RESIN_PLATE_CHANGED' });
  const changedSource = Buffer.from(input); changedSource[0] ^= 1;
  assert.throws(() => verifyResinPlate(changedSource, result, options), { code: 'RESIN_PLATE_CHANGED' });
});

test('invalid policies and nonnormalized source geometry cannot produce a plate proof', () => {
  const input = source();
  for (const patch of [{ copies: 0 }, { copies: 501 }, { copies: 1.5 }, { copies: '5' }, { gapMm: -1 }, { marginMm: NaN }, { supportEnvelopeMm: '1' }, { supportHeightMm: Infinity }, { orientation: { x: 0, y: 0 } }, { orientation: { x: 0, y: 0, z: 361 } }, { bed: { widthMm: 20, heightMm: 20, maxHeightMm: 0 } }, { bed: { widthMm: 20, heightMm: 20, maxHeightMm: 10, originMm: { x: 1, y: 0 } } }, { arbitraryPath: 'mesh.stl' }]) {
    assert.throws(() => planResinPlate(input, { ...baseOptions(), ...patch }), { code: 'RESIN_PLATE_INVALID' });
  }
  assert.throws(() => prepareResinPlate(binaryStl(boxTriangles([1,0,0], [3,3,3])), baseOptions()), { code: 'RESIN_PLATE_SOURCE_INVALID' });
  assert.throws(() => prepareResinPlate(binaryStl(boxTriangles([0,0,0], [10001,1,1])), baseOptions()), { code: 'RESIN_PLATE_SOURCE_INVALID' });
  assert.throws(() => prepareResinPlate(Buffer.alloc(0), baseOptions()), { code: 'RESIN_PLATE_LIMIT' });
  assert.throws(() => prepareResinPlate(Buffer.from('solid empty\nendsolid empty\n'), baseOptions()));
});

test('resource and time budgets may only lower hard bounds and are enforced before success', t => {
  const input = source();
  for (const limits of [{ maxBytes: RESIN_PLATE_LIMITS.maxBytes+1 }, { maxTriangles: 0 }, { maxTimeMs: '1000' }, { unknown: 1 }]) assert.throws(() => planResinPlate(input, { ...baseOptions(), limits }), { code: 'RESIN_PLATE_LIMIT' });
  assert.throws(() => prepareResinPlate(input, { ...baseOptions(), limits: { maxBytes: input.length-1 } }), { code: 'RESIN_PLATE_LIMIT' });
  assert.throws(() => prepareResinPlate(input, { ...baseOptions(), limits: { maxTriangles: 11 } }));
  let reads = 0; t.mock.method(performance, 'now', () => ++reads <= 4 ? 0 : 2);
  assert.throws(() => prepareResinPlate(input, { ...baseOptions(), limits: { maxTimeMs: 1 } }), { code: 'RESIN_PLATE_TIMEOUT' });
  assert.ok(Object.isFrozen(RESIN_PLATE_LIMITS));
});
