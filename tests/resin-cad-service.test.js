'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { buildOrderMetadata } = require('../src/connectors/layr-client');
const { createCadFixture, STEP, hash, boxTriangles } = require('./helpers/resin-cad');
const { CONFIRMED, createProfile, makeSlice, importTicket, deferred } = require('./helpers/resin-slice');

const CAD_CONFIRM = { confirmedEmbeddedUnits: true };
async function importStep(service, { units = 'mm', extension = 'step' } = {}) {
  const id = randomUUID(), portalUrl = 'https://printbylayr.example';
  const portalJob = { id, reference: `PBL-${id.toUpperCase()}`, version: 5, status: 'preparing', payment: { amountCents: 2000, confirmedAt: '2026-11-19T15:00:00Z' },
    ticket: { model: { size: STEP.length, fileId: 'private-cad-fixture' }, quote: { amountCents: 2000 }, specifications: {
      file: { name: `owned-source.${extension}`, format: extension, sizeBytes: STEP.length, units }, project: { name: 'Owned CAD fixture', quantity: 2 },
      production: { printType: 'resin', supports: 'allowed', qualityTier: 'standard', properties: 'standard', colour: 'grey' } } } };
  const order = buildOrderMetadata(portalJob, portalUrl, STEP);
  return (await service.submit({ source: `layr:${portalUrl}`, sourceId: `${id}:${order.ticketFingerprint}`, quantity: 1, order, files: [{ name: `owned-source.${extension}`, data: STEP }] })).jobs[0];
}

async function fixture(t, { prepare, engine = makeSlice } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-cad-service-'));
  const cad = await createCadFixture(dataDir), settings = await createProfile(dataDir), calls = [], sliceCalls = [];
  const options = { dataDir, resinCad: { prepareResinCad: input => { calls.push(input); return prepare ? prepare(input, cad) : cad.prepare(input); } },
    resinEngine: { prepareResin: input => { sliceCalls.push(input); return engine(input); } } };
  let service = await new QuickPrintService(options).init();
  await service.updateSettings({ resinEngine: { ...settings, freecadExecutable: cad.options.freecadExecutable, cadAuditPath: cad.options.cadAuditPath } });
  const f = { dataDir, cad, settings, calls, sliceCalls, get service() { return service; }, imported: input => importStep(service, input),
    slice: (id, request = CONFIRMED) => service.sliceResinJob(id, { ...request, expectedGeometrySha256: service.getJob(id).resinCad?.sha256 }),
    async reopen() { await service.close(); service = await new QuickPrintService(options).init(); } };
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return f;
}

function receipt(job) {
  const slice = job.resinSlice;
  return { id: randomUUID(), kind: 'slice', jobId: job.order.portalJobId, ticketFingerprint: job.order.ticketFingerprint, sourceSha256: job.sha256,
    profileSha256: slice.profileSha256, tool: slice.tool, printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material,
    artifact: { sha256: slice.sha256, sizeBytes: slice.bytes, format: 'goo' }, partsPerRun: 1, deviceFingerprint: '6'.repeat(64), printReady: false };
}

test('CAD settings require configured absolute provider/runtime paths and bounded numeric tolerances', async t => {
  const f = await fixture(t);
  assert.equal(f.service.state.settings.resinEngine.cadLinearDeflectionMm, 0.005);
  assert.equal(f.service.state.settings.resinEngine.cadAngularDeflectionRad, 0.1);
  for (const resinEngine of [{ freecadExecutable: 'relative.exe' }, { cadAuditPath: 'relative' }, { cadLinearDeflectionMm: 0 }, { cadLinearDeflectionMm: '0.005' }, { cadLinearDeflectionMm: 0.2 }, { cadAngularDeflectionRad: NaN }, { cadAngularDeflectionRad: 0.001 }, { cadAngularDeflectionRad: 1 }]) await assert.rejects(f.service.updateSettings({ resinEngine }));
  await f.service.updateSettings({ resinEngine: { cadLinearDeflectionMm: 0.01, cadAngularDeflectionRad: 0.2 } });
  const job = await f.imported(); await f.service.prepareResinCadJob(job.id, CAD_CONFIRM);
  assert.equal(f.calls[0].linearDeflectionMm, 0.01); assert.equal(f.calls[0].angularDeflectionRad, 0.2);
});

test('conversion requires an explicit intrinsic-unit review and cannot receive job-supplied local paths', async t => {
  const f = await fixture(t), job = await f.imported();
  for (const request of [{}, { confirmedEmbeddedUnits: false }, { ...CAD_CONFIRM, inputPath: job.inputPath }, { ...CAD_CONFIRM, freecadExecutable: f.cad.options.freecadExecutable }]) await assert.rejects(f.service.prepareResinCadJob(job.id, request), { code: 'RESIN_CAD_REVIEW_REQUIRED' });
  const mesh = await importTicket(f.service); await assert.rejects(f.service.prepareResinCadJob(mesh.id, CAD_CONFIRM), { code: 'RESIN_CAD_SOURCE_REQUIRED' });
  await assert.rejects(f.service.inspectResinGeometry(job.id), { code: 'RESIN_CAD_REQUIRED' });
  await assert.rejects(f.service.sliceResinJob(job.id, CONFIRMED), { code: 'RESIN_CAD_REQUIRED' });
  assert.equal(f.calls.length, 0); assert.equal(f.sliceCalls.length, 0);
});

test('CAD conversion captures actual verified mesh evidence and preserves source, ticket and intrinsic millimetres', async t => {
  const f = await fixture(t), job = await f.imported({ units: 'in', extension: 'stp' });
  const converted = await f.service.prepareResinCadJob(job.id, CAD_CONFIRM);
  assert.equal(converted.status, 'review'); assert.equal(converted.resinSlice, undefined); assert.equal(converted.artifact, undefined);
  assert.equal(converted.resinCad.sourceSha256, job.sha256); assert.equal(converted.resinCad.cad.solidCount, 2); assert.equal(converted.resinCad.operatorReview.embeddedUnits, true); assert.equal(converted.resinCad.operatorReview.ticketUnits, 'in');
  assert.deepEqual(converted.order, job.order); assert.deepEqual(await fs.readFile(job.inputPath), STEP);
  const count = f.cad.calls.length, state = await fs.readFile(path.join(f.dataDir, 'state.json'));
  const measured = await f.service.inspectResinGeometry(job.id);
  assert.deepEqual(measured.sourceDimensionsMm, { x: 6, y: 4, z: 4 }); assert.equal(measured.units, 'mm'); assert.equal(measured.unitScale, 1);
  assert.equal(measured.sourceSha256, job.sha256); assert.equal(measured.geometrySha256, converted.resinCad.sha256); assert.equal(measured.embeddedUnits, true);
  assert.equal(f.cad.calls.length, count); assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'state.json')), state);
  await f.reopen(); assert.equal((await f.service.inspectResinGeometry(job.id)).geometrySha256, converted.resinCad.sha256);
});

test('STEP slicing uses only verified CAD millimetres and binds source, normalized input and composite tool evidence', async t => {
  const f = await fixture(t), job = await f.imported({ units: 'm' });
  const converted = await f.service.prepareResinCadJob(job.id, CAD_CONFIRM);
  const sliced = await f.slice(job.id, { confirmedRequirements: true, confirmedSizing: true, sizing: { mode: 'dimension', axis: 'x', millimeters: 12 } });
  const slice = sliced.resinSlice;
  assert.equal(f.sliceCalls[0].inputPath, converted.resinCad.filePath); assert.equal(f.sliceCalls[0].unitScale, 1);
  assert.equal(slice.sourceSha256, job.sha256); assert.equal(slice.meshSourceSha256, converted.resinCad.sha256); assert.equal(slice.sizingPlan.sourceSha256, converted.resinCad.sha256);
  assert.deepEqual(slice.sizingPlan.dimensionsMm, { x: 12, y: 8, z: 8 }); assert.equal(slice.operatorReview.units, 'mm'); assert.equal(slice.operatorReview.ticketUnits, 'm'); assert.equal(slice.operatorReview.embeddedUnits, true);
  assert.notEqual(slice.tool.executableSha256, slice.rawSliceTool.executableSha256); assert.equal(slice.cadPreparation.cadToolSha256, converted.resinCad.tool.executableSha256);
  const captured = receipt(sliced); assert.ok(await f.service._resinDispatchBindings(sliced, captured, captured.deviceFingerprint));
  assert.equal((await f.service.getResinSliceDownload(job.id)).sha256, slice.sha256);
  assert.deepEqual(await fs.readFile(job.inputPath), STEP); assert.deepEqual(sliced.order, job.order); assert.equal(slice.printReady, false);
});

test('STEP/STP slicing requires the exact reviewed geometry hash before any SLA work or output', async t => {
  const f = await fixture(t);
  for (const extension of ['step', 'stp']) {
    const job = await f.imported({ extension }); await f.service.prepareResinCadJob(job.id, CAD_CONFIRM);
    for (const request of [CONFIRMED, { ...CONFIRMED, expectedGeometrySha256: '0'.repeat(64) }]) {
      await assert.rejects(f.service.sliceResinJob(job.id, request), { code: 'RESIN_CAD_REVIEW_STALE', status: 409 });
    }
    assert.equal(f.service.getJob(job.id).resinSlice, undefined); assert.equal(f.sliceCalls.length, 0);
    await assert.rejects(fs.stat(path.join(f.dataDir, 'jobs', job.id, 'resin-slicing')), { code: 'ENOENT' });
  }
  const mesh = await importTicket(f.service);
  for (const expectedGeometrySha256 of [null, '', 'invalid', 'A'.repeat(64), 42, []]) {
    await assert.rejects(f.service.sliceResinJob(mesh.id, { ...CONFIRMED, expectedGeometrySha256 }), { code: 'INVALID_RESIN_SLICE_REQUEST', status: 400 });
  }
  assert.equal(f.sliceCalls.length, 0);
  assert.ok((await f.service.sliceResinJob(mesh.id, CONFIRMED)).resinSlice, 'legacy STL review needs no CAD hash');
});

test('a re-converted mesh with the same valid CAD inventory invalidates an older visible sizing confirmation', async t => {
  const f = await fixture(t), job = await f.imported();
  const first = await f.service.prepareResinCadJob(job.id, CAD_CONFIRM), displayed = await f.service.inspectResinGeometry(job.id);
  const oldRequest = { confirmedRequirements: true, confirmedSizing: true, sizing: { mode: 'dimension', axis: 'x', millimeters: 12 }, expectedGeometrySha256: displayed.geometrySha256 };
  f.cad.hooks.mutateReport = async (_report, context) => { await context.writeSolid(0, boxTriangles([0,0,0], [2,3,4]).reverse()); };
  const second = await f.service.prepareResinCadJob(job.id, CAD_CONFIRM);
  assert.deepEqual(second.resinCad.cad, first.resinCad.cad, 'the analytic solids, units, bounds and volumes are unchanged');
  assert.notEqual(second.resinCad.sha256, displayed.geometrySha256, 'a different valid triangle ordering changes the actual slicing input bytes');
  await assert.rejects(f.service.sliceResinJob(job.id, oldRequest), { code: 'RESIN_CAD_REVIEW_STALE', status: 409 });
  assert.equal(f.sliceCalls.length, 0); assert.equal(f.service.getJob(job.id).resinSlice, undefined);
  await assert.rejects(fs.stat(path.join(f.dataDir, 'jobs', job.id, 'resin-slicing')), { code: 'ENOENT' });
  const sliced = await f.service.sliceResinJob(job.id, { ...oldRequest, expectedGeometrySha256: second.resinCad.sha256 });
  assert.equal(f.sliceCalls.length, 1); assert.equal(sliced.resinSlice.meshSourceSha256, second.resinCad.sha256); assert.equal(sliced.resinSlice.cadPreparation.meshSha256, second.resinCad.sha256);
  assert.deepEqual(sliced.resinSlice.sizingPlan.dimensionsMm, { x: 12, y: 8, z: 8 }); assert.deepEqual(await fs.readFile(job.inputPath), STEP);
});

test('identical CAD and engine providers yield a stable composite tool fingerprint across separate orders', async t => {
  const f = await fixture(t), hashes = [];
  for (let index = 0; index < 2; index++) {
    const job = await f.imported(); await f.service.prepareResinCadJob(job.id, CAD_CONFIRM);
    hashes.push((await f.slice(job.id)).resinSlice.tool.executableSha256);
  }
  assert.equal(hashes[0], hashes[1]);
});

test('a preparation approval prevents replacement conversion and native work', async t => {
  const f = await fixture(t), job = await f.imported();
  for (const approvalState of ['pending', 'approved']) {
    f.service.state.jobs.find(item => item.id === job.id).resinProduction = { plan: { approvalState } };
    await assert.rejects(f.service.prepareResinCadJob(job.id, CAD_CONFIRM), { code: 'RESIN_APPROVAL_LOCKED' });
  }
  assert.equal(f.calls.length, 0);
});

test('source changes and malformed or outside CAD records cannot become captured conversions', async t => {
  for (const kind of ['source-before', 'source-during', 'record', 'outside']) await t.test(kind, async child => {
    const f = await fixture(child, { prepare: async (input, cad) => {
      const record = await cad.prepare(input);
      if (kind === 'source-during') await fs.appendFile(input.inputPath, 'changed');
      if (kind === 'record') record.reportSha256 = '0'.repeat(64);
      if (kind === 'outside') record.filePath = input.inputPath;
      return record;
    } });
    const job = await f.imported();
    if (kind === 'source-before') await fs.appendFile(job.inputPath, 'changed');
    await assert.rejects(f.service.prepareResinCadJob(job.id, CAD_CONFIRM));
    const current = f.service.getJob(job.id); assert.equal(current.resinCad, undefined); assert.equal(current.resinSlice, undefined); assert.equal(current.status, 'review');
    if (kind === 'source-before') assert.equal(f.calls.length, 0);
  });
});

test('saved CAD source, reports, per-solid meshes and combined mesh are rechecked before geometry, download and dispatch', async t => {
  for (const kind of ['source-copy', 'report', 'audit', 'solid', 'combined']) await t.test(kind, async child => {
    const f = await fixture(child), job = await f.imported(); await f.service.prepareResinCadJob(job.id, CAD_CONFIRM);
    const sliced = await f.slice(job.id), cad = sliced.resinCad, captured = receipt(sliced);
    const target = { 'source-copy': cad.sourceCopy, report: cad.reportPath, audit: cad.auditReportPath, solid: path.join(path.dirname(cad.reportPath), cad.solids[0].artifact.fileName), combined: cad.filePath }[kind];
    const bytes = await fs.readFile(target); bytes[0] ^= 1; await fs.writeFile(target, bytes);
    await assert.rejects(f.service.inspectResinGeometry(job.id)); await assert.rejects(f.service.getResinSliceDownload(job.id));
    await assert.rejects(f.service._resinDispatchBindings(sliced, captured, captured.deviceFingerprint));
  });
});

test('changed CAD proof, raw provider fingerprint or embedded-unit review invalidates qualified slice bindings', async t => {
  const f = await fixture(t), job = await f.imported(); await f.service.prepareResinCadJob(job.id, CAD_CONFIRM); await f.slice(job.id);
  for (const alter of [slice => { slice.cadPreparation.meshSha256 = '0'.repeat(64); }, slice => { slice.rawSliceTool.executableSha256 = '0'.repeat(64); }, slice => { slice.meshSourceSha256 = '0'.repeat(64); }, slice => { slice.operatorReview.embeddedUnits = false; }, slice => { delete slice.sizingPlan; }]) {
    const current = structuredClone(f.service.getJob(job.id)); alter(current.resinSlice); const captured = receipt(current);
    await assert.rejects(f.service._resinDispatchBindings(current, captured, captured.deviceFingerprint), { code: current.resinSlice.sizingPlan ? 'RESIN_CAD_CHANGED' : 'RESIN_CAD_REQUIRED' });
  }
});

test('conversion rejects managed CAD directory junctions and invalidates old slice and permits on a new conversion', async t => {
  const f = await fixture(t), job = await f.imported(); await f.service.prepareResinCadJob(job.id, CAD_CONFIRM); await f.slice(job.id);
  f.service._resinDispatchPermits.set('fixture', { id: job.id });
  await f.service.prepareResinCadJob(job.id, CAD_CONFIRM); assert.equal(f.service.getJob(job.id).resinSlice, undefined); assert.equal(f.service._resinDispatchPermits.size, 0);
  const other = await f.imported(), outside = path.join(f.dataDir, 'outside-cad'), cadPath = path.join(f.dataDir, 'jobs', other.id, 'resin-cad');
  await fs.mkdir(outside); await fs.symlink(outside, cadPath, process.platform === 'win32' ? 'junction' : 'dir');
  const count = f.calls.length; await assert.rejects(f.service.prepareResinCadJob(other.id, CAD_CONFIRM), { code: 'RESIN_CAD_CHANGED' }); assert.equal(f.calls.length, count);
});

test('queued CAD cancellation persists immediately and cannot start native work or release the following engine gate', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, { prepare: async (input, cad) => { calls++; if (calls === 1) { entered.resolve(); await release.promise; } return cad.prepare(input); } });
  const one = await f.imported(), two = await f.imported(), three = await f.imported();
  const active = f.service.prepareResinCadJob(one.id, CAD_CONFIRM); await entered.promise;
  const queued = f.service.prepareResinCadJob(two.id, CAD_CONFIRM), rejected = assert.rejects(queued, { code: 'PREPARATION_CANCELLED' });
  const following = f.service.prepareResinCadJob(three.id, CAD_CONFIRM);
  try {
    await assert.rejects(f.service.prepareResinCadJob(two.id, CAD_CONFIRM), { code: 'JOB_BUSY' });
    assert.equal((await f.service.controlJob(two.id, 'cancel')).status, 'cancelled'); assert.equal(calls, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'))).jobs.find(job => job.id === two.id).status, 'cancelled');
  } finally { release.resolve(); }
  await Promise.all([active, rejected, following]); assert.equal(calls, 2); assert.equal(f.service.getJob(two.id).resinCad, undefined);
});

for (const trigger of ['operator', 'shutdown']) test(`active CAD ${trigger} cancellation clears capture and all pending preparation markers`, async t => {
  const entered = deferred();
  const f = await fixture(t, { prepare: input => new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => reject(Object.assign(new Error('Native process aborted.'), { code: 'ABORTED' })), { once: true }); entered.resolve(); }) });
  const one = await f.imported(), two = await f.imported();
  const active = f.service.prepareResinCadJob(one.id, CAD_CONFIRM), rejected = assert.rejects(active, { code: trigger === 'operator' ? 'PREPARATION_CANCELLED' : 'PREPARATION_SHUTDOWN' }); await entered.promise;
  let queued;
  if (trigger === 'shutdown') queued = assert.rejects(f.service.prepareResinCadJob(two.id, CAD_CONFIRM), { code: 'NOT_READY' });
  if (trigger === 'operator') await f.service.controlJob(one.id, 'cancel'); else await f.service.close();
  await rejected; if (queued) await queued;
  assert.equal(f.service._preparations.size, 0); assert.equal(f.service._pendingPreparations.size, 0);
  await f.reopen(); const current = f.service.getJob(one.id); assert.equal(current.resinCad, undefined); assert.equal(current.status, trigger === 'operator' ? 'cancelled' : 'review');
});
