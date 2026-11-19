'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { measureResinGeometry, planResinSizing, prepareResinGeometry, measureResinOrientation, float32Tolerance } = require('../src/slicing/resin-geometry');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const BASE = [[0, 0, 0], [2, 0, 0], [0, 3, 0], [0, 0, 4]];
const FACES = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
const triangles = (offset = [0, 0, 0]) => FACES.map(face => face.map(index => BASE[index].map((value, axis) => value + offset[axis])));
function binary(faces = triangles(), header = 'binary fixture') {
  const bytes = Buffer.alloc(84 + faces.length * 50); bytes.write(header); bytes.writeUInt32LE(faces.length, 80);
  faces.forEach((face, index) => face.forEach((vertex, at) => vertex.forEach((value, axis) => bytes.writeFloatLE(value, 84 + index * 50 + 12 + at * 12 + axis * 4))));
  return bytes;
}
function ascii(faces = triangles()) {
  return Buffer.from('solid fixture\n' + faces.map(face => 'facet normal 0 0 0\nouter loop\n' + face.map(vertex => 'vertex ' + vertex.join(' ')).join('\n') + '\nendloop\nendfacet\n').join('') + 'endsolid fixture\n');
}
function obj(vertices = BASE, faces = FACES) { return Buffer.from(vertices.map(vertex => 'v ' + vertex.join(' ')).join('\n') + '\n' + faces.map(face => 'f ' + face.map(index => index + 1).join(' ')).join('\n') + '\n'); }
const options = (sizing = { mode: 'original' }, extra = {}) => ({ format: 'stl', units: 'mm', sizing, ...extra });
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

test('owned verification fixture is twelve nondegenerate triangles with 3 mm pre-orientation extents', () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/resin/verification-cube.stl'));
  const result = measureResinGeometry(bytes, options());
  assert.equal(result.triangleCount, 12); assert.equal(result.sourceSha256, sha256(bytes));
  assert.deepEqual(result.sourceBounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 3, z: 3 } });
  assert.deepEqual(result.sourceDimensionsMm, { x: 3, y: 3, z: 3 });
});

test('exact binary STL length selects binary even when its header starts with solid', () => {
  const bytes = binary(triangles([10, -20, 30]), 'solid ambiguous binary'); bytes.writeUInt16LE(0x1234, 84 + 48);
  const result = measureResinGeometry(bytes, options());
  assert.equal(result.triangleCount, 4);
  assert.deepEqual(result.sourceBounds, { min: { x: 10, y: -20, z: 30 }, max: { x: 12, y: -17, z: 34 } });
  assert.deepEqual(result.sourceDimensionsMm, { x: 2, y: 3, z: 4 });
});

test('ASCII STL validates facet grammar, scientific notation and complete solid sections', () => {
  const bytes = Buffer.from(ascii().toString().replaceAll('vertex 2 0 0', 'vertex 2e0 +0.0 -0').replaceAll('\n', '\r\n'));
  assert.deepEqual(measureResinGeometry(bytes, options()).sourceDimensionsMm, { x: 2, y: 3, z: 4 });
  for (const value of [ascii().toString().replace('endloop', 'endfacet'), ascii().toString().replace('endsolid fixture', ''), ascii().toString().replace('vertex 2 0 0', 'vertex NaN 0 0'), 'solid empty\nendsolid empty\n']) {
    assert.throws(() => measureResinGeometry(Buffer.from(value), options()), { code: 'RESIN_GEOMETRY_INVALID' });
  }
});

test('malformed binary tables, nonfinite fields, degenerate triangles and flat extents are rejected', () => {
  for (const mutate of [bytes => bytes.subarray(0, -1), bytes => { bytes.writeUInt32LE(5, 80); return bytes; }, bytes => { bytes.writeFloatLE(Infinity, 96); return bytes; }, bytes => { bytes.writeFloatLE(NaN, 84); return bytes; }]) {
    assert.throws(() => measureResinGeometry(mutate(binary()), options()));
  }
  assert.throws(() => measureResinGeometry(binary([[[0, 0, 0], [1, 1, 1], [2, 2, 2]], ...triangles()]), options()), { code: 'RESIN_GEOMETRY_INVALID' });
  assert.throws(() => measureResinGeometry(binary([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]]), options()), /positive finite X, Y and Z extents/);
});

test('OBJ bounds use face-referenced vertices and support validated negative/texture/normal indices', () => {
  const contents = ['o specimen', 'g mesh', 's off', ...[...BASE, [99999, -99999, 99999]].map(vertex => 'v ' + vertex.join(' ')), 'vt 0 0', 'vt 1 0', 'vt 0 1', 'vn 0 0 1',
    'f 1/1/1 2/2/1 3/3/1', 'f -5//1 -2//1 -4//1', 'f 1 3 4', 'f 2 4 3 # bounded face'].join('\n');
  const result = measureResinGeometry(Buffer.from(contents), options(undefined, { format: 'obj' }));
  assert.equal(result.triangleCount, 4);
  assert.deepEqual(result.sourceBounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 3, z: 4 } });
});

test('OBJ rejects external files, commands and unsupported free-form or line geometry', () => {
  for (const directive of ['mtllib ../external.mtl', 'call other.obj', 'csh echo ignored', 'curv 0 1 1 2', 'surf 0 1 0 1 1 2 3 4', 'l 1 2', 'p 1', 'usemtl external', 'g continued \\']) {
    assert.throws(() => measureResinGeometry(Buffer.concat([obj(), Buffer.from(directive + '\n')]), options(undefined, { format: 'obj' })), { code: 'RESIN_OBJ_UNSUPPORTED' });
  }
});

test('OBJ indices, forward references, homogeneous vertices and polygons have explicit rejection', () => {
  for (const face of ['f 0 2 3', 'f 1 2 999', 'f 1.5 2 3', 'f 1/1 2/1 3/1', 'f 1//1 2//1 3//1', 'f 1/ 2/ 3/', 'f 1///1 2 3']) {
    const bytes = Buffer.from(BASE.map(v => 'v ' + v.join(' ')).join('\n') + '\n' + face + '\n');
    assert.throws(() => measureResinGeometry(bytes, options(undefined, { format: 'obj' })), { code: 'RESIN_GEOMETRY_INVALID' });
  }
  assert.throws(() => measureResinGeometry(Buffer.concat([Buffer.from('f 1 2 3\n'), obj()]), options(undefined, { format: 'obj' })), /forward-declared/);
  assert.throws(() => measureResinGeometry(Buffer.from('v 0 0 0 1\n'), options(undefined, { format: 'obj' })), /homogeneous/);
  assert.throws(() => measureResinGeometry(Buffer.concat([obj(), Buffer.from('f 1 2 3 4\n')]), options(undefined, { format: 'obj' })), { code: 'RESIN_OBJ_TRIANGULATION_REQUIRED' });
});

test('unit conversion is explicit and measurements precede orientation/support/pad geometry', () => {
  for (const [units, factor] of [['mm', 1], ['in', 25.4], ['m', 1000]]) {
    const measured = measureResinGeometry(binary(), options(undefined, { units }));
    assert.equal(measured.unitScale, factor);
    for (const [axis, value] of Object.entries({ x: 2, y: 3, z: 4 })) close(measured.sourceDimensionsMm[axis], value * factor);
  }
  for (const units of [undefined, 'cm', 'inches', 'MM', 1, ['mm'], { toString: () => 'mm' }]) assert.throws(() => measureResinGeometry(binary(), options(undefined, { units })), { code: 'RESIN_MODEL_UNITS' });
});

test('original and explicit uniform scaling produce frozen, source-bound plans with global origin metadata', () => {
  const source = binary(triangles([-10, 20, -30]));
  const original = planResinSizing(source, options());
  assert.equal(original.uniformScale, 1); assert.deepEqual(original.requestedSizing, { mode: 'original' });
  const plan = planResinSizing(source, options({ mode: 'scale', factor: 2 }));
  assert.deepEqual(plan.dimensionsMm, { x: 4, y: 6, z: 8 }); assert.equal(plan.coordinateUnits, 'mm');
  assert.deepEqual(plan.transform, { scale: 2, originSourceUnits: { x: -10, y: 20, z: -30 }, translateMm: { x: 20, y: -40, z: 60 } });
  assert.match(plan.sizingSha256, /^[a-f0-9]{64}$/); assert.equal(plan.sourceSha256, sha256(source));
  assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.sourceBounds.min)); assert.ok(Object.isFrozen(plan.transform.originSourceUnits)); assert.ok(Object.isFrozen(plan.requestedSizing));
  assert.throws(() => { plan.dimensionsMm.x = 999; }, TypeError);
  assert.equal(planResinSizing(source, options({ mode: 'scale', factor: 2 })).sizingSha256, plan.sizingSha256);
  assert.notEqual(planResinSizing(source, options({ mode: 'scale', factor: 1 })).sizingSha256, original.sizingSha256, 'identical geometry with a different explicit request retains distinct provenance');
});

test('single-axis target dimension uniformly preserves aspect ratio after declared unit conversion', () => {
  const plan = planResinSizing(binary(), options({ mode: 'dimension', axis: 'y', millimeters: 150 }, { units: 'in' }));
  close(plan.uniformScale, 150 / (3 * 25.4)); close(plan.transform.scale, 50);
  for (const [axis, value] of Object.entries({ x: 100, y: 150, z: 200 })) close(plan.dimensionsMm[axis], value);
  assert.deepEqual(plan.requestedSizing, { mode: 'dimension', axis: 'y', millimeters: 150 });
});

test('unsafe sizing modes, values, additional fields and aspect-preserving oversize are rejected', () => {
  for (const sizing of [undefined, {}, [], { mode: 'automatic' }, { mode: 'original', path: 'external.stl' }, { mode: 'scale', factor: '2' }, { mode: 'scale', factor: NaN }, { mode: 'scale', factor: Infinity }, { mode: 'scale', factor: 0.00001 }, { mode: 'scale', factor: 10001 }, { mode: 'dimension', axis: 'a', millimeters: 10 }, { mode: 'dimension', axis: 'x', millimeters: -1 }, { mode: 'dimension', axis: 'x', millimeters: 10000 }]) {
    const config = options(sizing); if (sizing === undefined) delete config.sizing;
    assert.throws(() => planResinSizing(binary(), config), { code: 'RESIN_SIZING_INVALID' });
  }
  assert.deepEqual(planResinSizing(binary(), options({ mode: 'dimension', axis: 'z', millimeters: 10000 })).dimensionsMm, { x: 5000, y: 7500, z: 10000 });
  assert.throws(() => planResinSizing(binary(), options({ mode: 'scale', factor: 3 }, { units: 'm' })), { code: 'RESIN_SIZING_INVALID' });
});

test('binary emission applies units/scale and one global origin shift while preserving relative component positions', () => {
  const source = binary([...triangles([-5, 10, -2]), ...triangles([15, 10, -2])]);
  const output = prepareResinGeometry(source, options({ mode: 'scale', factor: 2 }, { units: 'in' }));
  const reread = measureResinGeometry(output.stl, options());
  assert.equal(output.stl.length, 84 + 8 * 50); assert.equal(reread.triangleCount, 8);
  assert.equal(output.transformedSha256, sha256(output.stl)); assert.equal(output.plan.sourceSha256, sha256(source));
  assert.deepEqual(output.transformedBounds.min, { x: 0, y: 0, z: 0 });
  for (const axis of ['x', 'y', 'z']) close(reread.sourceDimensionsMm[axis], output.plan.dimensionsMm[axis], float32Tolerance(output.plan.dimensionsMm[axis]));
  close(output.stl.readFloatLE(84 + 4 * 50 + 12), 20 * 25.4 * 2, 1e-4, 'the second component is not separately recentered');
  close(output.stl.readFloatLE(84 + 8), 1, 1e-7, 'source zero normals are recomputed from preserved winding');
  assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.transformedBounds.min));
  assert.deepEqual(prepareResinGeometry(source, options({ mode: 'scale', factor: 2 }, { units: 'in' })).stl, output.stl);
});

test('triangulated OBJ emits millimetre binary STL and excludes unreferenced vertex outliers', () => {
  const source = obj([...BASE, [99999, 99999, 99999]]);
  const output = prepareResinGeometry(source, options({ mode: 'dimension', axis: 'x', millimeters: 10 }, { format: 'obj' }));
  assert.equal(output.stl.readUInt32LE(80), 4);
  assert.deepEqual(measureResinGeometry(output.stl, options()).sourceDimensionsMm, { x: 10, y: 15, z: 20 });
});

test('large source offsets are subtracted before scale and float32 emission', () => {
  const source = ascii(triangles([100000000, -100000000, 100000000]));
  const output = prepareResinGeometry(source, options({ mode: 'scale', factor: 100 }));
  assert.deepEqual(output.plan.transform.originSourceUnits, { x: 100000000, y: -100000000, z: 100000000 });
  assert.deepEqual(measureResinGeometry(output.stl, options()).sourceDimensionsMm, { x: 200, y: 300, z: 400 });
});

test('float32 conversion rejects collapsed features instead of returning a dimension-only success', () => {
  const bytes = obj([...BASE, [5000, 0, 0], [5000.000001, 0, 0], [5000, 1, 0]], [...FACES, [4, 5, 6]]);
  assert.ok(planResinSizing(bytes, options(undefined, { format: 'obj' })).dimensionsMm.x > 5000);
  assert.throws(() => prepareResinGeometry(bytes, options(undefined, { format: 'obj' })), { code: 'RESIN_GEOMETRY_PRECISION' });
});

test('byte, triangle, vertex, coordinate and text limits are bounded and may only be lowered', () => {
  for (const limits of [{ maxBytes: 100 }, { maxTriangles: 3 }, { maxCoordinate: 1 }]) assert.throws(() => measureResinGeometry(binary(), options(undefined, { limits })));
  assert.throws(() => measureResinGeometry(obj(), options(undefined, { format: 'obj', limits: { maxVertices: 3 } })), { code: 'RESIN_GEOMETRY_LIMIT' });
  assert.throws(() => measureResinGeometry(ascii(), options(undefined, { limits: { maxLineLength: 5 } })), { code: 'RESIN_GEOMETRY_LIMIT' });
  for (const limits of [{ maxBytes: 1000000000 }, { maxVertices: 1.5 }, { unknown: 1 }, { maxCoordinate: Infinity }]) assert.throws(() => measureResinGeometry(binary(), options(undefined, { limits })), { code: 'RESIN_GEOMETRY_LIMIT' });
  const bytes = obj(); assert.ok(bytes.length < 250);
  assert.throws(() => prepareResinGeometry(bytes, options(undefined, { format: 'obj', limits: { maxBytes: 250 } })), /output byte limit/);
});

test('orientation measurement applies the provider Z then X then Y order to actual vertices', () => {
  for (const [orientation, dimensions] of [
    [{ x: 0, y: 0, z: 90 }, { x: 3, y: 2, z: 4 }],
    [{ x: 90, y: 0, z: 0 }, { x: 2, y: 4, z: 3 }],
    [{ x: 0, y: 90, z: 0 }, { x: 4, y: 3, z: 2 }],
    [{ x: 90, y: 90, z: 90 }, { x: 2, y: 4, z: 3 }],
  ]) {
    const result = measureResinOrientation(binary(), { format: 'stl', units: 'mm', orientation });
    for (const axis of ['x', 'y', 'z']) close(result.dimensionsMm[axis], dimensions[axis]);
    assert.equal(result.triangleCount, 4); assert.equal(result.sourceSha256, sha256(binary())); assert.ok(Object.isFrozen(result.boundsMm.min));
  }
});

test('asymmetric rotated bounds use referenced vertices rather than corners of the original bounding box', () => {
  const orientation = { x: 0, y: 0, z: 45 };
  const result = measureResinOrientation(binary(), { format: 'stl', units: 'mm', orientation });
  close(result.dimensionsMm.x, 5 / Math.sqrt(2)); close(result.dimensionsMm.y, 3 / Math.sqrt(2)); close(result.dimensionsMm.z, 4);
  assert.ok(result.dimensionsMm.y < 5 / Math.sqrt(2), 'rotating AABB corners would overestimate the Y extent');
  const translated = measureResinOrientation(binary(triangles([20, -10, 5])), { format: 'stl', units: 'in', orientation });
  for (const axis of ['x', 'y', 'z']) close(translated.dimensionsMm[axis], result.dimensionsMm[axis] * 25.4);
  for (const invalid of [{ x: 0, y: 0 }, { x: 0, y: 0, z: 361 }, { x: '0', y: 0, z: 0 }, { x: 0, y: 0, z: 0, scale: 2 }]) assert.throws(() => measureResinOrientation(binary(), { format: 'stl', units: 'mm', orientation: invalid }), { code: 'RESIN_ORIENTATION_INVALID' });
});
