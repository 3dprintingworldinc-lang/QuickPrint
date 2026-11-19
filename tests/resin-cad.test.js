'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { prepareResinCad, verifyResinCadGeometry } = require('../src/slicing/resin-cad');
const { STEP, hash, boxTriangles, createCadFixture } = require('./helpers/resin-cad');

async function fixture(t, hooks) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-cad-protocol-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, ...(await createCadFixture(root, hooks)) };
}
const solidPath = record => path.join(path.dirname(record.reportPath), record.solids[0].artifact.fileName);
const scriptName = call => path.basename(call.args.find(argument => /\.py$/i.test(argument)) || '');

test('real Node boundary verifies closed per-solid evidence and translated combined input from an injected fake provider', async t => {
  const f = await fixture(t), result = await f.prepare();
  assert.equal(result.kind, 'step-tessellation'); assert.equal(result.coordinateUnits, 'mm'); assert.equal(result.embeddedUnitsConverted, true);
  assert.equal(result.sourceSha256, hash(STEP)); assert.deepEqual(await fs.readFile(f.options.inputPath), STEP); assert.deepEqual(await fs.readFile(result.sourceCopy), STEP);
  assert.deepEqual(result.originMm, { x: 10, y: 20, z: 30 });
  assert.deepEqual(result.measurement.sourceBounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 4, z: 4 } });
  assert.deepEqual(result.measurement.sourceDimensionsMm, { x: 6, y: 4, z: 4 });
  assert.equal(result.meshAudits.length, 2); assert.deepEqual(result.meshAudits.map(audit => audit.components[0].volumeMm3), [24,2]);
  assert.ok(result.meshAudits.every(audit => audit.topology.closed && audit.topology.vertexManifold && audit.components[0].winding === 'positive'));
  const verified = await f.verify(result), bytes = await fs.readFile(result.filePath);
  assert.deepEqual(verified.bytes, bytes); assert.equal(bytes.length, result.bytes); assert.equal(hash(bytes), result.sha256); assert.equal(bytes.readUInt32LE(80), 24);
  assert.ok(result.tool.binaryManifest.some(item => item.name === 'quickprint/cad-worker')); assert.ok(result.tool.binaryManifest.some(item => item.name === 'freecad/lib/Part.pyd'));
  assert.match(result.tool.executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.executable === f.modulePaths.pythonExecutable && call.args[0] === '-I' && call.options.timeoutMs === 10000));
  assert.equal(scriptName(f.calls[0]), 'resin-cad-transfer-audit.py');
  const worker = f.calls[1]; assert.equal(scriptName(worker), 'resin-cad-worker.py');
  assert.equal(worker.args[worker.args.indexOf('--input') + 1], result.sourceCopy); assert.notEqual(result.sourceCopy, f.options.inputPath);
});

test('assembly origin translation preserves small dimensions at large CAD offsets', async t => {
  const f = await fixture(t, { descriptors: [{ origin: [100000000,200000000,300000000], dimensions: [0.25,0.5,0.75] }] });
  const result = await f.prepare();
  assert.deepEqual(result.originMm, { x: 100000000, y: 200000000, z: 300000000 });
  assert.deepEqual(result.measurement.sourceDimensionsMm, { x: 0.25, y: 0.5, z: 0.75 });
  assert.equal(result.meshAudits[0].components[0].volumeMm3, 0.09375); await f.verify(result);
});

test('source, units, tolerance and provider version reports must exactly identify the requested conversion', async t => {
  const changes = [
    report => { report.schemaVersion = 2; }, report => { report.sourceSha256 = '0'.repeat(64); }, report => { report.sourceBytes++; },
    report => { report.coordinateUnits = 'in'; }, report => { report.tolerance.linearDeflectionMm *= 2; },
    report => { report.originMm.x++; }, report => { delete report.originMm; },
    report => { report.provider.freecadVersion = ['0','21','0']; }, report => { report.provider.occVersion = '6.9.1'; }, report => { report.provider.pythonVersion = '2.7.18'; },
  ];
  for (const [index, mutateReport] of changes.entries()) {
    const f = await fixture(t, { mutateReport }); await assert.rejects(f.prepare(), { code: 'RESIN_CAD_EVIDENCE_INVALID' }, `report case ${index}`);
    assert.deepEqual(await fs.readFile(f.options.inputPath), STEP);
  }
});

test('solid validity, every face, bounded counts and exact artifact names are mandatory', async t => {
  const changes = [
    report => { report.cad.valid = false; }, report => { report.cad.nonSolidLeafCount = 1; }, report => { report.cad.solidCount = 129; }, report => { report.solids.pop(); },
    report => { report.solids[0].index = 1; }, report => { report.solids[0].valid = false; }, report => { report.solids[0].closed = false; }, report => { report.solids[0].shellCount = 2; },
    report => { report.solids[0].faceCount = 0; }, report => { report.solids[0].meshedFaceCount = 5; },
    report => { delete report.solids[0].faceTriangleCounts; }, report => { report.solids[0].faceTriangleCounts = [2,2]; },
    report => { report.solids[0].faceTriangleCounts[0] = 0; }, report => { report.solids[0].faceTriangleCounts[0] = 1.5; }, report => { report.solids[0].faceTriangleCounts[0] = 3; },
    report => { report.solids[0].triangleCount = 250001; }, report => { report.solids[0].artifact.bytes++; },
    report => { report.solids[0].artifact.fileName = '../escape.stl'; }, report => { report.solids[0].artifact.fileName = 'other.stl'; }, report => { report.solids[0].artifact.sha256 = 'invalid'; },
  ];
  for (const [index, mutateReport] of changes.entries()) {
    const f = await fixture(t, { mutateReport }); await assert.rejects(f.prepare(), { code: 'RESIN_CAD_EVIDENCE_INVALID' }, `solid case ${index}`);
  }
});

test('aggregate bounds and analytic volume must agree with independently audited tessellations', async t => {
  const changes = [
    [report => { report.cad.volumeMm3++; }, 'RESIN_CAD_EVIDENCE_INVALID'],
    [report => { report.cad.areaMm2++; }, 'RESIN_CAD_EVIDENCE_INVALID'],
    [report => { report.solids[0].boundsMm.max.x++; }, 'RESIN_CAD_INVENTORY_MISMATCH'],
    [report => { report.cad.boundsMm.max.x++; }, 'RESIN_CAD_INVENTORY_MISMATCH'],
    [report => { const extra = report.solids[0].volumeMm3; report.solids[0].volumeMm3 += extra; report.cad.volumeMm3 += extra; }, 'RESIN_CAD_INVENTORY_MISMATCH'],
  ];
  for (const [mutateReport, code] of changes) {
    const f = await fixture(t, { mutateReport }); await assert.rejects(f.prepare(), { code });
  }
});

test('actual closed mesh bounds and volume must agree with both matching analytic CAD inventories', async t => {
  for (const changed of ['bounds', 'volume']) {
    const f = await fixture(t, { mutateReport: async (_report, context) => {
      const triangles = boxTriangles([0,0,0], [2,3,4]);
      for (const triangle of triangles) for (const point of triangle) {
        if (changed === 'bounds') point[0] += 0.25;
        else if (point[0] === 2 && point[1] === 3 && point[2] === 4) point[0] = 1;
      }
      await context.writeSolid(0, triangles);
    } });
    await assert.rejects(f.prepare(), { code: 'RESIN_CAD_GEOMETRY_MISMATCH' });
  }
});

test('open edges and negative shell winding fail even with self-consistent report hashes and counts', async t => {
  for (const [kind, code] of [['open', 'RESIN_MESH_OPEN'], ['negative', 'RESIN_CAD_TOPOLOGY_MISMATCH']]) {
    const f = await fixture(t, { mutateReport: async (report, context) => {
      let triangles = boxTriangles([0,0,0], [2,3,4]);
      if (kind === 'open') { triangles = triangles.slice(1); report.solids[0].faceTriangleCounts[0] = 1; }
      else triangles = triangles.map(([a,b,c]) => [a,c,b]);
      await context.writeSolid(0, triangles);
    } });
    await assert.rejects(f.prepare(), { code });
  }
});

test('provider identities and inventory cannot change or load modules outside the configured installation', async t => {
  for (const changed of ['module', 'missing-module', 'binary', 'kernel', 'audit-binding']) {
    const f = await fixture(t, { afterWrite: async context => {
      if (changed === 'module') { const outside = path.join(f.root, 'external.pyd'); await fs.writeFile(outside, 'external fixture'); context.report.provider.modulePaths.Part = outside; await context.writeReport(); }
      if (changed === 'missing-module') { delete context.report.provider.modulePaths.Part; await context.writeReport(); }
      if (changed === 'binary') await fs.appendFile(f.options.freecadExecutable, 'changed');
      if (changed === 'kernel') await fs.appendFile(path.join(f.bin, 'TKernel.dll'), 'changed');
      if (changed === 'audit-binding') await fs.appendFile(f.auditModulePaths.bindingModule, 'changed');
    } });
    await assert.rejects(f.prepare(), { code: 'RESIN_CAD_PROVIDER_CHANGED' });
  }
  const missing = await fixture(t); await fs.unlink(path.join(missing.bin, 'TKDESTEP.dll'));
  await assert.rejects(missing.prepare(), { code: 'RESIN_CAD_CONFIGURATION' }); assert.equal(missing.calls.length, 0);
});

test('tessellation report must bind the exact independently verified STEP transfer audit bytes', async t => {
  for (const mutateReport of [report => { delete report.transferAudit; }, report => { report.transferAudit.sha256 = '0'.repeat(64); }, report => { report.transferAudit.bytes++; }]) {
    const f = await fixture(t, { mutateReport }); await assert.rejects(f.prepare(), { code: 'RESIN_CAD_TRANSFER_FAILED' });
  }
});

test('independent STEP load/transfer diagnostics fail closed before any tessellation worker is invoked', async t => {
  const changes = [
    audit => { audit.schemaVersion = 2; }, audit => { audit.sourceSha256 = '0'.repeat(64); }, audit => { audit.sourceBytes++; }, audit => { audit.coordinateUnits = 'in'; },
    audit => { audit.provider.distributionVersion = '8.0.0'; }, audit => { delete audit.provider.modulePaths.bindingModule; },
    audit => { audit.diagnostics.loadFailureCount = 1; }, audit => { audit.diagnostics.loadWarningCount = 1; },
    audit => { audit.diagnostics.transferFailureCount = 1; }, audit => { audit.diagnostics.transferWarningCount = 1; },
    audit => { audit.diagnostics.rootCount = 0; audit.diagnostics.transferredRootCount = 0; },
    audit => { audit.diagnostics.rootCount = 2; audit.diagnostics.transferredRootCount = 1; }, audit => { audit.diagnostics.shapeCount = 0; },
  ];
  for (const [index, mutateAudit] of changes.entries()) {
    const f = await fixture(t, { mutateAudit }); await assert.rejects(f.prepare(), undefined, `transfer audit case ${index}`);
    assert.equal(f.calls.filter(call => scriptName(call) === 'resin-cad-worker.py').length, 0);
    assert.deepEqual(await fs.readFile(f.options.inputPath), STEP);
  }
});

test('independent analytic CAD inventory must match the tessellation provider inventory', async t => {
  const f = await fixture(t, { mutateAudit: audit => { const extra = audit.cad.solids[0].volumeMm3; audit.cad.solids[0].volumeMm3 += extra; audit.cad.volumeMm3 += extra; } });
  await assert.rejects(f.prepare());
  assert.equal(f.calls.filter(call => scriptName(call) === 'resin-cad-worker.py').length, 1);
});

test('large world offsets cannot hide a moved component or changed relative assembly positions', async t => {
  const f = await fixture(t, { descriptors: [{ origin: [100000000,200000000,300000000], dimensions: [2,3,4] }, { origin: [100000005,200000002,300000001], dimensions: [1,2,1] }],
    mutateReport: async (report, context) => {
      report.solids[1].boundsMm.min.x += 0.25; report.solids[1].boundsMm.max.x += 0.25; report.cad.boundsMm.max.x += 0.25;
      await context.writeSolid(1, boxTriangles([5.25,2,1], [1,2,1]));
    } });
  await assert.rejects(f.prepare(), { code: 'RESIN_CAD_INVENTORY_MISMATCH' });
});

test('loss or mutation of original and captured STEP bytes cannot yield an accepted conversion', async t => {
  for (const changed of ['original', 'snapshot', 'removed']) {
    const f = await fixture(t, { afterWrite: async context => {
      if (changed === 'original') await fs.appendFile(f.options.inputPath, 'changed');
      if (changed === 'snapshot') await fs.appendFile(context.inputPath, 'changed');
      if (changed === 'removed') await fs.unlink(f.options.inputPath);
    } });
    await assert.rejects(f.prepare(), changed === 'removed' ? undefined : { code: 'ORIGINAL_CHANGED' });
  }
});

test('timeouts and cancellation use bounded process options and cannot return later evidence', async t => {
  const controller = new AbortController(); controller.abort(Object.assign(new Error('Fixture cancellation'), { code: 'PREPARATION_CANCELLED' }));
  const before = await fixture(t); await assert.rejects(before.prepare({ signal: controller.signal }), { code: 'PREPARATION_CANCELLED' }); assert.equal(before.calls.length, 0);
  const late = new AbortController();
  const during = await fixture(t, { afterWrite: () => late.abort(Object.assign(new Error('Fixture late cancellation'), { code: 'PREPARATION_CANCELLED' })) });
  await assert.rejects(during.prepare({ signal: late.signal }), { code: 'PREPARATION_CANCELLED' });
  const timeout = await fixture(t, { failure: Object.assign(new Error('Fixture timeout'), { code: 'SLICER_TIMEOUT' }) });
  await assert.rejects(timeout.prepare({ timeoutMs: 1000 }), { code: 'SLICER_TIMEOUT' }); assert.equal(timeout.calls[0].options.timeoutMs, 1000);
  const invalid = await fixture(t);
  for (const patch of [{ timeoutMs: 999 }, { timeoutMs: 3600001 }, { timeoutMs: '1000' }, { linearDeflectionMm: 0.00001 }, { linearDeflectionMm: 0.11 }, { angularDeflectionRad: 0.001 }, { angularDeflectionRad: 0.51 }]) {
    await assert.rejects(invalid.prepare(patch), { code: 'RESIN_CAD_CONFIGURATION' });
  }
  assert.equal(invalid.calls.length, 0);
});

test('replay independently detects changed per-solid, combined, report, snapshot and stored proof claims', async t => {
  for (const changed of ['solid', 'combined', 'report', 'transfer-file', 'transfer-claims', 'snapshot', 'measurement', 'audit', 'origin']) {
    const f = await fixture(t), record = structuredClone(await f.prepare());
    if (changed === 'solid') await fs.appendFile(solidPath(record), 'changed');
    if (changed === 'combined') { const bytes = await fs.readFile(record.filePath); bytes[0] ^= 1; await fs.writeFile(record.filePath, bytes); record.sha256 = hash(bytes); }
    if (changed === 'report') await fs.appendFile(record.reportPath, '\n');
    if (changed === 'transfer-file') await fs.appendFile(record.auditReportPath, '\n');
    if (changed === 'transfer-claims') record.transferAudit.diagnostics.rootCount++;
    if (changed === 'snapshot') await fs.appendFile(record.sourceCopy, 'changed');
    if (changed === 'measurement') record.measurement.sourceDimensionsMm.x++;
    if (changed === 'audit') record.meshAudits[0].triangleCount++;
    if (changed === 'origin') record.originMm.x++;
    await assert.rejects(f.verify(record), { code: 'RESIN_CAD_CHANGED' });
  }
});

test('replay cannot weaken requested tessellation bounds or relabel the source coordinate conversion', async t => {
  for (const changed of ['linear', 'angular', 'units', 'source']) {
    const f = await fixture(t), record = structuredClone(await f.prepare());
    if (changed === 'linear' || changed === 'angular') {
      record.tolerance[changed === 'linear' ? 'linearDeflectionMm' : 'angularDeflectionRad'] = 1000;
      const report = JSON.parse(await fs.readFile(record.reportPath)); report.tolerance = structuredClone(record.tolerance);
      const bytes = Buffer.from(JSON.stringify(report)); await fs.writeFile(record.reportPath, bytes); record.reportSha256 = hash(bytes);
    }
    if (changed === 'units') record.embeddedUnitsConverted = false;
    if (changed === 'source') record.sourceSha256 = '0'.repeat(64);
    await assert.rejects(f.verify(record), { code: 'RESIN_CAD_CHANGED' });
  }
});

test('saved CAD evidence must remain inside managed directories without parent directory links', async t => {
  for (const field of ['sourceCopy', 'reportPath', 'auditReportPath', 'filePath']) {
    const f = await fixture(t), record = await f.prepare(), outside = path.join(f.root, `external-${path.basename(record[field])}`);
    await fs.copyFile(record[field], outside); record[field] = outside;
    await assert.rejects(f.verify(record), { code: 'RESIN_CAD_CHANGED' });
  }
  const f = await fixture(t), record = await f.prepare(), outside = path.join(f.root, 'external-evidence'), link = path.join(f.options.outputDir, 'linked-evidence');
  await fs.mkdir(outside); await fs.copyFile(record.filePath, path.join(outside, 'copy.stl'));
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); record.filePath = path.join(link, 'copy.stl');
  await assert.rejects(f.verify(record), { code: 'RESIN_CAD_CHANGED' });
});

test('prepare rejects a provider-replaced mesh directory junction before capturing external evidence', async t => {
  const f = await fixture(t, { afterWrite: async context => {
    const outside = path.join(f.root, 'external-meshes'); await fs.rename(context.outputDir, outside);
    await fs.symlink(outside, context.outputDir, process.platform === 'win32' ? 'junction' : 'dir');
  } });
  await assert.rejects(f.prepare());
});

test('worker report and per-solid file bytes are bounded and must exist before conversion succeeds', async t => {
  for (const changed of ['invalid-json', 'large-report', 'missing-report', 'solid-bytes']) {
    const f = await fixture(t, { afterWrite: async context => {
      if (changed === 'invalid-json') await fs.writeFile(context.reportPath, '{invalid');
      if (changed === 'large-report') await fs.writeFile(context.reportPath, Buffer.alloc(1024 * 1024 + 1));
      if (changed === 'missing-report') await fs.unlink(context.reportPath);
      if (changed === 'solid-bytes') await fs.appendFile(path.join(context.outputDir, context.report.solids[0].artifact.fileName), 'changed');
    } });
    await assert.rejects(f.prepare());
  }
});

test('the reusable injected implementation supplies actual CAD verification for service integration', async t => {
  const f = await fixture(t), alternate = path.join(f.root, 'job-source.stp'), source = Buffer.concat([STEP, Buffer.from('/* second owned fake input */\n')]); await fs.writeFile(alternate, source);
  const record = await f.implementation.prepareResinCad({ inputPath: alternate });
  assert.equal(record.sourceSha256, hash(source));
  const verified = await f.implementation.verifyResinCadGeometry(record, { source, directory: f.options.outputDir }); assert.equal(hash(verified.bytes), record.sha256);
  assert.deepEqual(await fs.readFile(alternate), source);
});
