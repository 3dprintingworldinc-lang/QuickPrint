'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { adapterCatalog, createAdapter } = require('../src/adapters');
const { SDCPAdapter } = require('../src/adapters/sdcp');

// Service ownership tests use the legacy manual model-job path and injected
// GOO metadata. These fixture bytes are not a physically qualified resin file.
// No real slicer, SDCP transport, discovery or printer is invoked here.
async function fixturePrepare({ inputPath, outputDir }) {
  const bytes = Buffer.concat([Buffer.from('SDCP service fixture only\n'), await fs.readFile(inputPath)]);
  const filePath = path.join(outputDir, 'prepared.goo');
  await fs.writeFile(filePath, bytes);
  return { filePath, fileName: 'prepared.goo', format: 'goo', sha256: createHash('sha256').update(bytes).digest('hex'), profileFingerprint: 'synthetic-service-profile' };
}

async function fixture(t, { ambiguousStart = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-sdcp-service-'));
  const adapter = {
    capabilities: { upload: true, start: true, pause: true, resume: true, cancel: true, formats: ['goo', 'ctb'], discovery: false },
    calls: [], telemetry: { state: 'idle' },
    async status() { return { observedAt: new Date().toISOString(), ...this.telemetry }; },
    async upload(input) { this.calls.push(['upload', input]); this.remotePath = input.fileName; return { remotePath: input.fileName }; },
    async start(input) {
      this.calls.push(['start', input]); this.remoteId = 'synthetic-printer-task-1';
      if (ambiguousStart) throw Object.assign(new Error('SDCP start result is uncertain.'), { code: 'SDCP_START_UNCERTAIN', uncertain: true, status: 504 });
      return { acknowledged: true, remoteId: this.remoteId };
    },
    async pause() { this.calls.push(['pause']); return { acknowledged: true }; },
    async resume() { this.calls.push(['resume']); return { acknowledged: true }; },
    async cancel() { this.calls.push(['cancel']); return { acknowledged: true }; },
    async close() {},
  };
  const options = { dataDir, adapters: () => adapter, slicer: fixturePrepare };
  let service = new QuickPrintService(options);
  await service.init();
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const printer = await service.savePrinter({ name: 'Synthetic SDCP target', type: 'sdcp', host: 'sdcp-fixture.invalid', port: 3030, mainboardId: '0123456789abcdef', brandId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', model: 'Saturn 4 Ultra 16K' });
  const job = (await service.submit({ source: 'test', files: [{ name: 'part.stl', data: Buffer.from('solid synthetic_model\nendsolid synthetic_model\n') }] })).jobs[0];
  assert.equal(job.technology, undefined, 'this exercises the manual unit-test path, not qualified resin production dispatch');
  await service.prepareJob(job.id, printer.id);
  return {
    dataDir, adapter, printer, job,
    get service() { return service; },
    async start() { return service.dispatchJob(job.id, printer.id, { confirmed: true }); },
    current() { return service.getJob(job.id); },
    async observe(telemetry) { adapter.telemetry = telemetry; await service.testPrinter(printer.id); return service.getJob(job.id); },
    async reopen(transform) {
      await service.close();
      if (transform) {
        const statePath = path.join(dataDir, 'state.json');
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        transform(state);
        await fs.writeFile(statePath, JSON.stringify(state));
      }
      service = new QuickPrintService(options);
      await service.init();
    }
  };
}

function mutations(adapter) { return adapter.calls.filter(([action]) => ['pause', 'resume', 'cancel'].includes(action)); }
function assertNoCredit(job) { assert.equal(job.completedQuantity, 0); assert.equal(job.acceptedQuantity, 0); assert.equal(job.remainingQuantity, 1); }

test('SDCP catalog exposes explicit discovery IDs and transport capability without scanning or connecting', async () => {
  const entry = adapterCatalog().find(adapter => adapter.type === 'sdcp');
  assert.ok(entry);
  assert.equal(entry.defaultPort, 3030);
  assert.ok(entry.fields.includes('mainboardId'));
  assert.ok(entry.fields.includes('brandId'));
  assert.deepEqual(entry.capabilities.formats, ['goo', 'ctb']);
  assert.equal(entry.capabilities.discovery, false);
  const adapter = createAdapter({ type: 'sdcp', host: 'sdcp-fixture.invalid', mainboardId: '0123456789abcdef', brandId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.ok(adapter instanceof SDCPAdapter);
  assert.equal(adapter.client, null, 'constructing a configured adapter performs no network I/O');
  await adapter.close();
});

test('SDCP discovery identity persists and either identity change invalidates the prepared artifact', async t => {
  const f = await fixture(t);
  await f.reopen();
  assert.equal(f.service.getPrinter(f.printer.id).mainboardId, '0123456789abcdef');
  assert.equal(f.service.getPrinter(f.printer.id).brandId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(f.current().artifact.format, 'goo');
  await f.service.savePrinter({ id: f.printer.id, mainboardId: 'fedcba9876543210' });
  assert.equal(f.current().status, 'review');
  assert.equal(f.current().artifact, undefined);
  await f.service.prepareJob(f.job.id, f.printer.id);
  await f.service.savePrinter({ id: f.printer.id, brandId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.equal(f.current().status, 'review');
  assert.equal(f.current().artifact, undefined);
  assert.equal(f.adapter.calls.length, 0);
});

test('SDCP freezes printer type on the durable run so restored configuration cannot enable filename fallback', async t => {
  const f = await fixture(t);
  const started = await f.start();
  assert.equal(started.runs.at(-1).printerType, 'sdcp');
  assert.equal(started.runs.at(-1).remoteId, f.adapter.remoteId);
  await assert.rejects(f.service.savePrinter({ id: f.printer.id, type: 'fixture' }), { code: 'PRINTER_BUSY' });
  // Simulate restored historical configuration independently of the frozen run.
  // The application itself refuses this edit while a run is unresolved.
  await f.reopen(state => { state.printers[0].type = 'fixture'; });
  assert.equal(f.current().runs.at(-1).printerType, 'sdcp');
  await f.observe({ state: 'printing', currentFile: f.adapter.remotePath });
  await assert.rejects(f.service.controlJob(f.job.id, 'pause'), { code: 'PRINT_IDENTITY_UNKNOWN' });
  assert.equal(f.current().status, 'needs_attention');
  assertNoCredit(f.current());
  assert.deepEqual(mutations(f.adapter), []);
});

test('SDCP refuses controls with a missing task, missing filename or different task despite a partial match', async t => {
  const f = await fixture(t);
  await f.start();
  const identities = [
    { currentFile: f.adapter.remotePath },
    { remoteId: f.adapter.remoteId },
    { currentFile: f.adapter.remotePath, remoteId: 'different-printer-task' },
  ];
  for (const partial of identities) {
    for (const [action, state] of [['pause', 'printing'], ['resume', 'paused'], ['cancel', 'printing']]) {
      f.adapter.telemetry = { state, ...partial };
      await assert.rejects(f.service.controlJob(f.job.id, action), { code: 'PRINT_IDENTITY_UNKNOWN' });
    }
  }
  assertNoCredit(f.current());
  assert.deepEqual(mutations(f.adapter), []);
  assert.equal(f.adapter.calls.filter(([action]) => action === 'start').length, 1);
});

test('SDCP matching task ID with a different filename holds controls and cannot claim terminal completion', async t => {
  const f = await fixture(t);
  await f.start();
  const pending = await f.observe({ state: 'printing', currentFile: 'unrelated.goo', remoteId: f.adapter.remoteId, progress: 30 });
  assert.equal(pending.status, 'needs_attention');
  await assert.rejects(f.service.controlJob(f.job.id, 'cancel'), { code: 'PRINT_IDENTITY_UNKNOWN' });
  const finished = await f.observe({ state: 'idle', currentFile: 'unrelated.goo', remoteId: f.adapter.remoteId, progress: 100, outcome: 'completed' });
  assert.equal(finished.status, 'needs_attention');
  assert.equal(finished.runs.at(-1).outcome, undefined);
  assertNoCredit(finished);
  assert.deepEqual(mutations(f.adapter), []);
});

test('SDCP matching task and filename allow controls while cancel still awaits operator reconciliation', async t => {
  const f = await fixture(t);
  await f.start();
  await f.observe({ state: 'printing', currentFile: f.adapter.remotePath, remoteId: f.adapter.remoteId, progress: 10 });
  await f.service.controlJob(f.job.id, 'pause');
  f.adapter.telemetry = { state: 'paused', currentFile: f.adapter.remotePath, remoteId: f.adapter.remoteId };
  await f.service.controlJob(f.job.id, 'resume');
  f.adapter.telemetry = { state: 'printing', currentFile: f.adapter.remotePath, remoteId: f.adapter.remoteId };
  const cancelled = await f.service.controlJob(f.job.id, 'cancel');
  assert.equal(cancelled.status, 'needs_attention');
  assertNoCredit(cancelled);
  assert.deepEqual(mutations(f.adapter).map(([action]) => action), ['pause', 'resume', 'cancel']);
});

test('SDCP identified idle at 100 percent earns no credit; matched terminal completion requires acceptance', async t => {
  const f = await fixture(t);
  const started = await f.start();
  const identity = { currentFile: f.adapter.remotePath, remoteId: f.adapter.remoteId };
  await f.observe({ state: 'printing', ...identity, progress: 80 });
  const idle = await f.observe({ state: 'idle', ...identity, progress: 100 });
  assert.equal(idle.status, 'needs_attention');
  assertNoCredit(idle);
  const finished = await f.observe({ state: 'idle', ...identity, progress: 100, outcome: 'completed' });
  assert.equal(finished.status, 'needs_attention');
  assert.equal(finished.runs.at(-1).phase, 'awaiting_review');
  assert.equal(finished.completedQuantity, 1);
  assert.equal(finished.acceptedQuantity, 0);
  assert.equal(finished.remainingQuantity, 1);
  await assert.rejects(f.start(), { code: 'JOB_NOT_READY' });
  const accepted = await f.service.reconcileJob(f.job.id, { outcome: 'completed', acceptedQuantity: 1, runId: started.currentRunId });
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.acceptedQuantity, 1);
  assert.equal(accepted.remainingQuantity, 0);
});

test('SDCP ambiguous start cannot rebind ownership through matching filename, even after restart', async t => {
  const f = await fixture(t, { ambiguousStart: true });
  await assert.rejects(f.start(), { code: 'SDCP_START_UNCERTAIN' });
  const original = f.current();
  const run = original.runs.at(-1);
  assert.equal(run.printerType, 'sdcp');
  assert.equal(original.status, 'needs_attention');
  assert.notEqual(run.remoteId, f.adapter.remoteId, 'unknown device task must not be guessed or rebound');
  for (const telemetry of [
    { state: 'printing', currentFile: f.adapter.remotePath },
    { state: 'printing', currentFile: f.adapter.remotePath, remoteId: f.adapter.remoteId },
    { state: 'idle', currentFile: f.adapter.remotePath, remoteId: f.adapter.remoteId, progress: 100, outcome: 'completed' },
  ]) {
    const held = await f.observe(telemetry);
    assert.equal(held.status, 'needs_attention');
    assert.equal(held.runs.at(-1).remoteId, run.remoteId);
    assert.equal(held.runs.at(-1).outcome, undefined);
    assertNoCredit(held);
  }
  await f.reopen();
  const held = await f.observe({ state: 'printing', currentFile: f.adapter.remotePath, remoteId: f.adapter.remoteId });
  assert.equal(held.status, 'needs_attention');
  assert.equal(held.currentRunId, original.currentRunId);
  assert.equal(held.runs.at(-1).remoteId, run.remoteId);
  await assert.rejects(f.service.controlJob(f.job.id, 'cancel'), { code: 'PRINT_IDENTITY_UNKNOWN' });
  await assert.rejects(f.start(), { code: 'JOB_NOT_READY' });
  assert.equal(f.adapter.calls.filter(([action]) => action === 'start').length, 1);
  assert.deepEqual(mutations(f.adapter), []);
  assertNoCredit(f.current());
});
