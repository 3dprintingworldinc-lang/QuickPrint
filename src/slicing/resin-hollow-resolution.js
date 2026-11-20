'use strict';

// Choose a single interval aggregation policy before native export. All source
// pixels still enter lower/upper aggregation; this is neither a geometry change
// nor permission to retry a failed audit at a coarser resolution.
const { createHash } = require('node:crypto');

const AXES = ['x', 'y', 'z'];
const CAPS = Object.freeze({ maxCells: 20000000, maxWorkingBytes: 768 * 1024 * 1024,
  maxReduction: 512, maxLayers: 25000, maxPixelsPerLayer: 100000000, maxDrains: 64 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_HOLLOW_RESOLUTION_INPUT', status = 400) => Object.assign(new Error(message), { code, status });
function keys(value, allowed, required, label) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail(`Invalid ${label}.`);
}
function numeric(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw fail(`Invalid ${label}.`);
  return value === 0 ? 0 : value;
}
function integer(value, minimum, maximum, label) {
  numeric(value, minimum, maximum, label);
  if (!Number.isSafeInteger(value)) throw fail(`Use a bounded whole number for ${label}.`);
  return value;
}
function vector(value, minimum, maximum, label) {
  keys(value, AXES, AXES, label);
  return Object.fromEntries(AXES.map(axis => [axis, numeric(value[axis], minimum, maximum, label)]));
}
function bounds(value, label) {
  keys(value, ['minMm', 'maxMm'], ['minMm', 'maxMm'], label);
  const result = { minMm: vector(value.minMm, -10000, 10000, label), maxMm: vector(value.maxMm, -10000, 10000, label) };
  if (AXES.some(axis => result.minMm[axis] >= result.maxMm[axis])) throw fail(`${label} must have positive extent on all axes.`);
  return result;
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function unresolved(reason) { throw fail(`The prior hollow raster policy is unresolved: ${reason}. Choose a new reviewed request before another attempt.`, 'RESIN_HOLLOW_RESOLUTION_UNRESOLVED', 422); }
const roundoff = value => Math.abs(value) * 2 ** -23 + 2 ** -149;

function configuration(input) {
  keys(input, ['geometry', 'sourceBoundsMm', 'supportEnvelope', 'modelElevationMm', 'wallThicknessMm', 'drains', 'request'],
    ['geometry', 'sourceBoundsMm', 'supportEnvelope', 'modelElevationMm', 'wallThicknessMm', 'request'], 'resolution request');
  const fields = ['resolutionX', 'resolutionY', 'displayWidthMm', 'displayHeightMm', 'machineZMm', 'layerHeightMm'];
  keys(input.geometry, fields, fields, 'printer geometry');
  const geometry = { resolutionX: integer(input.geometry.resolutionX, 1, 20000, 'X pixel count'), resolutionY: integer(input.geometry.resolutionY, 1, 20000, 'Y pixel count'),
    displayWidthMm: numeric(input.geometry.displayWidthMm, .001, 10000, 'display width'), displayHeightMm: numeric(input.geometry.displayHeightMm, .001, 10000, 'display height'),
    machineZMm: numeric(input.geometry.machineZMm, .001, 10000, 'machine height'), layerHeightMm: numeric(input.geometry.layerHeightMm, .0001, 10, 'layer height') };
  if (geometry.resolutionX * geometry.resolutionY > CAPS.maxPixelsPerLayer) throw fail('Native image pixels exceed the reader hard bound.');
  const sourceBoundsMm = bounds(input.sourceBoundsMm, 'canonical source bounds'), supportEnvelope = bounds(input.supportEnvelope, 'prior support envelope');
  if (AXES.some(axis => sourceBoundsMm.minMm[axis] !== 0)) throw fail('Canonical source minima must be zero before planning resolution.');
  const modelElevationMm = numeric(input.modelElevationMm, 0, 10000, 'model elevation'), wallThicknessMm = numeric(input.wallThicknessMm, .000001, 10000, 'wall thickness');
  keys(input.request, ['maximumUncertaintyMm', 'minimumPitchMm', 'reduction', 'maxCells', 'maxWorkingBytes'], ['maximumUncertaintyMm'], 'declared resolution policy');
  if (Object.hasOwn(input.request, 'reduction') && Object.hasOwn(input.request, 'minimumPitchMm')) throw fail('Choose explicit fixed reductions or automatic minimum pitches, not both.');
  let fixedReduction = null;
  if (Object.hasOwn(input.request, 'reduction')) {
    keys(input.request.reduction, AXES, AXES, 'fixed reduction');
    fixedReduction = Object.fromEntries(AXES.map(axis => [axis, integer(input.request.reduction[axis], 1, CAPS.maxReduction, 'fixed reduction')]));
  }
  const maximumUncertaintyMm = numeric(input.request.maximumUncertaintyMm, Number.MIN_VALUE, 10000, 'maximum uncertainty');
  if (maximumUncertaintyMm > wallThicknessMm / 3) throw fail('The declared maximum raster uncertainty must be no greater than one third of the wall request.');
  const nativePitch = { x: geometry.displayWidthMm / geometry.resolutionX, y: geometry.displayHeightMm / geometry.resolutionY, z: geometry.layerHeightMm };
  const minimumPitchMm = input.request.minimumPitchMm === undefined ? { ...nativePitch } : vector(input.request.minimumPitchMm, Number.MIN_VALUE, 10000, 'minimum pitch');
  const maxCells = input.request.maxCells === undefined ? CAPS.maxCells : integer(input.request.maxCells, 1, CAPS.maxCells, 'maximum cells');
  const maxWorkingBytes = input.request.maxWorkingBytes === undefined ? CAPS.maxWorkingBytes : integer(input.request.maxWorkingBytes, 1, CAPS.maxWorkingBytes, 'maximum working bytes');
  let drains = [];
  if (input.drains !== undefined) {
    if (!Array.isArray(input.drains) || !input.drains.length || input.drains.length > CAPS.maxDrains) throw fail('Supply one to 64 drain resolution projections.');
    const ids = new Set();
    drains = Array.from(input.drains, (value, index) => {
      keys(value, ['id', 'radiusMm', 'lengthMm', 'startMm', 'direction'], ['radiusMm', 'lengthMm'], 'drain projection');
      const id = value.id === undefined ? `drain-${index + 1}` : value.id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(id) || ids.has(id)) throw fail('Drain resolution identifiers must be unique bounded ASCII strings.');
      ids.add(id);
      if (value.startMm !== undefined) vector(value.startMm, -1000000, 1000000, 'drain start');
      if (value.direction !== undefined) { const direction = vector(value.direction, -1, 1, 'drain direction'); if (Math.abs(Math.hypot(...AXES.map(axis => direction[axis])) - 1) > 1e-12) throw fail('A supplied drain direction must be a unit vector.'); }
      return { id, radiusMm: numeric(value.radiusMm, .000001, 10000, 'drain radius'), lengthMm: numeric(value.lengthMm, .000001, 1000000, 'drain length') };
    });
  }
  return { geometry, sourceBoundsMm, supportEnvelope, modelElevationMm, wallThicknessMm, maximumUncertaintyMm, minimumPitchMm, fixedReduction, nativePitch, maxCells, maxWorkingBytes, drains };
}

/**
 * Resolve one fixed policy from only the prior profile/source/authorization.
 * No observed raster, issue count, runtime measurement or audit result is an
 * input. Automatic selection must fit the entire authorized envelope. Explicit
 * fixed selection may instead require the downstream actual crop to enforce
 * its declared limits before allocation; it never changes the fixed grid.
 */
function planResinHollowResolution(input) {
  const config = configuration(input), { geometry, sourceBoundsMm, supportEnvelope, modelElevationMm, wallThicknessMm,
    maximumUncertaintyMm, minimumPitchMm, fixedReduction, nativePitch, maxCells, maxWorkingBytes, drains } = config;
  // Full-relative-ULP reserves are conservative for finite positive float32
  // metadata. The actual audit still measures its metadata and must stay below
  // the same declared maximum. This is not a bound on native mesh operations.
  const displayRoundoff = { x: roundoff(geometry.displayWidthMm), y: roundoff(geometry.displayHeightMm) };
  const authorizedTopMm = Math.max(sourceBoundsMm.maxMm.z, supportEnvelope.maxMm.z) + modelElevationMm;
  const authorizedBottomMm = Math.min(sourceBoundsMm.minMm.z, supportEnvelope.minMm.z) + modelElevationMm;
  const heightUpperBoundMm = authorizedTopMm - Math.min(0, authorizedBottomMm);
  const zRoundoff = roundoff(Math.max(geometry.machineZMm, heightUpperBoundMm));
  const metadataRoundoffReserveMm = displayRoundoff.x + displayRoundoff.y + zRoundoff;
  const pitchUpper = { x: (geometry.displayWidthMm + displayRoundoff.x) / geometry.resolutionX,
    y: (geometry.displayHeightMm + displayRoundoff.y) / geometry.resolutionY, z: nativePitch.z };
  const unionBoundsMm = { minMm: {}, maxMm: {} };
  for (const axis of AXES) { unionBoundsMm.minMm[axis] = Math.min(sourceBoundsMm.minMm[axis], supportEnvelope.minMm[axis]); unionBoundsMm.maxMm[axis] = Math.max(sourceBoundsMm.maxMm[axis], supportEnvelope.maxMm[axis]); }
  // Two pixels cover arbitrary subpixel placement/outward crop rounding. A
  // valid native image cannot contribute more than its entire pixel dimension;
  // this cap changes no requested permission or downstream clipping guard.
  const cropPixelsUpperBound = { x: Math.min(geometry.resolutionX, Math.ceil((unionBoundsMm.maxMm.x - unionBoundsMm.minMm.x) / nativePitch.x) + 2),
    y: Math.min(geometry.resolutionY, Math.ceil((unionBoundsMm.maxMm.y - unionBoundsMm.minMm.y) / nativePitch.y) + 2) };
  const layerCountUpperBound = Math.ceil((heightUpperBoundMm + zRoundoff) / nativePitch.z) + 1;
  if (!Number.isSafeInteger(layerCountUpperBound) || layerCountUpperBound < 1 || layerCountUpperBound > CAPS.maxLayers) unresolved('the full authorized height exceeds the native layer hard bound');
  const minimumReduction = fixedReduction || Object.fromEntries(AXES.map(axis => [axis, Math.max(1, Math.ceil(minimumPitchMm[axis] / nativePitch[axis]))]));
  if (AXES.some(axis => minimumReduction[axis] > CAPS.maxReduction)) unresolved('the minimum requested pitch exceeds the reduction hard bound');
  const available = maximumUncertaintyMm - metadataRoundoffReserveMm;
  if (!(available > 0)) unresolved('the metadata reserve alone exceeds the declared uncertainty');
  const minimumRadius = drains.length ? Math.min(...drains.map(drain => drain.radiusMm)) : Infinity;
  const minimumLength = drains.length ? Math.min(...drains.map(drain => drain.lengthMm)) : Infinity;
  const inspect = (x, y, z) => {
    const dimensions = { x: Math.ceil(cropPixelsUpperBound.x / x) + 2, y: Math.ceil(cropPixelsUpperBound.y / y) + 2, z: Math.ceil(layerCountUpperBound / z) + 2 };
    const cells = dimensions.x * dimensions.y * dimensions.z, workingBytes = cells * 38 + Math.max(...AXES.map(axis => dimensions[axis])) * 20 + 8;
    return { dimensions, cells, workingBytes, fits: cells <= maxCells && workingBytes <= maxWorkingBytes };
  };
  const resolution = (x, y, z) => {
    const pitchMm = { x: x * pitchUpper.x, y: y * pitchUpper.y, z: z * pitchUpper.z }, diagonal = Math.hypot(pitchMm.x, pitchMm.y, pitchMm.z), total = diagonal + metadataRoundoffReserveMm;
    return { pitchMm, diagonal, total, resolvable: total <= maximumUncertaintyMm && minimumRadius > total + diagonal / 2 && minimumLength > 2 * total + Math.max(pitchMm.x, pitchMm.y, pitchMm.z) };
  };
  const min = minimumReduction, minimum = resolution(min.x, min.y, min.z);
  if (minimum.total > maximumUncertaintyMm) unresolved('the native or minimum requested pitch exceeds the declared uncertainty');
  if (!minimum.resolvable) unresolved('a requested drain radius or length has no resolved lower cylinder at the declared grid');
  const availableSquared = available ** 2, minZSquared = (min.z * pitchUpper.z) ** 2;
  let best = fixedReduction ? { reduction: fixedReduction, quality: minimum, preflight: inspect(min.x, min.y, min.z) } : null, pairs = 0, evaluations = 0;
  const maxX = Math.min(CAPS.maxReduction, Math.ceil(Math.sqrt(Math.max(0, availableSquared - (min.y * pitchUpper.y) ** 2 - minZSquared)) / pitchUpper.x));
  for (let x = min.x; !fixedReduction && x <= maxX; x++) {
    const xSquared = (x * pitchUpper.x) ** 2;
    const maxY = Math.min(CAPS.maxReduction, Math.ceil(Math.sqrt(Math.max(0, availableSquared - xSquared - minZSquared)) / pitchUpper.y));
    for (let y = min.y; y <= maxY; y++) {
      pairs++;
      // All feasibility predicates decrease monotonically as Z reduction grows.
      // Find the largest resolvable Z, then the smallest resource-fitting Z.
      let low = min.z, high = Math.min(CAPS.maxReduction, Math.ceil(Math.sqrt(Math.max(0, availableSquared - xSquared - (y * pitchUpper.y) ** 2)) / pitchUpper.z));
      if (high < low) continue;
      let maximumZ = low - 1;
      while (low <= high) { const z = Math.floor((low + high) / 2); evaluations++; if (resolution(x, y, z).resolvable) { maximumZ = z; low = z + 1; } else high = z - 1; }
      if (maximumZ < min.z || !inspect(x, y, maximumZ).fits) continue;
      low = min.z; high = maximumZ;
      while (low < high) { const z = Math.floor((low + high) / 2); evaluations++; if (inspect(x, y, z).fits) high = z; else low = z + 1; }
      const z = low, quality = resolution(x, y, z), preflight = inspect(x, y, z), score = quality.diagonal;
      if (!best || score < best.quality.diagonal || (score === best.quality.diagonal && (z < best.reduction.z || (z === best.reduction.z && (x < best.reduction.x || (x === best.reduction.x && y < best.reduction.y)))))) best = { reduction: { x, y, z }, quality, preflight };
    }
  }
  if (!best) unresolved('the complete authorized grid cannot fit its cell/memory bounds and unchanged wall/drain uncertainty');
  const result = { schemaVersion: 1, method: 'prior-bounded-hollow-interval-resolution-v1',
    geometry, sourceBoundsMm, supportEnvelope, modelElevationMm, wallThicknessMm,
    request: { maximumUncertaintyMm, ...(fixedReduction ? { reduction: { ...fixedReduction } } : { minimumPitchMm }), maxCells, maxWorkingBytes },
    reduction: best.reduction, policy: { reduction: { ...best.reduction }, maximumUncertaintyMm },
    preflight: { cropPixelsUpperBound, layerCountUpperBound, dimensions: best.preflight.dimensions, cells: best.preflight.cells, workingBytes: best.preflight.workingBytes,
      unionBoundsMm, finalHeightUpperBoundMm: heightUpperBoundMm, workingMemoryPolicy: 'six visible interval arrays plus 32N bounded final-audit working arrays and longest-axis scratch; 38N+20*longest+8',
      ...(fixedReduction ? { worstCaseFits: best.preflight.fits } : {}) },
    uncertainty: { voxelDiagonalMm: best.quality.diagonal, metadataRoundoffReserveMm, totalUpperBoundMm: best.quality.total,
      metadataPolicy: 'full relative float32 ULP reserves for both display dimensions and the greater of authorized final height/machine Z; actual measured metadata must satisfy the same declared maximum', pitchUpperBoundMm: best.quality.pitchMm },
    drainResolutionChecks: drains.map(drain => ({ ...drain, lowerCoreResolvedAtPriorGrid: true,
      radiusClearanceMm: drain.radiusMm - best.quality.total - best.quality.diagonal / 2,
      lengthClearanceMm: drain.lengthMm - 2 * best.quality.total - Math.max(...AXES.map(axis => best.quality.pitchMm[axis])) })),
    priorOnly: true, auditFeedbackUsed: false,
    ...(fixedReduction ? { boundedByActualCrop: true, actualCropLimits: { maxCells, maxWorkingBytes } } : {}),
    search: { candidateAxisPairs: pairs, binaryEvaluations: evaluations, maximumAxisPairs: CAPS.maxReduction ** 2, criterion: fixedReduction ? 'explicit fixed reduction; no search, substitution or observed-raster feedback; actual crop must enforce declared allocation bounds' : 'smallest upper-bound voxel diagonal; ties prefer smaller Z, X, Y reductions' } };
  result.sha256 = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return freeze(result);
}

module.exports = { planResinHollowResolution, RESIN_HOLLOW_RESOLUTION_LIMITS: CAPS };
