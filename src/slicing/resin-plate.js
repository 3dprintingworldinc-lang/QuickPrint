'use strict';

// Copies are complete source-mesh instances, never a mesh-component count or
// certified production-unit count. Native supports/pads need separate evidence.
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const { forEachResinTriangle, measureResinGeometry, measureResinOrientation, float32Tolerance } = require('./resin-geometry');

const AXES = ['x', 'y', 'z'];
const MAX_COPIES = 500;
const LIMITS = Object.freeze({ maxBytes: 100 * 1024 * 1024, maxTriangles: 2000000, maxTimeMs: 30000 });
const HASH = /^[a-f0-9]{64}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_PLATE_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
const object = values => Object.fromEntries(AXES.map((axis, at) => [axis, values[at] === 0 ? 0 : values[at]]));
const hash = value => createHash('sha256').update(value).digest('hex');
const doubleTolerance = (...values) => Number.EPSILON * Math.max(1, ...values.map(Math.abs)) * 16;
// Translation can consume several source-coordinate ULPs. Keep this allowance
// relative to model extent, not an absolute-world relative displacement bound.
const extentTolerance = (extent, world) => float32Tolerance(extent)*8 + doubleTolerance(world);

function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(`Plate ${label} must be a finite number from ${min} to ${max}.`);
  return value;
}
function readOrientation(value) {
  if (!plain(value) || Reflect.ownKeys(value).length !== 3 || Reflect.ownKeys(value).some(key => !AXES.includes(key))) throw fail('Plate orientation must contain exactly x, y and z degrees.');
  return Object.fromEntries(AXES.map(axis => [axis, number(value[axis], `orientation ${axis}`, -360, 360)]));
}
function readLimits(value) {
  const limits = { ...LIMITS };
  if (value !== undefined) {
    if (!plain(value) || Reflect.ownKeys(value).some(key => !Object.hasOwn(LIMITS, key))) throw fail('Plate resource limits are invalid.', 'RESIN_PLATE_LIMIT');
    for (const [key, item] of Object.entries(value)) {
      if (!Number.isSafeInteger(item) || item < 1 || item > LIMITS[key]) throw fail('Plate limits may only lower positive whole-number hard bounds.', 'RESIN_PLATE_LIMIT');
      limits[key] = item;
    }
  }
  return limits;
}
function configuration(options) {
  if (!plain(options) || Reflect.ownKeys(options).some(key => !['orientation', 'bed', 'copies', 'gapMm', 'marginMm', 'supportEnvelopeMm', 'supportHeightMm', 'pixelPitchMm', 'limits'].includes(key))) throw fail('Use an explicit plate orientation, rectangular bed, copy count and spacing policy.');
  const orientation = readOrientation(options.orientation);
  if (!plain(options.bed) || Reflect.ownKeys(options.bed).length !== 3 || Reflect.ownKeys(options.bed).some(key => !['widthMm', 'heightMm', 'maxHeightMm'].includes(key))) throw fail('Declare a zero-origin rectangular bed width, height and maximum print height.');
  const bed = Object.fromEntries(['widthMm', 'heightMm', 'maxHeightMm'].map(key => [key, number(options.bed[key], key, 0.001, 10000)]));
  if (!Number.isSafeInteger(options.copies) || options.copies < 1 || options.copies > MAX_COPIES) throw fail('Plate copies must be a whole number from 1 to 500.');
  let pixelPitchMm = null;
  if (options.pixelPitchMm !== undefined) {
    if (!plain(options.pixelPitchMm) || Reflect.ownKeys(options.pixelPitchMm).length !== 2 || Reflect.ownKeys(options.pixelPitchMm).some(key => !['x','y'].includes(key))) throw fail('Pixel pitch must contain exactly positive x and y millimetres.');
    pixelPitchMm = Object.fromEntries(['x','y'].map(axis => [axis, number(options.pixelPitchMm[axis], `pixelPitchMm.${axis}`, Number.MIN_VALUE, 10000)]));
  }
  return { orientation, bed, copies: options.copies,
    gapMm: number(options.gapMm, 'gapMm', 0, 10000), marginMm: number(options.marginMm, 'marginMm', 0, 10000),
    supportEnvelopeMm: number(options.supportEnvelopeMm, 'supportEnvelopeMm', 0, 10000),
    supportHeightMm: number(options.supportHeightMm === undefined ? 0 : options.supportHeightMm, 'supportHeightMm', 0, 10000), pixelPitchMm, limits: readLimits(options.limits) };
}

function normal(points) {
  const a = points[1].map((value, axis) => value - points[0][axis]), b = points[2].map((value, axis) => value - points[0][axis]);
  const divisor = Math.max(...a.map(Math.abs), ...b.map(Math.abs));
  if (!Number.isFinite(divisor) || divisor === 0) throw fail('Plate placement collapsed a source triangle.', 'RESIN_PLATE_PRECISION');
  for (let axis = 0; axis < 3; axis++) { a[axis] /= divisor; b[axis] /= divisor; }
  const cross = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]], length = Math.hypot(...cross);
  if (!Number.isFinite(length) || length === 0) throw fail('Plate placement collapsed a source triangle.', 'RESIN_PLATE_PRECISION');
  return cross.map(value => value / length);
}
function rotation(orientation) {
  const [x,y,z] = AXES.map(axis => orientation[axis] * Math.PI / 180), [cx,cy,cz] = [x,y,z].map(Math.cos), [sx,sy,sz] = [x,y,z].map(Math.sin);
  return ([x,y,z]) => {
    const zx = x*cz-y*sz, zy = x*sz+y*cz, xy = zy*cx-z*sx, xz = zy*sx+z*cx;
    return [zx*cy+xz*sy, xy, -zx*sy+xz*cy];
  };
}
function axisCapacity(available, footprint, gap) {
  if (available <= 0 || footprint - available > doubleTolerance(footprint, available)) return 0;
  const quotient = (available + gap) / (footprint + gap);
  let count = Math.min(MAX_COPIES, Math.floor(quotient + Number.EPSILON * Math.abs(quotient) * 8));
  while (count > 0 && count*footprint+(count-1)*gap-available > doubleTolerance(available, count*footprint)) count--;
  return count;
}
function bounds(minimum, maximum) { return { min: object(minimum), max: object(maximum) }; }

function canonicalSource(source, orientation, limits, checkTime) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > limits.maxBytes) throw fail('The normalized source STL exceeds its nonempty input byte bound.', 'RESIN_PLATE_LIMIT', 413);
  const parserOptions = { format: 'stl', units: 'mm', limits: { maxBytes: limits.maxBytes, maxTriangles: limits.maxTriangles } };
  const measured = measureResinGeometry(source, parserOptions); checkTime();
  if (AXES.some(axis => measured.sourceBounds.min[axis] !== 0 || measured.sourceBounds.max[axis] > 10000)) throw fail('Plate input must be the zero-origin millimetre STL from normalized source preparation.', 'RESIN_PLATE_SOURCE_INVALID');
  const rotated = measureResinOrientation(source, { ...parserOptions, orientation }); checkTime();
  if (rotated.sourceSha256 !== measured.sourceSha256) throw fail('The source STL changed while planning the plate.', 'RESIN_PLATE_SOURCE_CHANGED', 409);
  const length = 84+measured.triangleCount*50;
  if (length > limits.maxBytes) throw fail('Canonical source STL exceeds the byte bound.', 'RESIN_PLATE_LIMIT', 413);
  const stl = Buffer.alloc(length); stl.write('QuickPrint rotated normalized plate source'); stl.writeUInt32LE(measured.triangleCount,80);
  const rotate = rotation(orientation);
  const parsed = forEachResinTriangle(source, parserOptions, (points, index) => {
    if ((index & 255) === 0) checkTime();
    const transformed = points.map(rotate), originalNormal = normal(transformed);
    const rounded = transformed.map(point => point.map((value, axis) => {
      const exact = value-rotated.boundsMm.min[AXES[axis]], result = Math.fround(exact);
      if (!Number.isFinite(result) || result < 0 || Math.abs(result-exact) > float32Tolerance(exact)) throw fail('Rotated source cannot be represented safely in float32.', 'RESIN_PLATE_PRECISION');
      return result === 0 ? 0 : result;
    }));
    const emittedNormal = normal(rounded);
    if (originalNormal.reduce((sum,value,axis) => sum+value*emittedNormal[axis],0) <= 0) throw fail('Source normalization changed triangle winding.', 'RESIN_PLATE_PRECISION');
    const offset = 84+index*50;
    emittedNormal.forEach((value,axis) => stl.writeFloatLE(value === 0 ? 0 : value,offset+axis*4));
    rounded.forEach((point,vertex) => point.forEach((value,axis) => stl.writeFloatLE(value,offset+12+vertex*12+axis*4)));
  });
  checkTime();
  if (parsed.sourceSha256 !== measured.sourceSha256) throw fail('The source STL changed while normalizing orientation.', 'RESIN_PLATE_SOURCE_CHANGED',409);
  const actual = measureResinGeometry(stl, parserOptions); checkTime();
  return { stl, sha256: actual.sourceSha256, bounds: actual.sourceBounds, dimensionsMm: actual.sourceDimensionsMm,
    sourceSha256: measured.sourceSha256, triangleCount: measured.triangleCount, measured, rotated };
}

function prepareResinPlateSource(source, options) {
  if (!plain(options) || Reflect.ownKeys(options).some(key => !['orientation','limits'].includes(key))) throw fail('Canonical plate source accepts orientation and bounded limits only.');
  const orientation = readOrientation(options.orientation), limits = readLimits(options.limits), deadline = performance.now()+limits.maxTimeMs;
  const checkTime = () => { if (performance.now() > deadline) throw fail('Plate source preparation exceeded its time budget.','RESIN_PLATE_TIMEOUT',413); };
  const result = canonicalSource(source,orientation,limits,checkTime);
  return Object.freeze({ stl: result.stl, sha256: result.sha256, bounds: freeze(result.bounds), dimensionsMm: freeze(result.dimensionsMm), sourceSha256: result.sourceSha256, triangleCount: result.triangleCount });
}

function pixelAxis(low, high, minimumStep, pitch) {
  const quotient = minimumStep/pitch;
  let stepPixels = Math.max(1,Math.ceil(quotient-Number.EPSILON*Math.abs(quotient)*8));
  if (!Number.isSafeInteger(stepPixels)) throw fail('Pixel grid steps exceed exact integer precision.','RESIN_PLATE_PIXEL_GRID_INVALID');
  if (stepPixels*pitch < minimumStep-doubleTolerance(minimumStep)) stepPixels++;
  if (high < low-doubleTolerance(low,high)) return { first: null, last: null, stepPixels, capacity: 0 };
  const lowPixels = low/pitch, highPixels = high/pitch;
  let first = Math.ceil(lowPixels-Number.EPSILON*Math.abs(lowPixels)*8), last = Math.floor(highPixels+Number.EPSILON*Math.abs(highPixels)*8);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) throw fail('Pixel grid anchors exceed exact integer precision.','RESIN_PLATE_PIXEL_GRID_INVALID');
  if (first*pitch < low-doubleTolerance(low)) first++;
  if (last*pitch > high+doubleTolerance(high)) last--;
  return { first, last, stepPixels, capacity: Math.max(0,Math.min(MAX_COPIES,1+Math.floor((last-first)/stepPixels))) };
}

function buildPlate(source, options, emit) {
  const config = configuration(options), { orientation, bed, copies, gapMm, marginMm, supportEnvelopeMm: envelope, supportHeightMm, pixelPitchMm, limits } = config;
  const deadline = performance.now() + limits.maxTimeMs;
  const checkTime = () => { if (performance.now() > deadline) throw fail('Plate preparation exceeded its bounded time budget.', 'RESIN_PLATE_TIMEOUT', 413); };
  const parserOptions = { format: 'stl', units: 'mm', limits: { maxBytes: limits.maxBytes, maxTriangles: limits.maxTriangles } };
  const canonical = canonicalSource(source,orientation,limits,checkTime), { measured,rotated } = canonical;
  const dimensions = canonical.dimensionsMm, triangleCount = measured.triangleCount;
  if (AXES.some(axis => !Number.isFinite(dimensions[axis]) || dimensions[axis] <= 0)) throw fail('The rotated source must have three positive extents.', 'RESIN_PLATE_SOURCE_INVALID');
  const footprintWidth = dimensions.x + envelope*2, footprintHeight = dimensions.y + envelope*2;
  const pixelX = pixelPitchMm ? pixelAxis(marginMm+envelope,bed.widthMm-marginMm-envelope-dimensions.x,footprintWidth+gapMm,pixelPitchMm.x) : null;
  const pixelY = pixelPitchMm ? pixelAxis(marginMm+envelope,bed.heightMm-marginMm-envelope-dimensions.y,footprintHeight+gapMm,pixelPitchMm.y) : null;
  const columnsCapacity = pixelX ? pixelX.capacity : axisCapacity(bed.widthMm-marginMm*2, footprintWidth, gapMm);
  const rowsCapacity = pixelY ? pixelY.capacity : axisCapacity(bed.heightMm-marginMm*2, footprintHeight, gapMm);
  const gridPitchMm = { x: pixelX ? pixelX.stepPixels*pixelPitchMm.x : footprintWidth+gapMm, y: pixelY ? pixelY.stepPixels*pixelPitchMm.y : footprintHeight+gapMm };
  const heightFits = dimensions.z+supportHeightMm-bed.maxHeightMm <= doubleTolerance(dimensions.z+supportHeightMm, bed.maxHeightMm);
  const xyCapacity = Math.min(MAX_COPIES, columnsCapacity*rowsCapacity), bedCapacity = heightFits ? xyCapacity : 0;
  const triangleCapacity = Math.floor(limits.maxTriangles / triangleCount), byteCapacity = Math.floor((limits.maxBytes-84)/(triangleCount*50));
  const capacity = Math.max(0, Math.min(MAX_COPIES, bedCapacity, triangleCapacity, byteCapacity)), copiesPlaced = Math.min(copies, capacity);
  const columns = copiesPlaced ? Math.min(columnsCapacity, copiesPlaced) : 0, rows = columns ? Math.ceil(copiesPlaced/columns) : 0;
  const gridWidth = columns ? footprintWidth+(columns-1)*gridPitchMm.x : 0, gridHeight = rows ? footprintHeight+(rows-1)*gridPitchMm.y : 0;
  const startX = (bed.widthMm-gridWidth)/2, startY = (bed.heightMm-gridHeight)/2;
  const startPixelX = pixelX && columns ? pixelX.first+Math.floor((pixelX.last-pixelX.first-(columns-1)*pixelX.stepPixels)/2) : null;
  const startPixelY = pixelY && rows ? pixelY.first+Math.floor((pixelY.last-pixelY.first-(rows-1)*pixelY.stepPixels)/2) : null;
  const placements = Array.from({ length: copiesPlaced }, (_, index) => ({ index, row: Math.floor(index/columns), column: index%columns,
    offsetMm: { x: pixelX ? (startPixelX+(index%columns)*pixelX.stepPixels)*pixelPitchMm.x : startX+(index%columns)*gridPitchMm.x+envelope,
      y: pixelY ? (startPixelY+Math.floor(index/columns)*pixelY.stepPixels)*pixelPitchMm.y : startY+Math.floor(index/columns)*gridPitchMm.y+envelope, z: 0 },
    anchorPixels: pixelPitchMm ? { x: startPixelX+(index%columns)*pixelX.stepPixels, y: startPixelY+Math.floor(index/columns)*pixelY.stepPixels } : null,
    startTriangle: index*triangleCount, triangleCount }));
  const outputTriangleCount = triangleCount*copiesPlaced, outputBytes = copiesPlaced ? 84+outputTriangleCount*50 : 0;
  const stl = emit && copiesPlaced ? Buffer.alloc(outputBytes) : null;
  const header = Buffer.alloc(84); header.write('QuickPrint verified explicit source-mesh instances'); header.writeUInt32LE(outputTriangleCount, 80);
  const digest = createHash('sha256'); if (copiesPlaced) { digest.update(header); if (stl) header.copy(stl); }
  const record = Buffer.alloc(50), totalMinimum = [Infinity,Infinity,Infinity], totalMaximum = [-Infinity,-Infinity,-Infinity];
  let steps = 0;
  for (const placement of placements) {
    checkTime();
    const minimum = [Infinity,Infinity,Infinity], maximum = [-Infinity,-Infinity,-Infinity];
    const parsed = forEachResinTriangle(canonical.stl, parserOptions, (points, index) => {
      if ((steps++ & 255) === 0) checkTime();
      const originalNormal = normal(points);
      const rounded = points.map(point => point.map((value, axis) => {
        const name = AXES[axis], exact = value+placement.offsetMm[name], result = Math.fround(exact);
        if (!Number.isFinite(result) || Math.abs(result-exact) > extentTolerance(dimensions[name], exact)) throw fail('Placed geometry cannot retain the source extent at float32 precision.', 'RESIN_PLATE_PRECISION');
        return result === 0 ? 0 : result;
      }));
      const roundedNormal = normal(rounded);
      if (originalNormal.reduce((sum, value, axis) => sum+value*roundedNormal[axis], 0) <= 0) throw fail('Float32 plate placement changed triangle winding.', 'RESIN_PLATE_PRECISION');
      roundedNormal.forEach((value, axis) => record.writeFloatLE(value === 0 ? 0 : value, axis*4));
      rounded.forEach((point, vertex) => point.forEach((value, axis) => { record.writeFloatLE(value, 12+vertex*12+axis*4); minimum[axis] = Math.min(minimum[axis], value); maximum[axis] = Math.max(maximum[axis], value); }));
      digest.update(record); if (stl) record.copy(stl, 84+(placement.startTriangle+index)*50);
    });
    checkTime();
    if (parsed.sourceSha256 !== canonical.sha256 || parsed.triangleCount !== triangleCount) throw fail('The canonical source STL changed while emitting copies.', 'RESIN_PLATE_SOURCE_CHANGED', 409);
    placement.boundsMm = bounds(minimum, maximum);
    placement.reservedBoundsMm = bounds([minimum[0]-envelope,minimum[1]-envelope,minimum[2]], [maximum[0]+envelope,maximum[1]+envelope,maximum[2]+supportHeightMm]);
    placement.precisionToleranceMm = object(AXES.map((axis, at) => extentTolerance(dimensions[axis], maximum[at])));
    for (const axis of AXES) {
      const lower = placement.reservedBoundsMm.min[axis], upper = placement.reservedBoundsMm.max[axis], tolerance = placement.precisionToleranceMm[axis];
      const margin = axis === 'z' ? 0 : marginMm, limit = axis === 'x' ? bed.widthMm : axis === 'y' ? bed.heightMm : bed.maxHeightMm;
      if (lower < margin-tolerance || upper > limit-margin+tolerance) throw fail('A rounded placed model or its reserved envelope exceeds the reviewed bed.', 'RESIN_PLATE_OUT_OF_BOUNDS');
    }
    for (let axis = 0; axis < 3; axis++) { totalMinimum[axis] = Math.min(totalMinimum[axis], minimum[axis]); totalMaximum[axis] = Math.max(totalMaximum[axis], maximum[axis]); }
  }
  let minimumReservedGapMm = null;
  for (let first = 0; first < placements.length; first++) for (let second = first+1; second < placements.length; second++) {
    if ((steps++ & 255) === 0) checkTime();
    const a = placements[first], b = placements[second];
    const modelX = Math.max(b.boundsMm.min.x-a.boundsMm.max.x,a.boundsMm.min.x-b.boundsMm.max.x), modelY = Math.max(b.boundsMm.min.y-a.boundsMm.max.y,a.boundsMm.min.y-b.boundsMm.max.y);
    if (modelX < 0 && modelY < 0) throw fail('Rounded source instance footprints overlap.', 'RESIN_PLATE_PRECISION');
    const x = Math.max(b.reservedBoundsMm.min.x-a.reservedBoundsMm.max.x,a.reservedBoundsMm.min.x-b.reservedBoundsMm.max.x);
    const y = Math.max(b.reservedBoundsMm.min.y-a.reservedBoundsMm.max.y,a.reservedBoundsMm.min.y-b.reservedBoundsMm.max.y);
    const clearance = Math.max(x,y), tolerance = Math.max(a.precisionToleranceMm.x,a.precisionToleranceMm.y,b.precisionToleranceMm.x,b.precisionToleranceMm.y)*2;
    if (clearance < gapMm-tolerance) throw fail('Rounded reservations no longer retain the reviewed copy gap.', 'RESIN_PLATE_PRECISION');
    minimumReservedGapMm = minimumReservedGapMm === null ? clearance : Math.min(minimumReservedGapMm, clearance);
  }
  checkTime();
  if (hash(source) !== measured.sourceSha256) throw fail('The source STL changed after plate preparation.', 'RESIN_PLATE_SOURCE_CHANGED', 409);
  checkTime();
  const outputSha256 = copiesPlaced ? digest.digest('hex') : null, outputBoundsMm = copiesPlaced ? bounds(totalMinimum,totalMaximum) : null;
  const limitingReasons = [];
  if (!heightFits) limitingReasons.push('height_limit'); else if (bedCapacity < copies) limitingReasons.push('bed_capacity');
  if (triangleCapacity < copies) limitingReasons.push('triangle_limit'); if (byteCapacity < copies) limitingReasons.push('byte_limit');
  const base = { schemaVersion: 1, sourceSha256: measured.sourceSha256, coordinateUnits: 'mm', sourceTriangleCount: triangleCount,
    sourceBoundsMm: measured.sourceBounds, sourceDimensionsMm: measured.sourceDimensionsMm, orientation, rotationOrder: ['z','x','y'], rotatedBoundsMm: rotated.boundsMm,
    canonicalSourceSha256: canonical.sha256, canonicalSourceBytes: canonical.stl.length, canonicalSourceBoundsMm: canonical.bounds, instanceDimensionsMm: dimensions,
    bed, gapMm, marginMm, supportEnvelopeMm: envelope, supportHeightMm, footprintMm: { width: footprintWidth, height: footprintHeight },
    pixelPitchMm, gridPitchMm, gridPitchPixels: pixelPitchMm ? { x: pixelX.stepPixels, y: pixelY.stepPixels } : null,
    anchorPixelRange: pixelPitchMm ? { x: { first: pixelX.first, last: pixelX.last }, y: { first: pixelY.first, last: pixelY.last } } : null,
    copiesRequested: copies, copiesPlaced, remainingCopies: copies-copiesPlaced, complete: copiesPlaced === copies,
    capacity, bedCapacity, xyCapacity, triangleCapacity, byteCapacity, columnsCapacity, rowsCapacity, heightFits, columns, rows,
    limitingReasons, zeroCapacityReason: copiesPlaced ? null : !heightFits ? 'height_limit' : !bedCapacity ? 'bed_footprint' : !triangleCapacity ? 'triangle_limit' : 'byte_limit',
    placements, minimumReservedGapMm, outputTriangleCount, outputBytes, outputSha256, outputBoundsMm, limits };
  const plan = freeze({ ...base, layoutSha256: hash(JSON.stringify(base)) });
  return { plan, stl, sha256: outputSha256, bounds: outputBoundsMm };
}

function planResinPlate(source, options) { return buildPlate(source, options, false).plan; }
function prepareResinPlate(source, options) {
  const result = buildPlate(source, options, true);
  if (!result.plan.copiesPlaced) throw Object.assign(fail('No complete source instance fits the reviewed plate policy.', 'RESIN_PLATE_NO_CAPACITY', 409), { plan: result.plan });
  return Object.freeze(result);
}
function verifyResinPlate(source, record, options) {
  if (!plain(record) || !Buffer.isBuffer(record.stl) || !HASH.test(record.sha256 || '')) throw fail('Plate verification requires the actual STL bytes and saved proof.', 'RESIN_PLATE_CHANGED', 409);
  const expected = prepareResinPlate(source, options);
  if (!isDeepStrictEqual(record.plan, expected.plan) || record.sha256 !== expected.sha256 || hash(record.stl) !== record.sha256 || !record.stl.equals(expected.stl) || !isDeepStrictEqual(record.bounds, expected.bounds)) throw fail('The placed mesh or canonical layout proof changed.', 'RESIN_PLATE_CHANGED', 409);
  return freeze({ plan: expected.plan, sha256: expected.sha256, bounds: expected.bounds, triangleCount: expected.plan.outputTriangleCount, bytes: expected.plan.outputBytes });
}

module.exports = { planResinPlate, prepareResinPlate, prepareResinPlateSource, verifyResinPlate, RESIN_PLATE_LIMITS: LIMITS };
