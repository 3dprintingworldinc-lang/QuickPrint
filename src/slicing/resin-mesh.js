'use strict';

// A bounded topology audit, not a solid/CAD kernel. Closed, consistently wound
// manifold shells may still intersect, overlap, or form unreviewed cavities.
const { performance } = require('node:perf_hooks');
const { forEachResinTriangle } = require('./resin-geometry');

const AXES = ['x', 'y', 'z'];
const UNIT_SCALE = Object.freeze({ mm: 1, in: 25.4, m: 1000 });
const LIMITS = Object.freeze({ maxBytes: 100 * 1024 * 1024, maxTriangles: 250000, maxVertices: 250000, maxEdges: 375000, maxComponents: 4096, maxTimeMs: 20000 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code, status = 422) => Object.assign(new Error(message), { code, status });
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const object = values => Object.fromEntries(AXES.map((axis, at) => [axis, values[at] === 0 ? 0 : values[at]]));
const next = halfedge => halfedge - halfedge % 3 + (halfedge % 3 + 1) % 3;

function configuration(options) {
  if (!plain(options) || Object.keys(options).some(key => !['format', 'units', 'limits'].includes(key)) || !['stl', 'obj'].includes(options.format) || !Object.hasOwn(UNIT_SCALE, options.units)) throw fail('Declare STL or triangulated OBJ and mm, in or m units.', 'RESIN_MESH_OPTIONS_INVALID', 400);
  const limits = { ...LIMITS };
  if (options.limits !== undefined) {
    if (!plain(options.limits) || Object.keys(options.limits).some(key => !Object.hasOwn(LIMITS, key))) throw fail('Mesh audit limits are invalid.', 'RESIN_MESH_OPTIONS_INVALID', 400);
    for (const [key, value] of Object.entries(options.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) throw fail('Mesh audit limits may only lower positive whole-number hard bounds.', 'RESIN_MESH_OPTIONS_INVALID', 400);
      limits[key] = value;
    }
  }
  return { ...options, limits, unitScale: UNIT_SCALE[options.units] };
}

function accumulator() {
  let sum = 0, correction = 0;
  return {
    add(value) {
      const combined = sum + value;
      correction += Math.abs(sum) >= Math.abs(value) ? (sum - combined) + value : (value - combined) + sum;
      sum = combined;
    },
    value: () => sum + correction,
  };
}

function auditResinMesh(buffer, options) {
  const config = configuration(options), { limits, unitScale } = config;
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail('Supply a nonempty triangle mesh Buffer.', 'RESIN_MESH_OPTIONS_INVALID', 400);
  if (buffer.length > limits.maxBytes) throw fail('Mesh exceeds the bounded audit input size.', 'RESIN_MESH_LIMIT', 413);
  const deadline = performance.now() + limits.maxTimeMs;
  let steps = 0;
  const checkTime = () => { if (performance.now() > deadline) throw fail('Mesh topology audit exceeded its time budget.', 'RESIN_MESH_TIMEOUT', 413); };
  const tick = () => { if ((steps++ & 255) === 0) checkTime(); };
  tick();
  const coordinates = new Float64Array(limits.maxVertices * 3);
  const vertices = new Uint32Array(limits.maxTriangles * 3);
  const twins = new Int32Array(limits.maxTriangles * 3); twins.fill(-1);
  const vertexIds = new Map(), edges = new Map(), faces = new Set();
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  // Safe integer pairing: (250000+1)^2 is well below Number.MAX_SAFE_INTEGER.
  const edgeBase = LIMITS.maxVertices + 1;
  let vertexCount = 0;
  const identify = point => {
    const key = point.join(',');
    let id = vertexIds.get(key);
    if (id !== undefined) return id;
    if (vertexCount >= limits.maxVertices) throw fail('Mesh exceeds the audit vertex limit.', 'RESIN_MESH_LIMIT', 413);
    id = vertexCount++; vertexIds.set(key, id); coordinates.set(point, id * 3);
    for (let axis = 0; axis < 3; axis++) { minimum[axis] = Math.min(minimum[axis], point[axis]); maximum[axis] = Math.max(maximum[axis], point[axis]); }
    return id;
  };
  let parsed;
  try {
    // Deliberately retain source coordinates here. Multiplying a large absolute
    // offset before subtraction can destroy small features; units are applied
    // to relative coordinates during dimensions and volume calculations below.
    parsed = forEachResinTriangle(buffer, { format: config.format, units: 'mm', limits: { maxBytes: limits.maxBytes, maxTriangles: limits.maxTriangles, maxVertices: limits.maxVertices } }, (points, index) => {
      tick();
      const ids = points.map(identify), sorted = [...ids].sort((a, b) => a - b), faceKey = sorted.join(':');
      if (faces.has(faceKey)) throw fail('Coordinate-identical duplicate triangle faces are unsupported.', 'RESIN_MESH_DUPLICATE_FACE');
      faces.add(faceKey);
      for (let at = 0; at < 3; at++) vertices[index * 3 + at] = ids[at];
      for (let at = 0; at < 3; at++) {
        const halfedge = index * 3 + at, a = ids[at], b = ids[(at + 1) % 3];
        const key = Math.min(a, b) * edgeBase + Math.max(a, b), previous = edges.get(key);
        if (previous === undefined) {
          if (edges.size >= limits.maxEdges) throw fail('Mesh exceeds the audit edge limit.', 'RESIN_MESH_LIMIT', 413);
          edges.set(key, halfedge);
        } else {
          if (twins[previous] !== -1) throw fail('Every closed manifold edge must have exactly two incident triangles.', 'RESIN_MESH_NON_MANIFOLD_EDGE');
          if (vertices[previous] !== b || vertices[next(previous)] !== a) throw fail('Adjacent mesh triangles must traverse shared edges in opposite directions.', 'RESIN_MESH_WINDING');
          twins[halfedge] = previous; twins[previous] = halfedge;
        }
      }
    });
  } catch (failure) {
    if (failure.code === 'RESIN_GEOMETRY_LIMIT') throw fail(failure.message, 'RESIN_MESH_LIMIT', 413);
    throw failure;
  }
  checkTime();
  const triangleCount = parsed.triangleCount, halfedgeCount = triangleCount * 3, edgeCount = edges.size;
  vertexIds.clear(); edges.clear(); faces.clear();
  for (let halfedge = 0; halfedge < halfedgeCount; halfedge++) {
    tick();
    if (twins[halfedge] === -1) throw fail('Open boundary edges cannot certify a closed shell.', 'RESIN_MESH_OPEN');
  }
  // In a closed oriented edge-manifold mesh, each vertex link is a collection
  // of cycles. Exactly one cycle is required; two cycles expose bow-tie vertices
  // even when all individual edges have two opposite triangle incidences.
  const walked = new Uint8Array(halfedgeCount), vertexCycle = new Uint8Array(vertexCount);
  for (let start = 0; start < halfedgeCount; start++) {
    tick();
    if (walked[start]) continue;
    const vertex = vertices[start];
    if (vertexCycle[vertex]) throw fail('A mesh vertex has disconnected incident triangle fans.', 'RESIN_MESH_NON_MANIFOLD_VERTEX');
    vertexCycle[vertex] = 1;
    let halfedge = start;
    do {
      tick();
      if (walked[halfedge] || vertices[halfedge] !== vertex) throw fail('A mesh vertex link is not a single manifold cycle.', 'RESIN_MESH_NON_MANIFOLD_VERTEX');
      walked[halfedge] = 1; halfedge = next(twins[halfedge]);
    } while (halfedge !== start);
  }
  const labels = new Uint32Array(triangleCount), queue = new Uint32Array(triangleCount), vertexComponent = new Uint32Array(vertexCount);
  const components = [], signedTotal = accumulator();
  for (let start = 0; start < triangleCount; start++) {
    tick();
    if (labels[start]) continue;
    if (components.length >= limits.maxComponents) throw fail('Mesh exceeds the audit connected-component limit.', 'RESIN_MESH_LIMIT', 413);
    const id = components.length + 1, reference = vertices[start * 3] * 3, volume = accumulator();
    const componentMinimum = [Infinity, Infinity, Infinity], componentMaximum = [-Infinity, -Infinity, -Infinity];
    let head = 0, tail = 1, componentVertices = 0; queue[0] = start; labels[start] = id;
    while (head < tail) {
      tick();
      const triangle = queue[head++], relative = [];
      for (let at = 0; at < 3; at++) {
        const halfedge = triangle * 3 + at, vertex = vertices[halfedge], coordinate = vertex * 3;
        relative.push([0, 1, 2].map(axis => (coordinates[coordinate + axis] - coordinates[reference + axis]) * unitScale));
        if (vertexComponent[vertex] !== id) {
          vertexComponent[vertex] = id; componentVertices++;
          for (let axis = 0; axis < 3; axis++) { componentMinimum[axis] = Math.min(componentMinimum[axis], coordinates[coordinate + axis]); componentMaximum[axis] = Math.max(componentMaximum[axis], coordinates[coordinate + axis]); }
        }
        const neighbor = Math.floor(twins[halfedge] / 3);
        if (!labels[neighbor]) { labels[neighbor] = id; queue[tail++] = neighbor; }
      }
      const [a, b, c] = relative;
      volume.add(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
    }
    const signedVolumeMm3 = volume.value() / 6;
    if (!Number.isFinite(signedVolumeMm3) || Math.abs(signedVolumeMm3) === 0) throw fail('A closed component must have finite nonzero signed enclosed volume.', 'RESIN_MESH_VOLUME_INVALID');
    signedTotal.add(signedVolumeMm3);
    components.push({ id, triangleCount: tail, vertexCount: componentVertices,
      boundsMm: { min: object(componentMinimum.map(value => value * unitScale)), max: object(componentMaximum.map(value => value * unitScale)) },
      dimensionsMm: object(componentMaximum.map((value, axis) => (value - componentMinimum[axis]) * unitScale)),
      signedVolumeMm3, volumeMm3: Math.abs(signedVolumeMm3), winding: signedVolumeMm3 > 0 ? 'positive' : 'negative' });
  }
  checkTime();
  return freeze({ schemaVersion: 1, sourceSha256: parsed.sourceSha256, units: config.units, unitScale, coordinateUnits: 'mm', triangleCount, vertexCount, edgeCount, componentCount: components.length,
    sourceBounds: { min: object(minimum), max: object(maximum) },
    boundsMm: { min: object(minimum.map(value => value * unitScale)), max: object(maximum.map(value => value * unitScale)) },
    dimensionsMm: object(maximum.map((value, axis) => (value - minimum[axis]) * unitScale)),
    topology: { closed: true, edgeManifold: true, vertexManifold: true, consistentlyOriented: true },
    components, signedShellVolumeMm3: signedTotal.value(),
    intersectionStatus: 'not_checked', cavityStatus: 'not_classified', solidCertified: false,
    cavityReviewRequired: components.length > 1 || components.some(component => component.winding === 'negative'), limits: { ...limits } });
}

module.exports = { auditResinMesh, RESIN_MESH_LIMITS: LIMITS };
