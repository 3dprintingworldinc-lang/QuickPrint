'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { canonicalSDCPDevice, fingerprintSDCPDevice } = require('../src/adapters/sdcp-identity');
const { CONFIRMED, hash, createProfile, makeSlice, importTicket } = require('./helpers/resin-slice');
const { inspectGoo } = require('../src/slicing/goo');

// Entirely injected SDCP/slicer fixtures: no sockets, providers or hardware.
async function fixture(t, { enabled = true, requestedParts = 3, profilePrinterId } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-qualified-resin-'));
  const settings = await createProfile(dataDir);
  const adapter = {
    capabilities: { upload: true, start: true, pause: true, resume: true, cancel: true, formats: ['goo'], discovery: false },
    attrs: { MainboardID: '0123456789abcdef', Name: 'User label', BrandName: 'ELEGOO', MachineName: 'Synthetic SDCP model', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'V1.5.6', Resolution: '4x2', XYZsize: '41x21x30', Capabilities: ['FILE_TRANSFER', 'PRINT_CONTROL'], SupportFileType: ['GOO'] },
    telemetry: { state: 'idle' }, calls: [], serial: 0,
    async attributes() { this.calls.push(['attributes']); return { ...this.attrs, observedAt: new Date().toISOString() }; },
    async status() { this.calls.push(['status']); return { observedAt: new Date().toISOString(), ...this.telemetry }; },
    async upload(input) { this.calls.push(['upload', input]); this.remotePath = input.fileName; await this.onUpload?.(input); return { remotePath: input.fileName }; },
    async start(input) {
      this.calls.push(['start', input]); this.remoteId = `synthetic-task-${++this.serial}`;
      this.telemetry = { state: 'printing', remoteId: this.remoteId, currentFile: this.remotePath };
      if (this.onStart) return this.onStart(input);
      return { acknowledged: true, remoteId: this.remoteId, currentFile: this.remotePath, observedAt: new Date().toISOString() };
    },
    async pause() { this.calls.push(['pause']); return { acknowledged: true }; },
    async resume() { this.calls.push(['resume']); return { acknowledged: true }; },
    async cancel() { this.calls.push(['cancel']); return { acknowledged: true }; },
    async close() {},
  };
  const options = { dataDir, adapters: () => adapter, resinEngine: { prepareResin: makeSlice } };
  let service = new QuickPrintService(options); await service.init();
  await service.updateSettings({ resinEngine: { ...settings, ...(enabled ? { dispatchEnabled: true } : {}) } });
  const printer = await service.savePrinter({ name: 'Synthetic physical target', type: 'sdcp', host: 'printer-fixture.invalid', mainboardId: adapter.attrs.MainboardID, brandId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', model: 'QuickPrint Test' });
  const profile = JSON.parse(await fs.readFile(settings.profilePath));
  profile.printerId = profilePrinterId || printer.id;
  await fs.writeFile(settings.profilePath, JSON.stringify(profile));
  const job = await importTicket(service, { project: { quantity: requestedParts } });
  const captured = await service.sliceResinJob(job.id, CONFIRMED), slice = captured.resinSlice;
  const deviceFingerprint = fingerprintSDCPDevice(printer, adapter.attrs);
  const receipt = { id: randomUUID(), jobId: job.order.portalJobId, kind: 'slice', ticketFingerprint: job.order.ticketFingerprint, sourceSha256: slice.sourceSha256, profileSha256: slice.profileSha256, tool: structuredClone(slice.tool), printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material, artifact: { sha256: slice.sha256, sizeBytes: slice.bytes, format: 'goo' }, partsPerRun: 1, deviceFingerprint, qualified: false, qualifiedAtCapture: false, printReady: false };
  let issuer;
  const f = {
    dataDir, settings, adapter, printer, job, receipt, deviceFingerprint, portalPrintedParts: 0, portalVersion: 10, onReauthorize: null,
    get service() { return service; }, get issuer() { return issuer; },
    current() { return service.getJob(job.id); },
    proof() {
      const checkedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 30000).toISOString();
      const progress = { requestedParts, printedParts: f.portalPrintedParts, remainingParts: requestedParts - f.portalPrintedParts, completedRuns: f.portalPrintedParts, failedRuns: 0 };
      const ticket = { id: job.order.portalJobId, version: f.portalVersion, status: progress.remainingParts > 0 ? 'queued' : 'post_processing', ticketFingerprint: job.order.ticketFingerprint, ticket: { specifications: { project: { quantity: requestedParts }, production: { printType: 'resin' }, file: { units: 'mm', sizeBytes: job.bytes, name: 'source.stl', format: 'stl' } } }, production: { progress, approvedReceiptId: receipt.id } };
      const authorization = { qualified: true, checkedAt, expiresAt, jobVersion: ticket.version, ticketFingerprint: job.order.ticketFingerprint, receiptId: receipt.id, sourceSha256: receipt.sourceSha256, artifactSha256: receipt.artifact.sha256, profileSha256: receipt.profileSha256, engineSha256: receipt.tool.executableSha256, printerId: receipt.printerId, printerModel: receipt.printerModel, material: receipt.material, format: 'goo', deviceFingerprint, partsPerRun: 1, plannedParts: 1, remainingParts: progress.remainingParts, qualificationFingerprint: 'f'.repeat(64) };
      return { ticket, receipt: structuredClone(receipt), authorization };
    },
    async plan() { return service.reviewResinProductionPlan(issuer, job.id, { receipt: structuredClone(receipt), deviceFingerprint, confirmedWholeModel: true }); },
    async permit(proof = f.proof()) { return service.issueResinDispatchPermit(issuer, job.id, { printerId: printer.id, ...proof, deviceFingerprint, observedAt: new Date().toISOString() }); },
    async dispatch(permit) { return service.dispatchQualifiedResinJob(job.id, { permitId: (permit || await f.permit()).permitId, confirmedReady: true }); },
    async observe(telemetry) { adapter.telemetry = telemetry; await service.testPrinter(printer.id); return f.current(); },
    async reopen() { await service.close(); service = new QuickPrintService(options); await service.init(); issuer = makeIssuer(); },
  };
  function makeIssuer() { return service.createResinPermitIssuer({ reauthorize: async context => f.onReauthorize ? f.onReauthorize(context) : f.proof() }); }
  issuer = makeIssuer();
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return f;
}

const mutations = f => f.adapter.calls.filter(([action]) => ['upload', 'start', 'pause', 'resume', 'cancel'].includes(action));

test('device fingerprint includes exact firmware and geometry while excluding labels, address and counters', () => {
  const printer = { type: 'sdcp', mainboardId: '0123456789abcdef', brandId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
  const attrs = { MainboardID: printer.mainboardId, BrandName: 'ELEGOO', MachineName: 'Synthetic', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'V1.5.6', Resolution: '15120x6230', XYZsize: '218.88x128.88x220' };
  const first = fingerprintSDCPDevice(printer, attrs);
  assert.equal(fingerprintSDCPDevice(printer, { ...attrs, Name: 'Renamed', MainboardIP: '192.0.2.1', RemainingMemory: 42, observedAt: new Date().toISOString() }), first);
  assert.notEqual(fingerprintSDCPDevice(printer, { ...attrs, FirmwareVersion: 'V1.5.7' }), first);
  assert.notEqual(fingerprintSDCPDevice(printer, { ...attrs, XYZsize: '211.68x118.37x220' }), first);
  assert.equal(canonicalSDCPDevice(printer, attrs).xyzSize, attrs.XYZsize);
  assert.throws(() => fingerprintSDCPDevice(printer, { ...attrs, MainboardID: 'ffffffffffffffff' }), { code: 'RESIN_DEVICE_IDENTITY_INVALID' });
});

test('qualified dispatch is disabled by default and generic dispatch/reconciliation cannot bypass resin guards', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal(f.service.getSettings().resinEngine.dispatchEnabled, false);
  await f.plan();
  await assert.rejects(f.permit(), { code: 'RESIN_DISPATCH_DISABLED' });
  await assert.rejects(f.service.dispatchJob(f.job.id, f.printer.id, { confirmed: true }), { code: 'RESIN_DISPATCH_UNAVAILABLE' });
  await assert.rejects(f.service.reconcileJob(f.job.id, { outcome: 'completed', acceptedQuantity: 1 }), { code: 'RESIN_RECONCILIATION_REQUIRED' });
  await assert.rejects(f.service.updateSettings({ resinEngine: { dispatchEnabled: 'true' } }), { code: 'RESIN_DISPATCH_CONFIGURATION' });
  assert.deepEqual(mutations(f), []);
});

test('JSON cannot forge the manager issuer or skip the explicit whole-source-model unit plan', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.reviewResinProductionPlan({}, f.job.id, { receipt: f.receipt, deviceFingerprint: f.deviceFingerprint, confirmedWholeModel: true }), { code: 'RESIN_AUTHORITY_REQUIRED' });
  await assert.rejects(f.service.issueResinDispatchPermit({}, f.job.id, { qualified: true, ...f.proof() }), { code: 'RESIN_AUTHORITY_REQUIRED' });
  await assert.rejects(f.service.reviewResinProductionPlan(f.issuer, f.job.id, { receipt: f.receipt, deviceFingerprint: f.deviceFingerprint, confirmedWholeModel: false }), { code: 'RESIN_UNIT_PLAN_REQUIRED' });
  await assert.rejects(f.permit(), { code: 'RESIN_UNIT_PLAN_REQUIRED' });
  const plan = await f.plan();
  assert.equal(plan.status, 'review'); assert.equal(plan.artifact, undefined); assert.equal(plan.resinSlice.printReady, false);
  assert.equal(plan.resinProduction.plan.partsPerRun, 1); assert.equal(plan.resinProduction.plan.confirmedWholeModel, true);
  assert.equal(f.receipt.qualified, false, 'historical receipt qualification does not override current authoritative authorization');
  assert.deepEqual(mutations(f), []);
});

test('plan review rejects missing or multiple source-instance proof and receipt/device/hash mismatch', async t => {
  const f = await fixture(t);
  for (const field of ['deviceFingerprint', 'sourceSha256', 'profileSha256']) {
    const receipt = { ...f.receipt, [field]: '0'.repeat(64) };
    await assert.rejects(f.service.reviewResinProductionPlan(f.issuer, f.job.id, { receipt, deviceFingerprint: f.deviceFingerprint, confirmedWholeModel: true }), { code: 'RESIN_RECEIPT_MISMATCH' });
  }
  const original = f.current().resinSlice.modelCopiesPerRun;
  for (const value of [undefined, 2]) {
    await f.service._mutate(() => { f.service._job(f.job.id).resinSlice.modelCopiesPerRun = value; });
    await assert.rejects(f.plan(), { code: 'RESIN_SLICE_UNQUALIFIED' });
  }
  await f.service._mutate(() => { f.service._job(f.job.id).resinSlice.modelCopiesPerRun = original; });
  assert.deepEqual(mutations(f), []);
});

test('fresh authorization must bind every hash, printer profile, device, quantity and portal version', async t => {
  const f = await fixture(t); await f.plan();
  const invalid = [
    { qualified: false }, { printerId: 'other' }, { printerModel: 'other' }, { material: 'other' }, { format: 'ctb' },
    { sourceSha256: '0'.repeat(64) }, { artifactSha256: '0'.repeat(64) }, { profileSha256: '0'.repeat(64) }, { engineSha256: '0'.repeat(64) }, { deviceFingerprint: '0'.repeat(64) },
    { partsPerRun: 2 }, { plannedParts: 2 }, { jobVersion: 9 }, { qualificationFingerprint: '' },
    { checkedAt: new Date(Date.now() - 31000).toISOString() }, { expiresAt: new Date(Date.now() - 1).toISOString() },
  ];
  for (const patch of invalid) {
    const proof = f.proof(); Object.assign(proof.authorization, patch);
    await assert.rejects(f.permit(proof));
  }
  const proof = f.proof(); proof.ticket.production.approvedReceiptId = randomUUID();
  await assert.rejects(f.permit(proof), { code: 'RESIN_AUTHORIZATION_REQUIRED' });
  assert.deepEqual(mutations(f), []);
});

test('a logical profile identity cannot authorize a different configured local printer UUID', async t => {
  const f = await fixture(t, { profilePrinterId: 'legacy-logical-printer' });
  await f.plan();
  assert.equal(f.current().resinSlice.printerId, 'legacy-logical-printer');
  assert.notEqual(f.current().resinSlice.printerId, f.printer.id);
  await assert.rejects(f.permit(), { code: 'RESIN_PRINTER_BINDING_MISMATCH' });
  assert.deepEqual(mutations(f), []);
});

test('a one-use permit needs a fresh per-run readiness confirmation and persists intent before upload/start', async t => {
  const f = await fixture(t); await f.plan();
  const inspection = await f.service.inspectResinPrinter(f.printer.id);
  assert.equal(inspection.deviceFingerprint, f.deviceFingerprint); assert.equal(inspection.device.xyzSize, '41x21x30');
  const permit = await f.permit();
  await assert.rejects(f.service.dispatchQualifiedResinJob(f.job.id, { permitId: permit.permitId }), { code: 'CONFIRMATION_REQUIRED' });
  f.adapter.onUpload = async () => {
    const stored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')).jobs.find(job => job.id === f.job.id);
    assert.equal(stored.status, 'dispatching'); assert.equal(stored.runs.at(-1).phase, 'uploading');
    assert.equal(stored.runs.at(-1).receiptId, f.receipt.id); assert.equal(stored.runs.at(-1).plannedParts, 1);
  };
  f.adapter.onStart = async () => {
    const stored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')).jobs.find(job => job.id === f.job.id);
    assert.equal(stored.runs.at(-1).phase, 'starting'); assert.ok(stored.runs.at(-1).startRequestedAt);
    return { acknowledged: true, remoteId: f.adapter.remoteId, currentFile: f.adapter.remotePath, observedAt: new Date().toISOString() };
  };
  const started = await f.dispatch(permit), run = started.runs.at(-1);
  assert.equal(started.status, 'printing'); assert.equal(started.artifact, undefined);
  assert.deepEqual(run.startEvidence, { remoteId: f.adapter.remoteId, currentFile: f.adapter.remotePath, observedAt: run.startEvidence.observedAt });
  assert.equal(run.deviceFingerprint, f.deviceFingerprint); assert.equal(run.receiptId, f.receipt.id);
  assert.equal(started.acceptedQuantity, 0); assert.equal(started.resinProduction.printedParts, 0);
  await assert.rejects(f.dispatch(permit), { code: 'RESIN_PERMIT_REQUIRED' });
  assert.equal(f.adapter.calls.filter(([action]) => action === 'start').length, 1);
});

test('expired permits and application restart require fresh authorization without touching a device', async t => {
  const f = await fixture(t); await f.plan();
  const permit = await f.permit(), now = Date.now();
  t.mock.method(Date, 'now', () => now + 31000);
  await assert.rejects(f.dispatch(permit), { code: 'RESIN_PERMIT_EXPIRED' });
  t.mock.restoreAll();
  const second = await f.permit(); await f.reopen();
  await assert.rejects(f.dispatch(second), { code: 'RESIN_PERMIT_REQUIRED' });
  assert.deepEqual(mutations(f), []);
});

test('artifact, source, profile and actual device identity are rechecked before upload', async t => {
  for (const changed of ['artifact', 'source', 'profile', 'firmware']) {
    const f = await fixture(t); await f.plan(); const permit = await f.permit();
    if (changed === 'artifact') { const file = f.current().resinSlice.filePath; const bytes = await fs.readFile(file); bytes[0] ^= 1; await fs.writeFile(file, bytes); }
    if (changed === 'source') await fs.appendFile(f.current().inputPath, 'changed');
    if (changed === 'profile') { const profile = JSON.parse(await fs.readFile(f.settings.profilePath)); profile.material = 'Changed profile'; await fs.writeFile(f.settings.profilePath, JSON.stringify(profile)); }
    if (changed === 'firmware') f.adapter.attrs.FirmwareVersion = 'V9.9.9';
    await assert.rejects(f.dispatch(permit));
    assert.deepEqual(mutations(f), []);
  }
});

test('qualified dispatch rejects a hash-consistent GOO with machine height differing from INI before inspecting or commanding a printer', async t => {
  const f = await fixture(t); await f.plan();
  assert.equal(JSON.parse(await fs.readFile(f.settings.profilePath)).expected.machineZMm, undefined);
  const slice = f.current().resinSlice, bytes = await fs.readFile(slice.filePath);
  // Simulate faulty captured evidence with internally matching file/receipt
  // hashes, so rejection must come from authoritative profile geometry.
  bytes.writeFloatBE(31, 195310 + 4 + 2 + 2 + 1 + 1 + 4 + 4);
  await fs.writeFile(slice.filePath, bytes);
  const sha256 = hash(bytes), inspection = inspectGoo(bytes);
  await f.service._mutate(() => { const current = f.service._job(f.job.id).resinSlice; current.sha256 = sha256; current.inspection = inspection; });
  f.receipt.artifact.sha256 = sha256;
  await assert.rejects(f.permit(), { code: 'GOO_PROFILE_MISMATCH' });
  assert.deepEqual(f.adapter.calls, []); assert.deepEqual(mutations(f), []);
});

test('post-upload reauthorization rejects revocation, changed approval or device and never starts', async t => {
  for (const changed of ['revoked', 'qualification', 'version', 'firmware', 'artifact']) {
    const f = await fixture(t); await f.plan();
    f.onReauthorize = async context => {
      assert.equal(context.receiptId, f.receipt.id); assert.equal(context.deviceFingerprint, f.deviceFingerprint); assert.equal(context.plannedParts, 1);
      const proof = f.proof();
      if (changed === 'revoked') proof.authorization.qualified = false;
      if (changed === 'qualification') proof.authorization.qualificationFingerprint = 'b'.repeat(64);
      if (changed === 'version') { proof.ticket.version++; proof.authorization.jobVersion++; }
      if (changed === 'firmware') f.adapter.attrs.FirmwareVersion = 'V9.9.9';
      if (changed === 'artifact') { const file = f.current().resinSlice.filePath; const bytes = await fs.readFile(file); bytes[0] ^= 1; await fs.writeFile(file, bytes); }
      return proof;
    };
    await assert.rejects(f.dispatch());
    const current = f.current(), run = current.runs.at(-1);
    assert.equal(current.status, 'review'); assert.equal(current.currentRunId, null);
    assert.equal(run.outcome, 'not_started'); assert.equal(run.startEvidence, undefined);
    assert.equal(f.adapter.calls.filter(([action]) => action === 'upload').length, 1);
    assert.equal(f.adapter.calls.filter(([action]) => action === 'start').length, 0);
  }
});

test('failure to save the qualified start checkpoint cannot send a physical start command', async t => {
  const f = await fixture(t); await f.plan();
  const save = f.service.store.save.bind(f.service.store);
  let failed = false;
  t.mock.method(f.service.store, 'save', async state => {
    if (!failed && state.jobs.find(job => job.id === f.job.id).runs.at(-1)?.phase === 'starting') {
      failed = true; throw Object.assign(new Error('Fixture disk unavailable'), { code: 'FIXTURE_DISK_FAILURE' });
    }
    return save(state);
  });
  await assert.rejects(f.dispatch(), { code: 'FIXTURE_DISK_FAILURE' });
  assert.equal(f.adapter.calls.filter(([action]) => action === 'upload').length, 1);
  assert.equal(f.adapter.calls.filter(([action]) => action === 'start').length, 0);
  assert.equal(f.current().status, 'review'); assert.equal(f.current().runs.at(-1).outcome, 'not_started');
});

test('authorization expiration during a slow durable checkpoint prevents start even after the intent was saved', async t => {
  const f = await fixture(t); await f.plan();
  const save = f.service.store.save.bind(f.service.store), now = Date.now();
  t.mock.method(f.service.store, 'save', async state => {
    await save(state);
    if (state.jobs.find(job => job.id === f.job.id).runs.at(-1)?.phase === 'starting') t.mock.method(Date, 'now', () => now + 31000);
  });
  await assert.rejects(f.dispatch(), { code: 'RESIN_AUTHORIZATION_CHANGED' });
  t.mock.restoreAll();
  assert.equal(f.adapter.calls.filter(([action]) => action === 'start').length, 0);
  assert.equal(f.current().runs.at(-1).outcome, 'not_started');
  assert.equal(f.current().runs.at(-1).startEvidence, undefined);
});

test('restart resolves upload-only resin intent safely and holds a potentially transmitted start', async t => {
  for (const phase of ['uploaded', 'starting']) {
    const f = await fixture(t); await f.plan();
    await f.service.close();
    const statePath = path.join(f.dataDir, 'state.json'), state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const job = state.jobs.find(item => item.id === f.job.id), runId = randomUUID();
    job.printerId = f.printer.id; job.status = 'dispatching'; job.currentRunId = runId;
    job.runs.push({ id: runId, technology: 'resin', printerId: f.printer.id, printerType: 'sdcp', phase, receiptId: f.receipt.id, plannedParts: 1, remotePath: 'interrupted.goo', startRequestedAt: new Date().toISOString() });
    await fs.writeFile(statePath, JSON.stringify(state));
    await f.reopen();
    const restored = f.current();
    assert.equal(restored.status, phase === 'uploaded' ? 'review' : 'needs_attention');
    assert.equal(restored.currentRunId, phase === 'uploaded' ? null : runId);
    assert.equal(restored.resinProduction.printedParts, 0);
    assert.equal(restored.runs.at(-1).startEvidence, undefined);
    assert.deepEqual(mutations(f), []);
  }
});

test('lost or incomplete SDCP start evidence creates a durable hold and never rebinds by filename', async t => {
  for (const lost of [true, false]) {
    const f = await fixture(t); await f.plan();
    f.adapter.onStart = async () => { if (lost) throw Object.assign(new Error('Start ack lost'), { code: 'SDCP_COMMAND_UNCERTAIN' }); return { acknowledged: true, remoteId: f.adapter.remoteId }; };
    await assert.rejects(f.dispatch());
    let current = f.current(), run = current.runs.at(-1);
    assert.equal(current.status, 'needs_attention'); assert.equal(run.phase, 'result_unknown'); assert.equal(run.startEvidence, undefined); assert.equal(run.remoteId, undefined);
    current = await f.observe({ state: 'printing', currentFile: f.adapter.remotePath, remoteId: f.adapter.remoteId });
    assert.equal(current.status, 'needs_attention'); assert.equal(current.runs.at(-1).startEvidence, undefined);
    await assert.rejects(f.service.reconcileResinRun(f.job.id, { runId: run.id, outcome: 'not_started', printedParts: 0 }), { code: 'RESIN_RUN_ACTIVE' });
    await f.reopen();
    current = await f.observe({ state: 'idle', currentFile: f.adapter.remotePath, remoteId: f.adapter.remoteId, outcome: 'completed' });
    assert.equal(current.runs.at(-1).terminalEvidence, undefined);
    await assert.rejects(f.service.reconcileResinRun(f.job.id, { runId: run.id, outcome: 'completed', printedParts: 1 }), { code: 'RESIN_TERMINAL_EVIDENCE_REQUIRED' });
    assert.equal(f.adapter.calls.filter(([action]) => action === 'start').length, 1);
    assert.equal(f.current().resinProduction.printedParts, 0);
  }
});

test('idle, stale telemetry and partial identities cannot manufacture terminal production evidence', async t => {
  const f = await fixture(t); await f.plan(); const started = await f.dispatch(), run = started.runs.at(-1);
  for (const telemetry of [
    { state: 'idle', progress: 100, remoteId: run.remoteId, currentFile: run.remotePath },
    { state: 'idle', outcome: 'completed', remoteId: run.remoteId, currentFile: 'other.goo' },
    { state: 'idle', outcome: 'completed', currentFile: run.remotePath },
    { state: 'unknown', outcome: 'completed', remoteId: run.remoteId, currentFile: run.remotePath },
    { state: 'idle', outcome: 'completed', remoteId: run.remoteId, currentFile: run.remotePath, observedAt: new Date(Date.now() - 31000).toISOString() },
  ]) {
    const held = await f.observe(telemetry);
    assert.equal(held.runs.at(-1).terminalEvidence, undefined); assert.equal(held.resinProduction.printedParts, 0);
  }
  await assert.rejects(f.service.reconcileResinRun(f.job.id, { runId: run.id, outcome: 'completed', printedParts: 1 }), { code: 'RESIN_TERMINAL_EVIDENCE_REQUIRED' });
});

test('separate confirmed runs satisfy multiple units only after identified completion and operator production review', async t => {
  const f = await fixture(t, { requestedParts: 3 }); await f.plan();
  for (let index = 0; index < 3; index++) {
    const started = await f.dispatch(), run = started.runs.at(-1);
    const completed = await f.observe({ state: 'idle', outcome: 'completed', remoteId: run.remoteId, currentFile: run.remotePath, progress: 100 });
    assert.deepEqual(completed.runs.at(-1).terminalEvidence, { remoteId: run.remoteId, currentFile: run.remotePath, observedAt: completed.runs.at(-1).terminalEvidence.observedAt, outcome: 'completed' });
    assert.equal(completed.resinProduction.printedParts, index, 'printer completion alone is not a counted production unit');
    const reviewed = await f.service.reconcileResinRun(f.job.id, { runId: run.id, outcome: 'completed', printedParts: 1, notes: 'One ordered unit produced; QC remains separate.' });
    assert.equal(reviewed.status, 'review'); assert.equal(reviewed.quantity, 1); assert.equal(reviewed.acceptedQuantity, 0);
    assert.equal(reviewed.resinProduction.printedParts, index + 1); assert.equal(reviewed.resinProduction.remainingParts, 2 - index);
    assert.equal(reviewed.runs.at(-1).reconciliation.printedParts, 1);
    assert.equal(reviewed.resinSlice.printReady, false); assert.equal(reviewed.artifact, undefined);
    await assert.rejects(f.permit(), { code: 'RESIN_PORTAL_PROGRESS_UNCONFIRMED' });
    f.portalPrintedParts++; f.portalVersion++;
  }
  await assert.rejects(f.permit(), { code: 'RESIN_AUTHORIZATION_REQUIRED' });
  assert.equal(f.adapter.calls.filter(([action]) => action === 'start').length, 3);
  assert.equal(f.current().resinProduction.printedParts, 3);
  await f.reopen(); assert.equal(f.current().resinProduction.printedParts, 3); assert.equal(f.current().acceptedQuantity, 0);
});

test('reconciliation is idempotent, forbids overcount and preserves run evidence for portal writeback', async t => {
  const f = await fixture(t); await f.plan(); const started = await f.dispatch(), run = started.runs.at(-1);
  await f.observe({ state: 'idle', outcome: 'completed', remoteId: run.remoteId, currentFile: run.remotePath });
  await assert.rejects(f.service.reconcileResinRun(f.job.id, { runId: run.id, outcome: 'completed', printedParts: 2 }), { code: 'RESIN_RECONCILIATION_INVALID' });
  const input = { runId: run.id, outcome: 'completed', printedParts: 1, notes: 'Observed unit.' };
  const first = await f.service.reconcileResinRun(f.job.id, input), repeated = await f.service.reconcileResinRun(f.job.id, input);
  assert.equal(repeated.resinProduction.printedParts, 1); assert.equal(repeated.runs.at(-1).reconciliation.reviewedAt, first.runs.at(-1).reconciliation.reviewedAt);
  const evidence = repeated.runs.at(-1);
  assert.ok(evidence.startEvidence && evidence.terminalEvidence && evidence.reconciliation);
  assert.equal(evidence.receiptId, f.receipt.id); assert.equal(evidence.deviceFingerprint, f.deviceFingerprint); assert.equal(evidence.plannedParts, 1);
  await assert.rejects(f.service.reconcileResinRun(f.job.id, { runId: run.id, outcome: 'failed', printedParts: 0 }), { code: 'STALE_RECONCILIATION' });
});

test('zero-unit reconciliation checks that printing stopped and its retry remains idempotent during a later print', async t => {
  const f = await fixture(t); await f.plan(); const started = await f.dispatch(), run = started.runs.at(-1);
  await f.observe({ state: 'unknown', remoteId: run.remoteId, currentFile: run.remotePath });
  f.adapter.telemetry = { state: 'printing', remoteId: run.remoteId, currentFile: run.remotePath };
  const input = { runId: run.id, outcome: 'failed', printedParts: 0, notes: 'No accepted production unit.' };
  await assert.rejects(f.service.reconcileResinRun(f.job.id, input), { code: 'RESIN_RUN_ACTIVE' });
  f.adapter.telemetry = { state: 'idle', remoteId: run.remoteId, currentFile: run.remotePath, outcome: 'failed' };
  const resolved = await f.service.reconcileResinRun(f.job.id, input);
  assert.equal(resolved.resinProduction.printedParts, 0);
  f.adapter.telemetry = { state: 'printing', remoteId: 'unrelated-later-task', currentFile: 'unrelated.goo' };
  const repeated = await f.service.reconcileResinRun(f.job.id, input);
  assert.equal(repeated.runs.at(-1).reconciliation.reviewedAt, resolved.runs.at(-1).reconciliation.reviewedAt);
});

test('a zero-unit failed run clears its approval hold so a new candidate can be prepared without losing physical history', async t => {
  const f = await fixture(t); await f.plan();
  await f.service.withResinPreparationEvidence(f.issuer, f.job.id, { receipt: f.receipt, deviceFingerprint: f.deviceFingerprint }, async () => ({ ticket: f.proof().ticket }));
  assert.equal(f.current().resinProduction.plan.approvalState, 'approved');
  const started = await f.dispatch(), run = started.runs.at(-1);
  await f.observe({ state: 'idle', outcome: 'failed', remoteId: run.remoteId, currentFile: run.remotePath });
  await f.service.reconcileResinRun(f.job.id, { runId: run.id, outcome: 'failed', printedParts: 0, notes: 'No production unit; prepare a new candidate.' });
  assert.equal(f.current().resinProduction.plan.approvalState, undefined);
  await f.service.sliceResinJob(f.job.id, CONFIRMED);
  const current = f.current();
  assert.equal(current.resinProduction.printedParts, 0);
  assert.equal(current.runs.at(-1).receiptId, f.receipt.id);
  assert.ok(current.runs.at(-1).startEvidence); assert.ok(current.runs.at(-1).terminalEvidence); assert.ok(current.runs.at(-1).reconciliation);
  assert.equal(current.resinSlice.printReady, false);
});
