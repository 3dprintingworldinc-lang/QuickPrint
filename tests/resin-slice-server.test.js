'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../src/server');
const { MODEL, CONFIRMED, hash, createProfile, goo, makeSlice, importTicket, deferred } = require('./helpers/resin-slice');

async function setup(t, prepareResin = makeSlice) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-http-'));
  const settings = await createProfile(dataDir);
  let calls = 0;
  const app = await startServer({ dataDir, resinEngine: { prepareResin: input => { calls++; return prepareResin(input); } } });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = (route, options = {}) => fetch(app.url + route, { ...options, headers: { Authorization: `Bearer ${app.token}`, ...(options.headers || {}) } });
  const json = (route, body, method = 'POST') => request(route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const saved = await json('/api/settings', { resinEngine: settings }, 'PUT');
  assert.equal(saved.status, 200);
  return { ...app, dataDir, settings, request, json, calls: () => calls };
}

test('resin slice and download HTTP routes require the desktop access token', async t => {
  const app = await setup(t);
  const job = await importTicket(app.service);
  const slice = `/api/jobs/${job.id}/resin/slice`;
  const unauthorized = await fetch(app.url + slice, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CONFIRMED) });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error, 'UNAUTHORIZED');
  assert.equal((await fetch(app.url + slice + '/download')).status, 401);
  assert.equal((await app.json(slice, CONFIRMED, 'POST')).status, 200);
  assert.equal((await app.request(slice + '/download', { headers: { Authorization: 'Bearer incorrect' } })).status, 401);
  assert.equal(app.calls(), 1);
});

test('HTTP settings accept absolute operator paths and reject job-supplied paths or unconfirmed review', async t => {
  const app = await setup(t);
  const job = await importTicket(app.service, { project: { scale: '200%', targetDimensions: '40 x 20 x 10 mm' } });
  const slice = `/api/jobs/${job.id}/resin/slice`;
  for (const resinEngine of [{ profilePath: 'relative/profile.json' }, { prusaExecutable: 'relative.exe' }, { uvtoolsExecutable: 'bad\npath' }, { timeoutMs: 999 }]) {
    const response = await app.json('/api/settings', { resinEngine }, 'PUT');
    assert.equal(response.status, 400);
  }
  for (const body of [{}, { confirmedRequirements: true }, { confirmedOriginalSize: true }]) {
    const response = await app.json(slice, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'RESIN_REVIEW_REQUIRED');
  }
  for (const key of ['inputPath', 'outputDir', 'profilePath', 'prusaExecutable', 'uvtoolsExecutable', 'unitScale']) {
    const response = await app.json(slice, { ...CONFIRMED, [key]: key === 'unitScale' ? 2 : path.join(app.dataDir, 'injected') });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'INVALID_RESIN_SLICE_REQUEST');
  }
  assert.equal(app.calls(), 0);
  assert.equal(app.service.getJob(job.id).status, 'review');
  assert.deepEqual(app.service.getJob(job.id).order.project, job.order.project);
  assert.equal(app.service.getSettings().resinEngine.profilePath, app.settings.profilePath);
});

test('HTTP captures a structurally checked slice, preserves ticket/source, and downloads exact verified bytes', async t => {
  const app = await setup(t);
  const job = await importTicket(app.service);
  const response = await app.json(`/api/jobs/${job.id}/resin/slice`, CONFIRMED);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'review');
  assert.equal(result.resinSlice.status, 'sliced_pending_qualification');
  assert.equal(result.resinSlice.printReady, false);
  assert.equal(result.resinSlice.printerCompatible, false);
  assert.equal(result.artifact, undefined);
  assert.equal(result.runs.length, 0);
  assert.deepEqual(result.order, job.order);
  assert.equal(result.resinSlice.operatorReview.ticketFingerprint, job.order.ticketFingerprint);
  assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
  const download = await app.request(`/api/jobs/${job.id}/resin/slice/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('Content-Disposition'), /prepared-unqualified\.goo/);
  assert.equal(download.headers.get('Cache-Control'), 'no-store');
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.deepEqual(bytes, goo());
  assert.equal(hash(bytes), result.resinSlice.sha256);
  const dispatch = await app.json(`/api/jobs/${job.id}/dispatch`, { printerId: 'unconfigured', confirmed: true });
  assert.equal(dispatch.status, 409);
  assert.equal((await dispatch.json()).error, 'RESIN_DISPATCH_UNAVAILABLE');
});

test('HTTP download rejects a captured file changed after slicing', async t => {
  const app = await setup(t);
  const job = await importTicket(app.service);
  const result = await (await app.json(`/api/jobs/${job.id}/resin/slice`, CONFIRMED)).json();
  const bytes = await fs.readFile(result.resinSlice.filePath); bytes[195549] ^= 1;
  await fs.writeFile(result.resinSlice.filePath, bytes);
  const response = await app.request(`/api/jobs/${job.id}/resin/slice/download`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'RESIN_ARTIFACT_CHANGED');
});

test('reported print issues stay visible in review while the captured file remains available for inspection', async t => {
  const app = await setup(t, input => makeSlice(input, { issues: 2 }));
  const job = await importTicket(app.service);
  const response = await app.json(`/api/jobs/${job.id}/resin/slice`, CONFIRMED);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'review');
  assert.equal(result.resinSlice.status, 'analysis_failed');
  assert.equal(result.resinSlice.analysis.passed, false);
  assert.equal(result.resinSlice.analysis.issues.length, 2);
  assert.match(result.error, /2 resin print issue/);
  assert.equal(result.resinSlice.printReady, false);
  assert.equal((await app.request(`/api/jobs/${job.id}/resin/slice/download`)).status, 200);
});

test('HTTP cancellation aborts the engine and returns a cancelled job without captured readiness', async t => {
  const entered = deferred(); let aborted = false;
  const app = await setup(t, input => new Promise((resolve, reject) => {
    input.signal.addEventListener('abort', () => { aborted = true; reject(input.signal.reason); }, { once: true });
    entered.resolve();
  }));
  const job = await importTicket(app.service);
  const pending = app.json(`/api/jobs/${job.id}/resin/slice`, CONFIRMED);
  await entered.promise;
  const cancelled = await app.json(`/api/jobs/${job.id}/control`, { action: 'cancel' });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');
  const rejected = await pending;
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error, 'PREPARATION_CANCELLED');
  assert.equal(aborted, true);
  assert.equal(app.service.getJob(job.id).resinSlice, undefined);
  assert.equal(app.service.getJob(job.id).runs.length, 0);
});

test('closing the HTTP service aborts active native work and persists a retryable review ticket', async t => {
  const entered = deferred(); let aborted = false;
  const app = await setup(t, input => new Promise((resolve, reject) => {
    input.signal.addEventListener('abort', () => { aborted = true; reject(input.signal.reason); }, { once: true });
    entered.resolve();
  }));
  const job = await importTicket(app.service);
  const pending = app.json(`/api/jobs/${job.id}/resin/slice`, CONFIRMED).catch(error => error);
  await entered.promise;
  await app.close();
  await pending;
  assert.equal(aborted, true);
  const state = JSON.parse(await fs.readFile(path.join(app.dataDir, 'state.json'), 'utf8'));
  const persisted = state.jobs.find(item => item.id === job.id);
  assert.equal(persisted.status, 'review');
  assert.equal(persisted.resinSlice, undefined);
  assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
});
