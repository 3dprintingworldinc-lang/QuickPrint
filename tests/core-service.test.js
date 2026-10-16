'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');

function fakePrinter() {
  const adapter = {
    capabilities: { upload: true, start: true, pause: true, resume: true, cancel: true, formats: ['gcode'] },
    telemetry: { state: 'idle' }, calls: [],
    async status() { return { observedAt: new Date().toISOString(), ...this.telemetry }; },
    async upload(input) { this.calls.push(['upload', input]); this.remotePath = input.fileName; return { remotePath: input.fileName }; },
    async start(input) { this.calls.push(['start', input]); this.remoteId = input.jobId; return { acknowledged: true, remoteId: input.jobId }; },
    async pause() { this.calls.push(['pause']); },
    async resume() { this.calls.push(['resume']); },
    async cancel() { this.calls.push(['cancel']); },
    close() { this.closed = true; },
  };
  return adapter;
}

async function fakePrepare({ inputPath, outputDir }) {
  const filePath = path.join(outputDir, 'prepared.gcode');
  const bytes = Buffer.concat([Buffer.from('; prepared fixture\n'), await fs.readFile(inputPath)]);
  await fs.writeFile(filePath, bytes);
  return { filePath, fileName: 'prepared.gcode', format: 'gcode', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), profileFingerprint: 'test-profile-v1' };
}

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-core-'));
  const adapter = fakePrinter();
  const constructor = { dataDir, adapters: () => adapter, slicer: fakePrepare, ...options };
  let service = new QuickPrintService(constructor);
  await service.init();
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, adapter, get service() { return service; },
    async reopen() { await service.close(); service = new QuickPrintService(constructor); await service.init(); return service; },
    async printer(overrides = {}) { return service.savePrinter({ name: 'Test printer', type: 'fixture', host: 'printer.invalid', ...overrides }); },
    async job(overrides = {}) { return (await service.submit({ source: 'test', files: [{ name: 'part.stl', data: Buffer.from('solid fixture') }], ...overrides })).jobs[0]; },
    async ready(overrides = {}) { const printer = await this.printer(); const job = await this.job(overrides); await service.prepareJob(job.id, printer.id); return { printer, job: service.getJob(job.id) }; },
    async finish(job, printer, acceptedQuantity = 1) {
      adapter.telemetry = { state: 'idle', currentFile: adapter.remotePath, remoteId: adapter.remoteId, progress: 100, outcome: 'completed' };
      await service.testPrinter(printer.id);
      return service.reconcileJob(job.id, { outcome: 'completed', acceptedQuantity, runId: service.getJob(job.id).currentRunId });
    },
  };
}

test('starts empty, persists multi-file source identity, and allows intentional repeat orders', async (t) => {
  const env = await fixture(t);
  assert.equal(env.service.snapshot().jobs.length, 0);
  assert.equal(env.service.snapshot().printers.length, 0);
  const request = { source: 'website', sourceId: 'order-100', quantity: 2, files: [
    { name: 'a.stl', data: Buffer.from('A') }, { name: 'b.step', data: Buffer.from('B'), quantity: 4 },
  ] };
  const [first, retry] = await Promise.all([env.service.submit(request), env.service.submit(request)]);
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.deepEqual(first.jobs.map((job) => job.id), retry.jobs.map((job) => job.id));
  assert.equal(first.jobs[0].submissionId, first.jobs[1].submissionId);
  assert.deepEqual(first.jobs.map((job) => job.quantity), [2, 4]);
  assert.equal(await fs.readFile(first.jobs[1].inputPath, 'utf8'), 'B');
  await env.reopen();
  assert.equal((await env.service.submit(request)).duplicate, true);
  const intentional = await env.service.submit({ ...request, sourceId: 'order-101' });
  assert.equal(intentional.duplicate, false);
  assert.equal(env.service.snapshot().jobs.length, 4);
});

test('invalid batch does not create a partial order; names cannot escape original storage', async (t) => {
  const env = await fixture(t);
  await assert.rejects(env.service.submit({ files: [{ name: 'good.stl', data: Buffer.from('a') }, { name: 'bad.exe', data: Buffer.from('b') }] }), { code: 'FILE_TYPE' });
  assert.equal(env.service.snapshot().jobs.length, 0);
  const job = await env.job({ files: [{ name: '../../' + '很'.repeat(100) + '.stl', data: Buffer.from('a') }] });
  assert.equal(path.extname(job.fileName), '.stl');
  assert.ok(Buffer.byteLength(job.fileName) <= 180);
  assert.ok(job.inputPath.startsWith(path.join(env.dataDir, 'jobs')));
  assert.ok(!job.fileName.includes('/'));
});

test('printer and mailbox secrets persist encrypted, stay redacted, and blank updates preserve them', async (t) => {
  const env = await fixture(t);
  const printer = await env.printer({ apiKey: 'printer-secret-123', password: 'printer-password', accessCode: '87654321' });
  const connector = await env.service.saveConnector({ type: 'email', name: 'Inbox', host: 'mail.invalid', password: 'mailbox-secret-123' });
  await env.service.savePrinter({ id: printer.id, name: 'Renamed', apiKey: '', password: '' });
  await env.service.saveConnector({ id: connector.id, password: '' });
  await env.service.recordEvent({ message: 'password=printer-password Bearer printer-secret-123 mailbox-secret-123', type: 'diagnostic' });
  const publicSnapshot = JSON.stringify(env.service.snapshot());
  const onDisk = await fs.readFile(path.join(env.dataDir, 'state.json'), 'utf8');
  for (const secret of ['printer-secret-123', 'printer-password', 'mailbox-secret-123', '87654321']) {
    assert.ok(!publicSnapshot.includes(secret));
    assert.ok(!onDisk.includes(secret));
  }
  assert.equal(env.service.getPrinter(printer.id).hasApiKey, true);
  assert.equal(env.service.getConnectors({ secrets: true })[0].password, 'mailbox-secret-123');
  await env.reopen();
  assert.equal(env.service.getPrinter(printer.id).name, 'Renamed');
  assert.equal(env.service.getConnectors({ secrets: true })[0].password, 'mailbox-secret-123');
  assert.equal(env.service.getSettings({ secrets: true }).intake.token.length > 24, true);
});

test('injected encryption supports async string wrappers and data is isolated from returned views', async (t) => {
  const secretKey = crypto.randomBytes(32);
  const seal = async (secret) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    return Buffer.concat([iv, c.update(secret), c.final(), c.getAuthTag()]).toString('base64');
  };
  const unseal = async (encoded) => {
    const b = Buffer.from(encoded, 'base64');
    const c = crypto.createDecipheriv('aes-256-gcm', secretKey, b.subarray(0, 12));
    c.setAuthTag(b.subarray(-16));
    return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString();
  };
  const env = await fixture(t, { seal, unseal });
  const job = await env.job();
  job.quantity = 999;
  const settings = env.service.getSettings({ secrets: true });
  const originalToken = settings.intake.token;
  settings.intake.token = 'changed-in-caller';
  await env.reopen();
  assert.equal(env.service.getJob(job.id).quantity, 1);
  assert.equal(env.service.getSettings({ secrets: true }).intake.token, originalToken);
  await assert.rejects(fs.access(path.join(env.dataDir, 'secret.key')), { code: 'ENOENT' });
});

test('another writer is refused and corrupt state is never reset', async (t) => {
  const env = await fixture(t);
  const other = new QuickPrintService({ dataDir: env.dataDir });
  await assert.rejects(other.init(), { code: 'STATE_LOCKED' });
  await env.service.close();
  const file = path.join(env.dataDir, 'state.json');
  await fs.writeFile(file, '{damaged');
  const broken = new QuickPrintService({ dataDir: env.dataDir });
  await assert.rejects(broken.init(), { code: 'STATE_CORRUPT' });
  assert.equal(await fs.readFile(file, 'utf8'), '{damaged');
});

test('preparation failures retain originals and never create a ready artifact', async (t) => {
  const env = await fixture(t, { slicer: { prepare: async () => { throw new Error('Configure a slicer executable.'); } } });
  const printer = await env.printer();
  const job = await env.job();
  await assert.rejects(env.service.prepareJob(job.id, printer.id), /Configure a slicer/);
  assert.equal(env.service.getJob(job.id).status, 'review');
  assert.equal(env.service.getJob(job.id).artifact, undefined);
  assert.equal(await fs.readFile(job.inputPath, 'utf8'), 'solid fixture');
  assert.equal(env.adapter.calls.length, 0);
});

test('every confirmed run is one copy; finished printing needs sign-off and repeat resolution is idempotent', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready({ quantity: 2 });
  await assert.rejects(env.service.dispatchJob(job.id, printer.id), { code: 'CONFIRMATION_REQUIRED' });
  const started = await env.service.dispatchJob(job.id, printer.id, { confirmed: true });
  assert.equal(started.status, 'printing');
  assert.equal(started.completedQuantity, 0);
  const firstRun = started.currentRunId;
  env.adapter.telemetry = { state: 'idle', currentFile: env.adapter.remotePath, remoteId: env.adapter.remoteId, outcome: 'completed', progress: 100 };
  await env.service.testPrinter(printer.id);
  const pending = env.service.getJob(job.id);
  assert.equal(pending.status, 'needs_attention');
  assert.equal(pending.completedQuantity, 1);
  assert.equal(pending.acceptedQuantity, 0);
  const accepted = await env.service.reconcileJob(job.id, { outcome: 'completed', acceptedQuantity: 1, runId: firstRun });
  assert.equal(accepted.status, 'ready');
  assert.equal(accepted.remainingQuantity, 1);
  await env.service.reconcileJob(job.id, { outcome: 'completed', acceptedQuantity: 1, runId: firstRun });
  assert.equal(env.service.getJob(job.id).acceptedQuantity, 1);
  env.adapter.telemetry = { state: 'idle' };
  const second = await env.service.dispatchJob(job.id, printer.id, { confirmed: true });
  assert.notEqual(second.currentRunId, firstRun);
  await env.service.reconcileJob(job.id, { outcome: 'completed', acceptedQuantity: 1, runId: firstRun });
  assert.equal(env.service.getJob(job.id).status, 'printing', 'stale retry does not accept the new run');
  const finished = await env.finish(job, printer);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.completedQuantity, 2);
  assert.equal(finished.acceptedQuantity, 2);
  assert.equal(finished.remainingQuantity, 0);
  assert.equal(env.adapter.calls.filter(([kind]) => kind === 'start').length, 2);
});

test('rejected completed copy is counted physically but does not fulfill the requested quantity', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  await env.service.dispatchJob(job.id, printer.id, { confirmed: true });
  const rejected = await env.finish(job, printer, 0);
  assert.equal(rejected.completedQuantity, 1);
  assert.equal(rejected.acceptedQuantity, 0);
  assert.equal(rejected.remainingQuantity, 1);
  assert.equal(rejected.status, 'ready');
});

test('progress or idle status alone never credits completion and wrong remote IDs cannot claim a job', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  await env.service.dispatchJob(job.id, printer.id, { confirmed: true });
  env.adapter.telemetry = { state: 'printing', currentFile: env.adapter.remotePath, remoteId: env.adapter.remoteId, progress: 80 };
  await env.service.testPrinter(printer.id);
  env.adapter.telemetry = { state: 'idle', currentFile: env.adapter.remotePath, remoteId: env.adapter.remoteId, progress: 100 };
  await env.service.testPrinter(printer.id);
  assert.equal(env.service.getJob(job.id).status, 'needs_attention');
  assert.equal(env.service.getJob(job.id).completedQuantity, 0);
  env.adapter.telemetry = { state: 'idle', currentFile: env.adapter.remotePath, remoteId: 'another-run', progress: 100, outcome: 'completed' };
  await env.service.testPrinter(printer.id);
  assert.equal(env.service.getJob(job.id).completedQuantity, 0);
});

test('generic Bambu telemetry filename can reconcile by unique remote run ID', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  const started = await env.service.dispatchJob(job.id, printer.id, { confirmed: true });
  assert.equal(env.adapter.remoteId, started.currentRunId);
  env.adapter.telemetry = { state: 'idle', currentFile: 'Metadata/plate_1.gcode', remoteId: started.currentRunId, outcome: 'completed' };
  await env.service.testPrinter(printer.id);
  assert.equal(env.service.getJob(job.id).completedQuantity, 1);
});

test('ambiguous start is durable across restart and cannot be blindly retried or edited away', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  env.adapter.start = async function (input) { this.calls.push(['start', input]); throw new Error('Connection dropped after command.'); };
  await assert.rejects(env.service.dispatchJob(job.id, printer.id, { confirmed: true }), /Connection dropped/);
  assert.equal(env.service.getJob(job.id).status, 'needs_attention');
  await assert.rejects(env.service.dispatchJob(job.id, printer.id, { confirmed: true }), { code: 'JOB_NOT_READY' });
  await assert.rejects(env.service.removePrinter(printer.id), { code: 'PRINTER_BUSY' });
  await assert.rejects(env.service.savePrinter({ id: printer.id, host: 'other.invalid' }), { code: 'PRINTER_BUSY' });
  await env.reopen();
  assert.equal(env.service.getJob(job.id).status, 'needs_attention');
  assert.equal(env.adapter.calls.filter(([kind]) => kind === 'start').length, 1);
  await env.service.reconcileJob(job.id, { outcome: 'not_started', acceptedQuantity: 0 });
  assert.equal(env.service.getJob(job.id).status, 'ready');
  assert.equal(env.service.getJob(job.id).completedQuantity, 0);
});

test('upload failure stays retryable without claiming any start or production', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  env.adapter.upload = async function () { this.calls.push(['upload']); throw new Error('Upload interrupted.'); };
  await assert.rejects(env.service.dispatchJob(job.id, printer.id, { confirmed: true }), /Upload interrupted/);
  const current = env.service.getJob(job.id);
  assert.equal(current.status, 'ready');
  assert.equal(current.currentRunId, null);
  assert.equal(current.completedQuantity, 0);
  assert.equal(env.adapter.calls.filter(([kind]) => kind === 'start').length, 0);
});

test('stale status and artifact modification prevent dispatch before network mutation', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  env.adapter.telemetry = { state: 'idle', observedAt: new Date(Date.now() - 60000).toISOString() };
  await assert.rejects(env.service.dispatchJob(job.id, printer.id, { confirmed: true }), { code: 'PRINTER_NOT_READY' });
  env.adapter.telemetry = { state: 'idle' };
  await fs.appendFile(env.service.getJob(job.id).artifact.filePath, 'tampered');
  await assert.rejects(env.service.dispatchJob(job.id, printer.id, { confirmed: true }), { code: 'ARTIFACT_CHANGED' });
  assert.equal(env.adapter.calls.length, 0);
});

test('concurrent jobs cannot acquire the same physical printer', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  const other = await env.job();
  await env.service.prepareJob(other.id, printer.id);
  const outcomes = await Promise.allSettled([
    env.service.dispatchJob(job.id, printer.id, { confirmed: true }),
    env.service.dispatchJob(other.id, printer.id, { confirmed: true }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(env.adapter.calls.filter(([kind]) => kind === 'start').length, 1);
  assert.equal(outcomes.find((item) => item.status === 'rejected').reason.code, 'PRINTER_BUSY');
});

test('controls refuse a different physical print and cancellation waits for resolution', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  await env.service.dispatchJob(job.id, printer.id, { confirmed: true });
  env.adapter.telemetry = { state: 'printing', currentFile: 'someone-else.gcode' };
  await assert.rejects(env.service.controlJob(job.id, 'cancel'), { code: 'PRINT_IDENTITY_UNKNOWN' });
  env.adapter.telemetry = { state: 'printing', currentFile: env.adapter.remotePath, remoteId: env.adapter.remoteId };
  const cancelled = await env.service.controlJob(job.id, 'cancel');
  assert.equal(cancelled.status, 'needs_attention');
  assert.equal(cancelled.acceptedQuantity, 0);
  const resolved = await env.service.reconcileJob(job.id, { outcome: 'cancelled', acceptedQuantity: 0 });
  assert.equal(resolved.status, 'cancelled');
  assert.equal(resolved.remainingQuantity, 1);
});

test('restart distinguishes upload intent from a potentially transmitted start', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  await env.service.close();
  const statePath = path.join(env.dataDir, 'state.json');
  let state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.jobs[0].status = 'dispatching';
  state.jobs[0].currentRunId = 'interrupted-upload';
  state.jobs[0].runs.push({ id: 'interrupted-upload', printerId: printer.id, phase: 'uploading' });
  await fs.writeFile(statePath, JSON.stringify(state));
  await env.reopen();
  assert.equal(env.service.getJob(job.id).status, 'ready');
  assert.equal(env.service.getJob(job.id).currentRunId, null);
  await env.service.close();
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.jobs[0].status = 'dispatching';
  state.jobs[0].currentRunId = 'interrupted-start';
  state.jobs[0].runs.push({ id: 'interrupted-start', printerId: printer.id, phase: 'starting' });
  await fs.writeFile(statePath, JSON.stringify(state));
  await env.reopen();
  assert.equal(env.service.getJob(job.id).status, 'needs_attention');
  assert.equal(env.adapter.calls.length, 0);
});

test('precomputed firmware identity recovers a timed-out start without sending it again', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  env.adapter.deriveRemoteId = (runId) => String(parseInt(crypto.createHash('sha256').update(runId).digest('hex').slice(0, 7), 16));
  env.adapter.start = async function (input) {
    this.calls.push(['start', input]);
    this.remoteId = this.deriveRemoteId(input.jobId);
    throw new Error('Start response was lost.');
  };
  await assert.rejects(env.service.dispatchJob(job.id, printer.id, { confirmed: true }), /response was lost/);
  const run = env.service.getJob(job.id).runs.at(-1);
  assert.equal(run.remoteId, env.adapter.remoteId);
  env.adapter.telemetry = { state: 'printing', remoteId: env.adapter.remoteId, currentFile: 'Metadata/plate_1.gcode' };
  await env.service.testPrinter(printer.id);
  assert.equal(env.service.getJob(job.id).status, 'printing');
  assert.equal(env.adapter.calls.filter(([kind]) => kind === 'start').length, 1);
});

test('per-printer slicer configuration is snapshotted and changes invalidate its prepared artifact', async (t) => {
  let received;
  const env = await fixture(t, { slicer: async (input) => { received = input; return fakePrepare(input); } });
  const printer = await env.printer({ slicer: { kind: 'prusa', executable: '/test/slicer', profilePaths: ['/test/profile.ini'], extraArgs: [] } });
  const job = await env.job();
  await env.service.prepareJob(job.id, printer.id);
  assert.equal(received.printer.slicer.kind, 'prusa');
  await env.service.updateSettings({ slicer: { kind: 'orca', profilePaths: ['/new/global.json'] } });
  assert.equal(env.service.getJob(job.id).status, 'ready', 'global changes do not rewrite an immutable prepared artifact');
  await env.service.savePrinter({ id: printer.id, slicer: { profilePaths: ['/test/changed.ini'] } });
  assert.equal(env.service.getJob(job.id).status, 'review');
  assert.equal(env.service.getJob(job.id).artifact, undefined);
});

test('idle barrier waits for an in-progress preparation and its durable commit', async (t) => {
  let release, entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const env = await fixture(t, { slicer: async (input) => { entered(); await blocked; return fakePrepare(input); } });
  const printer = await env.printer();
  const job = await env.job();
  const preparing = env.service.prepareJob(job.id, printer.id);
  await started;
  let idle = false;
  const barrier = env.service.waitForIdle().then(() => { idle = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idle, false);
  release();
  await preparing;
  await barrier;
  assert.equal(idle, true);
  const persisted = JSON.parse(await fs.readFile(path.join(env.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.jobs[0].status, 'ready');
});

test('a failed durable start checkpoint cannot send a physical start command', async (t) => {
  const env = await fixture(t);
  const { job, printer } = await env.ready();
  const save = env.service.store.save.bind(env.service.store);
  env.service.store.save = async (state) => {
    if (state.jobs.some((item) => item.runs.some((run) => run.phase === 'starting'))) throw new Error('Storage unavailable.');
    return save(state);
  };
  await assert.rejects(env.service.dispatchJob(job.id, printer.id, { confirmed: true }), /Storage unavailable/);
  assert.equal(env.adapter.calls.filter(([kind]) => kind === 'start').length, 0);
  const persisted = JSON.parse(await fs.readFile(path.join(env.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.jobs[0].runs.at(-1).phase, 'uploading');
  env.service.store.save = save;
  await env.reopen();
  assert.equal(env.service.getJob(job.id).status, 'ready');
});

test('shutdown aborts active preparation, waits for cleanup, and persists a restartable review state', { timeout: 2000 }, async (t) => {
  let entered, cleanedUp = false;
  const started = new Promise((resolve) => { entered = resolve; });
  const env = await fixture(t, {
    slicer: async ({ signal }) => {
      assert.ok(signal instanceof AbortSignal);
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const printer = await env.printer();
  const job = await env.job();
  const preparing = env.service.prepareJob(job.id, printer.id);
  const rejected = assert.rejects(preparing.finally(() => { cleanedUp = true; }), { code: 'PREPARATION_SHUTDOWN' });
  await started;
  await env.service.close();
  await rejected;
  assert.equal(cleanedUp, true);
  const persisted = JSON.parse(await fs.readFile(path.join(env.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.jobs[0].status, 'review');
  assert.match(persisted.jobs[0].error, /closing/);
  assert.equal(env.adapter.calls.length, 0);
  await env.reopen();
  assert.equal(env.service.getJob(job.id).status, 'review');
});

test('operator cancellation aborts preparation and remains cancelled after restart', { timeout: 2000 }, async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const env = await fixture(t, {
    slicer: async ({ signal }) => {
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Slicer stopped.')), { once: true }));
    },
  });
  const printer = await env.printer();
  const job = await env.job();
  const preparing = env.service.prepareJob(job.id, printer.id);
  const rejected = assert.rejects(preparing, { code: 'PREPARATION_CANCELLED' });
  await started;
  const result = await env.service.controlJob(job.id, 'cancel');
  await rejected;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.artifact, undefined);
  assert.equal(result.error, undefined);
  assert.equal(env.adapter.calls.length, 0);
  await env.reopen();
  assert.equal(env.service.getJob(job.id).status, 'cancelled');
});

test('queued preparation cannot start after shutdown has begun', { timeout: 2000 }, async (t) => {
  let entered, calls = 0;
  const started = new Promise((resolve) => { entered = resolve; });
  const env = await fixture(t, {
    slicer: async ({ signal }) => {
      calls += 1;
      entered();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const printer = await env.printer();
  const job = await env.job();
  const other = await env.job();
  const preparing = env.service.prepareJob(job.id, printer.id);
  const firstRejected = assert.rejects(preparing, { code: 'PREPARATION_SHUTDOWN' });
  await started;
  const waiting = env.service.prepareJob(other.id, printer.id);
  const secondRejected = assert.rejects(waiting, { code: 'NOT_READY' });
  await env.service.close();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(calls, 1);
});

test('null printer slicer override restores site configuration and invalidates its prepared artifact', async (t) => {
  const env = await fixture(t);
  const printer = await env.printer({ slicer: { kind: 'prusa', profilePaths: ['/test/override.ini'] } });
  const job = await env.job();
  await env.service.prepareJob(job.id, printer.id);
  const updated = await env.service.savePrinter({ id: printer.id, slicer: null });
  assert.equal(updated.slicer, undefined);
  assert.equal(env.service.getJob(job.id).status, 'review');
  await env.reopen();
  assert.equal(env.service.getPrinter(printer.id).slicer, undefined);
});
