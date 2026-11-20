'use strict';

// Geometry measurements are pre-orientation and do not certify manifoldness,
// solid topology, support suitability, or a physical production-unit count.
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const AXES = ['x', 'y', 'z'];
const UNIT_SCALE = Object.freeze({ mm: 1, in: 25.4, m: 1000 });
const CAPS = Object.freeze({ maxBytes: 100 * 1024 * 1024, maxTriangles: 2000000, maxVertices: 1000000, maxLineLength: 65536, maxCoordinate: 1000000000 });
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, code = 'RESIN_GEOMETRY_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };

function settings(options) {
  if (!plain(options)) throw fail('Explicit geometry format and units are required.');
  if (!['stl', 'obj'].includes(options.format)) throw fail('Measure an STL or triangulated OBJ buffer.', 'RESIN_GEOMETRY_FORMAT');
  if (typeof options.units !== 'string' || !Object.hasOwn(UNIT_SCALE, options.units)) throw fail('Declare model units as mm, in or m.', 'RESIN_MODEL_UNITS');
  const limits = { ...CAPS };
  if (options.limits !== undefined) {
    if (!plain(options.limits) || Object.keys(options.limits).some(key => !Object.hasOwn(CAPS, key))) throw fail('Geometry resource limits are invalid.', 'RESIN_GEOMETRY_LIMIT');
    for (const [key, value] of Object.entries(options.limits)) {
      if (!Number.isFinite(value) || value <= 0 || value > CAPS[key] || (key !== 'maxCoordinate' && !Number.isSafeInteger(value))) throw fail('Geometry resource limits may only lower positive hard bounds.', 'RESIN_GEOMETRY_LIMIT');
      limits[key] = value;
    }
  }
  return { format: options.format, units: options.units, unitScale: UNIT_SCALE[options.units], limits };
}

function coordinate(value, limits) {
  if (!Number.isFinite(value) || Math.abs(value) > limits.maxCoordinate) throw fail('Mesh coordinates must be finite and within the geometry coordinate limit.');
  return value === 0 ? 0 : value;
}
function number(token, limits) {
  if (!NUMBER.test(token)) throw fail('Mesh numeric fields must use finite decimal numbers.');
  return coordinate(Number(token), limits);
}
function normal(vertices) {
  const a = vertices[1].map((value, axis) => value - vertices[0][axis]);
  const b = vertices[2].map((value, axis) => value - vertices[0][axis]);
  const divisor = Math.max(...a.map(Math.abs), ...b.map(Math.abs));
  if (!Number.isFinite(divisor) || divisor === 0) throw fail('Degenerate mesh triangles are unsupported.');
  for (let axis = 0; axis < 3; axis++) { a[axis] /= divisor; b[axis] /= divisor; }
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = Math.hypot(...cross);
  if (!Number.isFinite(length) || length === 0) throw fail('Degenerate mesh triangles are unsupported.');
  return cross.map(value => value / length);
}
function* lines(buffer, limits) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw fail('Text meshes must contain valid UTF-8.'); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw fail('Text meshes contain unsupported control characters.');
  let start = 0;
  for (let end = 0; end <= text.length; end++) {
    if (end !== text.length && text.charCodeAt(end) !== 10) continue;
    const line = text.slice(start, end).replace(/\r$/, ''); start = end + 1;
    if (line.length > limits.maxLineLength) throw fail('Mesh text line exceeds its resource limit.', 'RESIN_GEOMETRY_LIMIT', 413);
    yield line.trim();
  }
}

function binaryStl(buffer, limits, visit) {
  const count = buffer.readUInt32LE(80);
  if (!count || count > limits.maxTriangles) throw fail('STL triangle count is empty or exceeds its resource limit.', 'RESIN_GEOMETRY_LIMIT', 413);
  if (84 + count * 50 !== buffer.length) throw fail('Binary STL length does not match its triangle table.');
  for (let index = 0; index < count; index++) {
    const offset = 84 + index * 50;
    for (let axis = 0; axis < 3; axis++) coordinate(buffer.readFloatLE(offset + axis * 4), limits);
    const vertices = Array.from({ length: 3 }, (_, vertex) => Array.from({ length: 3 }, (_, axis) => coordinate(buffer.readFloatLE(offset + 12 + vertex * 12 + axis * 4), limits)));
    normal(vertices); visit(vertices);
  }
}
function asciiStl(buffer, limits, visit) {
  let state = 'solid', count = 0, solids = 0, vertices;
  for (const line of lines(buffer, limits)) {
    if (!line) continue;
    const tokens = line.split(/\s+/), command = tokens[0].toLowerCase();
    if (state === 'solid') {
      if (command !== 'solid') throw fail('ASCII STL must begin each section with solid.');
      solids++; state = 'facet'; continue;
    }
    if (state === 'facet' && command === 'endsolid') { state = 'solid'; continue; }
    if (state === 'facet' && command === 'facet' && tokens[1]?.toLowerCase() === 'normal' && tokens.length === 5) {
      tokens.slice(2).forEach(value => number(value, limits)); vertices = []; state = 'loop'; continue;
    }
    if (state === 'loop' && /^outer\s+loop$/i.test(line)) { state = 'vertex'; continue; }
    if (state === 'vertex' && command === 'vertex' && tokens.length === 4 && vertices.length < 3) {
      vertices.push(tokens.slice(1).map(value => number(value, limits))); if (vertices.length === 3) state = 'endloop'; continue;
    }
    if (state === 'endloop' && /^endloop$/i.test(line)) { state = 'endfacet'; continue; }
    if (state === 'endfacet' && /^endfacet$/i.test(line)) {
      if (++count > limits.maxTriangles) throw fail('STL triangle count exceeds its resource limit.', 'RESIN_GEOMETRY_LIMIT', 413);
      normal(vertices); visit(vertices); state = 'facet'; continue;
    }
    throw fail('ASCII STL facet grammar is malformed or unsupported.');
  }
  if (state !== 'solid' || !solids || !count) throw fail('ASCII STL is incomplete or contains no triangles.');
}

function obj(buffer, limits, visit) {
  // Chunked storage bounds coordinate memory to about 24 MiB at the hard cap.
  const chunks = [], chunkSize = 8192;
  let vertices = 0, textures = 0, normals = 0, triangles = 0;
  const vertex = index => { const chunk = chunks[Math.floor(index / chunkSize)], at = (index % chunkSize) * 3; return [chunk[at], chunk[at + 1], chunk[at + 2]]; };
  const index = (token, count) => {
    if (!/^-?[1-9]\d*$/.test(token)) throw fail('OBJ face indices must be nonzero whole numbers.');
    const value = Number(token), resolved = value > 0 ? value - 1 : count + value;
    if (!Number.isSafeInteger(value) || resolved < 0 || resolved >= count) throw fail('OBJ face references missing or forward-declared geometry.');
    return resolved;
  };
  for (const raw of lines(buffer, limits)) {
    const line = raw.split('#', 1)[0].trim(); if (!line) continue;
    if (line.endsWith('\\')) throw fail('OBJ line continuations are unsupported.', 'RESIN_OBJ_UNSUPPORTED');
    const [command, ...tokens] = line.split(/\s+/);
    if (command === 'v') {
      if (tokens.length !== 3) throw fail('OBJ vertices require exactly x, y and z; homogeneous/color extensions are unsupported.');
      if (vertices >= limits.maxVertices) throw fail('OBJ vertex count exceeds its resource limit.', 'RESIN_GEOMETRY_LIMIT', 413);
      const values = tokens.map(value => number(value, limits)), chunk = Math.floor(vertices / chunkSize), at = (vertices % chunkSize) * 3;
      chunks[chunk] ||= new Float64Array(Math.min(chunkSize, limits.maxVertices - chunk * chunkSize) * 3);
      chunks[chunk].set(values, at); vertices++;
    } else if (command === 'vn' || command === 'vt') {
      if ((command === 'vn' && tokens.length !== 3) || (command === 'vt' && (tokens.length < 1 || tokens.length > 3))) throw fail('OBJ normal/texture metadata is malformed.');
      tokens.forEach(value => number(value, limits));
      if ((command === 'vn' ? ++normals : ++textures) > limits.maxVertices) throw fail('OBJ metadata exceeds its resource limit.', 'RESIN_GEOMETRY_LIMIT', 413);
    } else if (command === 'f') {
      if (tokens.length !== 3) throw fail('Triangulate OBJ faces before preparation; polygon tessellation is unsupported.', 'RESIN_OBJ_TRIANGULATION_REQUIRED');
      if (++triangles > limits.maxTriangles) throw fail('OBJ triangle count exceeds its resource limit.', 'RESIN_GEOMETRY_LIMIT', 413);
      const face = tokens.map(token => {
        const parts = token.split('/');
        if (parts.length > 3 || !parts[0] || (parts.length === 2 && !parts[1]) || (parts.length === 3 && !parts[2])) throw fail('OBJ face index syntax is malformed.');
        const result = vertex(index(parts[0], vertices));
        if (parts[1]) index(parts[1], textures);
        if (parts[2]) index(parts[2], normals);
        return result;
      });
      normal(face); visit(face);
    } else if (!['o', 'g', 's'].includes(command)) throw fail(`Unsupported OBJ directive: ${command}. External files and free-form geometry are not permitted.`, 'RESIN_OBJ_UNSUPPORTED');
  }
  if (!triangles) throw fail('OBJ contains no triangle faces.');
}
function parse(buffer, config, visit) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail('Supply a nonempty geometry Buffer.');
  if (buffer.length > config.limits.maxBytes) throw fail('Mesh exceeds its input byte limit.', 'RESIN_GEOMETRY_LIMIT', 413);
  if (config.format === 'obj') return obj(buffer, config.limits, visit);
  if (buffer.length >= 84 && 84 + buffer.readUInt32LE(80) * 50 === buffer.length) return binaryStl(buffer, config.limits, visit);
  return asciiStl(buffer, config.limits, visit);
}

function forEachResinTriangle(buffer, options, visit) {
  if (typeof visit !== 'function') throw fail('A triangle visitor is required.');
  const config = settings(options); let triangleCount = 0;
  parse(buffer, config, vertices => {
    visit(vertices.map(vertex => vertex.map(value => value * config.unitScale)), triangleCount++);
  });
  return freeze({ sourceSha256: hash(buffer), units: config.units, unitScale: config.unitScale, triangleCount, coordinateUnits: 'mm' });
}

function measureResinGeometry(buffer, options) {
  const config = settings(options), minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  let triangleCount = 0;
  parse(buffer, config, vertices => { triangleCount++; for (const vertex of vertices) for (let axis = 0; axis < 3; axis++) { minimum[axis] = Math.min(minimum[axis], vertex[axis]); maximum[axis] = Math.max(maximum[axis], vertex[axis]); } });
  const sourceDimensionsMm = Object.fromEntries(AXES.map((axis, index) => [axis, (maximum[index] - minimum[index]) * config.unitScale]));
  if (Object.values(sourceDimensionsMm).some(value => !Number.isFinite(value) || value <= 0)) throw fail('The referenced mesh must have positive finite X, Y and Z extents.');
  return freeze({ sourceSha256: hash(buffer), units: config.units, unitScale: config.unitScale, triangleCount,
    sourceBounds: { min: Object.fromEntries(AXES.map((axis, index) => [axis, minimum[index]])), max: Object.fromEntries(AXES.map((axis, index) => [axis, maximum[index]])) }, sourceDimensionsMm });
}

function planResinSizing(buffer, options) {
  const measured = measureResinGeometry(buffer, options), input = options.sizing;
  if (!plain(input) || !['original', 'scale', 'dimension'].includes(input.mode)) throw fail('Select an explicit original, scale or dimension sizing plan.', 'RESIN_SIZING_INVALID');
  const allowed = { original: ['mode'], scale: ['mode', 'factor'], dimension: ['mode', 'axis', 'millimeters'] }[input.mode];
  if (Object.keys(input).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(input, key))) throw fail('Sizing plans contain only the selected mode and its numeric fields.', 'RESIN_SIZING_INVALID');
  let uniformScale = 1, requestedSizing = { mode: 'original' };
  if (input.mode === 'scale') { uniformScale = input.factor; requestedSizing = { mode: 'scale', factor: input.factor }; }
  if (input.mode === 'dimension') {
    if (!AXES.includes(input.axis) || typeof input.millimeters !== 'number' || !Number.isFinite(input.millimeters) || input.millimeters <= 0 || input.millimeters > 10000) throw fail('Choose x/y/z and a positive target dimension no larger than 10000 mm.', 'RESIN_SIZING_INVALID');
    uniformScale = input.millimeters / measured.sourceDimensionsMm[input.axis]; requestedSizing = { mode: 'dimension', axis: input.axis, millimeters: input.millimeters };
  }
  if (typeof uniformScale !== 'number' || !Number.isFinite(uniformScale) || uniformScale < 0.0001 || uniformScale > 10000) throw fail('Uniform sizing factor must be from 0.0001 to 10000.', 'RESIN_SIZING_INVALID');
  const dimensionsMm = Object.fromEntries(AXES.map(axis => [axis, measured.sourceDimensionsMm[axis] * uniformScale]));
  if (Object.values(dimensionsMm).some(value => !Number.isFinite(value) || value <= 0 || value > 10000)) throw fail('Every transformed source dimension must be positive and at most 10000 mm.', 'RESIN_SIZING_INVALID');
  const scale = measured.unitScale * uniformScale;
  const plan = { schemaVersion: 1, ...measured, requestedSizing, uniformScale, dimensionsMm, coordinateUnits: 'mm',
    transform: { scale, originSourceUnits: { ...measured.sourceBounds.min }, translateMm: Object.fromEntries(AXES.map(axis => [axis, measured.sourceBounds.min[axis] === 0 ? 0 : -measured.sourceBounds.min[axis] * scale])) } };
  return freeze({ ...plan, sizingSha256: hash(JSON.stringify(plan)) });
}

function measureResinOrientation(buffer, options) {
  const config = settings(options), orientation = options.orientation;
  if (!plain(orientation) || Object.keys(orientation).length !== 3 || Object.keys(orientation).some(key => !AXES.includes(key)) || AXES.some(axis => typeof orientation[axis] !== 'number' || !Number.isFinite(orientation[axis]) || Math.abs(orientation[axis]) > 360)) throw fail('Orientation needs finite x/y/z degrees from -360 to 360.', 'RESIN_ORIENTATION_INVALID');
  const [xAngle, yAngle, zAngle] = AXES.map(axis => orientation[axis] * Math.PI / 180);
  const [cx, cy, cz] = [xAngle, yAngle, zAngle].map(Math.cos), [sx, sy, sz] = [xAngle, yAngle, zAngle].map(Math.sin);
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  let triangleCount = 0;
  parse(buffer, config, vertices => {
    triangleCount++;
    for (const vertex of vertices) {
      const [x, y, z] = vertex.map(value => value * config.unitScale);
      // Prusa's CLI applies Z, then X, then Y, independent of flag order.
      const zx = x * cz - y * sz, zy = x * sz + y * cz;
      const xy = zy * cx - z * sx, xz = zy * sx + z * cx;
      const rotated = [zx * cy + xz * sy, xy, -zx * sy + xz * cy];
      for (let axis = 0; axis < 3; axis++) { minimum[axis] = Math.min(minimum[axis], rotated[axis]); maximum[axis] = Math.max(maximum[axis], rotated[axis]); }
    }
  });
  const dimensionsMm = Object.fromEntries(AXES.map((axis, at) => [axis, maximum[at] - minimum[at]]));
  if (Object.values(dimensionsMm).some(value => !Number.isFinite(value) || value < 0)) throw fail('Rotated geometry has invalid extents.', 'RESIN_ORIENTATION_INVALID');
  return freeze({ sourceSha256: hash(buffer), triangleCount, orientation: { x: orientation.x, y: orientation.y, z: orientation.z }, coordinateUnits: 'mm',
    boundsMm: { min: Object.fromEntries(AXES.map((axis, at) => [axis, minimum[at]])), max: Object.fromEntries(AXES.map((axis, at) => [axis, maximum[at]])) }, dimensionsMm });
}

// A few float32 ULPs, including subnormal spacing; no millimetre-sized absolute
// floor that could mask the loss of very small geometry.
const float32Tolerance = value => Math.abs(value) * 2 ** -21 + 2 ** -148;
function prepareResinGeometry(buffer, options) {
  const config = settings(options), plan = planResinSizing(buffer, options), length = 84 + plan.triangleCount * 50;
  if (length > config.limits.maxBytes) throw fail('Transformed binary STL exceeds its output byte limit.', 'RESIN_GEOMETRY_LIMIT', 413);
  const stl = Buffer.alloc(length); stl.write('QuickPrint normalized millimetre source'); stl.writeUInt32LE(plan.triangleCount, 80);
  let index = 0;
  parse(buffer, config, source => {
    const vertices = source.map(vertex => vertex.map((value, axis) => {
      // Evaluate subtraction before multiplication. x*scale+translate can lose
      // small relative distances when raw coordinates have a large offset.
      const transformed = (value - plan.transform.originSourceUnits[AXES[axis]]) * plan.transform.scale, rounded = Math.fround(transformed);
      if (!Number.isFinite(rounded) || rounded < 0 || rounded > 10000 || Math.abs(rounded - transformed) > float32Tolerance(transformed)) throw fail('The requested geometry cannot be represented safely as float32 STL.', 'RESIN_GEOMETRY_PRECISION');
      return rounded === 0 ? 0 : rounded;
    }));
    let outputNormal;
    try { outputNormal = normal(vertices); } catch { throw fail('Float32 conversion collapsed a source triangle.', 'RESIN_GEOMETRY_PRECISION'); }
    const sourceNormal = normal(source);
    if (sourceNormal.reduce((sum, value, axis) => sum + value * outputNormal[axis], 0) <= 0) throw fail('Float32 conversion changed triangle winding.', 'RESIN_GEOMETRY_PRECISION');
    const offset = 84 + index++ * 50;
    outputNormal.forEach((value, axis) => stl.writeFloatLE(value, offset + axis * 4));
    vertices.forEach((vertex, at) => vertex.forEach((value, axis) => stl.writeFloatLE(value, offset + 12 + at * 12 + axis * 4)));
  });
  const reread = measureResinGeometry(stl, { format: 'stl', units: 'mm', limits: config.limits });
  if (reread.triangleCount !== plan.triangleCount || AXES.some(axis => reread.sourceBounds.min[axis] !== 0 || Math.abs(reread.sourceDimensionsMm[axis] - plan.dimensionsMm[axis]) > float32Tolerance(plan.dimensionsMm[axis]))) throw fail('The emitted STL does not match the requested sizing plan.', 'RESIN_GEOMETRY_PRECISION');
  return Object.freeze({ plan, stl, transformedSha256: reread.sourceSha256, transformedBounds: reread.sourceBounds });
}

module.exports = { measureResinGeometry, planResinSizing, prepareResinGeometry, measureResinOrientation, forEachResinTriangle, float32Tolerance };
