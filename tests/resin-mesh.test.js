'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { auditResinMesh, RESIN_MESH_LIMITS } = require('../src/slicing/resin-mesh');

const options = { format: 'stl', units: 'mm' };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const close = (actual, expected, relative = 1e-12) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * relative), `${actual} differs from ${expected}`);
const tetrahedron = (points = [[0,0,0], [1,0,0], [0,1,0], [0,0,1]]) => [[0,2,1], [0,1,3], [0,3,2], [1,2,3]].map(face => face.map(index => [...points[index]]));
function box(origin = [0,0,0], dimensions = [1,1,1]) {
  const points = [[0,0,0], [1,0,0], [1,1,0], [0,1,0], [0,0,1], [1,0,1], [1,1,1], [0,1,1]].map(point => point.map((value, axis) => origin[axis] + value * dimensions[axis]));
  return [[0,2,1], [0,3,2], [4,5,6], [4,6,7], [0,1,5], [0,5,4], [1,2,6], [1,6,5], [2,3,7], [2,7,6], [3,0,4], [3,4,7]].map(face => face.map(index => [...points[index]]));
}
const flip = triangles => triangles.map(([a,b,c]) => [[...a], [...c], [...b]]);
function binary(triangles) {
  const bytes = Buffer.alloc(84 + triangles.length * 50); bytes.write('Owned QuickPrint mesh audit fixture'); bytes.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, index) => triangle.forEach((vertex, at) => vertex.forEach((value, axis) => bytes.writeFloatLE(value, 84 + index * 50 + 12 + at * 12 + axis * 4))));
  return bytes;
}
function ascii(triangles) {
  return Buffer.from('solid owned\n' + triangles.map(triangle => 'facet normal 0 0 0\nouter loop\n' + triangle.map(vertex => 'vertex ' + vertex.join(' ')).join('\n') + '\nendloop\nendfacet').join('\n') + '\nendsolid owned\n');
}
function obj(triangles) {
  return Buffer.from(triangles.flatMap(triangle => triangle.map(vertex => 'v ' + vertex.join(' '))).join('\n') + '\n' + triangles.map((_, index) => `f ${index * 3 + 1} ${index * 3 + 2} ${index * 3 + 3}`).join('\n'));
}
function ellipsoid(level, radii = [2,3,5]) {
  const points = [[1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]];
  let faces = [[4,0,2], [4,2,1], [4,1,3], [4,3,0], [5,2,0], [5,1,2], [5,3,1], [5,0,3]];
  for (let iteration = 0; iteration < level; iteration++) {
    const midpoint = new Map();
    const middle = (a, b) => {
      const key = [Math.min(a,b), Math.max(a,b)].join(':'); if (midpoint.has(key)) return midpoint.get(key);
      const point = points[a].map((value, axis) => (value + points[b][axis]) / 2), length = Math.hypot(...point);
      const index = points.length; points.push(point.map(value => value / length)); midpoint.set(key, index); return index;
    };
    faces = faces.flatMap(([a,b,c]) => { const ab = middle(a,b), bc = middle(b,c), ca = middle(c,a); return [[a,ab,ca], [ab,b,bc], [ca,bc,c], [ab,bc,ca]]; });
  }
  return faces.map(face => face.map(index => points[index].map((value, axis) => value * radii[axis])));
}

test('a tetrahedron has closed oriented edge/vertex topology, stable volume and immutable source-bound proof', () => {
  const source = binary(tetrahedron()), before = Buffer.from(source), proof = auditResinMesh(source, options);
  assert.equal(proof.sourceSha256, hash(source)); assert.equal(proof.schemaVersion, 1);
  assert.deepEqual([proof.triangleCount, proof.vertexCount, proof.edgeCount, proof.componentCount], [4,4,6,1]);
  assert.deepEqual(proof.topology, { closed: true, edgeManifold: true, vertexManifold: true, consistentlyOriented: true });
  close(proof.components[0].volumeMm3, 1 / 6); assert.equal(proof.components[0].winding, 'positive');
  assert.deepEqual(proof.dimensionsMm, { x: 1, y: 1, z: 1 });
  assert.equal(proof.intersectionStatus, 'not_checked'); assert.equal(proof.cavityStatus, 'not_classified'); assert.equal(proof.solidCertified, false);
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.components[0].boundsMm.min));
  assert.throws(() => { proof.components[0].volumeMm3 = 999; }, TypeError);
  assert.deepEqual(JSON.parse(JSON.stringify(proof)), proof); assert.deepEqual(source, before);
});

test('binary and ASCII STL and triangulated OBJ weld coordinate-identical vertices across independent face records', () => {
  const triangles = box([0,0,0], [2,3,5]);
  for (const [format, bytes] of [['stl', binary(triangles)], ['stl', ascii(triangles)], ['obj', obj(triangles)]]) {
    const proof = auditResinMesh(bytes, { format, units: 'mm' });
    assert.equal(proof.vertexCount, 8); assert.equal(proof.edgeCount, 18); assert.equal(proof.triangleCount, 12); close(proof.components[0].signedVolumeMm3, 30);
    assert.deepEqual(proof.dimensionsMm, { x: 2, y: 3, z: 5 });
  }
});

test('arbitrary curved tessellations audit as manifold shells rather than relying on box-specific geometry', () => {
  const proof = auditResinMesh(binary(ellipsoid(5)), options);
  assert.equal(proof.triangleCount, 8192); assert.equal(proof.vertexCount, 4098); assert.equal(proof.edgeCount, 12288); assert.equal(proof.componentCount, 1);
  assert.deepEqual(proof.dimensionsMm, { x: 4, y: 6, z: 10 });
  close(proof.components[0].volumeMm3, 4 / 3 * Math.PI * 2 * 3 * 5, 0.002);
});

test('separated shells retain independent volumes, bounds and connected-triangle counts', () => {
  const proof = auditResinMesh(binary([...box(), ...box([3,4,5], [2,3,4])]), options);
  assert.equal(proof.componentCount, 2); assert.deepEqual(proof.components.map(component => component.triangleCount), [12,12]);
  assert.deepEqual(proof.components.map(component => component.volumeMm3), [1,24]);
  assert.deepEqual(proof.components[1].boundsMm, { min: { x: 3, y: 4, z: 5 }, max: { x: 5, y: 7, z: 9 } });
  assert.equal(proof.cavityReviewRequired, true);
});

test('coordinate welding is exact and does not merge shells separated by a small real gap', () => {
  const proof = auditResinMesh(ascii([...box(), ...box([1.000001,0,0])]), options);
  assert.equal(proof.componentCount, 2); assert.equal(proof.vertexCount, 16);
});

test('open boundaries, flipped local faces and third edge incidences are rejected', () => {
  const cube = box();
  assert.throws(() => auditResinMesh(binary(cube.slice(1)), options), { code: 'RESIN_MESH_OPEN' });
  const flipped = box(); flipped[0].reverse();
  assert.throws(() => auditResinMesh(binary(flipped), options), { code: 'RESIN_MESH_WINDING' });
  const sharingEdge = [...tetrahedron(), ...tetrahedron([[0,0,0], [1,0,0], [0,-1,0], [0,0,-1]])];
  assert.throws(() => auditResinMesh(binary(sharingEdge), options), { code: 'RESIN_MESH_NON_MANIFOLD_EDGE' });
});

test('duplicate geometric faces are rejected regardless of cyclic ordering or opposite winding', () => {
  const cube = box(), [a,b,c] = cube[0];
  for (const duplicate of [[a,b,c], [b,c,a], [a,c,b]]) {
    assert.throws(() => auditResinMesh(binary([...cube, duplicate]), options), { code: 'RESIN_MESH_DUPLICATE_FACE' });
  }
});

test('two otherwise closed shells touching only at a bow-tie vertex fail vertex-manifold validation', () => {
  const touching = [...tetrahedron(), ...tetrahedron([[0,0,0], [-1,0,0], [0,-1,0], [0,0,-1]])];
  assert.throws(() => auditResinMesh(binary(touching), options), { code: 'RESIN_MESH_NON_MANIFOLD_VERTEX' });
});

test('negative and nested shell winding is reported for review without claiming cavity or solid certification', () => {
  const negative = auditResinMesh(binary(flip(box())), options);
  assert.equal(negative.components[0].winding, 'negative'); assert.equal(negative.components[0].signedVolumeMm3, -1); assert.equal(negative.components[0].volumeMm3, 1);
  assert.equal(negative.cavityReviewRequired, true);
  const nested = auditResinMesh(binary([...box([0,0,0], [3,3,3]), ...flip(box([1,1,1]))]), options);
  assert.deepEqual(nested.components.map(component => component.signedVolumeMm3), [27,-1]); assert.equal(nested.signedShellVolumeMm3, 26);
  assert.equal(nested.cavityStatus, 'not_classified'); assert.equal(nested.intersectionStatus, 'not_checked'); assert.equal(nested.solidCertified, false);
});

test('topologically closed overlapping shells remain explicitly uncertified for intersections', () => {
  const proof = auditResinMesh(binary([...box(), ...box([0.5,0.5,0.5])]), options);
  assert.equal(proof.componentCount, 2); assert.equal(proof.intersectionStatus, 'not_checked'); assert.equal(proof.solidCertified, false);
});

test('signed volume subtracts large offsets before unit scaling and uses compensated relative tetrahedra', () => {
  const dimensions = [1.25,2.5,3.75], expectedRawVolume = dimensions.reduce((value, item) => value * item, 1);
  for (const [units, scale] of [['mm',1], ['in',25.4], ['m',1000]]) {
    const origin = [100000000,-200000000,300000000];
    const proof = auditResinMesh(ascii(box(origin, dimensions)), { format: 'stl', units });
    close(proof.components[0].signedVolumeMm3, expectedRawVolume * scale ** 3);
    for (const [axis, index] of [['x',0], ['y',1], ['z',2]]) close(proof.dimensionsMm[axis], dimensions[index] * scale);
    assert.deepEqual(proof.sourceBounds.min, { x: origin[0], y: origin[1], z: origin[2] });
  }
});

test('a combinatorially closed flat tetrahedron cannot claim positive enclosed volume', () => {
  assert.throws(() => auditResinMesh(binary(tetrahedron([[0,0,0], [1,0,0], [0,1,0], [1,1,0]])), options), { code: 'RESIN_MESH_VOLUME_INVALID' });
});

test('input, triangle, vertex, edge and component resource bounds reject before unbounded growth', () => {
  const source = binary(box());
  for (const limits of [{ maxBytes: source.length - 1 }, { maxTriangles: 11 }, { maxVertices: 7 }, { maxEdges: 17 }]) {
    assert.throws(() => auditResinMesh(source, { ...options, limits }), { code: 'RESIN_MESH_LIMIT' });
  }
  assert.throws(() => auditResinMesh(binary([...tetrahedron(), ...box([3,3,3])]), { ...options, limits: { maxComponents: 1 } }), { code: 'RESIN_MESH_LIMIT' });
  for (const limits of [{ maxTriangles: RESIN_MESH_LIMITS.maxTriangles + 1 }, { maxBytes: Infinity }, { maxVertices: '8' }, { maxEdges: 0 }, { maxTimeMs: 0.5 }, { unknown: 1 }]) {
    assert.throws(() => auditResinMesh(source, { ...options, limits }), { code: 'RESIN_MESH_OPTIONS_INVALID' });
  }
  assert.ok(Object.isFrozen(RESIN_MESH_LIMITS));
});

test('CPU budget is checked during triangle processing without relying on wall-clock timing', t => {
  const source = binary(ellipsoid(3)); let reads = 0;
  t.mock.method(performance, 'now', () => ++reads <= 2 ? 0 : 2);
  assert.throws(() => auditResinMesh(source, { ...options, limits: { maxTimeMs: 1 } }), { code: 'RESIN_MESH_TIMEOUT' });
  assert.ok(reads >= 3);
});

test('unsupported options and malformed or degenerate geometry fail rather than returning a topology proof', () => {
  const source = binary(tetrahedron());
  for (const invalid of [undefined, {}, { ...options, units: 'cm' }, { ...options, format: 'step' }, { ...options, tolerance: 0.01 }]) {
    assert.throws(() => auditResinMesh(source, invalid), { code: 'RESIN_MESH_OPTIONS_INVALID' });
  }
  assert.throws(() => auditResinMesh(Buffer.from('solid empty\nendsolid empty\n'), options));
  const malformed = Buffer.from(source); malformed.writeFloatLE(NaN, 96);
  assert.throws(() => auditResinMesh(malformed, options), { code: 'RESIN_GEOMETRY_INVALID' });
  assert.throws(() => auditResinMesh(Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3 4\n'), { format: 'obj', units: 'mm' }), { code: 'RESIN_OBJ_TRIANGULATION_REQUIRED' });
});
