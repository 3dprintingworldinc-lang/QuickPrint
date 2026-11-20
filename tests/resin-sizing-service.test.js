'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { startServer } = require('../src/server');
const { measureResinGeometry } = require('../src/slicing/resin-geometry');
const { inspectGoo } = require('../src/slicing/goo');
const { MODEL, CONFIRMED, hash, createProfile, makeSlice, importTicket } = require('./helpers/resin-slice');

const confirmed = sizing => ({ confirmedRequirements: true, confirmedSizing: true, sizing });
async function fixture(t, engine = makeSlice, { http = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-sizing-'));
  const settings = await createProfile(dataDir), calls = [];
  const options = { dataDir, resinEngine: { prepareResin: input => { calls.push(input); return engine(input); } } };
  const app = http ? await startServer(options) : null;
  const service = app?.service || new QuickPrintService(options);
  if (!app) await service.init();
  await service.updateSettings({ resinEngine: settings });
  t.after(async () => { await (app ? app.close() : service.close()); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, settings, service, app, calls, imported: options => importTicket(service, options) };
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);

test('geometry inspection reports frozen original units/bounds without mutating the job or source', async t => {
  const f = await fixture(t), job = await f.imported();
  const before = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const measured = await f.service.inspectResinGeometry(job.id);
  assert.deepEqual(measured.sourceDimensionsMm, { x: 3, y: 3, z: 3 }); assert.equal(measured.triangleCount, 12); assert.equal(measured.sourceSha256, job.sha256);
  assert.equal(measured.units, 'mm'); assert.equal(measured.unitScale, 1); assert.ok(Object.isFrozen(measured.sourceBounds.min));
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), before); assert.deepEqual(await fs.readFile(job.inputPath), MODEL); assert.equal(f.calls.length, 0);
  await fs.appendFile(job.inputPath, 'external edit'); await assert.rejects(f.service.inspectResinGeometry(job.id), { code: 'ORIGINAL_CHANGED' });
});

test('scale2 and a1.5mm single-axis target capture independently normalized geometry while preserving source/ticket', async t => {
  const f = await fixture(t);
  for (const [sizing, dimension] of [[{ mode: 'scale', factor: 2 }, 6], [{ mode: 'dimension', axis: 'x', millimeters: 1.5 }, 1.5]]) {
    const job = await f.imported({ project: { scale: 'Customer text remains unparsed', targetDimensions: 'Needs review' } });
    const result = await f.service.sliceResinJob(job.id, confirmed(sizing)), slice = result.resinSlice;
    assert.deepEqual(slice.sizingPlan.dimensionsMm, { x: dimension, y: dimension, z: dimension });
    assert.deepEqual(slice.sizingPlan.requestedSizing, sizing); assert.deepEqual(slice.operatorReview.sizing, sizing);
    assert.equal(slice.operatorReview.confirmedOriginalSize, false); assert.equal(slice.operatorReview.confirmedSizing, true);
    const input = await fs.readFile(slice.inputGeometry.filePath); assert.equal(hash(input), slice.inputGeometry.sha256); assert.equal(input.length, slice.inputGeometry.bytes);
    assert.deepEqual(measureResinGeometry(input, { format: 'stl', units: 'mm' }).sourceDimensionsMm, { x: dimension, y: dimension, z: dimension });
    assert.deepEqual(await fs.readFile(job.inputPath), MODEL); assert.deepEqual(result.order, job.order); assert.equal(result.resinSlice.printReady, false); assert.equal(result.artifact, undefined);
  }
  assert.deepEqual(f.calls.map(input => input.sizing), [{ mode: 'scale', factor: 2 }, { mode: 'dimension', axis: 'x', millimeters: 1.5 }]);
});

test('original sizing accepts legacy confirmation or explicit sizing confirmation and records canonical review', async t => {
  const f = await fixture(t);
  for (const request of [CONFIRMED, confirmed({ mode: 'original' })]) {
    const job = await f.imported(), result = await f.service.sliceResinJob(job.id, request);
    assert.equal(result.resinSlice.operatorReview.confirmedOriginalSize, true); assert.equal(result.resinSlice.operatorReview.confirmedSizing, true);
    assert.deepEqual(result.resinSlice.sizingPlan.requestedSizing, { mode: 'original' }); assert.deepEqual(result.resinSlice.sizingPlan.dimensionsMm, { x: 3, y: 3, z: 3 });
  }
});

test('declared mm/in/m dimensions and explicit target sizing remain independent of free text', async t => {
  const f = await fixture(t);
  for (const [units, unitScale] of [['mm', 1], ['in', 25.4], ['m', 1000]]) {
    const job = await f.imported({ units, project: { scale: '999%', targetDimensions: 'unknown customer prose' } });
    const measured = await f.service.inspectResinGeometry(job.id); close(measured.sourceDimensionsMm.z, 3 * unitScale);
    const sizing = { mode: 'dimension', axis: 'z', millimeters: 6 }, result = await f.service.sliceResinJob(job.id, confirmed(sizing));
    for (const axis of ['x', 'y', 'z']) close(result.resinSlice.sizingPlan.dimensionsMm[axis], 6);
    assert.equal(result.resinSlice.sizingPlan.unitScale, unitScale); assert.equal(f.calls.at(-1).unitScale, unitScale);
    assert.equal(result.order.project.scale, '999%'); assert.equal(result.order.project.targetDimensions, 'unknown customer prose'); assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
  }
});

test('nonoriginal sizing requires explicit confirmation and malformed plans cannot invoke providers', async t => {
  const f = await fixture(t), job = await f.imported();
  await assert.rejects(f.service.sliceResinJob(job.id, { ...CONFIRMED, sizing: { mode: 'scale', factor: 2 } }), { code: 'RESIN_REVIEW_REQUIRED' });
  await assert.rejects(f.service.sliceResinJob(job.id, { ...confirmed({ mode: 'scale', factor: 2 }), confirmedRequirements: false }), { code: 'RESIN_REVIEW_REQUIRED' });
  for (const sizing of [null, [], '200%', { mode: 'original', path: 'arbitrary.stl' }, { mode: 'scale', factor: '2' }, { mode: 'scale', factor: 0 }, { mode: 'scale', factor: Infinity }, { mode: 'dimension', axis: 'invalid', millimeters: 6 }, { mode: 'dimension', axis: 'x', millimeters: 100000 }, { mode: 'dimensions', x: 2, y: 3, z: 4 }]) {
    await assert.rejects(f.service.sliceResinJob(job.id, confirmed(sizing)), { code: 'RESIN_SIZING_INVALID' });
  }
  assert.equal(f.calls.length, 0); assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
});

test('engine plan/hash/bounds claims must equal the independently derived canonical proof', async t => {
  for (const change of [
    result => { delete result.sizingPlan; },
    result => { result.sizingPlan = { ...result.sizingPlan, sizingSha256: '0'.repeat(64) }; },
    result => { result.sizingPlan = { ...result.sizingPlan, dimensionsMm: { x: 999, y: 999, z: 999 } }; },
    result => { delete result.inputGeometry; },
    result => { result.inputGeometry.sha256 = '0'.repeat(64); },
    result => { result.inputGeometry.bytes++; },
    result => { result.inputGeometry.bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 999, y: 999, z: 999 } }; },
  ]) {
    const f = await fixture(t, async input => { const result = await makeSlice(input); change(result); return result; }), job = await f.imported();
    await assert.rejects(f.service.sliceResinJob(job.id, confirmed({ mode: 'scale', factor: 2 })), { code: 'INVALID_RESIN_GEOMETRY' });
    assert.equal(f.service.getJob(job.id).resinSlice, undefined); assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
  }
});

test('capture checks GOO machine height against the explicit INI even when JSON omits machineZMm', async t => {
  const f = await fixture(t, async input => {
    const result = await makeSlice(input), bytes = await fs.readFile(result.filePath);
    // Header: layer count, XY resolution, mirror flags, display width/height, Z.
    bytes.writeFloatBE(31, 195310 + 4 + 2 + 2 + 1 + 1 + 4 + 4);
    await fs.writeFile(result.filePath, bytes);
    result.sha256 = hash(bytes); result.inspection = inspectGoo(bytes);
    return result;
  });
  const profile = JSON.parse(await fs.readFile(f.settings.profilePath));
  assert.equal(profile.expected.machineZMm, undefined, 'height is declared only as max_print_height=30 in the INI');
  const job = await f.imported();
  await assert.rejects(f.service.sliceResinJob(job.id, confirmed({ mode: 'scale', factor: 2 })), { code: 'GOO_PROFILE_MISMATCH' });
  assert.equal(f.calls.length, 1); assert.equal(f.service.getJob(job.id).resinSlice, undefined);
  assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
});

test('normalized input edits, outside files and directory links cannot be captured', async t => {
  for (const kind of ['content', 'size', 'outside', 'directory-link']) await t.test(kind, async child => {
    const f = await fixture(child, async input => {
      const result = await makeSlice(input);
      if (kind === 'content') { const bytes = await fs.readFile(result.inputGeometry.filePath); bytes[0] ^= 1; await fs.writeFile(result.inputGeometry.filePath, bytes); }
      if (kind === 'size') await fs.appendFile(result.inputGeometry.filePath, 'extra');
      if (kind === 'outside' || kind === 'directory-link') {
        const outside = path.join(f.dataDir, 'external-input'); await fs.mkdir(outside);
        const filePath = path.join(outside, 'prepared-input.stl'); await fs.copyFile(result.inputGeometry.filePath, filePath);
        if (kind === 'outside') result.inputGeometry.filePath = filePath;
        else { const link = path.join(input.outputDir, 'linked-input'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); result.inputGeometry.filePath = path.join(link, 'prepared-input.stl'); }
      }
      return result;
    });
    const job = await f.imported();
    await assert.rejects(f.service.sliceResinJob(job.id, CONFIRMED), { code: kind === 'content' ? 'RESIN_INPUT_GEOMETRY_CHANGED' : 'INVALID_RESIN_GEOMETRY' });
    assert.equal(f.service.getJob(job.id).resinSlice, undefined);
  });
});

function receipt(job) {
  const slice = job.resinSlice;
  return { id: randomUUID(), kind: 'slice', jobId: job.order.portalJobId, ticketFingerprint: job.order.ticketFingerprint, sourceSha256: job.sha256,
    profileSha256: slice.profileSha256, tool: slice.tool, printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material,
    artifact: { sha256: slice.sha256, sizeBytes: slice.bytes, format: 'goo' }, partsPerRun: 1, deviceFingerprint: '6'.repeat(64), printReady: false };
}
test('dispatch bindings recheck resized geometry proof and original-only legacy compatibility', async t => {
  const f = await fixture(t), imported = await f.imported();
  await f.service.sliceResinJob(imported.id, confirmed({ mode: 'scale', factor: 2 }));
  const job = f.service.getJob(imported.id), captured = receipt(job);
  assert.ok(await f.service._resinDispatchBindings(job, captured, captured.deviceFingerprint));
  const bytes = await fs.readFile(job.resinSlice.inputGeometry.filePath); bytes[0] ^= 1; await fs.writeFile(job.resinSlice.inputGeometry.filePath, bytes);
  await assert.rejects(f.service._resinDispatchBindings(job, captured, captured.deviceFingerprint), { code: 'RESIN_INPUT_GEOMETRY_CHANGED' });
  const original = await f.imported(); await f.service.sliceResinJob(original.id, CONFIRMED);
  const legacy = f.service.getJob(original.id), oldReceipt = receipt(legacy);
  delete legacy.resinSlice.sizingPlan; delete legacy.resinSlice.inputGeometry; delete legacy.resinSlice.operatorReview.confirmedSizing; delete legacy.resinSlice.operatorReview.sizing;
  assert.ok(await f.service._resinDispatchBindings(legacy, oldReceipt, oldReceipt.deviceFingerprint));
  legacy.resinSlice.operatorReview.sizing = { mode: 'scale', factor: 2 };
  await assert.rejects(f.service._resinDispatchBindings(legacy, oldReceipt, oldReceipt.deviceFingerprint), { code: 'RESIN_SIZING_UNQUALIFIED' });
});

test('geometry HTTP read requires authentication, returns measurements only and rejects changed originals', async t => {
  const f = await fixture(t, makeSlice, { http: true }), job = await f.imported(), route = `/api/jobs/${job.id}/resin/geometry`;
  assert.equal((await fetch(f.app.url + route)).status, 401);
  const headers = { Authorization: `Bearer ${f.app.token}` }, response = await fetch(f.app.url + route, { headers }); assert.equal(response.status, 200);
  const value = await response.json(); assert.deepEqual(value.sourceDimensionsMm, { x: 3, y: 3, z: 3 }); assert.equal(value.sourceSha256, job.sha256);
  assert.ok(!JSON.stringify(value).includes(f.dataDir)); assert.equal(f.calls.length, 0);
  await fs.appendFile(job.inputPath, 'changed'); const changed = await fetch(f.app.url + route, { headers }); assert.equal(changed.status, 409); assert.equal((await changed.json()).error, 'ORIGINAL_CHANGED');
});

test('sized geometry review and exact source download bind the coordinates used by drain/contact automation without slicing', async t => {
  const f = await fixture(t), job = await f.imported({ units: 'in' }), before = await fs.readFile(path.join(f.dataDir, 'state.json'));
  const sizing = { mode: 'dimension', axis: 'z', millimeters: 10 }, plan = await f.service.planResinGeometry(job.id, { sizing }), artifact = await f.service.getResinGeometrySource(job.id, { sizing });
  assert.equal(plan.sourceSha256, job.sha256); assert.equal(plan.engineSourceSha256, job.sha256); assert.equal(plan.coordinateUnits, 'mm'); assert.equal(plan.triangleCount, 12); assert.deepEqual(plan.dimensionsMm, { x: 10, y: 10, z: 10 });
  assert.equal(hash(artifact.bytes), plan.geometrySha256); assert.equal(artifact.sha256, plan.geometrySha256); assert.equal(artifact.sizingSha256, plan.sizingSha256); assert.equal(plan.meshAudit.sourceSha256, artifact.sha256);
  assert.deepEqual(measureResinGeometry(artifact.bytes, { format: 'stl', units: 'mm' }).sourceDimensionsMm, plan.dimensionsMm);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'state.json')), before); assert.deepEqual(await fs.readFile(job.inputPath), MODEL); assert.equal(f.calls.length, 0); assert.ok(!JSON.stringify(plan).includes(f.dataDir));
  const resized = await f.service.planResinGeometry(job.id, { sizing: { mode: 'dimension', axis: 'z', millimeters: 11 } }); assert.notEqual(resized.geometrySha256, plan.geometrySha256); assert.notEqual(resized.sizingSha256, plan.sizingSha256);
  for (const request of [{ inputPath: job.inputPath }, { sizing: null }, { sizing: { mode: 'scale', factor: 0 } }]) { await assert.rejects(f.service.planResinGeometry(job.id, request), { code: 'RESIN_SIZING_INVALID' }); await assert.rejects(f.service.getResinGeometrySource(job.id, request), { code: 'RESIN_SIZING_INVALID' }); }
});

test('authenticated geometry planning endpoints deliver matching hashes and exact reviewed STL while rejecting stale originals', async t => {
  const f = await fixture(t, makeSlice, { http: true }), job = await f.imported(), base = f.app.url + `/api/jobs/${job.id}/resin/geometry`, body = JSON.stringify({ sizing: { mode: 'scale', factor: 2 } });
  assert.equal((await fetch(base + '/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  const headers = { Authorization: `Bearer ${f.app.token}`, 'Content-Type': 'application/json' }, planned = await fetch(base + '/plan', { method: 'POST', headers, body }); assert.equal(planned.status, 200); const value = await planned.json();
  const download = await fetch(base + '/source', { method: 'POST', headers, body }); assert.equal(download.status, 200); const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(hash(bytes), value.geometrySha256); assert.equal(download.headers.get('X-QuickPrint-Geometry-Sha256'), value.geometrySha256); assert.equal(download.headers.get('X-QuickPrint-Sizing-Sha256'), value.sizingSha256); assert.match(download.headers.get('Content-Disposition'), /reviewed-sized-source\.stl/);
  await fs.appendFile(job.inputPath, 'changed'); assert.equal((await fetch(base + '/plan', { method: 'POST', headers, body })).status, 409); assert.equal((await fetch(base + '/source', { method: 'POST', headers, body })).status, 409); assert.equal(f.calls.length, 0);
});

test('an isolated source facet cannot be silently discarded by a native slicer before capture', async t => {
  const f = await fixture(t);
  const extra = 'facet normal 0 0 1\nouter loop\nvertex 10 10 10\nvertex 11 10 10\nvertex 10 11 10\nendloop\nendfacet\n';
  const data = Buffer.from(MODEL.toString().replace(/endsolid/, extra + 'endsolid'));
  const job = await f.imported({ data });
  const measured = await f.service.inspectResinGeometry(job.id);
  assert.equal(measured.triangleCount, 13, 'measurement preserves the complete submitted geometry');
  await assert.rejects(f.service.sliceResinJob(job.id, CONFIRMED), { code: 'RESIN_MESH_OPEN' });
  assert.equal(f.calls.length, 0, 'source audit must fail before a native or injected slicing provider runs');
  assert.equal(f.service.getJob(job.id).resinSlice, undefined);
  assert.deepEqual(await fs.readFile(job.inputPath), data);
});

test('source topology evidence is independently captured and rechecked on download and dispatch', async t => {
  const f = await fixture(t), job = await f.imported();
  await f.service.sliceResinJob(job.id, CONFIRMED);
  let current = f.service.getJob(job.id);
  assert.equal(current.resinSlice.inputGeometry.meshAudit.topology.closed, true);
  assert.equal(current.resinSlice.inputGeometry.meshAudit.triangleCount, 12);
  const captured = receipt(current);
  await f.service._mutate(() => { const geometry = f.service._job(job.id).resinSlice.inputGeometry; geometry.meshAudit = structuredClone(geometry.meshAudit); geometry.meshAudit.triangleCount--; });
  await assert.rejects(f.service.getResinSliceDownload(job.id), { code: 'RESIN_INPUT_GEOMETRY_CHANGED' });
  current = f.service.getJob(job.id);
  await assert.rejects(f.service._resinDispatchBindings(current, captured, captured.deviceFingerprint), { code: 'RESIN_INPUT_GEOMETRY_CHANGED' });
});
