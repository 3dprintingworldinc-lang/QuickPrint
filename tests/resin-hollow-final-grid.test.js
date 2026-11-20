'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { auditResinHollowFinalGrid, RESIN_HOLLOW_FINAL_GRID_LIMITS } = require('../src/slicing/resin-hollow-final-grid');
const { auditResinHollowGrid } = require('../src/slicing/resin-hollow-grid');

const index = (f, x, y, z) => z * f.nx * f.ny + y * f.nx + x;
function point(f, x, y, z) { return { x: f.originMm.x + f.direction.x * (x + .5) * f.pitchMm.x, y: f.originMm.y + f.direction.y * (y + .5) * f.pitchMm.y, z: f.originMm.z + (z + .5) * f.pitchMm.z }; }
function cylinder(p, d) { const a = [p.x - d.startMm.x, p.y - d.startMm.y, p.z - d.startMm.z], u = [d.direction.x, d.direction.y, d.direction.z], t = a.reduce((n, v, i) => n + v * u[i], 0); const c = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]]; return t >= 0 && t <= d.lengthMm && c.reduce((n, v) => n + v * v, 0) <= d.radiusMm ** 2; }
function fixture({ supports = true } = {}) {
  const frame = { nx: 25, ny: 25, nz: 37, pitchMm: { x: .25, y: .25, z: .25 }, originMm: { x: -.5, y: -.5, z: -.5 }, direction: { x: 1, y: 1, z: 1 } }, n = frame.nx * frame.ny * frame.nz, source = new Uint8Array(n), body = new Uint8Array(n);
  for (let z = 12; z <= 28; z++) for (let y = 4; y <= 20; y++) for (let x = 4; x <= 20; x++) source[index(frame, x, y, z)] = 255;
  body.set(source);
  for (let z = 15; z <= 25; z++) for (let y = 7; y <= 17; y++) for (let x = 7; x <= 17; x++) body[index(frame, x, y, z)] = 0;
  const drains = [1.625, 3.625].map((x, i) => ({ id: 'bottom-' + i, startMm: { x, y: 2.625, z: 1.5 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: .75, lengthMm: 3 }));
  for (let z = 0; z < frame.nz; z++) for (let y = 0; y < frame.ny; y++) for (let x = 0; x < frame.nx; x++) if (drains.some(d => cylinder(point(frame, x, y, z), d))) body[index(frame, x, y, z)] = 0;
  const final = body.slice();
  if (supports) {
    for (let z = 2; z <= 3; z++) for (let y = 3; y <= 21; y++) for (let x = 3; x <= 21; x++) final[index(frame, x, y, z)] = 255;
    for (let z = 4; z <= 11; z++) final[index(frame, 12, 5, z)] = 255;
  }
  return { solidBody: { lower: source, upper: source.slice() }, hollowBody: { lower: body, upper: body.slice() }, final: { lower: final, upper: final.slice() }, frame, wallThicknessMm: .75, uncertaintyMm: Math.sqrt(3) * .25, drains, supportEnvelope: { minMm: { x: 0, y: 0, z: 0 }, maxMm: { x: 5, y: 5, z: 2.5 } },
    supportRegions: [{ id: 'authored-pad', minMm: { x: .25, y: .25, z: 0 }, maxMm: { x: 5, y: 5, z: .5 } }, { id: 'authored-post', minMm: { x: 2.5, y: .75, z: .5 }, maxMm: { x: 2.75, y: 1, z: 2.5 } }] };
}
function copy(input) { return { ...input, solidBody: { lower: input.solidBody.lower.slice(), upper: input.solidBody.upper.slice() }, hollowBody: { lower: input.hollowBody.lower.slice(), upper: input.hollowBody.upper.slice() }, final: { lower: input.final.lower.slice(), upper: input.final.upper.slice() }, frame: structuredClone(input.frame), drains: structuredClone(input.drains), supportEnvelope: structuredClone(input.supportEnvelope), supportRegions: structuredClone(input.supportRegions) }; }
function set(input, x, y, z, lo, hi = lo) { const i = index(input.frame, x, y, z); input.final.lower[i] = lo; input.final.upper[i] = hi; }
function cup(input, drain = 0, gray = false) {
  const center = input.drains[drain].startMm;
  input.supportRegions.push({ id: 'explicit-test-cup-' + drain, minMm: { x: center.x - 1.375, y: center.y - 1.375, z: 1 }, maxMm: { x: center.x + 1.375, y: center.y + 1.375, z: 2.5 } });
  for (let z = 6; z <= 11; z++) for (let y = 1; y < input.frame.ny - 1; y++) for (let x = 1; x < input.frame.nx - 1; x++) {
    const p = point(input.frame, x, y, z), d = Math.max(Math.abs(p.x - center.x), Math.abs(p.y - center.y));
    if (d <= 1.25 && (z === 6 || d >= 1)) set(input, x, y, z, gray ? 128 : 255);
  }
}

test('padded final model with permitted external support material preserves both independent black drains without masking', () => {
  const input = fixture(), before = copy(input), result = auditResinHollowFinalGrid(input);
  assert.equal(result.disposition, 'conforming'); assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.bodyReferencePrecondition, { sourceAuditRequired: true, callerMustVerifyConforming: true, performedHere: false }); assert.ok(result.finalMaterialAudit.counts.addedOutsideSource > 0);
  assert.equal(result.counts.outsideSupportCells, 19 * 19 * 2 + 8); assert.equal(result.counts.enclosedSupportCells, result.counts.outsideSupportCells);
  assert.equal(result.counts.changedBodyCells, 0); assert.equal(result.exteriorSeedPolicy, 'processed-source-exterior');
  assert.equal(result.counts.unapprovedOriginalAirFill, 0); assert.equal(result.counts.authorizedTemporarySupportCells, result.counts.outsideSupportCells); assert.equal(result.functionalVoidClearanceCertified, false); assert.equal(result.removalRequired, true);
  assert.ok(result.finalMaterialAudit.drains.every(d => d.disposition === 'conforming' && d.fullyBlackExteriorToCavity && d.retainedLowerCylinderCells === 0));
  assert.equal(result.productionEligible, false); assert.equal(result.geometricWallCertification, false); assert.equal(result.physicalDrainageCertification, false);
  assert.deepEqual(input, before); assert.equal(Object.isFrozen(result.finalMaterialAudit.drains[0]), true); assert.deepEqual(JSON.parse(JSON.stringify(result)), result); assert.deepEqual(auditResinHollowFinalGrid(input), result);
});

test('a cap entirely outside the body cannot borrow the second drain or source-exterior pocket as an exterior seed', () => {
  const input = fixture(); cup(input);
  const naive = auditResinHollowGrid({ solid: input.solidBody, hollow: input.final, frame: input.frame, wallThicknessMm: input.wallThicknessMm, uncertaintyMm: input.uncertaintyMm, drains: input.drains });
  assert.equal(naive.drains[0].fullyBlackExteriorToCavity, true, 'source-only exterior seeds see the trapped under-cap pocket');
  const result = auditResinHollowFinalGrid(input);
  assert.equal(result.counts.changedBodyCells, 0); assert.equal(result.counts.supportOutsideEnvelopeCells, 0);
  assert.equal(result.finalMaterialAudit.counts.cavityUnreachableLower, 0, 'the other drain still ventilates the whole cavity');
  assert.equal(result.finalMaterialAudit.drains[0].retainedLowerCylinderCells, 0, 'the cap is outside the declared shrunken cylinder');
  assert.equal(result.finalMaterialAudit.drains[0].fullyBlackExteriorToCavity, false); assert.equal(result.finalMaterialAudit.drains[0].possibleExteriorToCavity, false);
  assert.equal(result.finalMaterialAudit.drains[1].disposition, 'conforming'); assert.equal(result.disposition, 'nonconforming');
});

test('closing both outside cups also fails the unmasked global cavity-to-halo flood', () => {
  const input = fixture(); cup(input, 0); cup(input, 1); const result = auditResinHollowFinalGrid(input);
  assert.equal(result.disposition, 'nonconforming'); assert.ok(result.finalMaterialAudit.counts.cavityUnreachableLower > 0); assert.ok(result.finalMaterialAudit.counts.cavityUnreachableUpper > 0);
  assert.ok(result.finalMaterialAudit.drains.every(d => !d.possibleExteriorToCavity));
});

test('a partial cap inside one lower drill cylinder fails even with a remaining black thread and a second open channel', () => {
  const input = fixture(); set(input, 8, 12, 13, 255); const result = auditResinHollowFinalGrid(input);
  assert.equal(result.disposition, 'nonconforming'); assert.ok(result.finalMaterialAudit.drains[0].retainedLowerCylinderCells > 0); assert.ok(result.finalMaterialAudit.drains[0].reasons.includes('requested-channel-obstruction'));
  assert.equal(result.finalMaterialAudit.drains[1].disposition, 'conforming'); assert.equal(result.finalMaterialAudit.counts.cavityUnreachableLower, 0);
});

test('gray channel caps and uncertain cavity filling cannot acquire a conforming result from interval maxima', () => {
  const channel = fixture(); set(channel, 8, 12, 13, 128); const a = auditResinHollowFinalGrid(channel);
  assert.equal(a.disposition, 'inconclusive'); assert.ok(a.finalMaterialAudit.drains[0].ambiguousLowerCylinderCells > 0);
  const cavity = fixture(); set(cavity, 12, 12, 20, 0, 128); const b = auditResinHollowFinalGrid(cavity);
  assert.equal(b.disposition, 'inconclusive'); assert.equal(b.counts.filledRequiredVoidCells, 1); assert.ok(b.finalMaterialAudit.counts.ambiguousExpectedCavity > 0);
  const exterior = fixture(); cup(exterior, 0, true); const c = auditResinHollowFinalGrid(exterior);
  assert.equal(c.disposition, 'inconclusive'); assert.equal(c.finalMaterialAudit.drains[0].fullyBlackExteriorToCavity, false); assert.equal(c.finalMaterialAudit.drains[0].possibleExteriorToCavity, true);
});

test('the support envelope never authorizes filled cavity cells, shallow expected black body cells or erased body wall', () => {
  for (const [x, y, z, value] of [[12, 12, 20, 255], [8, 12, 12, 255], [4, 4, 20, 0]]) {
    const input = fixture(); input.supportEnvelope.maxMm.z = 10; input.supportRegions.push({ id: 'cannot-authorize-body-change', minMm: { x: 0, y: 0, z: 0 }, maxMm: { x: 5, y: 5, z: 10 } }); set(input, x, y, z, value); const result = auditResinHollowFinalGrid(input);
    assert.equal(result.disposition, 'nonconforming'); assert.ok(result.counts.definitelyChangedBodyCells > 0); assert.equal(result.counts.supportOutsideEnvelopeCells, 0);
  }
});

test('permitted support additions are exhausted over XYZ and any material outside the explicit envelope fails', () => {
  const input = fixture(); set(input, 23, 5, 3, 255); const result = auditResinHollowFinalGrid(input);
  assert.equal(result.disposition, 'nonconforming'); assert.equal(result.counts.supportOutsideEnvelopeCells, 1); assert.equal(result.witnesses.supportOutsideEnvelopeCells.length, 1);
  const height = fixture(); set(height, 2, 2, 30, 128); const z = auditResinHollowFinalGrid(height); assert.equal(z.disposition, 'nonconforming'); assert.equal(z.counts.supportOutsideEnvelopeCells, 1);
});

test('a global envelope alone grants no original-air occupancy and specific predeclared pad/post regions are required', () => {
  const input = fixture(); delete input.supportRegions; const denied = auditResinHollowFinalGrid(input);
  assert.equal(denied.disposition, 'nonconforming'); assert.equal(denied.counts.unapprovedOriginalAirFill, denied.counts.outsideSupportCells); assert.equal(denied.counts.authorizedTemporarySupportCells, 0);
  assert.ok(denied.counts.outsideAuthorizedSupportRegions > 0);
  const bare = fixture({ supports: false }); bare.supportRegions = []; const unchanged = auditResinHollowFinalGrid(bare); assert.equal(unchanged.disposition, 'conforming'); assert.equal(unchanged.removalRequired, false);
});

test('an original through-hole mouth cannot be occupied by an unrelated post-region permission', () => {
  const input = fixture(); input.supportEnvelope.maxMm.z = 2.9;
  for (let z = 12; z <= 28; z++) {
    const i = index(input.frame, 5, 5, z); input.solidBody.lower[i] = input.solidBody.upper[i] = 0; input.hollowBody.lower[i] = input.hollowBody.upper[i] = 0; set(input, 5, 5, z, 0);
  }
  const prior = auditResinHollowGrid({ solid: input.solidBody, hollow: input.hollowBody, frame: input.frame, wallThicknessMm: input.wallThicknessMm, uncertaintyMm: input.uncertaintyMm, drains: input.drains }); assert.equal(prior.disposition, 'conforming');
  set(input, 5, 5, 12, 255); const result = auditResinHollowFinalGrid(input);
  assert.equal(result.disposition, 'nonconforming'); assert.equal(result.counts.changedBodyCells, 0); assert.equal(result.counts.outsideAuthorizedSupportRegions, 1); assert.equal(result.counts.unapprovedOriginalAirFill, 1); assert.equal(result.counts.sourcePocketFillCells, 0);
  // A deliberate permission at this original-air contact changes the scope:
  // it is temporary support occupancy requiring removal, not a clearance claim.
  input.supportRegions.push({ id: 'deliberate-temporary-mouth-contact', minMm: { x: .75, y: .75, z: 2.5 }, maxMm: { x: 1, y: 1, z: 2.75 } });
  const authorized = auditResinHollowFinalGrid(input); assert.equal(authorized.disposition, 'conforming'); assert.equal(authorized.counts.unapprovedOriginalAirFill, 0); assert.equal(authorized.functionalVoidClearanceCertified, false); assert.equal(authorized.removalRequired, true);
});

test('a sealed original source pocket cannot be filled even by a specifically overlapping region', () => {
  const input = fixture(); input.supportEnvelope.maxMm.z = 10; const i = index(input.frame, 5, 5, 20);
  input.solidBody.lower[i] = input.solidBody.upper[i] = 0; input.hollowBody.lower[i] = input.hollowBody.upper[i] = 0; set(input, 5, 5, 20, 255);
  input.supportRegions.push({ id: 'cannot-authorize-internal-pocket', minMm: { x: .75, y: .75, z: 4.5 }, maxMm: { x: 1, y: 1, z: 4.75 } });
  const result = auditResinHollowFinalGrid(input); assert.equal(result.disposition, 'nonconforming'); assert.equal(result.counts.sourcePocketFillCells, 1); assert.equal(result.counts.unapprovedOriginalAirFill, 1); assert.equal(result.counts.outsideAuthorizedSupportRegions, 0);
});

test('a support voxel straddling the envelope is inconclusive even if its center lies exactly on the permitted boundary', () => {
  const input = fixture(); set(input, 2, 2, 2, 255); input.supportEnvelope.minMm.x = .125; input.supportRegions.push({ id: 'boundary-test', minMm: { x: 0, y: 0, z: 0 }, maxMm: { x: .25, y: .25, z: .25 } }); const result = auditResinHollowFinalGrid(input);
  assert.equal(result.disposition, 'inconclusive'); assert.equal(result.counts.supportEnvelopeBoundaryCells, 1); assert.equal(result.counts.supportOutsideEnvelopeCells, 0);
  const region = fixture(); region.supportRegions[1].minMm.x = 2.625; const partial = auditResinHollowFinalGrid(region); assert.equal(partial.disposition, 'inconclusive'); assert.equal(partial.counts.supportRegionBoundaryCells, 8); assert.equal(partial.counts.unapprovedOriginalAirFill, 8);
});

test('nonzero final halo material is never excused by an enlarged support envelope', () => {
  const input = fixture(); input.supportEnvelope = { minMm: { x: -10, y: -10, z: -10 }, maxMm: { x: 20, y: 20, z: 20 } }; set(input, 0, 0, 0, 255);
  const result = auditResinHollowFinalGrid(input); assert.equal(result.disposition, 'nonconforming'); assert.equal(result.counts.finalHaloMaterialCells, 1);
});

test('a bad body reference cannot be promoted by a corrected final print', () => {
  const input = fixture(), i = index(input.frame, 12, 12, 20); input.hollowBody.lower[i] = input.hollowBody.upper[i] = 255;
  const result = auditResinHollowFinalGrid(input); assert.equal(result.disposition, 'nonconforming'); assert.ok(result.counts.definitelyChangedBodyCells > 0);
});

test('boundary changes are explicit, source-distance bounded and cannot waive original cavity or drill interfaces', () => {
  const exact = fixture(); set(exact, 4, 5, 20, 128); const a = auditResinHollowFinalGrid(exact); assert.equal(a.disposition, 'inconclusive'); assert.equal(a.counts.ambiguousBodyChanges, 1);
  const enclosed = copy(exact); enclosed.boundaryPolicy = 'voxel-enclosure'; const b = auditResinHollowFinalGrid(enclosed); assert.equal(b.disposition, 'conforming'); assert.equal(b.counts.permittedBoundaryChanges, 1);
  const cavity = fixture(); cavity.boundaryPolicy = 'voxel-enclosure'; set(cavity, 7, 7, 20, 128); const c = auditResinHollowFinalGrid(cavity); assert.notEqual(c.disposition, 'conforming'); assert.equal(c.counts.permittedBoundaryChanges, 0); assert.equal(c.counts.filledRequiredVoidCells, 1);
});

test('mirrored handedness preserves final supported geometry and envelope classification', () => {
  const input = fixture(), baseline = auditResinHollowFinalGrid(input);
  for (const direction of [-1, 1]) {
    const f = copy(input); f.frame.direction.x = direction; f.frame.originMm.x = direction < 0 ? 5.75 : -.5;
    if (direction < 0) { f.drains = f.drains.map(d => ({ ...d, startMm: { ...d.startMm, x: 5.25 - d.startMm.x } })); f.supportEnvelope.minMm.x = .25; f.supportEnvelope.maxMm.x = 5.25; f.supportRegions = f.supportRegions.map(r => ({ ...r, minMm: { ...r.minMm, x: 5.25 - r.maxMm.x }, maxMm: { ...r.maxMm, x: 5.25 - r.minMm.x } })); }
    const result = auditResinHollowFinalGrid(f); assert.equal(result.disposition, baseline.disposition); assert.deepEqual(result.counts, baseline.counts);
  }
  const canonicalModelZ = copy(input); canonicalModelZ.frame.originMm.z -= 2.5; canonicalModelZ.supportEnvelope.minMm.z -= 2.5; canonicalModelZ.supportEnvelope.maxMm.z -= 2.5;
  canonicalModelZ.drains = canonicalModelZ.drains.map(d => ({ ...d, startMm: { ...d.startMm, z: d.startMm.z - 2.5 } }));
  canonicalModelZ.supportRegions = canonicalModelZ.supportRegions.map(r => ({ ...r, minMm: { ...r.minMm, z: r.minMm.z - 2.5 }, maxMm: { ...r.maxMm, z: r.maxMm.z - 2.5 } }));
  const belowModel = auditResinHollowFinalGrid(canonicalModelZ); assert.equal(belowModel.disposition, baseline.disposition); assert.deepEqual(belowModel.counts, baseline.counts, 'supports below canonical model zero remain in the same physical envelope');
});

test('a genuinely tilted body with oblique drains and padded model Z retains the same unmasked support rules', () => {
  const frame = { nx: 39, ny: 29, nz: 45, pitchMm: { x: .25, y: .25, z: .25 }, originMm: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 1, z: 1 } }, n = frame.nx * frame.ny * frame.nz;
  const source = new Uint8Array(n), body = new Uint8Array(n), s = Math.SQRT1_2, center = { x: 4.5, y: 3.5, z: 5.5 }, direction = { x: -s, y: 0, z: s };
  const drains = [-1, 1].map((u, i) => ({ id: 'tilted-' + i, startMm: { x: center.x + s * u + s * 3.5, y: center.y, z: center.z + s * u - s * 3.5 }, direction: { ...direction }, radiusMm: .9, lengthMm: 4 }));
  for (let z = 1; z < frame.nz - 1; z++) for (let y = 1; y < frame.ny - 1; y++) for (let x = 1; x < frame.nx - 1; x++) {
    const p = point(frame, x, y, z), u = (p.x - center.x + p.z - center.z) * s, v = p.y - center.y, w = (-p.x + center.x + p.z - center.z) * s, i = index(frame, x, y, z);
    if (Math.max(Math.abs(u), Math.abs(v), Math.abs(w)) <= 2.5) {
      source[i] = 255;
      if (Math.max(Math.abs(u), Math.abs(v), Math.abs(w)) > 1.5 && !drains.some(d => cylinder(p, d))) body[i] = 255;
    }
  }
  const final = body.slice(); for (let z = 2; z <= 3; z++) for (let y = 4; y <= 24; y++) for (let x = 4; x <= 34; x++) final[index(frame, x, y, z)] = 255;
  const input = { solidBody: { lower: source, upper: source.slice() }, hollowBody: { lower: body, upper: body.slice() }, final: { lower: final, upper: final.slice() }, frame, drains, wallThicknessMm: 1, uncertaintyMm: Math.sqrt(3) * .25, supportEnvelope: { minMm: { x: 1, y: 1, z: .5 }, maxMm: { x: 8.75, y: 6.25, z: 1 } }, supportRegions: [{ id: 'authored-tilted-pad', minMm: { x: 1, y: 1, z: .5 }, maxMm: { x: 8.75, y: 6.25, z: 1 } }] };
  const result = auditResinHollowFinalGrid(input); assert.equal(result.disposition, 'conforming'); assert.ok(result.finalMaterialAudit.drains.every(d => d.disposition === 'conforming')); assert.ok(result.counts.outsideSupportCells > 1000); assert.equal(result.counts.changedBodyCells, 0);
  const blocked = copy(input); const i = source.findIndex((value, j) => value === 255 && body[j] === 0 && cylinder(point(frame, j % frame.nx, Math.floor(j / frame.nx) % frame.ny, Math.floor(j / (frame.nx * frame.ny))), drains[0]));
  blocked.final.lower[i] = blocked.final.upper[i] = 255; assert.equal(auditResinHollowFinalGrid(blocked).disposition, 'nonconforming');
});

test('all six input backings and strict resource, interval, frame and envelope limits are checked', () => {
  const input = fixture(), baseline = auditResinHollowFinalGrid(input), n = input.final.lower.length;
  assert.equal(baseline.resources.inputViewBytes, n * 6); assert.equal(baseline.resources.inputBackingBytes, n * 6); assert.ok(baseline.resources.chargedOperations < baseline.limits.maxOperations);
  assert.ok(baseline.finalMaterialAudit.resources.additionalArrayBytes + n * 5 <= baseline.resources.additionalArrayBytesUpperBound);
  const oversized = copy(input); oversized.final.upper = new Uint8Array(new ArrayBuffer(n * 100), 0, n); oversized.final.upper.set(input.final.upper);
  assert.throws(() => auditResinHollowFinalGrid({ ...oversized, limits: { maxWorkingBytes: baseline.resources.conservativeVisiblePeakBytes } }), { code: 'RESIN_HOLLOW_FINAL_MEMORY' });
  for (const mutate of [f => f.final.lower = new Uint8Array(new SharedArrayBuffer(n)), f => f.hollowBody.upper = new Uint8ClampedArray(n), f => f.solidBody.lower = new Uint8Array(1)]) { const f = copy(input); mutate(f); assert.throws(() => auditResinHollowFinalGrid(f), { code: 'RESIN_HOLLOW_FINAL_ARRAY' }); }
  for (const mutate of [f => f.supportEnvelope.extra = true, f => f.supportEnvelope.maxMm.z = NaN, f => f.supportEnvelope.maxMm.x = f.supportEnvelope.minMm.x, f => f.frame.direction.z = -1, f => f.drains[0].direction.z = .5, f => f.extra = true, f => f.boundaryPolicy = 'ignore-drift']) { const f = copy(input); mutate(f); assert.throws(() => auditResinHollowFinalGrid(f)); }
  for (const supportRegions of [null, {}, new Array(2), [{ id: 'bad', minMm: { x: 0, y: 0, z: 0 }, maxMm: { x: 1, y: 1, z: Infinity } }], [input.supportRegions[0], input.supportRegions[0]]]) assert.throws(() => auditResinHollowFinalGrid({ ...input, supportRegions }));
  assert.throws(() => auditResinHollowFinalGrid({ ...input, limits: { maxSupportRegions: 1 } }), { code: 'RESIN_HOLLOW_FINAL_REGIONS' });
  const invalid = copy(input); invalid.final.lower[0] = 255; assert.throws(() => auditResinHollowFinalGrid(invalid), { code: 'RESIN_HOLLOW_FINAL_INTERVAL' });
  for (const limits of [{ maxVoxels: 1 }, { maxWorkingBytes: 1 }, { maxOperations: 1 }, { maxTimeMs: 1 }]) assert.throws(() => auditResinHollowFinalGrid({ ...input, limits }));
  for (const limits of [{ maxVoxels: 20000001 }, { constructor: 1 }, { [Symbol('x')]: 1 }]) assert.throws(() => auditResinHollowFinalGrid({ ...input, limits }), { code: 'RESIN_HOLLOW_FINAL_LIMITS' });
  const controller = new AbortController(); controller.abort(); assert.throws(() => auditResinHollowFinalGrid({ ...input, signal: controller.signal }), { code: 'RESIN_HOLLOW_FINAL_ABORTED' });
  assert.equal(RESIN_HOLLOW_FINAL_GRID_LIMITS.maxVoxels, 20000000);
});
