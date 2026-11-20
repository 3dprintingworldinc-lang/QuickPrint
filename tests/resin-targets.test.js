'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { fingerprintSDCPDevice } = require('../src/adapters/sdcp-identity');
const { CONFIRMED, createProfile, makeSlice, importTicket } = require('./helpers/resin-slice');

// The fake adapter permits read-only identity inspection. Any upload/start is a
// test failure: stale target/operation proofs must fail before physical effects.
async function fixture(t, { explicitTarget = true } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-targets-'));
  const settings = await createProfile(dataDir), commands = [];
  const attrs = { MainboardID: '0123456789abcdef', BrandName: 'ELEGOO', MachineName: 'Synthetic target', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'V1.5.6', Resolution: '4x2', XYZsize: '40x20x30', Capabilities: ['FILE_TRANSFER', 'PRINT_CONTROL'], SupportFileType: ['GOO'] };
  const adapter = {
    capabilities: { upload: true, start: true, formats: ['goo'] },
    async attributes() { return { ...attrs, observedAt: new Date().toISOString() }; },
    async status() { return { state: 'idle', observedAt: new Date().toISOString() }; },
    async upload() { commands.push('upload'); throw new Error('Target tests must not upload.'); },
    async start() { commands.push('start'); throw new Error('Target tests must not start.'); },
    async close() {},
  };
  const options = { dataDir, adapters: () => adapter, resinEngine: { prepareResin: makeSlice } };
  let service = new QuickPrintService(options); await service.init();
  await service.updateSettings({ resinEngine: { ...settings, dispatchEnabled: true } });
  const printer = await service.savePrinter({ name: 'Synthetic target', type: 'sdcp', host: 'target-fixture.invalid', mainboardId: attrs.MainboardID, brandId: 'a'.repeat(32), model: 'QuickPrint Test' });
  const profile = JSON.parse(await fs.readFile(settings.profilePath)); profile.printerId = printer.id; await fs.writeFile(settings.profilePath, JSON.stringify(profile));
  const job = await importTicket(service, { project: { quantity: 3 } });
  const slice = (await service.sliceResinJob(job.id, CONFIRMED)).resinSlice;
  const deviceFingerprint = fingerprintSDCPDevice(printer, attrs);
  const receipt = { id: randomUUID(), jobId: job.order.portalJobId, kind: 'slice', ticketFingerprint: job.order.ticketFingerprint, sourceSha256: slice.sourceSha256, profileSha256: slice.profileSha256, tool: structuredClone(slice.tool), printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material, artifact: { sha256: slice.sha256, sizeBytes: slice.bytes, format: 'goo' }, partsPerRun: 1, deviceFingerprint, printReady: false };
  let issuer;
  const f = {
    dataDir, settings, job, receipt, printer, deviceFingerprint, commands, version: 10, printedParts: 0,
    target: { id: job.order.portalJobId, kind: 'order', cycle: 0, requiredParts: 3, authorizedAt: job.createdAt, qcOperationId: null },
    get service() { return service; }, get issuer() { return issuer; }, current: () => service.getJob(job.id),
    ticket({ target = f.target, status = 'preparing', version = f.version, printedParts = f.printedParts } = {}) {
      return { id: job.order.portalJobId, version, status, ticketFingerprint: job.order.ticketFingerprint,
        ticket: { specifications: { project: { quantity: 3 }, production: { printType: 'resin' } } },
        production: { target: structuredClone(target), approvedTargetId: status === 'queued' ? target.id : null, approvedReceiptId: status === 'queued' ? receipt.id : null,
          progress: { requestedParts: target.requiredParts, printedParts, remainingParts: target.requiredParts - printedParts, completedRuns: printedParts, failedRuns: 0 } } };
    },
    proof(target = f.target) {
      const ticket = f.ticket({ target, status: 'queued' }), checkedAt = new Date().toISOString();
      return { ticket, receipt, authorization: { qualified: true, checkedAt, expiresAt: new Date(Date.now() + 30000).toISOString(), jobVersion: ticket.version, ticketFingerprint: receipt.ticketFingerprint, receiptId: receipt.id, sourceSha256: receipt.sourceSha256, artifactSha256: receipt.artifact.sha256, profileSha256: receipt.profileSha256, engineSha256: receipt.tool.executableSha256, printerId: receipt.printerId, printerModel: receipt.printerModel, material: receipt.material, format: 'goo', deviceFingerprint, partsPerRun: 1, plannedParts: 1, remainingParts: ticket.production.progress.remainingParts, qualificationFingerprint: 'f'.repeat(64), targetId: target.id, targetKind: target.kind, targetCycle: target.cycle, targetParts: target.requiredParts } };
    },
    plan(target = f.target) { return service.reviewResinProductionPlan(issuer, job.id, { receipt, deviceFingerprint, confirmedWholeModel: true, ticket: f.ticket({ target }) }); },
    adopt(ticket = f.ticket()) { return service.adoptResinPreparationTarget(issuer, job.id, { ticket, confirmedTarget: true, observedAt: new Date().toISOString() }); },
    permit(proof = f.proof()) { return service.issueResinDispatchPermit(issuer, job.id, { printerId: printer.id, ...proof, deviceFingerprint, observedAt: new Date().toISOString() }); },
    approve(operationId, operation = async () => ({ ticket: f.ticket({ status: 'queued' }) })) { return service.withResinPreparationEvidence(issuer, job.id, { receipt, deviceFingerprint, operationId, expectedVersion: f.version }, operation); },
    async pending(operationId) { await assert.rejects(f.approve(operationId, async () => { throw Object.assign(new Error('Lost approval response'), { code: 'FIXTURE_LOST_REPLY' }); }), { code: 'FIXTURE_LOST_REPLY' }); },
    async counts(runs, baselinePrintedParts) { return service._mutate(() => { const current = service._job(job.id); current.runs.push(...runs); current.resinProduction.baselinePrintedParts = baselinePrintedParts; service._quantities(current); }); },
    async reopen() { await service.close(); service = new QuickPrintService(options); await service.init(); issuer = makeIssuer(); },
  };
  const makeIssuer = () => service.createResinPermitIssuer({ reauthorize: async () => f.proof() });
  issuer = makeIssuer();
  if (explicitTarget) await f.plan();
  else await service.reviewResinProductionPlan(issuer, job.id, { receipt, deviceFingerprint, confirmedWholeModel: true });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return f;
}

function replacement(cycle, requiredParts = 1) {
  const id = randomUUID(); return { id, kind: 'replacement', cycle, requiredParts, authorizedAt: new Date().toISOString(), qcOperationId: id };
}
const resolved = (targetId, printedParts = 1) => ({ id: randomUUID(), technology: 'resin', targetId, phase: 'resolved', outcome: printedParts ? 'completed' : 'failed', printedParts, resolvedAt: new Date().toISOString() });

test('replacement targets reset current counts while preserving original quantity, prior targets and lifetime local production after restart', async t => {
  const f = await fixture(t);
  await f.counts([resolved(f.target.id), resolved(f.target.id), resolved(f.target.id, 0)], 1);
  assert.equal(f.current().resinProduction.printedParts, 3);
  f.target = replacement(1, 2); await f.plan();
  let production = f.current().resinProduction;
  assert.equal(production.printedParts, 0); assert.equal(production.remainingParts, 2); assert.equal(production.lifetimeLocalPrintedParts, 2);
  assert.equal(production.targetHistory[0].printedParts, 3);
  await f.counts([resolved(f.target.id)], 1);
  assert.equal(f.current().resinProduction.printedParts, 2);
  f.target = replacement(3, 1); await f.plan(); await f.reopen();
  production = f.current().resinProduction;
  assert.equal(production.printedParts, 0); assert.equal(production.remainingParts, 1); assert.equal(production.requestedParts, 1);
  assert.equal(production.originalRequestedParts, 3); assert.equal(production.lifetimeLocalPrintedParts, 3);
  assert.deepEqual(production.targetHistory.map(item => item.printedParts), [3, 2]);
  assert.equal(f.current().quantity, 1); assert.equal(f.current().acceptedQuantity, 0); assert.deepEqual(f.commands, []);
});

for (const [field, value] of [['requiredParts', 2], ['cycle', 2], ['authorizedAt', '2026-11-19T01:02:03.000Z']]) {
  test(`a reviewed replacement target cannot mutate ${field} while retaining its identity`, async t => {
    const f = await fixture(t); f.target = replacement(1); await f.plan();
    const before = f.current().resinProduction;
    await assert.rejects(f.plan({ ...f.target, [field]: value }), error => /^RESIN_TARGET_/.test(error.code));
    assert.deepEqual(f.current().resinProduction, before); assert.deepEqual(f.commands, []);
  });
}

test('replacement cycles reject regressions and reuse of an earlier target ID even at a later cycle', async t => {
  const f = await fixture(t), first = replacement(1), second = replacement(2);
  f.target = first; await f.plan(); f.target = second; await f.plan();
  await assert.rejects(f.plan(replacement(1)), { code: 'RESIN_TARGET_INVALID' });
  await assert.rejects(f.plan({ ...first, cycle: 3 }), error => /^RESIN_TARGET_/.test(error.code));
  assert.deepEqual(f.current().resinProduction.target, second); assert.deepEqual(f.commands, []);
});

test('fresh authorization cannot change the reviewed target quota or cycle under the same target ID', async t => {
  const f = await fixture(t); f.target = replacement(1); await f.plan();
  for (const patch of [{ requiredParts: 2 }, { cycle: 2 }, { authorizedAt: '2026-11-19T01:02:03.000Z' }]) {
    await assert.rejects(f.permit(f.proof({ ...f.target, ...patch })), error => /^RESIN_TARGET_/.test(error.code));
  }
  assert.equal(f.current().resinProduction.requestedParts, 1); assert.deepEqual(f.commands, []);
});

test('a permit for an earlier target is invalidated before any upload after target replacement', async t => {
  const f = await fixture(t), permit = await f.permit();
  f.target = replacement(1); await f.plan();
  await assert.rejects(f.service.dispatchQualifiedResinJob(f.job.id, { permitId: permit.permitId, confirmedReady: true }), { code: 'RESIN_PERMIT_REQUIRED' });
  await assert.rejects(f.service.dispatchQualifiedResinJob(f.job.id, { permitId: permit.permitId, confirmedReady: true }), { code: 'RESIN_PERMIT_REQUIRED' });
  assert.deepEqual(f.commands, []);
});

test('normalizing a legacy target to explicit authority metadata invalidates a previously issued permit', async t => {
  const f = await fixture(t, { explicitTarget: false }), proof = f.proof();
  delete proof.ticket.production.target; delete proof.ticket.production.approvedTargetId;
  for (const key of ['targetId', 'targetKind', 'targetCycle', 'targetParts']) delete proof.authorization[key];
  const permit = await f.permit(proof);
  assert.equal(f.current().resinProduction.targetVerified, false);
  f.target = { ...f.target, authorizedAt: '2026-11-19T01:02:03.000Z' }; await f.plan();
  assert.equal(f.current().resinProduction.targetVerified, true);
  await assert.rejects(f.service.dispatchQualifiedResinJob(f.job.id, { permitId: permit.permitId, confirmedReady: true }), { code: 'RESIN_PERMIT_REQUIRED' });
  assert.deepEqual(f.commands, []);
});

test('confirmed preparation withdrawal invalidates an existing permit before any upload or start', async t => {
  const f = await fixture(t), permit = await f.permit();
  assert.equal(f.current().resinProduction.plan.approvalState, 'approved');
  await f.service.applyResinPreparationWithdrawal(f.issuer, f.job.id, { ticket: f.ticket({ version: 11 }), receiptId: f.receipt.id, operationId: randomUUID(), withdrawalVersion: 11 });
  assert.equal(f.current().resinProduction.plan.approvalState, 'withdrawn');
  assert.equal(f.current().resinProduction.authorization, undefined);
  await assert.rejects(f.service.dispatchQualifiedResinJob(f.job.id, { permitId: permit.permitId, confirmedReady: true }), { code: 'RESIN_PERMIT_REQUIRED' });
  assert.deepEqual(f.commands, []);
});

test('a delayed queued proof cannot mint a new permit after withdrawal or roll back a newer known approval version', async t => {
  const f = await fixture(t), delayed = f.proof(); await f.permit(delayed);
  await f.service.applyResinPreparationWithdrawal(f.issuer, f.job.id, { ticket: f.ticket({ version: 11 }), receiptId: f.receipt.id, operationId: randomUUID(), withdrawalVersion: 11 });
  await assert.rejects(f.permit(delayed), { code: 'RESIN_AUTHORIZATION_STALE' });
  f.version = 11; await assert.rejects(f.permit(), { code: 'RESIN_AUTHORIZATION_STALE' });
  assert.equal(f.current().resinProduction.plan.approvalState, 'withdrawn');
  f.version = 14; assert.ok((await f.permit()).permitId);
  f.version = 13; await assert.rejects(f.permit(), { code: 'RESIN_AUTHORIZATION_STALE' });
  assert.equal(f.current().resinProduction.plan.approvalVersion, 14); assert.deepEqual(f.commands, []);
});

test('withdrawn preparation rejects missing or stale saved approval versions before invoking any RPC', async t => {
  const f = await fixture(t); await f.permit();
  await f.service.applyResinPreparationWithdrawal(f.issuer, f.job.id, { ticket: f.ticket({ version: 11 }), receiptId: f.receipt.id, operationId: randomUUID(), withdrawalVersion: 11 });
  let calls = 0;
  for (const expectedVersion of [undefined, 10]) {
    await assert.rejects(f.service.withResinPreparationEvidence(f.issuer, f.job.id, { receipt: f.receipt, deviceFingerprint: f.deviceFingerprint, operationId: randomUUID(), expectedVersion }, async () => { calls++; return { ticket: f.ticket({ status: 'queued', version: 12 }) }; }), { code: 'RESIN_AUTHORIZATION_STALE' });
  }
  assert.equal(calls, 0); assert.equal(f.current().resinProduction.plan.approvalState, 'withdrawn');
  await f.service.withResinPreparationEvidence(f.issuer, f.job.id, { receipt: f.receipt, deviceFingerprint: f.deviceFingerprint, operationId: randomUUID(), expectedVersion: 11 }, async () => { calls++; return { ticket: f.ticket({ status: 'queued', version: 12 }) }; });
  assert.equal(calls, 1); assert.equal(f.current().resinProduction.plan.approvalState, 'approved'); assert.deepEqual(f.commands, []);
});

test('a zero-unit correction target authorizes no physical permit or quota increase', async t => {
  const f = await fixture(t), target = replacement(1, 0);
  await assert.rejects(f.plan(target), { code: 'RESIN_TARGET_COMPLETE' });
  await assert.rejects(f.permit(f.proof(target)));
  assert.equal(f.current().resinProduction.target.kind, 'order'); assert.deepEqual(f.commands, []);
});

test('operation-bound pending approval needs the exact operation identity for release', async t => {
  const f = await fixture(t), operationId = randomUUID(); await f.pending(operationId);
  await assert.rejects(f.service.releaseResinPreparationApproval(f.issuer, f.job.id, { receiptId: f.receipt.id }), { code: 'RESIN_APPROVAL_PLAN_MISMATCH' });
  await assert.rejects(f.service.releaseResinPreparationApproval(f.issuer, f.job.id, { receiptId: f.receipt.id, operationId: randomUUID() }), { code: 'RESIN_APPROVAL_PLAN_MISMATCH' });
  assert.equal(f.current().resinProduction.plan.approvalOperationId, operationId);
  await f.service.releaseResinPreparationApproval(f.issuer, f.job.id, { receiptId: f.receipt.id, operationId });
  const newer = randomUUID(); await f.pending(newer);
  await assert.rejects(f.service.releaseResinPreparationApproval(f.issuer, f.job.id, { receiptId: f.receipt.id, operationId }), { code: 'RESIN_APPROVAL_PLAN_MISMATCH' });
  assert.equal(f.current().resinProduction.plan.approvalState, 'pending'); assert.equal(f.current().resinProduction.plan.approvalOperationId, newer);
});

test('another operation cannot replace an unresolved pending approval generation', async t => {
  const f = await fixture(t), operationId = randomUUID(); await f.pending(operationId);
  let invoked = false;
  await assert.rejects(f.approve(randomUUID(), async () => { invoked = true; return { ticket: f.ticket({ status: 'queued' }) }; }), { code: 'RESIN_APPROVAL_LOCKED' });
  assert.equal(invoked, false); assert.equal(f.current().resinProduction.plan.approvalOperationId, operationId);
});

test('a stale withdrawal cannot clear a newer pending hold for the same target and reusable receipt', async t => {
  const f = await fixture(t); await f.approve(randomUUID());
  const withdrawal = { ticket: f.ticket({ version: 11 }), receiptId: f.receipt.id, operationId: randomUUID() };
  await f.service.applyResinPreparationWithdrawal(f.issuer, f.job.id, withdrawal);
  f.version = 12; const newerApproval = randomUUID(); await f.pending(newerApproval);
  const before = f.current().resinProduction.plan;
  await assert.rejects(f.service.applyResinPreparationWithdrawal(f.issuer, f.job.id, { ...withdrawal, operationId: randomUUID() }), error => /^RESIN_WITHDRAWAL_/.test(error.code));
  assert.deepEqual(f.current().resinProduction.plan, before);
  assert.equal(f.current().resinProduction.plan.approvalState, 'pending'); assert.equal(f.current().resinProduction.plan.approvalOperationId, newerApproval);
  await f.service.applyResinPreparationWithdrawal(f.issuer, f.job.id, withdrawal);
  assert.equal(f.current().resinProduction.plan.approvalState, 'pending', 'replaying a known older withdrawal is idempotent and does not release the newer hold');
  assert.deepEqual(f.commands, []);
});

test('withdrawal uses its immutable commit version rather than a newer latest projection to release an approval generation', async t => {
  const f = await fixture(t), operationId = randomUUID();
  await assert.rejects(f.service.withResinPreparationEvidence(f.issuer, f.job.id, { receipt: f.receipt, deviceFingerprint: f.deviceFingerprint, operationId, expectedVersion: 20 }, async () => { throw Object.assign(new Error('Lost approval response'), { code: 'FIXTURE_LOST_REPLY' }); }), { code: 'FIXTURE_LOST_REPLY' });
  const latestPreparingTicket = f.ticket({ version: 30 });
  await assert.rejects(f.service.applyResinPreparationWithdrawal(f.issuer, f.job.id, { ticket: latestPreparingTicket, receiptId: f.receipt.id, operationId: randomUUID(), withdrawalVersion: 19 }), { code: 'RESIN_WITHDRAWAL_STALE' });
  assert.equal(f.current().resinProduction.plan.approvalState, 'pending');
  assert.equal(f.current().resinProduction.plan.approvalOperationId, operationId);
  assert.equal(f.current().resinProduction.plan.approvalExpectedVersion, 20);
  await f.service.applyResinPreparationWithdrawal(f.issuer, f.job.id, { ticket: latestPreparingTicket, receiptId: f.receipt.id, operationId: randomUUID(), withdrawalVersion: 21 });
  assert.equal(f.current().resinProduction.plan.approvalState, 'withdrawn'); assert.deepEqual(f.commands, []);
});

test('adopting a fresh QC replacement unlocks revision without needing the old slice or its profile qualification', async t => {
  const f = await fixture(t), permit = await f.permit();
  await f.counts([resolved(f.target.id), resolved(f.target.id), resolved(f.target.id)], 0);
  await f.service._mutate(() => { f.service._job(f.job.id).status = 'cancelled'; });
  const before = f.current(), source = await fs.readFile(before.inputPath);
  const changedProfile = JSON.parse(await fs.readFile(f.settings.profilePath)); changedProfile.material = 'Revised correction resin';
  await fs.writeFile(f.settings.profilePath, JSON.stringify(changedProfile));
  await fs.unlink(before.resinSlice.filePath);
  f.target = replacement(1, 2); f.version = 11;
  const adopted = await f.adopt();
  assert.equal(adopted.status, 'review'); assert.deepEqual(adopted.order, before.order); assert.deepEqual(adopted.resinSlice, before.resinSlice); assert.deepEqual(adopted.runs, before.runs);
  assert.deepEqual(await fs.readFile(adopted.inputPath), source);
  const production = adopted.resinProduction;
  assert.deepEqual(production.target, f.target); assert.equal(production.targetVerified, true); assert.equal(production.plan, undefined); assert.equal(production.authorization, undefined); assert.equal(production.baselinePrintedParts, undefined);
  assert.equal(production.printedParts, 0); assert.equal(production.remainingParts, 2); assert.equal(production.originalRequestedParts, 3); assert.equal(production.lifetimeLocalPrintedParts, 3);
  assert.equal(production.targetHistory.at(-1).printedParts, 3); assert.equal(production.targetHistory.at(-1).localPrintedParts, 3);
  await assert.rejects(f.service.dispatchQualifiedResinJob(f.job.id, { permitId: permit.permitId, confirmedReady: true }), { code: 'RESIN_PERMIT_REQUIRED' });
  const resliced = await f.service.sliceResinJob(f.job.id, CONFIRMED);
  assert.equal(resliced.resinSlice.material, 'Revised correction resin'); assert.equal(resliced.resinProduction.lifetimeLocalPrintedParts, 3); assert.deepEqual(resliced.runs, before.runs);
  assert.equal(resliced.acceptedQuantity, 0); assert.deepEqual(f.commands, []);
});

test('adoption requires authority, explicit confirmation, fresh observation and the exact unapproved stopped frozen ticket', async t => {
  const f = await fixture(t); f.target = replacement(1);
  const valid = { ticket: f.ticket(), confirmedTarget: true, observedAt: new Date().toISOString() };
  await assert.rejects(f.service.adoptResinPreparationTarget({}, f.job.id, valid), { code: 'RESIN_AUTHORITY_REQUIRED' });
  await assert.rejects(f.service.adoptResinPreparationTarget(f.issuer, f.job.id, { ...valid, confirmedTarget: false }), { code: 'RESIN_TARGET_REVIEW_REQUIRED' });
  for (const observedAt of [undefined, 'invalid', new Date(Date.now() - 31000).toISOString(), new Date(Date.now() + 6000).toISOString()]) {
    await assert.rejects(f.service.adoptResinPreparationTarget(f.issuer, f.job.id, { ...valid, observedAt }), { code: 'RESIN_AUTHORIZATION_STALE' });
  }
  const before = f.current();
  for (const change of [
    ticket => { ticket.id = randomUUID(); }, ticket => { ticket.ticketFingerprint = '0'.repeat(64); },
    ticket => { ticket.ticket.specifications.project.quantity = 2; }, ticket => { ticket.ticket.specifications.production.printType = 'fdm'; },
    ticket => { delete ticket.production.target; }, ticket => { ticket.version = 0; }, ticket => { ticket.status = 'queued'; },
    ticket => { ticket.production.approvedReceiptId = f.receipt.id; }, ticket => { ticket.production.approvedTargetId = f.target.id; },
    ticket => { ticket.production.run = { status: 'printing' }; }, ticket => { ticket.production.target.requiredParts = 4; },
    ticket => { ticket.production.target.qcOperationId = randomUUID(); },
  ]) {
    const ticket = structuredClone(valid.ticket); change(ticket);
    await assert.rejects(f.adopt(ticket), { code: 'RESIN_TARGET_INVALID' });
    assert.deepEqual(f.current(), before);
  }
  assert.deepEqual(f.commands, []);
});

test('an active, uncertain or still-preparing local job cannot adopt another target', async t => {
  for (const [status, currentRun] of [['printing', false], ['needs_attention', true], ['preparing', false]]) await t.test(status, async child => {
    const f = await fixture(child); f.target = replacement(1);
    await f.service._mutate(() => { const job = f.service._job(f.job.id); job.status = status; if (currentRun) { const run = { id: randomUUID(), technology: 'resin', phase: 'result_unknown' }; job.runs.push(run); job.currentRunId = run.id; } });
    const before = f.current();
    await assert.rejects(f.adopt(), { code: 'JOB_BUSY' });
    assert.deepEqual(f.current(), before); assert.deepEqual(f.commands, []);
  });
});

test('a repeated immutable current-target adoption preserves its pending or approved generation and permits', async t => {
  const f = await fixture(t); f.target = replacement(1); f.version = 11; await f.adopt(); await f.plan();
  const operationId = randomUUID(); await f.pending(operationId);
  let before = f.current(), stored = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  assert.deepEqual(await f.adopt(), before); assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), stored);
  await f.approve(operationId); const permit = await f.permit();
  before = f.current(); stored = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  assert.deepEqual(await f.adopt(), before); assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), stored);
  assert.ok(f.service._resinDispatchPermits.has(permit.permitId));
  await assert.rejects(f.adopt(f.ticket({ target: { ...f.target, requiredParts: 2 } })), { code: 'RESIN_TARGET_MISMATCH' });
  assert.equal(f.current().resinProduction.plan.approvalState, 'approved'); assert.deepEqual(f.commands, []);
});

test('target adoption rejects cycle rollback and any previously used target identity', async t => {
  const f = await fixture(t), first = replacement(1), second = replacement(2);
  f.target = first; await f.adopt(); f.target = second; await f.adopt();
  const before = f.current();
  await assert.rejects(f.adopt(f.ticket({ target: replacement(1) })), { code: 'RESIN_TARGET_INVALID' });
  await assert.rejects(f.adopt(f.ticket({ target: { ...first, cycle: 3 } })), { code: 'RESIN_TARGET_MISMATCH' });
  assert.deepEqual(f.current(), before);
  const used = replacement(3); await f.counts([resolved(used.id)], 0);
  await assert.rejects(f.adopt(f.ticket({ target: used })), { code: 'RESIN_TARGET_MISMATCH' });
  assert.deepEqual(f.commands, []);
});

test('a zero-unit finishing target can be adopted without authorizing another physical run', async t => {
  const f = await fixture(t); await f.permit(); f.target = replacement(1, 0); f.version = 11;
  const result = await f.adopt(f.ticket({ status: 'post_processing' }));
  assert.equal(result.resinProduction.requestedParts, 0); assert.equal(result.resinProduction.remainingParts, 0); assert.equal(result.resinProduction.plan, undefined);
  await assert.rejects(f.plan(), { code: 'RESIN_TARGET_COMPLETE' }); await assert.rejects(f.permit());
  assert.deepEqual(f.commands, []);
});

test('failed adoption persistence rolls back the target, plan, history and production counts', async t => {
  const f = await fixture(t); await f.permit(); f.target = replacement(1); f.version = 11;
  const before = f.current(), stored = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  t.mock.method(f.service.store, 'save', async () => { throw Object.assign(new Error('Fixture disk unavailable'), { code: 'FIXTURE_DISK_FAILURE' }); });
  await assert.rejects(f.adopt(), { code: 'FIXTURE_DISK_FAILURE' }); t.mock.restoreAll();
  assert.deepEqual(f.current(), before); assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), stored); assert.deepEqual(f.commands, []);
});
