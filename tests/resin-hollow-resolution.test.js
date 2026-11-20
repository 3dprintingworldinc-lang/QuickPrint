'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planResinHollowResolution, RESIN_HOLLOW_RESOLUTION_LIMITS } = require('../src/slicing/resin-hollow-resolution');

function fixture() {
  return { geometry: { resolutionX: 15120, resolutionY: 6230, displayWidthMm: 211.68, displayHeightMm: 118.37, machineZMm: 220, layerHeightMm: .05 },
    sourceBoundsMm: { minMm: { x: 0, y: 0, z: 0 }, maxMm: { x: 10, y: 10, z: 10 } },
    supportEnvelope: { minMm: { x: -8, y: -8, z: -7.037 }, maxMm: { x: 18, y: 18, z: 10.8 } },
    modelElevationMm: 7.037, wallThicknessMm: 2,
    drains: [{ id: 'bottom', radiusMm: 1.25, lengthMm: 3, startMm: { x: 5, y: 5, z: 0 }, direction: { x: 0, y: 0, z: 1 } }],
    request: { maximumUncertaintyMm: .2 } };
}

test('the actual 16K geometry plans a bounded one-time grid for a 10mm model before any raster exists', () => {
  const input = fixture(), original = structuredClone(input), result = planResinHollowResolution(input);
  assert.deepEqual(result.reduction, { x: 6, y: 4, z: 2 });
  assert.ok(result.preflight.cells <= 20000000); assert.ok(result.preflight.workingBytes <= 768 * 1024 * 1024);
  assert.equal(result.preflight.workingBytes, 38 * result.preflight.cells + 20 * Math.max(...Object.values(result.preflight.dimensions)) + 8);
  assert.ok(result.uncertainty.totalUpperBoundMm <= .2); assert.ok(result.uncertainty.metadataRoundoffReserveMm > 0);
  assert.ok(result.preflight.layerCountUpperBound * input.geometry.layerHeightMm > input.supportEnvelope.maxMm.z + input.modelElevationMm);
  assert.ok(result.drainResolutionChecks.every(item => item.lowerCoreResolvedAtPriorGrid && item.radiusClearanceMm > 0 && item.lengthClearanceMm > 0));
  assert.deepEqual(result.policy, { reduction: result.reduction, maximumUncertaintyMm: .2 });
  assert.equal(result.priorOnly, true); assert.equal(result.auditFeedbackUsed, false);
  assert.equal(Object.hasOwn(result, 'productionEligible'), false); assert.equal(Object.hasOwn(result, 'printReady'), false);
  assert.deepEqual(input, original); assert.ok(Object.isFrozen(result) && Object.isFrozen(result.policy.reduction));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result); assert.deepEqual(planResinHollowResolution(input), result);
});

test('a large 16K source plus prior support envelope is covered under a separately declared wall and band', () => {
  const input = fixture(); input.sourceBoundsMm.maxMm = { x: 100, y: 60, z: 90 }; input.supportEnvelope.maxMm = { x: 108, y: 68, z: 90.8 }; input.wallThicknessMm = 4; input.request.maximumUncertaintyMm = 1;
  const result = planResinHollowResolution(input);
  assert.deepEqual(result.reduction, { x: 24, y: 20, z: 7 });
  assert.ok(result.preflight.cells <= 20000000); assert.ok(result.preflight.workingBytes <= RESIN_HOLLOW_RESOLUTION_LIMITS.maxWorkingBytes);
  assert.ok(result.uncertainty.totalUpperBoundMm < 1); assert.ok(result.preflight.layerCountUpperBound > 1900);
  assert.deepEqual(result.preflight.unionBoundsMm, { minMm: { x: -8, y: -8, z: -7.037 }, maxMm: { x: 108, y: 68, z: 90.8 } });
});

test('explicit minimum pitches and lower cell/memory caps are honored without changing the declared uncertainty', () => {
  const input = fixture(); input.request = { maximumUncertaintyMm: .35, minimumPitchMm: { x: .15, y: .12, z: .05 }, maxCells: 8000000, maxWorkingBytes: 128 * 1024 * 1024 };
  const result = planResinHollowResolution(input), n = input.geometry;
  assert.ok(result.reduction.x * n.displayWidthMm / n.resolutionX >= .15); assert.ok(result.reduction.y * n.displayHeightMm / n.resolutionY >= .12);
  assert.ok(result.preflight.cells <= 8000000); assert.ok(result.preflight.workingBytes <= 128 * 1024 * 1024);
  assert.equal(result.policy.maximumUncertaintyMm, .35); assert.ok(result.uncertainty.totalUpperBoundMm <= .35);
  const broad = fixture(); broad.supportEnvelope.minMm.x = -1000; broad.supportEnvelope.maxMm.x = 1000; broad.request.maximumUncertaintyMm = .5;
  const capacity = planResinHollowResolution(broad); assert.equal(capacity.preflight.cropPixelsUpperBound.x, n.resolutionX, 'complete native image capacity bounds represented pixels, without changing permissions'); assert.equal(capacity.supportEnvelope.minMm.x, -1000);
});

test('the selected policy is optimal against an independently exhaustive small-grid search', () => {
  const input = { geometry: { resolutionX: 40, resolutionY: 30, displayWidthMm: 4, displayHeightMm: 3, machineZMm: 10, layerHeightMm: .1 },
    sourceBoundsMm: { minMm: { x: 0, y: 0, z: 0 }, maxMm: { x: 2, y: 1.5, z: 1 } }, supportEnvelope: { minMm: { x: -.2, y: -.2, z: -.6 }, maxMm: { x: 2.2, y: 1.7, z: 1.2 } },
    modelElevationMm: .6, wallThicknessMm: 1.5, request: { maximumUncertaintyMm: .5, maxCells: 1600 } };
  const result = planResinHollowResolution(input), candidates = [], reserve = result.uncertainty.metadataRoundoffReserveMm;
  for (let x = 1; x <= 8; x++) for (let y = 1; y <= 8; y++) for (let z = 1; z <= 8; z++) {
    const diagonal = Math.hypot(x * (4 + 4 * 2 ** -23 + 2 ** -149) / 40, y * (3 + 3 * 2 ** -23 + 2 ** -149) / 30, z * .1);
    const dimensions = [Math.ceil(result.preflight.cropPixelsUpperBound.x / x) + 2, Math.ceil(result.preflight.cropPixelsUpperBound.y / y) + 2, Math.ceil(result.preflight.layerCountUpperBound / z) + 2], cells = dimensions.reduce((a, b) => a * b);
    if (cells <= 1600 && diagonal + reserve <= .5) candidates.push({ reduction: { x, y, z }, diagonal });
  }
  candidates.sort((a, b) => a.diagonal - b.diagonal || a.reduction.z - b.reduction.z || a.reduction.x - b.reduction.x || a.reduction.y - b.reduction.y);
  assert.ok(candidates.length); assert.deepEqual(result.reduction, candidates[0].reduction); assert.equal(result.uncertainty.voxelDiagonalMm, candidates[0].diagonal);
  assert.ok(result.search.candidateAxisPairs <= 512 ** 2); assert.ok(result.search.binaryEvaluations <= 18 * 512 ** 2);
});

test('too small walls, unresolved drill cores and infeasible resource requests hold instead of widening or coarsening after failure', () => {
  for (const mutate of [
    input => { input.wallThicknessMm = .03; input.request.maximumUncertaintyMm = .01; },
    input => { input.drains[0].radiusMm = .01; }, input => { input.drains[0].lengthMm = .1; },
    input => { input.request.maxCells = 1; }, input => { input.request.maxWorkingBytes = 1; },
    input => { input.request.minimumPitchMm = { x: 1000, y: 1000, z: 1000 }; },
    input => { input.request.maximumUncertaintyMm = .06; },
  ]) { const input = fixture(); mutate(input); const before = structuredClone(input); assert.throws(() => planResinHollowResolution(input), { code: 'RESIN_HOLLOW_RESOLUTION_UNRESOLVED', status: 422 }); assert.deepEqual(input, before); }
  const height = fixture(); height.supportEnvelope.maxMm.z = 2000; assert.throws(() => planResinHollowResolution(height), { code: 'RESIN_HOLLOW_RESOLUTION_UNRESOLVED' });
});

test('native resolution is retained when it fits, including an exact declared diagonal boundary', () => {
  const input = fixture(); input.geometry = { resolutionX: 512, resolutionY: 512, displayWidthMm: 40, displayHeightMm: 40, machineZMm: 40, layerHeightMm: .1 };
  input.supportEnvelope.minMm = { x: -1, y: -1, z: -7.037 }; input.supportEnvelope.maxMm = { x: 11, y: 11, z: 10.8 };
  const first = planResinHollowResolution(input); assert.deepEqual(first.reduction, { x: 1, y: 1, z: 1 });
  input.request.maximumUncertaintyMm = first.uncertainty.totalUpperBoundMm;
  assert.deepEqual(planResinHollowResolution(input).reduction, { x: 1, y: 1, z: 1 });
  const previous = structuredClone(input); previous.observedAudit = { disposition: 'nonconforming' }; assert.throws(() => planResinHollowResolution(previous), { code: 'RESIN_HOLLOW_RESOLUTION_INPUT' });
});

test('invalid authority geometry, raised bounds and malformed policies fail before finite search', () => {
  for (const mutate of [
    input => { input.geometry.resolutionX = 3.5; }, input => { input.geometry.resolutionX = 20000; input.geometry.resolutionY = 20000; },
    input => { input.geometry.layerHeightMm = NaN; }, input => { input.geometry.extra = 1; },
    input => { input.sourceBoundsMm.minMm.x = .1; }, input => { input.supportEnvelope.maxMm.x = input.supportEnvelope.minMm.x; },
    input => { input.request.maximumUncertaintyMm = 1; }, input => { input.request.maximumUncertaintyMm = null; },
    input => { input.request.maxCells = 20000001; }, input => { input.request.maxWorkingBytes = 768 * 1024 * 1024 + 1; },
    input => { input.request.minimumPitchMm = { x: 0, y: .1, z: .1 }; }, input => { input.request.retryCoarser = true; },
    input => { input.request[Symbol('unexpected')] = true; }, input => { input.drains = []; }, input => { input.drains = new Array(1); },
    input => { input.drains[0].direction.z = .9; }, input => { input.drains.push(structuredClone(input.drains[0])); },
  ]) { const input = fixture(); mutate(input); assert.throws(() => planResinHollowResolution(input), { code: 'RESIN_HOLLOW_RESOLUTION_INPUT' }); }
  assert.ok(Object.isFrozen(RESIN_HOLLOW_RESOLUTION_LIMITS)); assert.equal(RESIN_HOLLOW_RESOLUTION_LIMITS.maxReduction, 512);
});

test('explicit fixed fine grid retains prior authorization even when its worst-case envelope exceeds the crop budget', () => {
  const input=fixture();input.geometry={resolutionX:512,resolutionY:512,displayWidthMm:40,displayHeightMm:40,machineZMm:40,layerHeightMm:.1};
  input.request={maximumUncertaintyMm:.16,reduction:{x:1,y:1,z:1},maxCells:20000000};const original=structuredClone(input),result=planResinHollowResolution(input);
  assert.deepEqual(result.reduction,{x:1,y:1,z:1});assert.deepEqual(result.policy,{reduction:{x:1,y:1,z:1},maximumUncertaintyMm:.16});
  assert.equal(result.preflight.cells,20669558);assert.equal(result.preflight.worstCaseFits,false);assert.equal(result.boundedByActualCrop,true);
  assert.deepEqual(result.actualCropLimits,{maxCells:20000000,maxWorkingBytes:768*1024*1024});assert.equal(Object.hasOwn(result.request,'minimumPitchMm'),false);assert.deepEqual(result.request.reduction,input.request.reduction);
  assert.ok(result.uncertainty.totalUpperBoundMm<=.16);assert.ok(result.drainResolutionChecks.every(drain=>drain.lowerCoreResolvedAtPriorGrid));
  assert.equal(result.search.candidateAxisPairs,0);assert.equal(result.search.binaryEvaluations,0);assert.equal(result.priorOnly,true);assert.equal(result.auditFeedbackUsed,false);
  assert.equal(Object.hasOwn(result,'actualCells'),false);assert.equal(Object.hasOwn(result,'productionEligible'),false);assert.equal(Object.hasOwn(result,'printReady'),false);
  assert.deepEqual(input,original);assert.deepEqual(result,JSON.parse(JSON.stringify(result)));assert.deepEqual(planResinHollowResolution(input),result);assert.ok(Object.isFrozen(result.actualCropLimits));
  const auto=structuredClone(input);delete auto.request.reduction;assert.throws(()=>planResinHollowResolution(auto),{code:'RESIN_HOLLOW_RESOLUTION_UNRESOLVED'},'auto mode still requires the entire authorized envelope to fit');
});

test('fixed reductions keep exact 16K axes and report both fitting and deliberately lower actual-crop budgets', () => {
  const input=fixture();input.request={maximumUncertaintyMm:.2,reduction:{x:8,y:5,z:2},maxCells:20000000};const first=planResinHollowResolution(input);
  assert.deepEqual(first.reduction,{x:8,y:5,z:2});assert.equal(first.preflight.worstCaseFits,true);assert.equal(first.boundedByActualCrop,true);assert.ok(first.preflight.cells<=first.actualCropLimits.maxCells);assert.ok(first.uncertainty.totalUpperBoundMm<=.2);
  input.request.maxCells=1000;input.request.maxWorkingBytes=4096;const limited=planResinHollowResolution(input);
  assert.deepEqual(limited.reduction,first.reduction);assert.equal(limited.preflight.worstCaseFits,false);assert.deepEqual(limited.actualCropLimits,{maxCells:1000,maxWorkingBytes:4096});assert.deepEqual(limited.uncertainty,first.uncertainty);assert.deepEqual(limited.supportEnvelope,first.supportEnvelope);
});

test('fixed choice never waives wall, metadata or complete drain-core resolution', () => {
  for(const mutate of [
    input=>{input.request.reduction={x:512,y:512,z:512};},
    input=>{input.request.maximumUncertaintyMm=.01;},
    input=>{input.drains[0].radiusMm=.1;},
    input=>{input.drains[0].lengthMm=.1;},
  ]){const input=fixture();input.request={maximumUncertaintyMm:.2,reduction:{x:8,y:5,z:2}};mutate(input);const original=structuredClone(input);assert.throws(()=>planResinHollowResolution(input),{code:'RESIN_HOLLOW_RESOLUTION_UNRESOLVED',status:422});assert.deepEqual(input,original);}
  const input=fixture();input.request={maximumUncertaintyMm:.7,reduction:{x:1,y:1,z:1}};assert.throws(()=>planResinHollowResolution(input),{code:'RESIN_HOLLOW_RESOLUTION_INPUT'});
});

test('fixed mode rejects malformed axes, dual policy choices, raised limits and observed-input feedback', () => {
  for(const mutate of [
    input=>{input.request.reduction={x:0,y:1,z:1};},input=>{input.request.reduction={x:513,y:1,z:1};},input=>{input.request.reduction={x:1.5,y:1,z:1};},
    input=>{input.request.reduction={x:1,y:1};},input=>{input.request.reduction={x:1,y:1,z:1,extra:1};},input=>{input.request.reduction=null;},
    input=>{input.request.reduction={x:'1',y:1,z:1};},input=>{input.request.minimumPitchMm={x:.1,y:.1,z:.1};},
    input=>{input.request.maxCells=20000001;},input=>{input.request.maxWorkingBytes=768*1024*1024+1;},
    input=>{input.actualCrop={width:10,height:10};},input=>{input.request.actualCells=1000;},input=>{input.request.observedAudit={disposition:'conforming'};},
  ]){const input=fixture();input.request={maximumUncertaintyMm:.2,reduction:{x:1,y:1,z:1}};mutate(input);assert.throws(()=>planResinHollowResolution(input),{code:'RESIN_HOLLOW_RESOLUTION_INPUT'});}
});
