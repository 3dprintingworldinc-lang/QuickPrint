'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { CONFIRMED, createProfile, makeSlice, importTicket, deferred } = require('./helpers/resin-slice');

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-approval-lock-'));
  const settings = await createProfile(dataDir);
  let calls = 0, service;
  const options = { dataDir, adapters: () => { throw new Error('Approval locking must not invoke a printer adapter.'); }, resinEngine: { prepareResin: input => { calls++; return makeSlice(input); } } };
  service = new QuickPrintService(options); await service.init(); await service.updateSettings({ resinEngine: settings });
  const job = await importTicket(service), captured = await service.sliceResinJob(job.id, CONFIRMED), slice = captured.resinSlice;
  const deviceFingerprint = 'd'.repeat(64);
  const receipt = { id: randomUUID(), jobId: job.order.portalJobId, kind: 'slice', ticketFingerprint: job.order.ticketFingerprint, sourceSha256: slice.sourceSha256, profileSha256: slice.profileSha256, tool: structuredClone(slice.tool), printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material, artifact: { sha256: slice.sha256, sizeBytes: slice.bytes, format: 'goo' }, partsPerRun: 1, deviceFingerprint, printReady: false };
  const result = { ticket: { id: job.order.portalJobId, version: 8, status: 'queued', ticketFingerprint: job.order.ticketFingerprint, ticket: { specifications: { project: { quantity: job.order.requestedQuantity } } }, production: { approvedReceiptId: receipt.id } } };
  let issuer;
  const makeIssuer = () => service.createResinPermitIssuer({ reauthorize: () => { throw new Error('No production dispatch occurs in approval tests.'); } });
  issuer = makeIssuer();
  await service.reviewResinProductionPlan(issuer, job.id, { receipt, deviceFingerprint, confirmedWholeModel: true });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, job, receipt, deviceFingerprint, result,
    get service() { return service; }, get issuer() { return issuer; }, calls: () => calls,
    current: () => service.getJob(job.id),
    approve: operation => service.withResinPreparationEvidence(issuer, job.id, { receipt, deviceFingerprint }, operation),
    release: () => service.releaseResinPreparationApproval(issuer, job.id, { receiptId: receipt.id }),
    async reopen() { await service.close(); service = new QuickPrintService(options); await service.init(); issuer = makeIssuer(); },
  };
}

test('approval holds the job lock through RPC and a queued reslice cannot replace the committed artifact', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const original = f.current().resinSlice;
  const approving = f.approve(async () => {
    const stored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')).jobs.find(job => job.id === f.job.id);
    assert.equal(stored.resinProduction.plan.approvalState, 'pending', 'pending intent is durable before the external operation');
    entered.resolve(); await release.promise; return f.result;
  });
  await entered.promise;
  const reslicing = f.service.sliceResinJob(f.job.id, CONFIRMED);
  let settled = false;
  const rejected = assert.rejects(reslicing, { code: 'RESIN_APPROVAL_LOCKED' }).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'reslicing waits behind the approval RPC'); assert.equal(f.calls(), 1);
  release.resolve(); await approving; await rejected;
  const current = f.current();
  assert.equal(current.resinProduction.plan.approvalState, 'approved');
  assert.equal(current.resinSlice.filePath, original.filePath); assert.equal(current.resinSlice.sha256, original.sha256);
  assert.equal(current.resinSlice.printReady, false); assert.equal(f.calls(), 1);
});

test('lost approval response persists a pending hold across restart until trusted definitive release', async t => {
  const f = await fixture(t);
  await assert.rejects(f.approve(async () => { throw Object.assign(new Error('Response lost after possible remote commit'), { code: 'FIXTURE_AMBIGUOUS' }); }), { code: 'FIXTURE_AMBIGUOUS' });
  assert.equal(f.current().resinProduction.plan.approvalState, 'pending');
  await assert.rejects(f.service.sliceResinJob(f.job.id, CONFIRMED), { code: 'RESIN_APPROVAL_LOCKED' });
  await f.reopen();
  assert.equal(f.current().resinProduction.plan.approvalState, 'pending');
  await assert.rejects(f.service.sliceResinJob(f.job.id, CONFIRMED), { code: 'RESIN_APPROVAL_LOCKED' });
  await assert.rejects(f.service.releaseResinPreparationApproval({}, f.job.id, { receiptId: f.receipt.id }), { code: 'RESIN_AUTHORITY_REQUIRED' });
  await assert.rejects(f.service.releaseResinPreparationApproval(f.issuer, f.job.id, { receiptId: randomUUID() }), { code: 'RESIN_APPROVAL_PLAN_MISMATCH' });
  await f.release();
  assert.equal(f.current().resinProduction.plan.approvalState, undefined);
  await f.service.sliceResinJob(f.job.id, CONFIRMED); assert.equal(f.calls(), 2);
});

test('guard failures happen before RPC and do not create a misleading pending approval intent', async t => {
  const f = await fixture(t); let invoked = 0;
  const operation = async () => { invoked++; return f.result; };
  await assert.rejects(f.service.withResinPreparationEvidence({}, f.job.id, { receipt: f.receipt, deviceFingerprint: f.deviceFingerprint }, operation), { code: 'RESIN_AUTHORITY_REQUIRED' });
  const replacement = { ...f.receipt, id: randomUUID() };
  await assert.rejects(f.service.withResinPreparationEvidence(f.issuer, f.job.id, { receipt: replacement, deviceFingerprint: f.deviceFingerprint }, operation), { code: 'RESIN_APPROVAL_PLAN_MISMATCH' });
  const bytes = await fs.readFile(f.current().resinSlice.filePath); bytes[0] ^= 1; await fs.writeFile(f.current().resinSlice.filePath, bytes);
  await assert.rejects(f.approve(operation), { code: 'RESIN_ARTIFACT_CHANGED' });
  assert.equal(invoked, 0); assert.equal(f.current().resinProduction.plan.approvalState, undefined);
});

test('an invalid approval response leaves pending evidence for exact replay instead of claiming it was unsent', async t => {
  const f = await fixture(t); let invoked = false;
  const invalid = structuredClone(f.result); invalid.ticket.production.approvedReceiptId = randomUUID();
  await assert.rejects(f.approve(async () => { invoked = true; return invalid; }), error => error.code === 'RESIN_APPROVAL_UNCONFIRMED' && error.definitelyUnsent === undefined);
  assert.equal(invoked, true); assert.equal(f.current().resinProduction.plan.approvalState, 'pending');
  await assert.rejects(f.service.sliceResinJob(f.job.id, CONFIRMED), { code: 'RESIN_APPROVAL_LOCKED' });
});

test('reviewing an existing plan cannot erase an approved hold or replace its receipt identity', async t => {
  const f = await fixture(t); await f.approve(async () => f.result);
  await f.service.reviewResinProductionPlan(f.issuer, f.job.id, { receipt: f.receipt, deviceFingerprint: f.deviceFingerprint, confirmedWholeModel: true });
  assert.equal(f.current().resinProduction.plan.approvalState, 'approved');
  await assert.rejects(f.service.reviewResinProductionPlan(f.issuer, f.job.id, { receipt: { ...f.receipt, id: randomUUID() }, deviceFingerprint: f.deviceFingerprint, confirmedWholeModel: true }), { code: 'RESIN_APPROVAL_LOCKED' });
  await assert.rejects(f.release(), { code: 'RESIN_APPROVAL_RELEASE_FORBIDDEN' });
  assert.equal(f.current().resinProduction.plan.approvalState, 'approved');
});
