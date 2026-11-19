'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { QuickPrintService } = require('../src/core/service');
const { MODEL, CONFIRMED, hash, createProfile, makeSlice, importTicket, deferred } = require('./helpers/resin-slice');

async function fixture(t, prepareResin = makeSlice, satellite) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-slice-service-'));
  const settings = await createProfile(dataDir);
  let service = new QuickPrintService({ dataDir, resinEngine: { prepareResin }, satellite });
  await service.init(); await service.updateSettings({ resinEngine: settings });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, settings, get service() { return service; }, async imported(options) { return importTicket(service, options); }, async reopen() { await service.close(); service = new QuickPrintService({ dataDir, resinEngine: { prepareResin }, satellite }); await service.init(); } };
}

test('resin slice captures full evidence for review and preserves the original frozen ticket', async t => {
  let input;
  const f = await fixture(t, async options => { input = options; return makeSlice(options); });
  const job = await f.imported({ project: { scale: 'Already applied', targetDimensions: '20 mm overall' } });
  const result = await f.service.sliceResinJob(job.id, CONFIRMED);
  assert.equal(result.status, 'review'); assert.equal(result.artifact, undefined); assert.equal(result.runs.length, 0);
  assert.equal(result.resinSlice.status, 'sliced_pending_qualification'); assert.equal(result.resinSlice.printReady, false); assert.equal(result.resinSlice.printerCompatible, false);
  assert.equal(result.resinSlice.sourceSha256, job.sha256); assert.equal(result.resinSlice.inspection.validatedLayerData, true);
  assert.deepEqual(result.order, job.order); assert.equal(result.resinSlice.operatorReview.ticketFingerprint, job.order.ticketFingerprint);
  assert.equal(input.prusaExecutable, f.settings.prusaExecutable); assert.equal(input.profilePath, f.settings.profilePath); assert.equal(input.unitScale, 1);
  assert.ok(path.relative(f.dataDir, input.outputDir).startsWith(`jobs${path.sep}${job.id}${path.sep}`));
  assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
  assert.ok(!result.history.some(event => ['ready', 'printing', 'dispatching'].includes(event.to)));
  const download = await f.service.getResinSliceDownload(job.id);
  assert.equal(hash(await fs.readFile(download.filePath)), download.sha256);
  await assert.rejects(f.service.dispatchJob(job.id, 'printer', { confirmed: true }), { code: 'RESIN_DISPATCH_UNAVAILABLE' });
  await f.reopen(); assert.equal(f.service.getJob(job.id).resinSlice.printReady, false);
});

test('requirements and current-size confirmations are mandatory and job bodies cannot supply paths', async t => {
  let calls = 0; const f = await fixture(t, async options => { calls++; return makeSlice(options); });
  const job = await f.imported();
  for (const request of [{}, { confirmedRequirements: true }, { ...CONFIRMED, confirmedOriginalSize: false }]) await assert.rejects(f.service.sliceResinJob(job.id, request), { code: 'RESIN_REVIEW_REQUIRED' });
  for (const key of ['inputPath', 'outputDir', 'profilePath', 'prusaExecutable', 'unitScale']) await assert.rejects(f.service.sliceResinJob(job.id, { ...CONFIRMED, [key]: '/untrusted' }), { code: 'INVALID_RESIN_SLICE_REQUEST' });
  assert.equal(calls, 0);
  const manual = (await f.service.submit({ files: [{ name: 'manual.stl', data: MODEL }] })).jobs[0];
  await assert.rejects(f.service.sliceResinJob(manual.id, CONFIRMED), { code: 'RESIN_TICKET_REQUIRED' });
});

test('declared mm/in/m units use only their deterministic unit conversions', async t => {
  const scales = []; const f = await fixture(t, async options => { scales.push(options.unitScale); return makeSlice(options); });
  for (const units of ['mm', 'in', 'm']) { const job = await f.imported({ units }); const result = await f.service.sliceResinJob(job.id, CONFIRMED); assert.equal(result.resinSlice.operatorReview.units, units); }
  assert.deepEqual(scales, [1, 25.4, 1000]);
});

test('reported print issues retain the artifact for inspection and leave a visible review error', async t => {
  const f = await fixture(t, options => makeSlice(options, { issues: 2 })); const job = await f.imported();
  const result = await f.service.sliceResinJob(job.id, CONFIRMED);
  assert.equal(result.status, 'review'); assert.equal(result.resinSlice.status, 'analysis_failed'); assert.match(result.error, /2.*issue/i);
  assert.equal(result.resinSlice.printReady, false); assert.ok(await f.service.getResinSliceDownload(job.id));
});

test('malformed, wrong-source and wrong-profile engine evidence cannot be captured', async t => {
  for (const change of [() => undefined, result => ({}), result => ({ ...result, sourceSha256: '0'.repeat(64) }), result => ({ ...result, profileSha256: '0'.repeat(64) }), result => ({ ...result, analysis: { count: 1, passed: true, issues: ['x'] } }), result => ({ ...result, analysis: { ...result.analysis, checks: [] } }), result => ({ ...result, tool: {} })]) {
    const f = await fixture(t, async options => change(await makeSlice(options))); const job = await f.imported();
    await assert.rejects(f.service.sliceResinJob(job.id, CONFIRMED));
    const current = f.service.getJob(job.id); assert.equal(current.status, 'review'); assert.equal(current.resinSlice, undefined); assert.ok(current.error);
  }
});

test('source changes before or during work and tampered output invalidate captured evidence', async t => {
  const before = await fixture(t); const job = await before.imported(); await fs.appendFile(job.inputPath, 'changed');
  await assert.rejects(before.service.sliceResinJob(job.id, CONFIRMED), { code: 'ORIGINAL_CHANGED' });
  const during = await fixture(t, async options => { const result = await makeSlice(options); await fs.appendFile(options.inputPath, 'changed'); return result; }); const other = await during.imported();
  await assert.rejects(during.service.sliceResinJob(other.id, CONFIRMED), { code: 'ORIGINAL_CHANGED' });
  const output = await fixture(t, async options => { const result = await makeSlice(options); await fs.appendFile(result.filePath, 'changed'); return result; }); const third = await output.imported();
  await assert.rejects(output.service.sliceResinJob(third.id, CONFIRMED), { code: 'INVALID_RESIN_OUTPUT' });
});

test('download rejects modified output and failed retries clear stale success', async t => {
  let fail = false;
  const f = await fixture(t, async options => { if (fail) throw Object.assign(new Error('Native fixture failed'), { code: 'FIXTURE_FAILED' }); return makeSlice(options); }); const job = await f.imported();
  const sliced = await f.service.sliceResinJob(job.id, CONFIRMED);
  const file = sliced.resinSlice.filePath, bytes = await fs.readFile(file); bytes[0] ^= 1; await fs.writeFile(file, bytes);
  await assert.rejects(f.service.getResinSliceDownload(job.id), { code: 'RESIN_ARTIFACT_CHANGED' });
  fail = true; await assert.rejects(f.service.sliceResinJob(job.id, CONFIRMED), { code: 'FIXTURE_FAILED' });
  assert.equal(f.service.getJob(job.id).resinSlice, undefined);
});

test('job operations serialize across the resin engine and idle barrier waits for capture', async t => {
  const entered = deferred(), release = deferred(); let calls = 0, active = 0, maximum = 0;
  const f = await fixture(t, async options => { active++; maximum = Math.max(maximum, active); calls++; try { if (calls === 1) { entered.resolve(); await release.promise; } return await makeSlice(options); } finally { active--; } });
  const one = await f.imported(), two = await f.imported(); const first = f.service.sliceResinJob(one.id, CONFIRMED); await entered.promise;
  const second = f.service.sliceResinJob(two.id, CONFIRMED); let idle = false; const barrier = f.service.waitForIdle().then(() => { idle = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.equal(idle, false);
  release.resolve(); await Promise.all([first, second, barrier]); assert.equal(maximum, 1); assert.equal(idle, true);
});

test('native preprocessing uses the same resin engine lock', async t => {
  const entered = deferred(), release = deferred(); let probes = 0;
  const satellite = { preprocess: async input => { probes++; await fs.mkdir(input.outputDir, { recursive: true }); const filePath = path.join(input.outputDir, 'report.json'); const bytes = Buffer.from('{}'); await fs.writeFile(filePath, bytes); return { sourceSha256: hash(await fs.readFile(input.inputPath)), files: [{ filePath, bytes: bytes.length, sha256: hash(bytes), kind: 'report' }] }; } };
  const f = await fixture(t, async options => { entered.resolve(); await release.promise; return makeSlice(options); }, satellite);
  const one = await f.imported(), two = await f.imported(); const slice = f.service.sliceResinJob(one.id, CONFIRMED); await entered.promise;
  const probe = f.service.preprocessResinJob(two.id); await new Promise(resolve => setImmediate(resolve)); assert.equal(probes, 0);
  release.resolve(); await Promise.all([slice, probe]); assert.equal(probes, 1);
});

test('operator cancellation aborts slicing and records no captured success', async t => {
  const entered = deferred(); const f = await fixture(t, input => new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }); entered.resolve(); }));
  const job = await f.imported(); const pending = f.service.sliceResinJob(job.id, CONFIRMED); const rejected = assert.rejects(pending, { code: 'PREPARATION_CANCELLED' }); await entered.promise;
  const result = await f.service.controlJob(job.id, 'cancel'); await rejected;
  assert.equal(result.status, 'cancelled'); assert.equal(result.resinSlice, undefined); assert.equal(result.runs.length, 0);
});

for (const kind of ['slice', 'preprocess']) test(`queued resin ${kind} cancellation persists before another job releases the engine`, async t => {
  const entered = deferred(), release = deferred(); let calls = 0, probes = 0;
  const satellite = { preprocess: async () => { probes++; throw new Error('The cancelled probe must never start.'); } };
  const f = await fixture(t, async options => { calls++; if (calls === 1) { entered.resolve(); await release.promise; } return makeSlice(options); }, satellite);
  const one = await f.imported(), two = await f.imported(), three = await f.imported();
  const active = f.service.sliceResinJob(one.id, CONFIRMED); await entered.promise;
  const queued = kind === 'slice' ? f.service.sliceResinJob(two.id, CONFIRMED) : f.service.preprocessResinJob(two.id);
  const rejected = assert.rejects(queued, { code: 'PREPARATION_CANCELLED' });
  const following = f.service.sliceResinJob(three.id, CONFIRMED);
  let timer;
  try {
    await assert.rejects(f.service.sliceResinJob(two.id, CONFIRMED), { code: 'JOB_BUSY' });
    await assert.rejects(f.service.preprocessResinJob(two.id), { code: 'JOB_BUSY' });
    const cancelled = await Promise.race([
      f.service.controlJob(two.id, 'cancel'),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Queued cancellation waited for another job’s engine work.')), 2000); }),
    ]);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(calls, 1); assert.equal(probes, 0);
    const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
    assert.equal(persisted.jobs.find(job => job.id === two.id).status, 'cancelled');
    assert.equal(f.service.getJob(three.id).status, 'review');
    assert.ok(!f.service.getJob(two.id).history.some(event => event.to === 'preparing'));
    // Cancelling the middle queue entry cannot release the following gate early.
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  } finally { clearTimeout(timer); release.resolve(); }
  await Promise.all([active, rejected, following]);
  assert.equal(calls, 2); assert.equal(probes, 0);
  assert.equal(f.service.getJob(two.id).status, 'cancelled');
  assert.equal(f.service.getJob(two.id).resinSlice, undefined);
  assert.equal(f.service._preparations.size, 0); assert.equal(f.service._pendingPreparations.size, 0);
  await f.reopen(); assert.equal(f.service.getJob(two.id).status, 'cancelled');
});

test('shutdown aborts active slicing and rejects queued work while preserving reviewable tickets', async t => {
  const entered = deferred(); let calls = 0;
  const f = await fixture(t, input => new Promise((resolve, reject) => { calls++; input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }); entered.resolve(); }));
  const one = await f.imported(), two = await f.imported(); const first = f.service.sliceResinJob(one.id, CONFIRMED); const firstRejected = assert.rejects(first, { code: 'PREPARATION_SHUTDOWN' }); await entered.promise;
  const queued = f.service.sliceResinJob(two.id, CONFIRMED); const queuedRejected = assert.rejects(queued, { code: 'NOT_READY' });
  await f.service.close(); await Promise.all([firstRejected, queuedRejected]); assert.equal(calls, 1);
  assert.equal(f.service._preparations.size, 0); assert.equal(f.service._pendingPreparations.size, 0);
  await f.reopen();
  for (const job of [one, two]) { const current = f.service.getJob(job.id); assert.equal(current.status, 'review'); assert.equal(current.resinSlice, undefined); assert.deepEqual(current.order, job.order); }
});

for (const trigger of ['operator', 'shutdown']) test(`native ABORTED slicing failure preserves the ${trigger} cancellation reason`, async t => {
  const entered = deferred();
  const f = await fixture(t, input => new Promise((resolve, reject) => {
    // runProcess rejects its own ABORTED error after terminating the process,
    // rather than propagating the AbortController's application-level reason.
    input.signal.addEventListener('abort', () => reject(Object.assign(new Error('Preparation cancelled.'), { code: 'ABORTED', status: 400 })), { once: true });
    entered.resolve();
  }));
  const job = await f.imported();
  const operation = f.service.sliceResinJob(job.id, CONFIRMED);
  const rejected = assert.rejects(operation, { code: trigger === 'operator' ? 'PREPARATION_CANCELLED' : 'PREPARATION_SHUTDOWN', status: trigger === 'operator' ? 409 : 503 });
  await entered.promise;
  if (trigger === 'operator') await f.service.controlJob(job.id, 'cancel');
  else await f.service.close();
  await rejected;
  const current = trigger === 'shutdown' ? JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8')).jobs.find(item => item.id === job.id) : f.service.getJob(job.id);
  assert.equal(current.status, trigger === 'operator' ? 'cancelled' : 'review');
  assert.equal(current.resinSlice, undefined); assert.equal(current.runs.length, 0);
  assert.equal(f.service._preparations.size, 0);
  await f.reopen();
  assert.equal(f.service.getJob(job.id).status, trigger === 'operator' ? 'cancelled' : 'review');
});
