'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { fingerprintSDCPDevice } = require('../src/adapters/sdcp-identity');
const { createPlateSliceFixture } = require('./helpers/resin-plate-slice');
const { CONFIRMED, MODEL, importTicket } = require('./helpers/resin-slice');

const PLATE = { copies: 6, gapMm: 1, marginMm: 1 };
async function fixture(t, { capture = true, quantity = 20 } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'quickprint-plate-service-')), packed = await createPlateSliceFixture(dataDir);
  const adapter = { capabilities: { upload: true, start: true, formats: ['goo'] }, calls: [], telemetry: { state: 'idle' }, serial: 0,
    attrs: { MainboardID: '0123456789abcdef', BrandName: 'ELEGOO', MachineName: 'Owned packed fixture', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'V1.5.6', Resolution: '64x32', XYZsize: '40x20x30', Capabilities: ['FILE_TRANSFER','PRINT_CONTROL'], SupportFileType: ['GOO'] },
    async attributes() { this.calls.push('attributes'); return { ...this.attrs, observedAt: new Date().toISOString() }; },
    async status() { this.calls.push('status'); return { ...this.telemetry, observedAt: new Date().toISOString() }; },
    async upload(input) { this.calls.push('upload'); this.file = input.fileName; return { remotePath: input.fileName }; },
    async start() { this.calls.push('start'); this.remoteId = `owned-task-${++this.serial}`; this.telemetry = { state: 'printing',remoteId: this.remoteId,currentFile: this.file }; return { acknowledged: true,remoteId: this.remoteId,currentFile: this.file,observedAt: new Date().toISOString() }; },
    async close() {} };
  const options = { dataDir,adapters: () => adapter,resinEngine: packed.engine };
  let service = await new QuickPrintService(options).init(); await service.updateSettings({ resinEngine: { ...packed.settings,dispatchEnabled: true } });
  const printer = await service.savePrinter({ name: 'Owned packed fixture',type: 'sdcp',host: 'plate-fixture.invalid',mainboardId: adapter.attrs.MainboardID,brandId: 'a'.repeat(32),model: 'QuickPrint Test' }); await packed.bindPrinter(printer.id);
  const job = await importTicket(service,{ project: { quantity } }), deviceFingerprint = fingerprintSDCPDevice(printer,adapter.attrs);
  const f = { dataDir,packed,adapter,printer,job,deviceFingerprint,receipt: null,portalPrinted: 0,version: 10,portalStatus: 'preparing',remote: null,
    get service() { return service; },get issuer() { return issuer; },current: () => service.getJob(job.id),
    target: { id: job.order.portalJobId,kind: 'order',cycle: 0,requiredParts: quantity,authorizedAt: job.createdAt,qcOperationId: null },
    ticket(status = f.portalStatus) { return { id: job.order.portalJobId,ticketFingerprint: job.order.ticketFingerprint,version: f.version,status,
      ticket: { specifications: { project: { quantity },production: { printType: 'resin' } } },
      production: { target: structuredClone(f.target),approvedReceiptId: status === 'queued' ? f.receipt?.id : null,approvedTargetId: status === 'queued' ? f.target.id : null,run: structuredClone(f.remote),
        progress: { requestedParts: quantity,printedParts: f.portalPrinted,remainingParts: quantity-f.portalPrinted,completedRuns: f.adapter.serial,failedRuns: 0 } } }; },
    proof() { const ticket = f.ticket(),receipt = structuredClone(f.receipt),checkedAt = new Date().toISOString(); return { ticket,receipt,authorization: { qualified: true,checkedAt,expiresAt: new Date(Date.now()+30000).toISOString(),jobVersion: ticket.version,ticketFingerprint: receipt.ticketFingerprint,receiptId: receipt.id,sourceSha256: receipt.sourceSha256,artifactSha256: receipt.artifact.sha256,profileSha256: receipt.profileSha256,engineSha256: receipt.tool.executableSha256,printerId: receipt.printerId,printerModel: receipt.printerModel,material: receipt.material,format: 'goo',deviceFingerprint,partsPerRun: receipt.partsPerRun,plannedParts: receipt.partsPerRun,remainingParts: quantity-f.portalPrinted,qualificationFingerprint: 'f'.repeat(64),targetId: f.target.id,targetKind: f.target.kind,targetCycle: f.target.cycle,targetParts: quantity } }; },
    async capture(plate = PLATE) { const result = await service.sliceResinJob(job.id,{ ...CONFIRMED,plate }); const slice = result.resinSlice; f.receipt = { id: randomUUID(),kind: 'slice',jobId: job.order.portalJobId,ticketFingerprint: job.order.ticketFingerprint,sourceSha256: job.sha256,profileSha256: slice.profileSha256,tool: slice.tool,printerId: slice.printerId,printerModel: slice.printerModel,material: slice.material,artifact: { sha256: slice.sha256,sizeBytes: slice.bytes,format: 'goo' },partsPerRun: slice.modelCopiesPerRun,deviceFingerprint,printReady: false }; return result; },
    async plan() { const result = await service.reviewResinProductionPlan(issuer,job.id,{ receipt: f.receipt,deviceFingerprint,confirmedWholeModel: true,ticket: f.ticket('preparing') }); f.portalStatus = 'queued'; f.version++; return result; },
    permit: (proof = f.proof()) => service.issueResinDispatchPermit(issuer,job.id,{ ...proof,printerId: printer.id,deviceFingerprint,observedAt: new Date().toISOString() }),
    async dispatch() { return service.dispatchQualifiedResinJob(job.id,{ permitId: (await f.permit()).permitId,confirmedReady: true }); },
    async finish(printedParts,confirm = true) { const run = f.current().runs.at(-1); adapter.telemetry = { state: 'idle',remoteId: run.remoteId,currentFile: run.remotePath,outcome: 'completed' }; await service.testPrinter(printer.id); const result = await service.reconcileResinRun(job.id,{ runId: run.id,outcome: 'completed',printedParts }); if (confirm) f.confirm(result.runs.at(-1)); return result; },
    confirm(run) { f.portalPrinted += run.printedParts; f.version += 2; f.remote = { runId: run.id,targetId: run.targetId,receiptId: run.receiptId,artifactSha256: run.artifactSha256,remoteId: run.remoteId,printerId: run.printerId,deviceFingerprint: run.deviceFingerprint,plannedParts: run.plannedParts,printedParts: run.printedParts,status: 'completed',startedAt: run.startEvidence.observedAt,finishedAt: run.terminalEvidence.observedAt }; const remaining = quantity-f.portalPrinted; f.portalStatus = remaining === 0 ? 'post_processing' : remaining < run.plannedParts ? 'preparing' : 'queued'; },
    remainder: (ticket = f.ticket(),runId = f.current().runs.at(-1).id) => service.applyResinPlateRemainder(issuer,job.id,{ ticket,runId,observedAt: new Date().toISOString() }),
    async reopen() { await service.close(); service = await new QuickPrintService(options).init(); issuer = makeIssuer(); },
  };
  const makeIssuer = () => service.createResinPermitIssuer({ reauthorize: async () => f.proof() }); let issuer = makeIssuer();
  t.after(async () => { await service.close(); await fs.rm(dataDir,{ recursive: true,force: true }); });
  if (capture) await f.capture(); return f;
}
const mutations = f => f.adapter.calls.filter(action => ['upload','start'].includes(action));

test('capture independently verifies requested plate, actual source instances and full raster evidence without granting QC credit', async t => {
  const f = await fixture(t), current = f.current(), slice = current.resinSlice;
  assert.equal(slice.modelCopiesPerRun,6); assert.deepEqual(slice.operatorReview.plate,PLATE); assert.equal(slice.platePreparation.layout.copiesPlaced,6);
  assert.equal(slice.platePreparation.rasterProof.copiesPerRun,6); assert.equal(slice.platePreparation.artifactSha256,slice.sha256);
  assert.equal((await f.service.getResinSliceDownload(f.job.id)).sha256,slice.sha256);
  await f.plan(); const bindings = await f.service._resinDispatchBindings(f.current(),f.receipt,f.deviceFingerprint); assert.equal(bindings.partsPerRun,6);
  assert.equal(current.quantity,1); assert.equal(current.acceptedQuantity,0); assert.equal(slice.printReady,false); assert.equal(current.resinProduction?.printedParts || 0,0);
  assert.deepEqual(await fs.readFile(f.job.inputPath),MODEL); assert.deepEqual(mutations(f),[]);
});

test('plate policy is strictly bounded by numeric fields and the current target remainder before rendering', async t => {
  const f = await fixture(t,{ capture: false });
  for (const plate of [null,{}, { ...PLATE,copies: 0 },{ ...PLATE,copies: 501 },{ ...PLATE,copies: '6' },{ ...PLATE,gapMm: -1 },{ ...PLATE,marginMm: 0.5 },{ ...PLATE,supportEnvelopeMm: 1 }]) await assert.rejects(f.service.sliceResinJob(f.job.id,{ ...CONFIRMED,plate }),{ code: 'RESIN_PLATE_REQUEST_INVALID' });
  await assert.rejects(f.service.sliceResinJob(f.job.id,{ ...CONFIRMED,plate: { ...PLATE,copies: 21 } }),{ code: 'QUANTITY_EXCEEDED' });
  assert.equal(f.packed.calls.length,0); assert.equal(f.current().resinSlice,undefined);
});

test('a capacity-limited artifact binds the actual verified count rather than the larger requested order count', async t => {
  const f = await fixture(t,{ capture: false }), captured = await f.capture({ ...PLATE,copies: 20 }), slice = captured.resinSlice;
  assert.equal(slice.operatorReview.plate.copies,20); assert.ok(slice.modelCopiesPerRun > 0 && slice.modelCopiesPerRun < 20);
  assert.equal(slice.modelCopiesPerRun,slice.platePreparation.layout.copiesPlaced); assert.equal(slice.platePreparation.layout.remainingCopies,20-slice.modelCopiesPerRun);
  await f.plan(); const bindings = await f.service._resinDispatchBindings(f.current(),f.receipt,f.deviceFingerprint); assert.equal(bindings.partsPerRun,slice.modelCopiesPerRun);
  const started = await f.dispatch(); assert.equal(started.runs.at(-1).plannedParts,slice.modelCopiesPerRun); assert.notEqual(started.runs.at(-1).plannedParts,20);
});

test('claimed copy counts and omitted or incomplete raster proof cannot be captured', async t => {
  for (const fault of ['removeProof','claimedCopies','omitLastCopy']) {
    const f = await fixture(t,{ capture: false }); f.packed.faults[fault] = fault === 'claimedCopies' ? 1 : true;
    await assert.rejects(f.capture()); assert.equal(f.current().resinSlice,undefined); assert.equal(f.current().resinProduction?.printedParts || 0,0); assert.deepEqual(mutations(f),[]);
  }
});

test('download and dispatch recheck actual normalized source, reference GOO, shared 3MF and canonical layout proof', async t => {
  for (const kind of ['source','reference','3mf','layout']) {
    const f = await fixture(t); await f.plan(); const slice = f.current().resinSlice, proof = slice.platePreparation;
    if (kind === 'layout') await f.service._mutate(() => { const current = f.service._job(f.job.id).resinSlice; current.platePreparation = structuredClone(current.platePreparation); current.platePreparation.layout.placements[0].offsetMm.x++; });
    else { const filename = kind === 'source' ? slice.inputGeometry.filePath : kind === 'reference' ? proof.reference.filePath : proof.plateInput.filePath; const bytes = await fs.readFile(filename); bytes[0] ^= 1; await fs.writeFile(filename,bytes); }
    await assert.rejects(f.service.getResinSliceDownload(f.job.id)); await assert.rejects(f.permit()); assert.deepEqual(mutations(f),[]);
  }
});

test('receipt, fresh authorization and remaining production must identify the exact verified plate count', async t => {
  const f = await fixture(t); await f.plan();
  let proof = f.proof(); proof.receipt.partsPerRun = 1; await assert.rejects(f.permit(proof),{ code: 'RESIN_RECEIPT_MISMATCH' });
  proof = f.proof(); proof.authorization.plannedParts = 5; await assert.rejects(f.permit(proof),{ code: 'RESIN_AUTHORIZATION_MISMATCH' });
  proof = f.proof(); proof.ticket.production.progress.printedParts = 15; proof.ticket.production.progress.remainingParts = 5; proof.authorization.remainingParts = 5;
  await assert.rejects(f.permit(proof),{ code: 'RESIN_AUTHORIZATION_MISMATCH' }); assert.deepEqual(mutations(f),[]);
});

test('20 units use three identified six-instance plates then a freshly reviewed two-instance remainder without QC credit', async t => {
  const f = await fixture(t); await f.plan();
  for (let index = 0; index < 3; index++) {
    const started = await f.dispatch(), run = started.runs.at(-1); assert.equal(run.plannedParts,6); assert.ok(run.portalVersion > 0);
    const completed = await f.finish(6,false); assert.equal(completed.resinProduction.printedParts,(index+1)*6); assert.equal(completed.acceptedQuantity,0);
    await assert.rejects(f.permit(),{ code: 'RESIN_PORTAL_PROGRESS_UNCONFIRMED' }); f.confirm(completed.runs.at(-1));
  }
  assert.equal(f.current().resinProduction.remainingParts,2); assert.equal(f.portalStatus,'preparing');
  await assert.rejects(f.service.sliceResinJob(f.job.id,{ ...CONFIRMED,plate: { ...PLATE,copies: 2 } }),{ code: 'RESIN_APPROVAL_LOCKED' });
  const releaseTicket = f.ticket(), released = await f.remainder(releaseTicket), release = released.resinProduction.remainderRelease;
  assert.equal(released.resinProduction.plan.approvalState,undefined); assert.equal(released.resinProduction.authorization,undefined); assert.equal(release.runId,released.runs.at(-1).id);
  await assert.rejects(f.capture({ ...PLATE,copies: 3 }),{ code: 'QUANTITY_EXCEEDED' });
  await f.capture({ ...PLATE,copies: 2 }); await f.plan(); await f.permit();
  const newer = f.current(); await f.remainder(releaseTicket,release.runId); assert.deepEqual(f.current(),newer,'an old release replay cannot clear the newer partial-plate approval');
  const laterProjection = structuredClone(releaseTicket); laterProjection.version = f.version+1;
  await assert.rejects(f.remainder(laterProjection,release.runId),{ code: 'RESIN_REMAINDER_UNCONFIRMED' }); assert.deepEqual(f.current(),newer);
  await f.dispatch(); await f.finish(2);
  assert.equal(f.current().resinProduction.printedParts,20); assert.equal(f.current().resinProduction.remainingParts,0); assert.equal(f.current().acceptedQuantity,0); assert.equal(f.current().quantity,1);
  assert.deepEqual(f.current().runs.map(run => run.plannedParts),[6,6,6,2]); assert.equal(f.portalStatus,'post_processing');
  await f.reopen(); assert.equal(f.current().resinProduction.printedParts,20); assert.equal(f.current().resinProduction.lifetimeLocalPrintedParts,20);
});

test('run reconciliation accepts only the identified completed plate and at most its actual planned instance count', async t => {
  const f = await fixture(t); await f.plan(); const started = await f.dispatch(), run = started.runs.at(-1);
  await assert.rejects(f.service.reconcileResinRun(f.job.id,{ runId: run.id,outcome: 'completed',printedParts: 7 }),{ code: 'RESIN_RECONCILIATION_INVALID' });
  await assert.rejects(f.service.reconcileResinRun(f.job.id,{ runId: run.id,outcome: 'failed',printedParts: 1 }),{ code: 'RESIN_RECONCILIATION_INVALID' });
  await assert.rejects(f.service.reconcileResinRun(f.job.id,{ runId: run.id,outcome: 'completed',printedParts: 6 }));
  const completed = await f.finish(3); assert.equal(completed.resinProduction.printedParts,3); assert.equal(completed.acceptedQuantity,0);
  assert.equal((await f.service.reconcileResinRun(f.job.id,{ runId: run.id,outcome: 'completed',printedParts: 3 })).resinProduction.printedParts,3);
});

test('a remainder release requires fresh exact portal completion, local counts and the old matching approval generation', async t => {
  const f = await fixture(t); await f.plan(); for (let index = 0; index < 3; index++) { await f.dispatch(); await f.finish(6); }
  const ticket = f.ticket(), runId = f.current().runs.at(-1).id;
  await assert.rejects(f.service.applyResinPlateRemainder({},f.job.id,{ ticket,runId,observedAt: new Date().toISOString() }),{ code: 'RESIN_AUTHORITY_REQUIRED' });
  await assert.rejects(f.service.applyResinPlateRemainder(f.issuer,f.job.id,{ ticket,runId,observedAt: new Date(Date.now()-31000).toISOString() }),{ code: 'RESIN_AUTHORIZATION_STALE' });
  const before = f.current();
  for (const alter of [
    value => { value.id = randomUUID(); },value => { value.production.target.requiredParts--; },value => { value.status = 'queued'; },value => { value.production.approvedReceiptId = f.receipt.id; },
    value => { value.production.run.remoteId = 'other-task'; },value => { value.production.run.artifactSha256 = '0'.repeat(64); },value => { value.production.run.deviceFingerprint = '0'.repeat(64); },
    value => { value.production.run.plannedParts = 5; },value => { value.production.run.printedParts = 5; },value => { value.production.progress.printedParts--;value.production.progress.remainingParts++; },
  ]) { const changed = structuredClone(ticket); alter(changed); await assert.rejects(f.remainder(changed,runId)); assert.deepEqual(f.current(),before); }
  await f.service._mutate(() => { const plan = f.service._job(f.job.id).resinProduction.plan; plan.approvalState = 'pending'; plan.approvalExpectedVersion = ticket.version+1; });
  await assert.rejects(f.remainder(ticket,runId),{ code: 'RESIN_REMAINDER_STALE' }); assert.equal(f.current().resinProduction.plan.approvalState,'pending');
  const portalVersion = f.current().runs.at(-1).portalVersion;
  for (const invalid of [undefined,'12',NaN,0,-1]) {
    await f.service._mutate(() => { f.service._job(f.job.id).runs.at(-1).portalVersion = invalid; });
    await assert.rejects(f.remainder(ticket,runId),{ code: 'RESIN_REMAINDER_UNCONFIRMED' }); assert.equal(f.current().resinProduction.plan.approvalState,'pending');
  }
  await f.service._mutate(() => { f.service._job(f.job.id).runs.at(-1).portalVersion = portalVersion; });
});
