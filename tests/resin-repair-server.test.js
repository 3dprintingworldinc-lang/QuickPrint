'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { startServer } = require('../src/server');
const { prepareResinGeometry } = require('../src/slicing/resin-geometry');
const repair = require('../src/slicing/resin-repair');
const { MODEL, CONFIRMED, hash, createProfile, makeSlice, importTicket, deferred } = require('./helpers/resin-slice');

const CONFIRM = { confirmedExactRepair: true };
const normalized = prepareResinGeometry(MODEL, { format: 'stl', units: 'mm', sizing: { mode: 'original' } }).stl;
const DAMAGED = Buffer.concat([normalized, normalized.subarray(84, 134)]); DAMAGED.writeUInt32LE(13, 80);
async function setup(t, prepare = repair.prepareResinRepair) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-repair-http-')), settings = await createProfile(dataDir), calls = [], sliceCalls = [];
  const app = await startServer({ dataDir, resinRepair: { prepareResinRepair: input => { calls.push(input); return prepare(input); } }, resinEngine: { prepareResin: input => { sliceCalls.push(input); return makeSlice(input); } } });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await app.service.updateSettings({ resinEngine: settings });
  const request = (route, options = {}) => fetch(app.url + route, { ...options, headers: { Authorization: `Bearer ${app.token}`, ...(options.headers || {}) } });
  const json = (route, body, method = 'POST') => request(route, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ...app, dataDir, settings, calls, sliceCalls, request, json, imported: input => importTicket(app.service, { data: DAMAGED, ...input }) };
}

test('exact repair preparation and STL download require authenticated desktop access', async t => {
  const app = await setup(t), job = await app.imported(), route = `/api/jobs/${job.id}/resin/repair`;
  assert.equal((await fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(CONFIRM) })).status, 401);
  assert.equal((await fetch(app.url + route + '/download')).status, 401); assert.equal(app.calls.length, 0);
  for (const body of [{}, { confirmedExactRepair: false }, { ...CONFIRM, outputDir: app.dataDir }, { ...CONFIRM, source: 'injected' }]) {
    const response = await app.json(route, body); assert.equal(response.status, 400); assert.equal((await response.json()).error, 'RESIN_REPAIR_REVIEW_REQUIRED');
  }
  assert.equal((await app.json(route, CONFIRM)).status, 200); assert.equal(app.calls.length, 1);
  assert.equal((await app.request(route + '/download', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

test('HTTP repair shows actual geometry, binds reviewed slicing and downloads independently verified bytes', async t => {
  const app = await setup(t), job = await app.imported(), route = `/api/jobs/${job.id}/resin/repair`;
  const response = await app.json(route, CONFIRM); assert.equal(response.status, 200); const repaired = await response.json();
  assert.equal(repaired.resinRepair.summary.operations.removedExactDuplicateFaces, 1); assert.equal(repaired.resinRepair.summary.outputTriangleCount, 12); assert.equal(repaired.artifact, undefined);
  const geometry = await (await app.request(`/api/jobs/${job.id}/resin/geometry`)).json();
  assert.equal(geometry.sourceSha256, job.sha256); assert.equal(geometry.geometrySha256, repaired.resinRepair.sha256); assert.equal(geometry.repaired, true);
  const download = await app.request(route + '/download'); assert.equal(download.status, 200); assert.equal(download.headers.get('Cache-Control'), 'no-store'); assert.match(download.headers.get('Content-Disposition'), /repaired-unqualified\.stl/);
  const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(hash(bytes), repaired.resinRepair.sha256);
  const sliceRoute = `/api/jobs/${job.id}/resin/slice`, stale = await app.json(sliceRoute, CONFIRMED);
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error, 'RESIN_REPAIR_REVIEW_STALE'); assert.equal(app.sliceCalls.length, 0);
  const slicedResponse = await app.json(sliceRoute, { ...CONFIRMED, confirmedSizing: true, expectedGeometrySha256: geometry.geometrySha256, sizing: { mode: 'scale', factor: 2 } }); assert.equal(slicedResponse.status, 200);
  const sliced = await slicedResponse.json(); assert.equal(sliced.resinSlice.sourceSha256, job.sha256); assert.equal(sliced.resinSlice.repairedSourceSha256, geometry.geometrySha256); assert.deepEqual(sliced.resinSlice.sizingPlan.dimensionsMm, { x: 6, y: 6, z: 6 });
  assert.equal((await app.request(sliceRoute + '/download')).status, 200); assert.deepEqual(await fs.readFile(job.inputPath), DAMAGED); assert.deepEqual(sliced.order, job.order); assert.equal(sliced.runs.length, 0);
});

test('HTTP derivative download and geometry reject changed repair output and proof', async t => {
  for (const target of ['filePath', 'reportPath']) await t.test(target, async child => {
    const app = await setup(child), job = await app.imported(), route = `/api/jobs/${job.id}/resin/repair`;
    const repaired = await (await app.json(route, CONFIRM)).json(); await fs.appendFile(repaired.resinRepair[target], 'changed');
    const download = await app.request(route + '/download'); assert.equal(download.status, 409); assert.equal((await download.json()).error, 'RESIN_REPAIR_CHANGED');
    assert.equal((await app.request(`/api/jobs/${job.id}/resin/geometry`)).status, 409); assert.equal(app.sliceCalls.length, 0);
  });
});

test('HTTP repair cancellation aborts preparation without adopting a derivative', async t => {
  const entered = deferred();
  const app = await setup(t, input => new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }); entered.resolve(); }));
  const job = await app.imported(), pending = app.json(`/api/jobs/${job.id}/resin/repair`, CONFIRM); await entered.promise;
  const cancelled = await app.json(`/api/jobs/${job.id}/control`, { action: 'cancel' }); assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).status, 'cancelled');
  const rejected = await pending; assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error, 'PREPARATION_CANCELLED'); assert.equal(app.service.getJob(job.id).resinRepair, undefined);
});

test('backup refuses active exact repair and includes the completed captured proof chain', async t => {
  const entered = deferred(), release = deferred();
  const app = await setup(t, async input => { entered.resolve(); await release.promise; return repair.prepareResinRepair(input); });
  const one = await app.imported(), pending = app.json(`/api/jobs/${one.id}/resin/repair`, CONFIRM); await entered.promise;
  try {
    const refused = await app.request('/api/backup'); assert.equal(refused.status, 409); assert.match((await refused.json()).message, /active jobs/); assert.equal(app.calls.length, 1);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200); const response = await app.request('/api/backup'); assert.equal(response.status, 200);
  const zip = new AdmZip(Buffer.from(await response.arrayBuffer())), names = zip.getEntries().map(entry => entry.entryName);
  for (const file of ['normalized-source.stl', 'repair-proof.json', 'repaired.stl']) assert.ok(names.some(name => name.includes(`/resin-repair/`) && name.endsWith('/' + file)), file);
  assert.deepEqual(await fs.readFile(one.inputPath), DAMAGED);
});
