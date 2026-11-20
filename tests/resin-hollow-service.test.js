'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QuickPrintService } = require('../src/core/service');
const { loadProfile } = require('../src/slicing/resin-engine');
const { createProfile, makeSlice, importTicket, CONFIRMED } = require('./helpers/resin-slice');
const { expandedSlaPreset } = require('./helpers/resin-hollow-preset');
function choices(geometrySha256, profileSha256) { return { geometrySha256, profileSha256, recipe: { orientation: { x: 0, y: 0, z: 0 }, wallThicknessMm: 2, quality: .75, closingDistanceMm: 0, drains: [3, 7].map((x, index) => ({ id: 'bottom-' + index, startMm: { x, y: 5, z: 0 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: 1.25, lengthMm: 3 })) }, supportRequest: { mode: 'none', clearanceMm: 0, points: [], regions: [] }, resolutionRequest: { maximumUncertaintyMm: .25 }, boundaryPolicy: 'voxel-enclosure' }; }
async function fixture(t, engine) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-hollow-service-')), settings = await createProfile(dataDir), calls = [];
  const service = new QuickPrintService({ dataDir, resinEngine: { prepareResin: makeSlice, prepareControlledResinHollow: async options => { calls.push(options); return engine ? engine(options) : makeSlice(options); } } }); await service.init(); await service.updateSettings({ resinEngine: settings });
  t.after(async () => { await service.close(); const actual = await fs.realpath(dataDir); assert.equal(path.dirname(actual).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase()); assert.match(path.basename(actual), /^quickprint-hollow-service-/); await fs.rm(actual, { recursive: true, force: true }); });
  const job = await importTicket(service), measured = await service.planResinGeometry(job.id), loaded = await loadProfile(settings.profilePath);
  return { dataDir, settings, service, job, calls, review: choices(measured.geometrySha256, loaded.profileSha256) };
}
test('reviewed hollow request requires separate confirmation and rejects stale sized geometry/profile before any provider', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.sliceResinJob(f.job.id, { ...CONFIRMED, hollow: f.review }), { code: 'RESIN_HOLLOW_REVIEW_REQUIRED' });
  await assert.rejects(f.service.sliceResinJob(f.job.id, { ...CONFIRMED, confirmedHollowPreparation: true }), { code: 'RESIN_HOLLOW_REVIEW_REQUIRED' });
  for (const key of ['geometrySha256', 'profileSha256']) await assert.rejects(f.service.sliceResinJob(f.job.id, { ...CONFIRMED, confirmedHollowPreparation: true, hollow: { ...f.review, [key]: '0'.repeat(64) } }), { code: 'RESIN_HOLLOW_REVIEW_STALE' });
  const changed = structuredClone(f.review); changed.recipe.prusaExecutable = 'C:\\caller.exe'; await assert.rejects(f.service.sliceResinJob(f.job.id, { ...CONFIRMED, confirmedHollowPreparation: true, hollow: changed }), { code: 'RESIN_HOLLOW_REVIEW_INVALID' });
  assert.equal(f.calls.length, 0); assert.equal(f.service.getJob(f.job.id).resinSlice, undefined);
});
test('a valid recipe cannot turn an injected solid slice or caller JSON into controlled hollow evidence', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.sliceResinJob(f.job.id, { ...CONFIRMED, confirmedHollowPreparation: true, hollow: f.review }), { code: 'RESIN_HOLLOW_EVIDENCE_REQUIRED' });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].hollowRequest, f.review.recipe); assert.equal(f.calls[0].plate, undefined); assert.equal(f.calls[0].slots, undefined); assert.equal(f.service.getJob(f.job.id).resinSlice, undefined);
  const forged = await fixture(t, async options => ({ ...await makeSlice(options), hollowPreparation: { controlledExecution: true, productionEligible: false, profileSha256: f.review.profileSha256 } }));
  await assert.rejects(forged.service.sliceResinJob(forged.job.id, { ...CONFIRMED, confirmedHollowPreparation: true, hollow: forged.review }), { code: 'RESIN_HOLLOW_REVIEW_STALE' });
});
test('legacy original-size compatibility cannot skip the required hollow source and recipe verifier', async t => {
  const f = await fixture(t); await f.service.sliceResinJob(f.job.id, CONFIRMED);
  await f.service._mutate(() => { const slice = f.service._job(f.job.id).resinSlice; delete slice.sizingPlan; delete slice.inputGeometry; slice.operatorReview.hollow = f.review; slice.operatorReview.confirmedHollowPreparation = true; slice.hollowPreparation = {}; });
  await assert.rejects(f.service.getResinSliceDownload(f.job.id), { code: 'RESIN_HOLLOW_EVIDENCE_REQUIRED' });
});

test('recipe review checks current size/profile/support mode without native work or stored approval', async t => {
  const f = await fixture(t), sizing = { mode: 'dimension', axis: 'z', millimeters: 10 }, geometry = await f.service.planResinGeometry(f.job.id, { sizing }), review = { ...f.review, geometrySha256: geometry.geometrySha256, supportRequest: { mode: 'automatic', clearanceMm: 8, points: [], regions: [{ id: 'prior', minMm: { x: -8, y: -8, z: -7 }, maxMm: { x: 18, y: 18, z: .5 } }] } };
  const before = await fs.readFile(path.join(f.dataDir, 'state.json')), result = await f.service.reviewResinHollowPreparation(f.job.id, { hollow: review, sizing });
  assert.deepEqual(result.hollow, review); assert.deepEqual(result.geometry.dimensionsMm, { x: 10, y: 10, z: 10 }); assert.equal(result.profileSha256, review.profileSha256); assert.equal(result.digitalValidationPending, true); assert.equal(result.printReady, false); assert.equal(f.calls.length, 0); assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'state.json')), before); assert.ok(!JSON.stringify(result).includes(f.dataDir));
  await assert.rejects(f.service.reviewResinHollowPreparation(f.job.id, { hollow: review, sizing: { mode: 'scale', factor: 2 } }), { code: 'RESIN_HOLLOW_REVIEW_STALE' });
  await assert.rejects(f.service.reviewResinHollowPreparation(f.job.id, { hollow: { ...review, supportRequest: { mode: 'none', clearanceMm: 0, points: [], regions: [] } }, sizing }), { code: 'RESIN_HOLLOW_REVIEW_INVALID' });
  const contact = { ...review, supportRequest: { mode: 'points', clearanceMm: 4, points: [{ id: 'wrong-face', sourceFaceIndex: 99, positionMm: { x: 0, y: 0, z: 0 }, headRadiusMm: .4, allowedRadiusMm: 3 }], regions: [] } }; await assert.rejects(f.service.reviewResinHollowPreparation(f.job.id, { hollow: contact, sizing }), { code: 'RESIN_HOLLOW_REVIEW_INVALID' });
  await assert.rejects(f.service.reviewResinHollowPreparation(f.job.id, { hollow: review, sizing, inputPath: 'C:\\unreviewed.stl' }), { code: 'RESIN_HOLLOW_REVIEW_INVALID' });
});

test('cancelling post-native hollow inspection, replay or plate verification aborts the same signal and stores no slice', async t => {
  for (const phase of ['inspection', 'replay', 'plate']) await t.test(phase, async t => {
    const engineModule = require('../src/slicing/resin-hollow-engine'), plateModule = require('../src/slicing/resin-hollow-plate');
    let f, result, entered;
    const reached = new Promise(resolve => { entered = resolve; }), observed = [];
    const waitForCancellation = options => {
      assert.ok(options.signal instanceof AbortSignal); observed.push(options.signal); entered();
      return new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    };
    f = await fixture(t, async options => {
      result = await makeSlice(options);
      result.hollowPreparation = { sha256: 'f'.repeat(64), profileSha256: result.profileSha256, source: { sha256: result.sourceSha256 }, roles: { final: { artifact: { sha256: result.sha256 } } }, inputs: { sourceBinding: { geometrySha256: result.inputGeometry.sha256 } },
        request: { hollowRequest: f.review.recipe, supportRequest: f.review.supportRequest, resolutionRequest: f.review.resolutionRequest, boundaryPolicy: f.review.boundaryPolicy }, tool: result.tool };
      return result;
    });
    // These are verifier/controller seams only. No synthetic record is accepted
    // or persisted: every branch must be interrupted by the real service cancel.
    t.mock.method(engineModule, 'inspectControlledResinHollowBindings', async (record, options) => {
      assert.ok(options.signal instanceof AbortSignal); observed.push(options.signal);
      if (phase === 'inspection') return waitForCancellation(options);
      return { bindingHash: 'current-binding', sha256: result.sha256, bytes: result.bytes };
    });
    t.mock.method(engineModule, 'verifyControlledResinHollowPreparation', async (record, options) => {
      assert.ok(options.signal instanceof AbortSignal); observed.push(options.signal);
      if (phase === 'replay') return waitForCancellation(options);
      return { bindingHash: 'current-binding', hollowPreparationSha256: record.sha256, sha256: result.sha256 };
    });
    t.mock.method(plateModule, 'prepareResinHollowPlate', async options => {
      assert.ok(options.signal instanceof AbortSignal); observed.push(options.signal);
      return { modelCopiesPerRun: 2, platePreparation: { method: 'controlled-hollow-reference-raster-replication-v1', tool: result.tool } };
    });
    t.mock.method(plateModule, 'verifyResinHollowPlateReference', async (record, options) => {
      assert.ok(options.signal instanceof AbortSignal); observed.push(options.signal); return Object.freeze({ ownedTestReference: true });
    });
    t.mock.method(plateModule, 'verifyResinHollowPlatePreparation', async (source, record, options) => {
      assert.ok(options.referenceCapability.ownedTestReference); return waitForCancellation(options);
    });
    const operation = f.service.sliceResinJob(f.job.id, { ...CONFIRMED, confirmedHollowPreparation: true, hollow: f.review, ...(phase === 'plate' ? { plate: { copies: 2, gapMm: 1, marginMm: 1 } } : {}) });
    const rejected = assert.rejects(operation, { code: 'PREPARATION_CANCELLED' });
    await reached;
    await f.service.controlJob(f.job.id, 'cancel'); await rejected;
    assert.equal(f.calls.length, 1); assert.ok(observed.length >= (phase === 'plate' ? 5 : 2));
    assert.ok(observed.every(signal => signal === observed[0] && signal.aborted));
    assert.equal(f.service.getJob(f.job.id).status, 'cancelled'); assert.equal(f.service.getJob(f.job.id).resinSlice, undefined); assert.deepEqual(f.service.getJob(f.job.id).runs, []);
  });
});

const prusaExecutable = path.resolve('.cache/prusa/PrusaSlicer-2.9.7/prusa-slicer-console.exe'), uvtoolsExecutable = path.resolve('.cache/uvtools/UVtoolsCmd.exe');
test('actual controlled hollow capture is accepted by the manager, replayed after restart and invalidated by current profile edits', { skip: process.env.QUICKPRINT_HOLLOW_SERVICE_NATIVE !== '1' || process.platform !== 'win32' || !sync.existsSync(prusaExecutable) || !sync.existsSync(uvtoolsExecutable) ? 'Set QUICKPRINT_HOLLOW_SERVICE_NATIVE=1 with the pinned Windows native providers.' : false, timeout: 600000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-hollow-service-native-')), profilePath = path.join(dataDir, 'profile.json'), presetPath = path.join(dataDir, 'profile.ini');
  const preset = expandedSlaPreset({ hollowing_enable: '0', supports_enable: '0', pad_enable: '0' });
  const profile = { schemaVersion: 1, printerId: 'owned-no-printer', printerModel: 'QuickPrint Test', material: 'Owned digital fixture', presetPath: 'profile.ini', expected: { resolutionX: 512, resolutionY: 512, displayWidthMm: 40, displayHeightMm: 40, machineZMm: 40, layerHeightMm: .1, mirrorX: false, mirrorY: false }, orientationCandidates: [{ x: 0, y: 0, z: 0 }], uvtoolsProperties: { MachineName: 'QuickPrint Test', LayerHeight: .1, ExposureTime: 2, BottomExposureTime: 20, BottomLayerCount: 5, BottomLiftHeight: 5, LiftHeight: 5, BottomLiftSpeed: 100, LiftSpeed: 100, RetractSpeed: 100, LightPWM: 255, BottomLightPWM: 255 } };
  await fs.writeFile(presetPath, preset); await fs.writeFile(profilePath, JSON.stringify(profile));
  let service = new QuickPrintService({ dataDir }); await service.init();
  t.after(async () => { await service.close(); const actual = await fs.realpath(dataDir); assert.equal(path.dirname(actual).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase()); assert.match(path.basename(actual), /^quickprint-hollow-service-native-/); await fs.rm(actual, { recursive: true, force: true }); });
  await service.updateSettings({ resinEngine: { prusaExecutable, uvtoolsExecutable, profilePath, timeoutMs: 900000 } });
  const job = await importTicket(service), sizing = { mode: 'dimension', axis: 'z', millimeters: 10 }, geometry = await service.planResinGeometry(job.id, { sizing }), loaded = await loadProfile(profilePath), hollow = choices(geometry.geometrySha256, loaded.profileSha256);
  const result = await service.sliceResinJob(job.id, { confirmedRequirements: true, confirmedSizing: true, sizing, confirmedHollowPreparation: true, hollow });
  assert.equal(result.resinSlice.hollowPreparation.finalAudit.disposition, 'conforming'); assert.equal(result.resinSlice.printReady, false); assert.equal(result.resinSlice.modelCopiesPerRun, 1); assert.equal(result.resinSlice.operatorReview.hollow.geometrySha256, geometry.geometrySha256);
  assert.equal((await service.getResinSliceDownload(job.id)).sha256, result.resinSlice.sha256); assert.equal(service._resinHollowVerifications.size, 1);
  await service.close(); service = new QuickPrintService({ dataDir }); await service.init(); assert.equal(service._resinHollowVerifications.size, 0);
  assert.equal((await service.getResinSliceDownload(job.id)).sha256, result.resinSlice.sha256); assert.equal(service._resinHollowVerifications.size, 1);
  await fs.appendFile(presetPath, '\n'); await assert.rejects(service.getResinSliceDownload(job.id), { code: 'RESIN_PROFILE_CHANGED' });
});
