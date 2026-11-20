'use strict';

// Final supported-material intervals are never masked before connectivity is
// checked. This is a bounded raster comparison, not a physical certificate.
const { performance } = require('node:perf_hooks');
const { auditResinHollowGrid, RESIN_HOLLOW_GRID_LIMITS } = require('./resin-hollow-grid');

const AXES = ['x', 'y', 'z'];
const LIMITS = Object.freeze({ ...RESIN_HOLLOW_GRID_LIMITS, maxSupportRegions: 512 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_HOLLOW_FINAL_INPUT', status = 400) => Object.assign(new Error(message), { code, status });
function exact(value, keys, label) { if (!plain(value) || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => !keys.includes(key))) throw fail(`${label} has unsupported or missing fields.`); }
function number(value, minimum, maximum, label) { if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw fail(`${label} is outside the supported finite range.`); return value === 0 ? 0 : value; }
function vector(value, minimum, maximum, label) { exact(value, AXES, label); return Object.fromEntries(AXES.map(axis => [axis, number(value[axis], minimum, maximum, label)])); }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

function validate(input) {
  if (!plain(input) || Reflect.ownKeys(input).some(key => !['solidBody', 'hollowBody', 'final', 'frame', 'wallThicknessMm', 'uncertaintyMm', 'drains', 'supportEnvelope', 'supportRegions', 'boundaryPolicy', 'limits', 'signal'].includes(key))) throw fail('Supply only the declared final-material audit fields.');
  const boundaryPolicy = input.boundaryPolicy === undefined ? 'exact-raster' : input.boundaryPolicy;
  if (!['exact-raster', 'voxel-enclosure'].includes(boundaryPolicy)) throw fail('Choose an explicit supported body boundary policy.');
  const limits = { ...LIMITS };
  if (input.limits !== undefined) {
    if (!plain(input.limits) || Reflect.ownKeys(input.limits).some(key => !Object.hasOwn(LIMITS, key))) throw fail('Unsupported final-material limits.', 'RESIN_HOLLOW_FINAL_LIMITS');
    for (const [key, value] of Object.entries(input.limits)) { if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) throw fail('Limits may only lower positive whole-number hard bounds.', 'RESIN_HOLLOW_FINAL_LIMITS'); limits[key] = value; }
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) throw fail('Use a native AbortSignal.');
  const started = performance.now(); let operations = 0;
  const work = {
    check() { if (input.signal?.aborted) throw fail('The final-material audit was cancelled.', 'RESIN_HOLLOW_FINAL_ABORTED', 499); if (performance.now() - started > limits.maxTimeMs) throw fail('The final-material audit exceeded its deadline.', 'RESIN_HOLLOW_FINAL_TIMEOUT', 413); },
    step(count = 1) { operations += count; if (!Number.isSafeInteger(operations) || operations > limits.maxOperations) throw fail('The final-material audit exceeded its operation budget.', 'RESIN_HOLLOW_FINAL_OPERATIONS', 413); if (count > 1 || !(operations & 1023)) this.check(); },
    remaining() { this.check(); return { ...Object.fromEntries(Object.keys(RESIN_HOLLOW_GRID_LIMITS).map(key => [key, limits[key]])), maxOperations: Math.max(1, limits.maxOperations - operations), maxTimeMs: Math.max(1, Math.floor(limits.maxTimeMs - (performance.now() - started))) }; },
    get operations() { return operations; },
  };
  work.check();
  exact(input.frame, ['nx', 'ny', 'nz', 'pitchMm', 'originMm', 'direction'], 'Grid frame');
  const frame = { nx: input.frame.nx, ny: input.frame.ny, nz: input.frame.nz, pitchMm: vector(input.frame.pitchMm, 1e-9, 10000, 'Voxel pitch'), originMm: vector(input.frame.originMm, -1000000, 1000000, 'Grid origin'), direction: vector(input.frame.direction, -1, 1, 'Grid direction') };
  for (const key of ['nx', 'ny', 'nz']) if (!Number.isSafeInteger(frame[key]) || frame[key] < 3 || frame[key] > limits.maxAxisLength) throw fail('Grid dimensions require bounded whole numbers and an exterior halo.', 'RESIN_HOLLOW_FINAL_DIMENSIONS');
  if (![1, -1].includes(frame.direction.x) || ![1, -1].includes(frame.direction.y) || frame.direction.z !== 1) throw fail('Grid X/Y directions must be ±1 and Z must increase.');
  const plane = frame.nx * frame.ny, count = plane * frame.nz, longest = Math.max(frame.nx, frame.ny, frame.nz);
  if (!Number.isSafeInteger(count) || count > limits.maxVoxels) throw fail('The final-material grid exceeds its voxel bound.', 'RESIN_HOLLOW_FINAL_VOXELS', 413);
  for (const axis of AXES) if (frame.pitchMm[axis] * frame['n' + axis] > 1000000) throw fail('The grid physical extent is unsupported.');
  const wallThicknessMm = number(input.wallThicknessMm, 1e-9, 10000, 'Wall thickness'), uncertaintyMm = number(input.uncertaintyMm, 0, 10000, 'Raster uncertainty');
  const buffers = new Set(), intervals = {};
  for (const key of ['solidBody', 'hollowBody', 'final']) {
    exact(input[key], ['lower', 'upper'], key); intervals[key] = {};
    for (const bound of ['lower', 'upper']) {
      const array = input[key][bound];
      if (!(array instanceof Uint8Array) || array.length !== count || array.byteLength !== count || !(array.buffer instanceof ArrayBuffer)) throw fail('Six nonshared Uint8Array views must match the complete frame.', 'RESIN_HOLLOW_FINAL_ARRAY');
      buffers.add(array.buffer); intervals[key][bound] = array;
    }
  }
  exact(input.supportEnvelope, ['minMm', 'maxMm'], 'Support envelope');
  const supportEnvelope = { minMm: vector(input.supportEnvelope.minMm, -1000000, 1000000, 'Support envelope minimum'), maxMm: vector(input.supportEnvelope.maxMm, -1000000, 1000000, 'Support envelope maximum') };
  if (AXES.some(axis => supportEnvelope.minMm[axis] >= supportEnvelope.maxMm[axis])) throw fail('The explicit support envelope requires positive extent on every axis.');
  const regionInput = input.supportRegions === undefined ? [] : input.supportRegions;
  if (!Array.isArray(regionInput) || regionInput.length > limits.maxSupportRegions) throw fail('Declare a bounded list of specifically authorized support regions.', 'RESIN_HOLLOW_FINAL_REGIONS');
  const regionIds = new Set(), supportRegions = Array.from(regionInput, region => {
    exact(region, ['id', 'minMm', 'maxMm'], 'Authorized support region');
    if (typeof region.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(region.id) || regionIds.has(region.id)) throw fail('Support regions require unique bounded ASCII identifiers.', 'RESIN_HOLLOW_FINAL_REGIONS');
    regionIds.add(region.id);
    const item = { id: region.id, minMm: vector(region.minMm, -1000000, 1000000, 'Support region minimum'), maxMm: vector(region.maxMm, -1000000, 1000000, 'Support region maximum') };
    if (AXES.some(axis => item.minMm[axis] >= item.maxMm[axis])) throw fail('Support regions require positive extent on every axis.', 'RESIN_HOLLOW_FINAL_REGIONS');
    return item;
  });
  // A conservative upper bound covers one base audit's 25N working fields
  // plus the original-exterior mask and queue (5N). All six live input backings,
  // including bytes outside supplied views, are included before allocation.
  const inputViewBytes = count * 6, inputBackingBytes = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0), additionalArrayBytesUpperBound = count * 32 + longest * 20 + 8;
  if (!Number.isSafeInteger(inputBackingBytes + additionalArrayBytesUpperBound) || Math.max(inputViewBytes, inputBackingBytes) + additionalArrayBytesUpperBound > limits.maxWorkingBytes) throw fail('The six input arrays and complete working fields exceed the memory bound.', 'RESIN_HOLLOW_FINAL_MEMORY', 413);
  for (let z = 0; z < frame.nz; z++) for (let y = 0; y < frame.ny; y++) for (let x = 0; x < frame.nx; x++) {
    work.step(); const i = z * plane + y * frame.nx + x, halo = x === 0 || y === 0 || z === 0 || x === frame.nx - 1 || y === frame.ny - 1 || z === frame.nz - 1;
    for (const key of ['solidBody', 'hollowBody', 'final']) if (intervals[key].lower[i] > intervals[key].upper[i]) throw fail('Every lower interval must be no greater than its upper interval.', 'RESIN_HOLLOW_FINAL_INTERVAL');
    if (halo && intervals.solidBody.upper[i]) throw fail('The solid body requires a complete empty exterior halo.', 'RESIN_HOLLOW_FINAL_HALO');
  }
  work.check();
  return { frame, plane, count, longest, intervals, supportEnvelope, supportRegions, boundaryPolicy, wallThicknessMm, uncertaintyMm, limits, signal: input.signal, drains: input.drains, work, memory: { inputViewBytes, inputBackingBytes, additionalArrayBytesUpperBound, conservativeVisiblePeakBytes: Math.max(inputViewBytes, inputBackingBytes) + additionalArrayBytesUpperBound } };
}

function cellBox(i, config) {
  const { frame, plane } = config, indices = { x: i % frame.nx, y: Math.floor(i / frame.nx) % frame.ny, z: Math.floor(i / plane) }, min = {}, max = {};
  for (const axis of AXES) { const a = frame.originMm[axis] + frame.direction[axis] * indices[axis] * frame.pitchMm[axis], b = a + frame.direction[axis] * frame.pitchMm[axis]; min[axis] = Math.min(a, b); max[axis] = Math.max(a, b); }
  return { min, max };
}

function originalExterior(config) {
  const { frame, plane, count, intervals, work } = config, visited = new Uint8Array(count), queue = new Uint32Array(count);
  let head = 0, tail = 0, seededHaloCells = 0;
  for (let i = 0; i < count; i++) {
    work.step(); const x = i % frame.nx, y = Math.floor(i / frame.nx) % frame.ny, z = Math.floor(i / plane);
    if ((x === 0 || y === 0 || z === 0 || x === frame.nx - 1 || y === frame.ny - 1 || z === frame.nz - 1) && intervals.solidBody.upper[i] === 0) { visited[i] = 1; queue[tail++] = i; seededHaloCells++; }
  }
  const add = i => { work.step(); if (!visited[i] && intervals.solidBody.upper[i] === 0) { visited[i] = 1; queue[tail++] = i; } };
  while (head < tail) {
    work.step(); const i = queue[head++], x = i % frame.nx, y = Math.floor(i / frame.nx) % frame.ny, z = Math.floor(i / plane);
    if (x) add(i - 1); if (x + 1 < frame.nx) add(i + 1); if (y) add(i - frame.nx); if (y + 1 < frame.ny) add(i + frame.nx); if (z) add(i - plane); if (z + 1 < frame.nz) add(i + plane);
  }
  return { mask: visited, proof: { lowerConnectivity: 6, blackHaloSeedCells: seededHaloCells, reachableOriginalBlackCells: tail } };
}

// Only changed cells need this bounded, exhaustive nearest-site query. Its
// metric exactly matches the base auditor's anisotropic cell-center EDT. It
// never samples or enlarges the supplied uncertainty.
function boundaryWitness(i, config) {
  const { frame, plane, intervals, uncertaintyMm, work } = config, x = i % frame.nx, y = Math.floor(i / frame.nx) % frame.ny, z = Math.floor(i / plane), square = uncertaintyMm ** 2;
  const radii = Object.fromEntries(AXES.map(axis => [axis, Math.ceil(uncertaintyMm / frame.pitchMm[axis])]));
  let sourceMaterial = false, sourceBlack = false, bodyMaterial = false, bodyNotWhite = false;
  for (let zz = Math.max(0, z - radii.z); zz <= Math.min(frame.nz - 1, z + radii.z); zz++) for (let yy = Math.max(0, y - radii.y); yy <= Math.min(frame.ny - 1, y + radii.y); yy++) for (let xx = Math.max(0, x - radii.x); xx <= Math.min(frame.nx - 1, x + radii.x); xx++) {
    work.step();
    if (((xx - x) * frame.pitchMm.x) ** 2 + ((yy - y) * frame.pitchMm.y) ** 2 + ((zz - z) * frame.pitchMm.z) ** 2 > square) continue;
    const j = zz * plane + yy * frame.nx + xx;
    sourceMaterial ||= intervals.solidBody.upper[j] > 0; sourceBlack ||= intervals.solidBody.upper[j] === 0;
    bodyMaterial ||= intervals.hollowBody.upper[j] > 0; bodyNotWhite ||= intervals.hollowBody.lower[j] !== 255;
    if (sourceMaterial && sourceBlack && bodyMaterial && bodyNotWhite) return true;
  }
  return false;
}

function auditResinHollowFinalGrid(input) {
  const config = validate(input), { frame, plane, count, intervals, supportEnvelope, supportRegions, boundaryPolicy, wallThicknessMm, uncertaintyMm, limits, signal, drains, work } = config;
  const common = { solid: intervals.solidBody, frame, wallThicknessMm, uncertaintyMm, drains, boundaryPolicy, exteriorSeedPolicy: 'processed-source-exterior', signal };
  const exterior = originalExterior(config), authorizedRegionCells = Object.fromEntries(supportRegions.map(region => [region.id, 0]));
  const counts = { matchingBodyCells: 0, expectedBodyCells: 0, changedBodyCells: 0, definitelyChangedBodyCells: 0, ambiguousBodyChanges: 0, permittedBoundaryChanges: 0, filledRequiredVoidCells: 0,
    outsideSupportCells: 0, outsideSupportLowerWhiteCells: 0, outsideSupportUpperIntensity: 0, enclosedSupportCells: 0, supportOutsideEnvelopeCells: 0, supportEnvelopeBoundaryCells: 0, finalHaloMaterialCells: 0,
    authorizedTemporarySupportCells: 0, unapprovedOriginalAirFill: 0, sourcePocketFillCells: 0, outsideAuthorizedSupportRegions: 0, supportRegionBoundaryCells: 0 };
  const witnessKeys = ['definitelyChangedBodyCells', 'ambiguousBodyChanges', 'filledRequiredVoidCells', 'supportOutsideEnvelopeCells', 'supportEnvelopeBoundaryCells', 'finalHaloMaterialCells', 'sourcePocketFillCells', 'outsideAuthorizedSupportRegions', 'supportRegionBoundaryCells'];
  const witnesses = Object.fromEntries(witnessKeys.map(key => [key, []]));
  const witness = (key, i) => { if (witnesses[key].length < limits.maxWitnesses) witnesses[key].push({ index: i, cell: { x: i % frame.nx, y: Math.floor(i / frame.nx) % frame.ny, z: Math.floor(i / plane) } }); };
  for (let i = 0; i < count; i++) {
    work.step(); const x = i % frame.nx, y = Math.floor(i / frame.nx) % frame.ny, z = Math.floor(i / plane), finalLower = intervals.final.lower[i], finalUpper = intervals.final.upper[i], bodyLower = intervals.hollowBody.lower[i], bodyUpper = intervals.hollowBody.upper[i];
    const halo = x === 0 || y === 0 || z === 0 || x === frame.nx - 1 || y === frame.ny - 1 || z === frame.nz - 1;
    if (halo && finalUpper > 0) { counts.finalHaloMaterialCells++; witness('finalHaloMaterialCells', i); }
    if (intervals.solidBody.upper[i] > 0 || bodyUpper > 0) {
      counts.expectedBodyCells++;
      if (finalLower === bodyLower && finalUpper === bodyUpper) { counts.matchingBodyCells++; continue; }
      counts.changedBodyCells++;
      // An explicitly empty source-body cell is a required void even when it
      // is shallower than the source-derived deep-cavity threshold. Supports
      // cannot acquire permission to fill it from their outside envelope.
      if (bodyUpper === 0 && finalUpper > 0) {
        counts.filledRequiredVoidCells++; witness('filledRequiredVoidCells', i);
        if (finalLower === 255) { counts.definitelyChangedBodyCells++; witness('definitelyChangedBodyCells', i); }
        else { counts.ambiguousBodyChanges++; witness('ambiguousBodyChanges', i); }
        continue;
      }
      if (boundaryPolicy === 'voxel-enclosure' && boundaryWitness(i, config)) { counts.permittedBoundaryChanges++; continue; }
      if ((bodyLower === 255 && finalUpper === 0) || (bodyUpper === 0 && finalLower === 255)) { counts.definitelyChangedBodyCells++; witness('definitelyChangedBodyCells', i); }
      else { counts.ambiguousBodyChanges++; witness('ambiguousBodyChanges', i); }
      continue;
    }
    if (!finalUpper) continue;
    counts.outsideSupportCells++; counts.outsideSupportLowerWhiteCells += Number(finalLower === 255); counts.outsideSupportUpperIntensity += finalUpper;
    const box = cellBox(i, config), enclosed = AXES.every(axis => box.min[axis] >= supportEnvelope.minMm[axis] && box.max[axis] <= supportEnvelope.maxMm[axis]);
    if (enclosed) counts.enclosedSupportCells++;
    else if (AXES.some(axis => box.max[axis] <= supportEnvelope.minMm[axis] || box.min[axis] >= supportEnvelope.maxMm[axis])) { counts.supportOutsideEnvelopeCells++; witness('supportOutsideEnvelopeCells', i); }
    else { counts.supportEnvelopeBoundaryCells++; witness('supportEnvelopeBoundaryCells', i); }
    let authorizedRegion = null, intersectsRegion = false;
    for (const region of supportRegions) {
      work.step();
      if (AXES.every(axis => box.min[axis] >= region.minMm[axis] && box.max[axis] <= region.maxMm[axis])) { authorizedRegion = region; break; }
      if (AXES.every(axis => box.max[axis] > region.minMm[axis] && box.min[axis] < region.maxMm[axis])) intersectsRegion = true;
    }
    if (!exterior.mask[i]) { counts.sourcePocketFillCells++; witness('sourcePocketFillCells', i); }
    if (!authorizedRegion) {
      if (intersectsRegion) { counts.supportRegionBoundaryCells++; witness('supportRegionBoundaryCells', i); }
      else { counts.outsideAuthorizedSupportRegions++; witness('outsideAuthorizedSupportRegions', i); }
    }
    if (enclosed && authorizedRegion && exterior.mask[i] && !halo) { counts.authorizedTemporarySupportCells++; authorizedRegionCells[authorizedRegion.id]++; }
    else counts.unapprovedOriginalAirFill++;
  }
  // All original final intervals are passed verbatim. In particular, supports
  // and caps remain present in both global void floods and each drill flood.
  const finalMaterialAudit = auditResinHollowGrid({ ...common, hollow: intervals.final, limits: work.remaining() });
  work.step(finalMaterialAudit.resources.chargedOperations);
  const ignoredOutsideReasons = boundaryPolicy === 'exact-raster' ? new Set(['addedOutsideSource', 'changedOuterBandOutsideDrains']) : new Set(['upperMaterialOutsideSourceDilation', 'changedOuterBandOutsideBoundaryBand']);
  const finalReasons = finalMaterialAudit.reasons.filter(reason => !ignoredOutsideReasons.has(reason));
  const reasons = [];
  for (const key of ['definitelyChangedBodyCells', 'supportOutsideEnvelopeCells', 'finalHaloMaterialCells', 'sourcePocketFillCells', 'outsideAuthorizedSupportRegions']) if (counts[key]) reasons.push(key);
  reasons.push(...finalReasons.map(reason => 'final-' + reason));
  const definiteFailure = counts.definitelyChangedBodyCells > 0 || counts.supportOutsideEnvelopeCells > 0 || counts.finalHaloMaterialCells > 0 || counts.sourcePocketFillCells > 0 || counts.outsideAuthorizedSupportRegions > 0 || finalReasons.some(reason => ['definitelyRetainedExpectedCavity', 'definitelyThinWallOutsideDrains', 'cavityUnreachableUpper', 'protectedOuterWallLoss', 'drain-nonconforming'].includes(reason));
  if (counts.ambiguousBodyChanges) reasons.push('ambiguousBodyChanges');
  if (counts.supportEnvelopeBoundaryCells) reasons.push('supportEnvelopeBoundaryCells');
  if (counts.supportRegionBoundaryCells) reasons.push('supportRegionBoundaryCells');
  const disposition = definiteFailure ? 'nonconforming' : reasons.length ? 'inconclusive' : 'conforming';
  const declaredBaseLimits = Object.fromEntries(Object.keys(RESIN_HOLLOW_GRID_LIMITS).map(key => [key, limits[key]]));
  const result = { schemaVersion: 1, method: 'bounded-final-supported-hollow-grid-audit-v1', disposition, reasons, frame, wallThicknessMm, uncertaintyMm, supportEnvelope, supportRegions, boundaryPolicy,
    exteriorSeedPolicy: 'processed-source-exterior', counts, witnesses, authorizedRegionCells, originalExterior: exterior.proof,
    bodyReferencePrecondition: { sourceAuditRequired: true, callerMustVerifyConforming: true, performedHere: false }, finalMaterialAudit: { ...finalMaterialAudit, limits: declaredBaseLimits },
    policy: { finalMaterial: 'unmasked supplied final intervals for every exterior and drain traversal', outsideSupports: 'original halo-reachable black air only; each whole voxel box must lie inside both the global envelope and one specifically authorized region; straddling boxes are inconclusive', bodyPreservation: 'exact intervals except explicit original-source-boundary enclosure witnesses; every source-body expected-black cell remains required void', boundaryDistance: 'complete anisotropic Euclidean cell-center neighborhood at the unchanged supplied uncertainty', finalHalo: 'every final upper halo cell must be zero', supportScope: 'authorized temporary support occupancy only; removal required; supplied regions are caller geometry decisions, not native attestation or certification of all functional voids' },
    functionalVoidClearanceCertified: false, removalRequired: counts.authorizedTemporarySupportCells > 0, geometricWallCertification: false, physicalDrainageCertification: false, productionEligible: false, limits: { ...limits }, resources: { chargedOperations: work.operations, ...config.memory, memoryPolicy: 'all six visible input arrays and complete distinct backing buffers; one base working set plus original exterior mask and queue, without relying on garbage collection' } };
  work.check(); freeze(result); work.check(); return result;
}

module.exports = { auditResinHollowFinalGrid, RESIN_HOLLOW_FINAL_GRID_LIMITS: LIMITS };
