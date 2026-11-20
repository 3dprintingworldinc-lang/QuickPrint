'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { prepareResinGeometry, measureResinGeometry, float32Tolerance } = require('../src/slicing/resin-geometry');
const repair = require('../src/slicing/resin-repair');
const { MODEL, CONFIRMED, hash, createProfile, makeSlice, importTicket, deferred } = require('./helpers/resin-slice');

const CONFIRM = { confirmedExactRepair: true };
function damagedModel() {
  const source = prepareResinGeometry(MODEL, { format: 'stl', units: 'mm', sizing: { mode: 'original' } }).stl;
  const bytes = Buffer.concat([source, source.subarray(84 + 4 * 50, 84 + 5 * 50)]); bytes.writeUInt32LE(13, 80);
  const first = Buffer.from(bytes.subarray(96, 108)); bytes.copy(bytes, 96, 108, 120); first.copy(bytes, 108);
  return bytes;
}
const DAMAGED = damagedModel();
async function fixture(t, { prepare, engine = makeSlice, adapter } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-repair-service-'));
  const settings = await createProfile(dataDir), calls = [], sliceCalls = [];
  const options = { dataDir, ...(adapter ? { adapters: () => adapter } : {}), resinRepair: { prepareResinRepair: input => { calls.push(input); return prepare ? prepare(input) : repair.prepareResinRepair(input); } }, resinEngine: { prepareResin: input => { sliceCalls.push(input); return engine(input); } } };
  let service = await new QuickPrintService(options).init(); await service.updateSettings({ resinEngine: settings });
  const f = { dataDir, settings, calls, sliceCalls, get service() { return service; }, imported: input => importTicket(service, { data: DAMAGED, ...input }),
    slice: (id, request = CONFIRMED) => service.sliceResinJob(id, { ...request, expectedGeometrySha256: service.getJob(id).resinRepair?.sha256 }),
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

test('exact repair requires explicit review and accepts no job-supplied paths or STEP geometry', async t => {
  const f = await fixture(t), job = await f.imported();
  for (const request of [{}, { confirmedExactRepair: false }, { ...CONFIRM, inputPath: job.inputPath }, { ...CONFIRM, outputDir: f.dataDir }, { ...CONFIRM, units: 'mm' }]) await assert.rejects(f.service.prepareResinRepairJob(job.id, request), { code: 'RESIN_REPAIR_REVIEW_REQUIRED' });
  const step = await f.imported({ fileName: 'source.step' });
  await assert.rejects(f.service.prepareResinRepairJob(step.id, CONFIRM), { code: 'RESIN_REPAIR_SOURCE_REQUIRED' });
  await assert.rejects(f.service.getResinRepairDownload(job.id), { code: 'RESIN_REPAIR_REQUIRED' });
  assert.equal(f.calls.length, 0); assert.equal(f.sliceCalls.length, 0);
  await assert.rejects(f.service.sliceResinJob(job.id, CONFIRMED), { code: 'RESIN_MESH_WINDING' });
  assert.equal(f.sliceCalls.length, 0, 'damaged raw input cannot reach the engine without explicit repair');
});

test('verified repair preserves the original ticket and exposes only a reviewable millimetre derivative', async t => {
  const f = await fixture(t), job = await f.imported(), fixed = await f.service.prepareResinRepairJob(job.id, CONFIRM);
  assert.equal(fixed.status, 'review'); assert.equal(fixed.artifact, undefined); assert.equal(fixed.resinSlice, undefined); assert.equal(fixed.runs.length, 0);
  assert.equal(fixed.resinRepair.sourceSha256, job.sha256); assert.equal(fixed.resinRepair.summary.sourceTriangleCount, 13); assert.equal(fixed.resinRepair.summary.outputTriangleCount, 12);
  assert.equal(fixed.resinRepair.summary.operations.removedExactDuplicateFaces, 1); assert.equal(fixed.resinRepair.summary.operations.reorientedUniqueFaces, 1);
  assert.equal(fixed.resinRepair.summary.operations.coordinatesMoved, 0); assert.equal(fixed.resinRepair.summary.operations.holesFilled, 0); assert.equal(fixed.resinRepair.summary.operations.uniqueTrianglesRemoved, 0);
  assert.equal(fixed.resinRepair.summary.solidCertified, false); assert.equal(fixed.resinRepair.operatorReview.exactRepair, true);
  assert.deepEqual(fixed.order, job.order); assert.deepEqual(await fs.readFile(job.inputPath), DAMAGED);
  assert.equal(fixed.resinRepair.proofFile.filePath, fixed.resinRepair.reportPath); assert.equal(fixed.resinRepair.faces, undefined);
  const state = await fs.readFile(path.join(f.dataDir, 'state.json')), calls = f.calls.length;
  const measured = await f.service.inspectResinGeometry(job.id), download = await f.service.getResinRepairDownload(job.id);
  assert.equal(measured.sourceSha256, job.sha256); assert.equal(measured.geometrySha256, fixed.resinRepair.sha256); assert.equal(measured.repaired, true);
  assert.equal(measured.repairPreparation.reportSha256, fixed.resinRepair.proofFile.sha256); assert.equal(measured.units, 'mm'); assert.equal(measured.unitScale, 1);
  assert.deepEqual(measured.sourceDimensionsMm, { x: 3, y: 3, z: 3 }); assert.deepEqual(measured.repairSummary, fixed.resinRepair.summary);
  assert.equal(hash(await fs.readFile(download.filePath)), download.sha256); assert.equal(download.fileName, 'repaired-unqualified.stl');
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'state.json')), state); assert.equal(f.calls.length, calls); assert.equal(f.sliceCalls.length, 0);
  await f.reopen(); assert.equal((await f.service.inspectResinGeometry(job.id)).geometrySha256, fixed.resinRepair.sha256);
});

test('repair precedes sizing and captured GOO retains the original source receipt across restart and production binding', async t => {
  const f = await fixture(t), job = await f.imported(), fixed = await f.service.prepareResinRepairJob(job.id, CONFIRM);
  const sliced = await f.slice(job.id, { confirmedRequirements: true, confirmedSizing: true, sizing: { mode: 'scale', factor: 2 } }), slice = sliced.resinSlice;
  assert.equal(f.sliceCalls[0].inputPath, fixed.resinRepair.filePath); assert.equal(f.sliceCalls[0].unitScale, 1);
  assert.equal(slice.sourceSha256, job.sha256); assert.equal(slice.repairedSourceSha256, fixed.resinRepair.sha256); assert.equal(slice.sizingPlan.sourceSha256, fixed.resinRepair.sha256);
  assert.equal(slice.sizingPlan.triangleCount, 12); assert.deepEqual(slice.sizingPlan.dimensionsMm, { x: 6, y: 6, z: 6 });
  assert.equal(slice.repairPreparation.sourceSha256, job.sha256); assert.equal(slice.repairPreparation.repairToolSha256, fixed.resinRepair.tool.executableSha256);
  assert.notEqual(slice.tool.executableSha256, slice.repairSliceTool.executableSha256); assert.equal(slice.operatorReview.exactRepair, true); assert.equal(slice.operatorReview.units, 'mm'); assert.equal(slice.operatorReview.ticketUnits, 'mm');
  const captured = receipt(sliced); assert.equal(captured.sourceSha256, job.sha256); assert.ok(await f.service._resinDispatchBindings(sliced, captured, captured.deviceFingerprint));
  assert.equal((await f.service.getResinSliceDownload(job.id)).sha256, slice.sha256);
  await f.reopen(); const current = f.service.getJob(job.id);
  assert.equal((await f.service.getResinSliceDownload(job.id)).sha256, slice.sha256); assert.ok(await f.service._resinDispatchBindings(current, captured, captured.deviceFingerprint));
  assert.deepEqual(await fs.readFile(job.inputPath), DAMAGED); assert.deepEqual(current.order, job.order); assert.equal(current.resinSlice.printReady, false); assert.equal(current.runs.length, 0);
});

test('declared inch and metre units normalize once before repair and later numeric sizing', async t => {
  const f = await fixture(t);
  for (const [units, scale] of [['in', 25.4], ['m', 1000]]) {
    const job = await f.imported({ units }), fixed = await f.service.prepareResinRepairJob(job.id, CONFIRM), measured = await f.service.inspectResinGeometry(job.id);
    assert.equal(fixed.resinRepair.sourceUnits, units); assert.equal(fixed.resinRepair.normalizationPlan.unitScale, scale); assert.equal(measured.ticketUnits, units); assert.equal(measured.units, 'mm');
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(measured.sourceDimensionsMm[axis] - 3 * scale) <= float32Tolerance(3 * scale));
    const slice = (await f.slice(job.id, { confirmedRequirements: true, confirmedSizing: true, sizing: { mode: 'dimension', axis: 'z', millimeters: 6 } })).resinSlice;
    assert.equal(f.sliceCalls.at(-1).unitScale, 1); assert.equal(slice.operatorReview.ticketUnits, units); assert.equal(slice.operatorReview.units, 'mm');
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(slice.sizingPlan.dimensionsMm[axis] - 6) <= float32Tolerance(6));
    assert.deepEqual(await fs.readFile(job.inputPath), DAMAGED);
  }
});

test('a repaired mesh requires its freshly reviewed geometry hash before any slicing work', async t => {
  const f = await fixture(t), job = await f.imported(); await f.service.prepareResinRepairJob(job.id, CONFIRM);
  for (const request of [CONFIRMED, { ...CONFIRMED, expectedGeometrySha256: '0'.repeat(64) }]) await assert.rejects(f.service.sliceResinJob(job.id, request), { code: 'RESIN_REPAIR_REVIEW_STALE' });
  assert.equal(f.sliceCalls.length, 0); await assert.rejects(fs.stat(path.join(f.dataDir, 'jobs', job.id, 'resin-slicing')), { code: 'ENOENT' });
});

test('repair tool qualification remains stable across source-specific repair plans', async t => {
  const f = await fixture(t), hashes = [];
  for (const data of [DAMAGED, MODEL]) { const job = await f.imported({ data }); await f.service.prepareResinRepairJob(job.id, CONFIRM); hashes.push((await f.slice(job.id)).resinSlice.tool.executableSha256); }
  assert.equal(hashes[0], hashes[1]);
});

test('a repaired original-source receipt can obtain a qualified permit and changed repair proof blocks transfer', async t => {
  const { fingerprintSDCPDevice } = require('../src/adapters/sdcp-identity');
  const attributes = { MainboardID: '0123456789abcdef', BrandName: 'ELEGOO', MachineName: 'Synthetic SDCP model', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'V1.5.6', Resolution: '4x2', XYZsize: '41x21x30', Capabilities: ['FILE_TRANSFER', 'PRINT_CONTROL'], SupportFileType: ['GOO'] };
  const hardware = [];
  const adapter = { capabilities: { upload: true, start: true, formats: ['goo'] }, attributes: async () => ({ ...attributes, observedAt: new Date().toISOString() }), status: async () => ({ state: 'idle', observedAt: new Date().toISOString() }), upload: async () => { hardware.push('upload'); throw new Error('Unexpected transfer'); }, start: async () => { hardware.push('start'); throw new Error('Unexpected start'); }, close: async () => {} };
  const f = await fixture(t, { adapter }); await f.service.updateSettings({ resinEngine: { dispatchEnabled: true } });
  const printer = await f.service.savePrinter({ name: 'Synthetic target', type: 'sdcp', host: 'printer-fixture.invalid', mainboardId: attributes.MainboardID, brandId: 'a'.repeat(32), model: 'QuickPrint Test' });
  const profile = JSON.parse(await fs.readFile(f.settings.profilePath)); profile.printerId = printer.id; await fs.writeFile(f.settings.profilePath, JSON.stringify(profile));
  const job = await f.imported({ project: { quantity: 2 } }); await f.service.prepareResinRepairJob(job.id, CONFIRM); const sliced = await f.slice(job.id), captured = receipt(sliced);
  const deviceFingerprint = fingerprintSDCPDevice(printer, attributes); captured.deviceFingerprint = deviceFingerprint;
  const checkedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 30000).toISOString();
  const ticket = { id: job.order.portalJobId, version: 10, status: 'queued', ticketFingerprint: job.order.ticketFingerprint, ticket: { specifications: { project: { quantity: 2 }, production: { printType: 'resin' }, file: { units: 'mm', sizeBytes: job.bytes, name: 'source.stl', format: 'stl' } } }, production: { progress: { requestedParts: 2, printedParts: 0, remainingParts: 2, completedRuns: 0, failedRuns: 0 }, approvedReceiptId: captured.id } };
  const authorization = { qualified: true, checkedAt, expiresAt, jobVersion: 10, ticketFingerprint: job.order.ticketFingerprint, receiptId: captured.id, sourceSha256: job.sha256, artifactSha256: captured.artifact.sha256, profileSha256: captured.profileSha256, engineSha256: captured.tool.executableSha256, printerId: printer.id, printerModel: captured.printerModel, material: captured.material, format: 'goo', deviceFingerprint, partsPerRun: 1, plannedParts: 1, remainingParts: 2, qualificationFingerprint: 'f'.repeat(64) };
  const issuer = f.service.createResinPermitIssuer({ reauthorize: async () => ({ ticket, receipt: captured, authorization }) });
  await f.service.reviewResinProductionPlan(issuer, job.id, { receipt: captured, deviceFingerprint, confirmedWholeModel: true });
  const permit = await f.service.issueResinDispatchPermit(issuer, job.id, { printerId: printer.id, receipt: captured, ticket, authorization, deviceFingerprint, observedAt: checkedAt });
  assert.ok(permit.permitId); assert.deepEqual(hardware, []); assert.equal(captured.sourceSha256, job.sha256);
  await fs.appendFile(sliced.resinRepair.proofFile.filePath, 'changed');
  await assert.rejects(f.service.dispatchQualifiedResinJob(job.id, { permitId: permit.permitId, confirmedReady: true }), { code: 'RESIN_REPAIR_CHANGED' });
  assert.deepEqual(hardware, []); assert.equal(f.service.getJob(job.id).runs.length, 0);
});

test('new repair clears stale slices and permits but cannot replace pending or approved preparation', async t => {
  const f = await fixture(t), job = await f.imported(); await f.service.prepareResinRepairJob(job.id, CONFIRM); await f.slice(job.id);
  f.service._resinDispatchPermits.set('fixture', { id: job.id }); await f.service.prepareResinRepairJob(job.id, CONFIRM);
  assert.equal(f.service.getJob(job.id).resinSlice, undefined); assert.equal(f.service._resinDispatchPermits.size, 0);
  const count = f.calls.length;
  for (const approvalState of ['pending', 'approved']) { f.service.state.jobs.find(item => item.id === job.id).resinProduction = { plan: { approvalState } }; await assert.rejects(f.service.prepareResinRepairJob(job.id, CONFIRM), { code: 'RESIN_APPROVAL_LOCKED' }); }
  assert.equal(f.calls.length, count);
});

test('changed original and malformed or outside repair records cannot become captured preparations', async t => {
  for (const kind of ['source-before', 'source-during', 'source-buffer', 'record', 'outside']) await t.test(kind, async child => {
    let job;
    const f = await fixture(child, { prepare: async input => { if (kind === 'source-buffer') input.source[0] ^= 1; const record = await repair.prepareResinRepair(input); if (kind === 'source-during') await fs.appendFile(job.inputPath, 'changed'); if (kind === 'record') record.proofSha256 = '0'.repeat(64); if (kind === 'outside') record.filePath = job.inputPath; return record; } });
    job = await f.imported(); if (kind === 'source-before') await fs.appendFile(job.inputPath, 'changed');
    await assert.rejects(f.service.prepareResinRepairJob(job.id, CONFIRM)); const current = f.service.getJob(job.id);
    assert.equal(current.resinRepair, undefined); assert.equal(current.resinSlice, undefined); assert.equal(current.status, 'review');
    if (kind === 'source-before') assert.equal(f.calls.length, 0);
  });
});

test('normalized source, full proof and repaired mesh are independently rechecked before every read and production binding', async t => {
  for (const kind of ['normalized', 'proof', 'output', 'resealed-output']) await t.test(kind, async child => {
    const f = await fixture(child), job = await f.imported(); await f.service.prepareResinRepairJob(job.id, CONFIRM); const sliced = await f.slice(job.id), captured = receipt(sliced);
    const record = f.service.state.jobs.find(item => item.id === job.id).resinRepair, target = kind === 'normalized' ? record.normalizedSource.filePath : kind === 'proof' ? record.proofFile.filePath : record.filePath;
    const bytes = await fs.readFile(target); bytes[kind.includes('output') ? 96 : 0] ^= 1; await fs.writeFile(target, bytes);
    if (kind === 'resealed-output') record.sha256 = hash(bytes);
    await assert.rejects(f.service.inspectResinGeometry(job.id)); await assert.rejects(f.service.getResinRepairDownload(job.id)); await assert.rejects(f.service.getResinSliceDownload(job.id));
    await assert.rejects(f.service._resinDispatchBindings(f.service.getJob(job.id), captured, captured.deviceFingerprint));
  });
});

test('changed repair bindings, raw provider, unit review and absent sizing evidence cannot authorize production', async t => {
  const f = await fixture(t), job = await f.imported(); await f.service.prepareResinRepairJob(job.id, CONFIRM); await f.slice(job.id);
  for (const alter of [slice => { slice.repairPreparation.meshSha256 = '0'.repeat(64); }, slice => { slice.repairSliceTool.executableSha256 = '0'.repeat(64); }, slice => { slice.repairedSourceSha256 = '0'.repeat(64); }, slice => { slice.operatorReview.exactRepair = false; }, slice => { slice.operatorReview.ticketUnits = 'in'; }, slice => { delete slice.sizingPlan; }]) {
    const current = structuredClone(f.service.getJob(job.id)); alter(current.resinSlice); const captured = receipt(current);
    await assert.rejects(f.service._resinDispatchBindings(current, captured, captured.deviceFingerprint), { code: current.resinSlice.sizingPlan ? 'RESIN_REPAIR_CHANGED' : 'RESIN_REPAIR_REQUIRED' });
  }
});

test('raw mesh and CAD branches cannot adopt unrelated repair evidence or slicer-supplied derivatives', async t => {
  const f = await fixture(t, { engine: async input => ({ ...await makeSlice(input), repairPreparation: { method: 'forged' } }) });
  const job = await f.imported({ data: MODEL }); await assert.rejects(f.service.sliceResinJob(job.id, CONFIRMED), { code: 'INVALID_RESIN_OUTPUT' });
  const clean = await fixture(t), raw = await clean.imported({ data: MODEL }), sliced = await clean.service.sliceResinJob(raw.id, CONFIRMED);
  sliced.resinSlice.repairPreparation = { method: 'forged' }; const captured = receipt(sliced);
  await assert.rejects(clean.service._resinDispatchBindings(sliced, captured, captured.deviceFingerprint), { code: 'RESIN_REPAIR_CHANGED' });
  const step = await clean.imported({ fileName: 'source.step' }); clean.service.state.jobs.find(item => item.id === step.id).resinRepair = { method: 'forged' };
  await assert.rejects(clean.service.inspectResinGeometry(step.id), { code: 'RESIN_REPAIR_CHANGED' });
});

test('managed repair directories reject links before work', async t => {
  const f = await fixture(t), job = await f.imported(), outside = path.join(f.dataDir, 'outside-repair'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.dataDir, 'jobs', job.id, 'resin-repair'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.prepareResinRepairJob(job.id, CONFIRM), { code: 'RESIN_REPAIR_CHANGED' }); assert.equal(f.calls.length, 0);
});

test('queued repair cancellation persists immediately and preserves the following shared engine gate', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, { prepare: async input => { if (++calls === 1) { entered.resolve(); await release.promise; } return repair.prepareResinRepair(input); } });
  const one = await f.imported(), two = await f.imported(), three = await f.imported();
  const active = f.service.prepareResinRepairJob(one.id, CONFIRM); await entered.promise;
  const queued = f.service.prepareResinRepairJob(two.id, CONFIRM), rejected = assert.rejects(queued, { code: 'PREPARATION_CANCELLED' }), following = f.service.prepareResinRepairJob(three.id, CONFIRM);
  try { await assert.rejects(f.service.prepareResinRepairJob(two.id, CONFIRM), { code: 'JOB_BUSY' }); assert.equal((await f.service.controlJob(two.id, 'cancel')).status, 'cancelled'); assert.equal(calls, 1); assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'))).jobs.find(job => job.id === two.id).status, 'cancelled'); } finally { release.resolve(); }
  await Promise.all([active, rejected, following]); assert.equal(calls, 2); assert.equal(f.service.getJob(two.id).resinRepair, undefined);
});

for (const trigger of ['operator', 'shutdown']) test(`active repair ${trigger} cancellation clears capture and pending preparation markers`, async t => {
  const entered = deferred();
  const f = await fixture(t, { prepare: input => new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }); entered.resolve(); }) });
  const job = await f.imported(), pending = f.service.prepareResinRepairJob(job.id, CONFIRM), rejected = assert.rejects(pending, { code: trigger === 'operator' ? 'PREPARATION_CANCELLED' : 'PREPARATION_SHUTDOWN' }); await entered.promise;
  if (trigger === 'operator') await f.service.controlJob(job.id, 'cancel'); else await f.service.close(); await rejected;
  assert.equal(f.service._preparations.size, 0); assert.equal(f.service._pendingPreparations.size, 0);
  await f.reopen(); const current = f.service.getJob(job.id); assert.equal(current.resinRepair, undefined); assert.equal(current.status, trigger === 'operator' ? 'cancelled' : 'review');
});
