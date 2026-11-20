'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeResinHollowReview } = require('../src/core/resin-hollow-review');
function review() { return { geometrySha256: 'a'.repeat(64), profileSha256: 'b'.repeat(64), recipe: { orientation: { x: 30, y: 15, z: -0 }, wallThicknessMm: 2, quality: .75, closingDistanceMm: 0, drains: [{ id: 'bottom', startMm: { x: 8.5, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: 1.25, lengthMm: 3 }] }, supportRequest: { mode: 'automatic', clearanceMm: 8, points: [], regions: [{ id: 'before-capture', minMm: { x: -8, y: -8, z: -7 }, maxMm: { x: 22, y: 22, z: .8 } }] }, resolutionRequest: { maximumUncertaintyMm: .25, minimumPitchMm: { x: .1, y: .1, z: .1 } }, boundaryPolicy: 'voxel-enclosure' }; }
test('hollow review freezes source/profile choices, intended cylinders and support/resolution authority without local paths', () => {
  const value = review(), normalized = normalizeResinHollowReview(value); assert.equal(normalized.recipe.orientation.z, 0); assert.equal(Object.is(normalized.recipe.orientation.z, -0), false); assert.equal(Object.isFrozen(normalized.supportRequest.regions[0].minMm), true);
  value.recipe.drains[0].radiusMm = 3; assert.equal(normalized.recipe.drains[0].radiusMm, 1.25); assert.deepEqual(normalizeResinHollowReview(JSON.parse(JSON.stringify(normalized))), normalized);
});
test('unreviewed source/profile, script or path options and unsupported values are rejected', () => {
  for (const mutate of [v => v.geometrySha256 = 'bad', v => v.profileSha256 = null, v => v.presetPath = 'C:\\unreviewed.ini', v => v.recipe.script = 'run', v => v.recipe.wallThicknessMm = .9, v => v.recipe.orientation.x = NaN, v => v.recipe.drains[0].direction.z = .5, v => v.recipe.drains[0].startMm.x = Infinity, v => v.recipe.drains.push(v.recipe.drains[0]), v => v.supportRequest.regions = [], v => v.supportRequest.clearanceMm = 101, v => v.supportRequest.regions[0].maxMm.z = -8, v => v.resolutionRequest.maximumUncertaintyMm = .7, v => v.resolutionRequest.maxCells = 20000001, v => v.resolutionRequest.maxWorkingBytes = 768 * 1024 * 1024 + 1, v => v.resolutionRequest.minimumPitchMm.x = 0, v => v.boundaryPolicy = 'automatic-until-pass']) {
    const value = review(); mutate(value); assert.throws(() => normalizeResinHollowReview(value), { code: 'RESIN_HOLLOW_REVIEW_INVALID' });
  }
});
test('authored point and disabled-support modes have separate strict authority', () => {
  const value = review(); value.supportRequest = { mode: 'points', clearanceMm: 4, regions: [], points: [{ id: 'corner', sourceFaceIndex: 0, positionMm: { x: 0, y: 0, z: 0 }, headRadiusMm: .4, allowedRadiusMm: 3 }] };
  assert.equal(normalizeResinHollowReview(value).supportRequest.points[0].sourceFaceIndex, 0);
  for (const mutate of [v => v.supportRequest.points[0].sourceFaceIndex = 250000, v => v.supportRequest.points[0].allowedRadiusMm = .3, v => v.supportRequest.mode = 'none', v => v.supportRequest.points[0].filePath = 'C:\\model.stl']) { const changed = structuredClone(value); mutate(changed); assert.throws(() => normalizeResinHollowReview(changed)); }
  value.supportRequest = { mode: 'none', clearanceMm: 0, points: [], regions: [] }; assert.equal(normalizeResinHollowReview(value).supportRequest.mode, 'none');
});
test('a fixed resolution is an explicit prior choice and cannot be mixed with automatic pitch or feedback', () => {
  const value = review(); value.resolutionRequest = { maximumUncertaintyMm: .2, reduction: { x: 8, y: 5, z: 2 }, maxCells: 20000000 };
  assert.deepEqual(normalizeResinHollowReview(value).resolutionRequest, value.resolutionRequest);
  for (const mutate of [v => v.resolutionRequest.minimumPitchMm = { x: .1, y: .1, z: .1 }, v => v.resolutionRequest.reduction.x = 0, v => v.resolutionRequest.reduction.z = 1.5, v => v.resolutionRequest.observedCrop = { width: 100 }]) { const input = structuredClone(value); mutate(input); assert.throws(() => normalizeResinHollowReview(input), { code: 'RESIN_HOLLOW_REVIEW_INVALID' }); }
});
