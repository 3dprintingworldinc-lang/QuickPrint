'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { buildOrderMetadata } = require('../src/connectors/layr-client');

const MODEL = Buffer.from('solid resin_source\nendsolid resin_source\n');
const PORTAL = 'https://printbylayr.example';
const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function capture(input) {
  await fs.mkdir(input.outputDir, { recursive: true });
  const data = Buffer.from('{"evaluation":"captured"}');
  const filePath = path.join(input.outputDir, `${randomUUID()}.json`);
  await fs.writeFile(filePath, data);
  return {
    stage: 'preprocessed', status: 'qualified', printReady: true, slicingPerformed: false,
    sourceSha256: hash(await fs.readFile(input.inputPath)), executableSha256: 'e'.repeat(64), version: '1.0.0',
    requestedOperations: { evaluate: input.evaluate, fix: input.fix || null, hollowThicknessMm: input.hollowThicknessMm ?? null },
    files: [{ filePath, fileName: path.basename(filePath), bytes: data.length, sha256: hash(data), kind: 'report', report: { evaluation: 'captured' } }],
  };
}

async function fixture(t, preprocess = capture) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-service-'));
  let service = new QuickPrintService({ dataDir, satellite: { preprocess } });
  await service.init();
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, get service() { return service; },
    async imported({ units = 'mm' } = {}) {
      const portalId = randomUUID();
      const portalJob = {
        id: portalId, reference: `PBL-${portalId.toUpperCase()}`, version: 5, status: 'preparing',
        payment: { amountCents: 2000, confirmedAt: '2026-11-19T15:00:00Z' },
        ticket: {
          model: { size: MODEL.length, fileId: 'private-fixture' }, quote: { amountCents: 2000 },
          specifications: {
            file: { name: 'source.stl', format: 'stl', sizeBytes: MODEL.length, units },
            project: { name: 'Resin study', quantity: 4, notes: 'Review geometry.' },
            production: { printType: 'resin', supports: 'allowed', qualityTier: 'standard', properties: 'standard', colour: 'grey' },
          },
        },
      };
      const order = buildOrderMetadata(portalJob, PORTAL, MODEL);
      return (await service.submit({ source: `layr:${PORTAL}`, sourceId: `${portalId}:${order.ticketFingerprint}`, quantity: 1, order, files: [{ name: 'source.stl', data: MODEL }] })).jobs[0];
    },
    async reopen() { await service.close(); service = new QuickPrintService({ dataDir, satellite: { preprocess } }); await service.init(); return service; },
  };
}

test('resin preprocessing captures output for review without granting print readiness or changing the original', async t => {
  let received;
  const f = await fixture(t, async input => { received = input; return capture(input); });
  const job = await f.imported();
  const result = await f.service.preprocessResinJob(job.id, { evaluate: true, fix: 'simple', hollowThicknessMm: 1.5 });
  assert.equal(received.inputPath, job.inputPath);
  assert.equal(received.evaluate, true);
  assert.equal(received.fix, 'simple');
  assert.equal(received.hollowThicknessMm, 1.5);
  assert.equal(received.signal.aborted, false);
  assert.equal(result.status, 'review');
  assert.equal(result.resinPreparation.status, 'captured_unqualified');
  assert.equal(result.resinPreparation.printReady, false, 'an injected true value cannot qualify a print');
  assert.equal(result.resinPreparation.sourceSha256, job.sha256);
  assert.equal(result.artifact, undefined);
  assert.equal(result.printerId, undefined);
  assert.equal(result.runs.length, 0);
  assert.equal(result.order.requestedQuantity, 4);
  assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
  assert.equal(result.sha256, hash(MODEL));
  assert.ok(result.history.some(event => event.to === 'preparing'));
  assert.ok(!result.history.some(event => ['ready', 'printing', 'dispatching'].includes(event.to)));
  await assert.rejects(f.service.prepareJob(job.id, 'printer'), { code: 'RESIN_SLICING_UNAVAILABLE' });
  await assert.rejects(f.service.dispatchJob(job.id, 'printer', { confirmed: true }), { code: 'RESIN_DISPATCH_UNAVAILABLE' });
  await f.reopen();
  assert.equal(f.service.getJob(job.id).resinPreparation.printReady, false);
  assert.equal(f.service.getJob(job.id).status, 'review');
});

test('only imported resin tickets with millimetre units may enter preprocessing', async t => {
  let calls = 0;
  const f = await fixture(t, async input => { calls++; return capture(input); });
  const manual = (await f.service.submit({ files: [{ name: 'manual.stl', data: MODEL }] })).jobs[0];
  await assert.rejects(f.service.preprocessResinJob(manual.id), { code: 'RESIN_TICKET_REQUIRED' });
  for (const units of ['in', 'm']) {
    const job = await f.imported({ units });
    await assert.rejects(f.service.preprocessResinJob(job.id), { code: 'RESIN_UNIT_CONVERSION_REQUIRED' });
    assert.equal(f.service.getJob(job.id).status, 'review');
  }
  assert.equal(calls, 0);
});

test('an original changed on disk is rejected before the preprocessing engine runs', async t => {
  let calls = 0;
  const f = await fixture(t, async input => { calls++; return capture(input); });
  const job = await f.imported();
  await fs.appendFile(job.inputPath, 'changed');
  await assert.rejects(f.service.preprocessResinJob(job.id), { code: 'ORIGINAL_CHANGED' });
  assert.equal(calls, 0);
  const current = f.service.getJob(job.id);
  assert.equal(current.status, 'review');
  assert.equal(current.resinPreparation, undefined);
});

test('a preprocessing result for another source is rejected without recording success', async t => {
  const f = await fixture(t, async input => ({ ...await capture(input), sourceSha256: '0'.repeat(64) }));
  const job = await f.imported();
  await assert.rejects(f.service.preprocessResinJob(job.id), /source|integrity/i);
  const current = f.service.getJob(job.id);
  assert.equal(current.status, 'review');
  assert.equal(current.resinPreparation, undefined);
  assert.ok(current.error);
});

test('source changes during native work invalidate an otherwise matching captured result', async t => {
  const f = await fixture(t, async input => {
    const result = await capture(input);
    await fs.appendFile(input.inputPath, 'external edit during preprocessing');
    return result;
  });
  const job = await f.imported();
  await assert.rejects(f.service.preprocessResinJob(job.id), /source|original|integrity/i);
  const current = f.service.getJob(job.id);
  assert.equal(current.status, 'review');
  assert.equal(current.resinPreparation, undefined);
  assert.ok(current.error);
});

test('failed retries clear old captured metadata and record failure instead of stale success', async t => {
  let fail = false;
  const f = await fixture(t, async input => {
    if (fail) throw Object.assign(new Error('fixture native process failed'), { code: 'SATELLITE_NATIVE_FAILED' });
    return capture(input);
  });
  const job = await f.imported();
  await f.service.preprocessResinJob(job.id);
  assert.ok(f.service.getJob(job.id).resinPreparation);
  fail = true;
  await assert.rejects(f.service.preprocessResinJob(job.id), { code: 'SATELLITE_NATIVE_FAILED' });
  const current = f.service.getJob(job.id);
  assert.equal(current.status, 'review');
  assert.equal(current.resinPreparation, undefined);
  assert.match(current.error, /native process failed/);
  assert.equal(current.artifact, undefined);
  assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
});

test('empty or malformed native results cannot be recorded as captured output', async t => {
  for (const result of [undefined, null, {}, { sourceSha256: hash(MODEL), files: [] }]) {
    const f = await fixture(t, async () => result);
    const job = await f.imported();
    await assert.rejects(f.service.preprocessResinJob(job.id));
    assert.equal(f.service.getJob(job.id).resinPreparation, undefined);
    assert.equal(f.service.getJob(job.id).status, 'review');
  }
});

test('native preprocessing is serialized across jobs and each result remains attached to its source', async t => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let calls = 0, active = 0, maximum = 0;
  const f = await fixture(t, async input => {
    active++; maximum = Math.max(maximum, active); calls++;
    try {
      if (calls === 1) { firstEntered.resolve(); await releaseFirst.promise; }
      return await capture(input);
    } finally { active--; }
  });
  const one = await f.imported();
  const two = await f.imported();
  const first = f.service.preprocessResinJob(one.id);
  await firstEntered.promise;
  const second = f.service.preprocessResinJob(two.id);
  assert.equal(calls, 1);
  assert.equal(f.service.getJob(one.id).status, 'preparing');
  assert.equal(f.service.getJob(two.id).status, 'review');
  releaseFirst.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(maximum, 1);
  assert.ok(results.every(result => result.status === 'review' && !result.resinPreparation.printReady));
  assert.notEqual(results[0].resinPreparation.files[0].filePath, results[1].resinPreparation.files[0].filePath);
});

test('operator cancellation aborts native work and leaves no captured success or printer run', async t => {
  const entered = deferred();
  let aborted = false;
  const f = await fixture(t, input => new Promise((resolve, reject) => {
    input.signal.addEventListener('abort', () => { aborted = true; reject(input.signal.reason); }, { once: true });
    entered.resolve();
  }));
  const job = await f.imported();
  const preparation = f.service.preprocessResinJob(job.id);
  const rejected = assert.rejects(preparation, { code: 'PREPARATION_CANCELLED' });
  await entered.promise;
  const cancelled = await f.service.controlJob(job.id, 'cancel');
  await rejected;
  assert.equal(aborted, true);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.resinPreparation, undefined);
  assert.equal(cancelled.runs.length, 0);
});

test('shutdown aborts active preprocessing, rejects queued work and persists a retryable review state', async t => {
  const entered = deferred();
  let calls = 0;
  const f = await fixture(t, input => new Promise((resolve, reject) => {
    calls++;
    input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
    entered.resolve();
  }));
  const one = await f.imported();
  const two = await f.imported();
  const active = f.service.preprocessResinJob(one.id);
  const activeRejected = assert.rejects(active, { code: 'PREPARATION_SHUTDOWN' });
  await entered.promise;
  const queued = f.service.preprocessResinJob(two.id);
  const queuedRejected = assert.rejects(queued, { code: 'NOT_READY' });
  await f.service.close();
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(calls, 1);
  assert.equal(f.service._preparations.size, 0);
  assert.equal(f.service._pendingPreparations.size, 0);
  await f.reopen();
  for (const id of [one.id, two.id]) {
    const job = f.service.getJob(id);
    assert.equal(job.status, 'review');
    assert.equal(job.resinPreparation, undefined);
    assert.equal(job.runs.length, 0);
    assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
  }
});

for (const trigger of ['operator', 'shutdown']) test(`native ABORTED preprocessing failure preserves the ${trigger} cancellation reason`, async t => {
  const entered = deferred();
  const f = await fixture(t, input => new Promise((resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(Object.assign(new Error('Preparation cancelled.'), { code: 'ABORTED', status: 400 })), { once: true });
    entered.resolve();
  }));
  const job = await f.imported();
  const operation = f.service.preprocessResinJob(job.id);
  const rejected = assert.rejects(operation, { code: trigger === 'operator' ? 'PREPARATION_CANCELLED' : 'PREPARATION_SHUTDOWN', status: trigger === 'operator' ? 409 : 503 });
  await entered.promise;
  if (trigger === 'operator') await f.service.controlJob(job.id, 'cancel');
  else await f.service.close();
  await rejected;
  const current = trigger === 'shutdown' ? JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')).jobs.find(item => item.id === job.id) : f.service.getJob(job.id);
  assert.equal(current.status, trigger === 'operator' ? 'cancelled' : 'review');
  assert.equal(current.resinPreparation, undefined); assert.equal(current.runs.length, 0);
  assert.equal(f.service._preparations.size, 0);
  await f.reopen();
  assert.equal(f.service.getJob(job.id).status, trigger === 'operator' ? 'cancelled' : 'review');
});
