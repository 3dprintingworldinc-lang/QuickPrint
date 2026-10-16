'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const AdmZip = require('adm-zip');
const { ConnectorManager } = require('../src/connectors');
const { startServer } = require('../src/server');

function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function heldMultipart(t, app) {
  const received = barrier();
  const observe = req => {
    if (req.url === '/api/jobs' && req.headers['x-regression-request'] === 'held-upload') {
      // Receipt of actual body data establishes that the pre-parser middleware
      // admitted this request before the backup enables maintenance.
      req.once('data', () => setImmediate(received.release));
    }
  };
  app.server.on('request', observe);
  t.after(() => app.server.removeListener('request', observe));
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(app.url + '/api/jobs', {
      method: 'POST', headers: {
        Authorization: `Bearer ${app.token}`,
        'Content-Type': 'multipart/form-data; boundary=quickprint-regression',
        'X-Regression-Request': 'held-upload'
      }
    }, res => {
      let body = '';
      res.on('data', bytes => { body += bytes; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.write('--quickprint-regression\r\nContent-Disposition: form-data; name="files"; filename="held.gcode"\r\nContent-Type: application/octet-stream\r\n\r\nG28\nG1 X10 Y10 E1\n');
  });
  t.after(() => request.destroy());
  await received.promise;
  return { finish() { request.end('\r\n--quickprint-regression--\r\n'); return response; } };
}

async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-api-'));
  let starts = 0, telemetry = { state: 'idle', observedAt: new Date().toISOString() };
  const adapter = { capabilities: { upload: true, start: true, pause: true, resume: true, cancel: true, formats: ['gcode'] },
    status: async () => ({ ...telemetry, observedAt: new Date().toISOString() }),
    upload: async ({ fileName }) => ({ remotePath: fileName }),
    start: async ({ remotePath, jobId }) => { starts++; telemetry = { state: 'printing', currentFile: remotePath, remoteId: jobId, progress: 5 }; return { acknowledged: true, remoteId: jobId }; },
    pause: async () => { telemetry.state = 'paused'; }, resume: async () => { telemetry.state = 'printing'; }, cancel: async () => { telemetry.state = 'idle'; }, close: async () => {}
  };
  const instance = await startServer({ dataDir, adapters: { createAdapter: () => adapter } });
  t.after(async () => { await instance.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = (route, options = {}) => fetch(instance.url + route, { ...options, headers: { Authorization: `Bearer ${instance.token}`, ...(options.headers || {}) } });
  const json = (route, body, method = 'POST') => request(route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ...instance, dataDir, request, json, starts: () => starts, setTelemetry: value => { telemetry = value; } };
}
function form(sourceId = 'order-1') {
  const body = new FormData(); body.append('files', new Blob(['G28\nG1 X10 Y10 E1\n']), 'bracket.gcode');
  body.append('quantity', '2'); body.append('customer', 'Fixture customer'); if (sourceId) body.append('sourceId', sourceId);
  return body;
}
test('desktop HTML and health work; protected APIs reject unauthenticated access and rebinding', async t => {
  const app = await setup(t);
  assert.equal((await fetch(app.url + '/api/health')).status, 200);
  assert.equal((await fetch(app.url + '/api/state')).status, 401);
  const html = await (await fetch(app.url)).text();
  assert.ok(html.includes('quickprint-token')); assert.ok(!html.includes('__QUICKPRINT_TOKEN__'));
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = http.get(app.url + '/api/state', { headers: { Host: 'attacker.example', Authorization: `Bearer ${app.token}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await app.request('/api/unknown')).status, 404);
});
test('upload, prepare, explicit dispatch and quantity reconciliation work through HTTP', async t => {
  const app = await setup(t);
  let response = await app.request('/api/jobs', { method: 'POST', body: form() }); assert.equal(response.status, 201);
  const submitted = await response.json(); const id = submitted.jobs[0].id;
  response = await app.request('/api/jobs', { method: 'POST', body: form() }); assert.equal((await response.json()).duplicate, true);
  response = await app.json('/api/printers', { type: 'moonraker', name: 'Fixture printer', host: '127.0.0.1', apiKey: 'secret-fixture' });
  assert.equal(response.status, 200); const saved = await response.json(); const printerId = saved.id;
  assert.ok(printerId);
  response = await app.json(`/api/jobs/${id}/prepare`, { printerId }); assert.equal(response.status, 200, await response.clone().text());
  response = await app.json(`/api/jobs/${id}/dispatch`, { printerId }); assert.equal(response.status, 400);
  assert.equal(app.starts(), 0);
  response = await app.json(`/api/jobs/${id}/dispatch`, { printerId, confirmed: true }); assert.equal(response.status, 200, await response.clone().text());
  assert.equal(app.starts(), 1);
  const state = await (await app.request('/api/state')).json();
  assert.equal(state.jobs[0].status, 'printing'); assert.ok(!JSON.stringify(state).includes('secret-fixture'));
  const runId = state.jobs[0].currentRunId;
  app.setTelemetry({ state: 'idle', outcome: 'completed', remoteId: runId, progress: 100 });
  await app.service.refreshPrinters();
  response = await app.json(`/api/jobs/${id}/reconcile`, { outcome: 'completed', acceptedQuantity: 1, runId });
  assert.equal(response.status, 200, await response.clone().text());
  const job = (await (await app.request('/api/state')).json()).jobs[0];
  assert.equal(job.acceptedQuantity, 1); assert.equal(job.status, 'ready');
  assert.equal(await (await app.request(`/api/jobs/${id}/file`)).text(), 'G28\nG1 X10 Y10 E1\n');
});
test('LAN intake requires token and stable source ID, exposes no administration, rotates tokens', async t => {
  const app = await setup(t);
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let response = await app.json('/api/settings', { intake: { enabled: true, port } }, 'PUT');
  assert.equal(response.status, 200, await response.clone().text());
  const integration = await (await app.request('/api/integration')).json(); assert.ok(integration.listening);
  const endpoint = `http://127.0.0.1:${port}/api/intake`;
  assert.equal((await fetch(endpoint, { method: 'POST', body: form() })).status, 401);
  const headers = { Authorization: `Bearer ${integration.token}` };
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: form('') })).status, 400);
  response = await fetch(endpoint, { method: 'POST', headers, body: form() }); assert.equal(response.status, 201);
  response = await fetch(endpoint, { method: 'POST', headers, body: form() }); assert.equal(response.status, 200); assert.equal((await response.json()).duplicate, true);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers })).status, 404);
  await app.json('/api/integration/rotate', {});
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: form('second') })).status, 401);
  await app.json('/api/settings', { intake: { enabled: false } }, 'PUT');
});
test('folder configuration validates and creates a real imported job', async t => {
  const app = await setup(t); const folder = path.join(app.dataDir, 'drop'); await fs.mkdir(folder);
  const response = await app.json('/api/connectors', { name: 'Folder test', type: 'folder', path: folder, enabled: true, settleMs: 1000 });
  assert.equal(response.status, 200, await response.clone().text());
  const connector = await response.json(); assert.ok(connector.id);
  await fs.writeFile(path.join(folder, 'part.gcode'), 'G28\nG1 X10 Y10 E1\n');
  await app.json(`/api/connectors/${connector.id}/poll`, {});
  await new Promise(resolve => setTimeout(resolve, 1100));
  await app.json(`/api/connectors/${connector.id}/poll`, {});
  const state = await (await app.request('/api/state')).json();
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].status, 'review'); assert.equal(app.starts(), 0);
  const backup = await app.request('/api/backup'); assert.equal(backup.status, 200); assert.equal(backup.headers.get('content-type'), 'application/zip');
});

test('multipart admitted before backup cannot mutate after the idle barrier', { timeout: 10000 }, async t => {
  const app = await setup(t);
  const jobsDir = path.join(app.dataDir, 'jobs');
  await fs.mkdir(jobsDir, { recursive: true });
  const upload = await heldMultipart(t, app);
  const listedJobs = barrier(), continueBackup = barrier();
  const readdir = fs.readdir;
  let stopped = false;
  t.mock.method(fs, 'readdir', async function (directory, ...args) {
    const entries = await readdir.call(this, directory, ...args);
    if (String(directory) === jobsDir && !stopped) {
      stopped = true;
      listedJobs.release();
      await continueBackup.promise;
    }
    return entries;
  });
  const backupResponse = app.request('/api/backup');
  let rejected;
  try {
    await listedJobs.promise;
    rejected = await upload.finish();
  } finally { continueBackup.release(); }
  const backup = await backupResponse;
  assert.equal(backup.status, 200);
  const zip = new AdmZip(Buffer.from(await backup.arrayBuffer()));
  const archivedState = JSON.parse(zip.readAsText('state.json'));
  assert.equal(rejected.status, 503, 'a partially parsed upload must recheck maintenance before submitting');
  assert.equal(rejected.body.error, 'BACKUP_IN_PROGRESS');
  assert.equal(archivedState.jobs.length, 0);
  assert.equal(zip.getEntries().filter(entry => entry.entryName.startsWith('jobs/')).length, 0);
  assert.equal(app.service.snapshot().jobs.length, 0);
  const retry = await app.request('/api/jobs', { method: 'POST', body: form('after-backup') });
  assert.equal(retry.status, 201, 'intake resumes after the consistent backup finishes');
});

test('shutdown during backup waits for archive completion and does not restart connectors', { timeout: 10000 }, async t => {
  const app = await setup(t);
  const archiveEntered = barrier(), continueArchive = barrier();
  const readdir = fs.readdir;
  let stopped = false, restarts = 0;
  t.mock.method(fs, 'readdir', async function (directory, ...args) {
    const entries = await readdir.call(this, directory, ...args);
    if (String(directory) === app.dataDir && !stopped) {
      stopped = true; archiveEntered.release(); await continueArchive.promise;
    }
    return entries;
  });
  const start = ConnectorManager.prototype.start;
  t.mock.method(ConnectorManager.prototype, 'start', async function (...args) {
    restarts++;
    return start.apply(this, args);
  });
  // The client may finish receiving the archive or be disconnected by a user
  // requested shutdown; either is acceptable, but shutdown must drain its work.
  const response = app.request('/api/backup').then(async res => { await res.arrayBuffer(); return res.status; }, () => null).catch(() => null);
  await archiveEntered.promise;
  let closed = false;
  const closing = app.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'shutdown must wait for backup filesystem reads');
  } finally { continueArchive.release(); }
  await closing;
  await response;
  assert.equal(restarts, 0, 'backup cleanup must not restart connectors once shutdown has begun');
  assert.equal(app.server.listening, false);
  await assert.rejects(fs.stat(path.join(app.dataDir, 'service.lock')), { code: 'ENOENT' });
});

test('shutdown racing connector restart keeps service alive until backup cleanup drains', { timeout: 10000 }, async t => {
  const app = await setup(t);
  const restartEntered = barrier(), continueRestart = barrier();
  const start = ConnectorManager.prototype.start;
  let restartError;
  t.mock.method(ConnectorManager.prototype, 'start', async function (...args) {
    restartEntered.release();
    await continueRestart.promise;
    try { return await start.apply(this, args); }
    catch (error) { restartError = error; throw error; }
  });
  const response = app.request('/api/backup').then(async res => { await res.arrayBuffer(); return res.status; }, () => null).catch(() => null);
  await restartEntered.promise;
  let closed = false;
  const closing = app.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, 'service must remain available until already-started backup cleanup finishes');
  } finally { continueRestart.release(); }
  await closing;
  await response;
  assert.equal(restartError, undefined, 'connector cleanup must not observe a prematurely closed core service');
  assert.equal(app.server.listening, false);
  await assert.rejects(fs.stat(path.join(app.dataDir, 'service.lock')), { code: 'ENOENT' });
});
