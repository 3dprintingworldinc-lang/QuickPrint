'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const client = require('../src/connectors/layr-production-client');
const { QuickPrintService } = require('../src/core/service');
const { fingerprintSDCPDevice } = require('../src/adapters/sdcp-identity');
const { createPlateSliceFixture } = require('./helpers/resin-plate-slice');
const { MODEL, CONFIRMED } = require('./helpers/resin-slice');

const ORIGIN = 'https://printbylayr.example';
function originalTicket() {
  const id = randomUUID(), progress = { requestedParts: 8, printedParts: 6, remainingParts: 2, completedRuns: 1, failedRuns: 0 };
  return { id, version: 9, reference: 'PBL-PARTIAL', status: 'preparing', ticketFingerprint: 'a'.repeat(64),
    ticket: { specifications: { project: { quantity: 8 }, production: { printType: 'resin' }, file: { name: 'owned.stl', format: 'stl', sizeBytes: MODEL.length, units: 'mm' } } },
    production: { target: { id, kind: 'order', cycle: 0, requiredParts: 8, authorizedAt: '2026-11-19T12:00:00.000Z', qcOperationId: null }, targetHistory: [],
      progress, totals: { printedParts: 6, completedRuns: 1, failedRuns: 0 } } };
}
const submission = order => ({ source: `layr:${ORIGIN}`, sourceId: `${order.portalJobId}:${order.ticketFingerprint}`, order, files: [{ name: 'owned.stl', data: MODEL }] });

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'quickprint-import-progress-')), packed = await createPlateSliceFixture(dataDir);
  const adapter = { calls: [], attrs: { MainboardID: '0123456789abcdef', BrandName: 'ELEGOO', MachineName: 'Owned progress fixture', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'V1.5.6', Resolution: '64x32', XYZsize: '40x20x30', Capabilities: ['FILE_TRANSFER','PRINT_CONTROL'], SupportFileType: ['GOO'] },
    async attributes() { this.calls.push('attributes'); return this.attrs; }, async status() { this.calls.push('status'); return { state: 'idle', observedAt: new Date().toISOString() }; },
    async upload() { this.calls.push('upload'); throw new Error('No physical mutations in import tests'); }, async start() { this.calls.push('start'); throw new Error('No physical mutations in import tests'); }, async close() {} };
  const options = { dataDir, resinEngine: packed.engine, adapters: () => adapter };
  let service = await new QuickPrintService(options).init();
  await service.updateSettings({ resinEngine: { ...packed.settings, dispatchEnabled: true } });
  const printer = await service.savePrinter({ name: 'Owned progress fixture', type: 'sdcp', host: 'progress.invalid', mainboardId: adapter.attrs.MainboardID, brandId: 'b'.repeat(32), model: 'QuickPrint Test' });
  await packed.bindPrinter(printer.id);
  const f = { packed, adapter, printer, dataDir, get service() { return service; }, async reopen() { await service.close(); service = await new QuickPrintService(options).init(); } };
  t.after(async () => { await service.close(); await fs.rm(dataDir,{ recursive: true,force: true }); });
  return f;
}

test('fresh original-target import persists prior printed baseline, caps preparation and permits only the true two-unit remainder', async t => {
  const f = await fixture(t), ticket = originalTicket(), order = client.buildOrderMetadata(ticket,ORIGIN,MODEL);
  assert.deepEqual(order.productionSnapshot,{ portalJobId: ticket.id, portalVersion: ticket.version, ticketFingerprint: ticket.ticketFingerprint, target: ticket.production.target, progress: ticket.production.progress });
  ticket.production.progress.printedParts = 0;
  assert.equal(order.productionSnapshot.progress.printedParts,6,'the import snapshot is not a mutable portal object');
  const imported = (await f.service.submit(submission(order))).jobs[0], id = imported.id;
  assert.equal(imported.resinProduction.baselinePrintedParts,6); assert.equal(imported.resinProduction.printedParts,6); assert.equal(imported.resinProduction.remainingParts,2);
  assert.equal(imported.resinProduction.localPrintedParts,0); assert.equal(imported.resinProduction.lifetimeLocalPrintedParts,0); assert.equal(imported.resinProduction.targetVerified,true);
  assert.equal(imported.acceptedQuantity,0); assert.deepEqual(imported.runs,[]);
  await assert.rejects(f.service.sliceResinJob(id,{ ...CONFIRMED,plate: { copies: 6,gapMm: 1,marginMm: 1 } }),{ code: 'QUANTITY_EXCEEDED' });
  assert.equal(f.packed.calls.length,0);
  const captured = await f.service.sliceResinJob(id,{ ...CONFIRMED,plate: { copies: 2,gapMm: 1,marginMm: 1 } });
  assert.equal(captured.resinSlice.modelCopiesPerRun,2);
  await f.reopen();
  const reloaded = f.service.getJob(id), slice = reloaded.resinSlice;
  assert.equal(reloaded.resinProduction.baselinePrintedParts,6); assert.equal(reloaded.resinProduction.printedParts,6); assert.equal(reloaded.resinProduction.remainingParts,2);
  assert.deepEqual(await fs.readFile(reloaded.inputPath),MODEL);
  const deviceFingerprint = fingerprintSDCPDevice(f.printer,f.adapter.attrs), receipt = { id: randomUUID(),kind: 'slice',jobId: order.portalJobId,ticketFingerprint: order.ticketFingerprint,sourceSha256: reloaded.sha256,profileSha256: slice.profileSha256,tool: slice.tool,printerId: f.printer.id,printerModel: slice.printerModel,material: slice.material,artifact: { sha256: slice.sha256,sizeBytes: slice.bytes,format: 'goo' },partsPerRun: 2,deviceFingerprint,printReady: false };
  const preparing = originalTicket(); preparing.id = order.portalJobId; preparing.ticketFingerprint = order.ticketFingerprint; preparing.production.target = structuredClone(order.productionSnapshot.target);
  const issuer = f.service.createResinPermitIssuer({ reauthorize: async () => { throw new Error('No dispatch in import tests'); } });
  await f.service.reviewResinProductionPlan(issuer,id,{ receipt,deviceFingerprint,confirmedWholeModel: true,ticket: preparing });
  const queued = structuredClone(preparing); queued.status = 'queued'; queued.version++; queued.production.approvedReceiptId = receipt.id; queued.production.approvedTargetId = queued.production.target.id;
  const proof = () => ({ ticket: structuredClone(queued),receipt: structuredClone(receipt),authorization: { qualified: true,checkedAt: new Date().toISOString(),expiresAt: new Date(Date.now()+30000).toISOString(),jobVersion: queued.version,ticketFingerprint: order.ticketFingerprint,receiptId: receipt.id,sourceSha256: receipt.sourceSha256,artifactSha256: receipt.artifact.sha256,profileSha256: receipt.profileSha256,engineSha256: receipt.tool.executableSha256,printerId: receipt.printerId,printerModel: receipt.printerModel,material: receipt.material,format: 'goo',deviceFingerprint,partsPerRun: 2,plannedParts: 2,remainingParts: 2,qualificationFingerprint: 'f'.repeat(64),targetId: queued.production.target.id,targetKind: 'order',targetCycle: 0,targetParts: 8 } });
  const permit = value => f.service.issueResinDispatchPermit(issuer,id,{ ...value,printerId: f.printer.id,deviceFingerprint,observedAt: new Date().toISOString() });
  const stale = proof(); stale.ticket.production.progress.printedParts = 5; stale.ticket.production.progress.remainingParts = 3; stale.authorization.remainingParts = 3;
  await assert.rejects(permit(stale),{ code: 'RESIN_PORTAL_PROGRESS_UNCONFIRMED' });
  assert.ok((await permit(proof())).permitId);
  assert.equal(f.service.getJob(id).resinProduction.baselinePrintedParts,6);
  assert.equal(f.service.getJob(id).acceptedQuantity,0); assert.deepEqual(f.service.getJob(id).runs,[]);
  assert.equal(f.adapter.calls.includes('upload'),false); assert.equal(f.adapter.calls.includes('start'),false);
});

test('duplicate production import cannot refresh or overwrite an existing baseline, target, slice or run history', async t => {
  const f = await fixture(t), ticket = originalTicket(), first = client.buildOrderMetadata(ticket,ORIGIN,MODEL);
  const job = (await f.service.submit(submission(first))).jobs[0];
  await f.service.sliceResinJob(job.id,{ ...CONFIRMED,plate: { copies: 2,gapMm: 1,marginMm: 1 } });
  const before = f.service.getJob(job.id);
  ticket.version++; ticket.production.progress = { requestedParts: 8,printedParts: 7,remainingParts: 1,completedRuns: 2,failedRuns: 0 }; ticket.production.totals = { printedParts: 7,completedRuns: 2,failedRuns: 0 };
  const duplicate = await f.service.submit(submission(client.buildOrderMetadata(ticket,ORIGIN,MODEL)));
  assert.equal(duplicate.duplicate,true); assert.deepEqual(duplicate.jobs[0],before); assert.deepEqual(f.service.getJob(job.id),before);
});

test('malformed or replacement import snapshots are rejected before creating a job or model file', async t => {
  const f = await fixture(t), order = client.buildOrderMetadata(originalTicket(),ORIGIN,MODEL);
  for (const change of [
    snapshot => { snapshot.portalJobId = randomUUID(); }, snapshot => { snapshot.portalVersion--; }, snapshot => { snapshot.ticketFingerprint = '0'.repeat(64); },
    snapshot => { snapshot.target.id = randomUUID(); }, snapshot => { snapshot.target.kind = 'replacement'; snapshot.target.cycle = 1; snapshot.target.qcOperationId = snapshot.target.id; },
    snapshot => { snapshot.target.requiredParts = 2; }, snapshot => { snapshot.target.authorizedAt = 'not-a-date'; }, snapshot => { delete snapshot.target.qcOperationId; },
    snapshot => { snapshot.progress.requestedParts = 7; }, snapshot => { snapshot.progress.printedParts = '6'; }, snapshot => { snapshot.progress.printedParts = -1; }, snapshot => { snapshot.progress.printedParts = 9; },
    snapshot => { snapshot.progress.remainingParts = 3; }, snapshot => { snapshot.progress.failedRuns = -1; }, snapshot => { snapshot.progress.completedRuns = 0.5; },
    snapshot => { snapshot.progress.acceptedParts = 6; }, snapshot => { snapshot.qualified = true; },
  ]) {
    const invalid = structuredClone(order); change(invalid.productionSnapshot);
    await assert.rejects(f.service.submit(submission(invalid)),{ code: 'INVALID_PRODUCTION_SNAPSHOT' });
    assert.equal(f.service.state.jobs.length,0);
  }
  const jobs = await fs.readdir(path.join(f.dataDir,'jobs')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(jobs,[]); assert.equal(f.packed.calls.length,0); assert.deepEqual(f.adapter.calls,[]);
});

test('legacy metadata stays compatible and replacement portal projections do not silently adopt a target', async t => {
  const f = await fixture(t), original = originalTicket(), legacy = structuredClone(original); delete legacy.production;
  const legacyOrder = client.buildOrderMetadata(legacy,ORIGIN,MODEL); assert.equal(legacyOrder.productionSnapshot,undefined);
  const legacyJob = (await f.service.submit(submission(legacyOrder))).jobs[0]; assert.equal(legacyJob.resinProduction,undefined);
  const replacement = originalTicket(), previous = { ...replacement.production.target,progress: structuredClone(replacement.production.progress) };
  replacement.production.target = { id: randomUUID(),kind: 'replacement',cycle: 1,requiredParts: 2,authorizedAt: '2026-11-19T13:00:00.000Z',qcOperationId: null }; replacement.production.target.qcOperationId = replacement.production.target.id;
  replacement.production.targetHistory = [previous]; replacement.production.progress = { requestedParts: 2,printedParts: 0,remainingParts: 2,completedRuns: 0,failedRuns: 0 };
  const metadata = client.buildOrderMetadata(replacement,ORIGIN,MODEL); assert.equal(metadata.productionSnapshot,undefined);
  const job = (await f.service.submit(submission(metadata))).jobs[0]; assert.equal(job.resinProduction,undefined); assert.deepEqual(job.runs,[]);
  const malformed = originalTicket(); malformed.production.progress.remainingParts = 3;
  assert.throws(() => client.buildOrderMetadata(malformed,ORIGIN,MODEL),/inconsistent production quantities/);
});
