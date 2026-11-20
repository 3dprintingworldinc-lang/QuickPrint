'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { forEachResinTriangle, measureResinGeometry } = require('../src/slicing/resin-geometry');
const { fingerprintSDCPDevice } = require('../src/adapters/sdcp-identity');
const productionClient = require('../src/connectors/layr-production-client');
const { MODEL, CONFIRMED } = require('./helpers/resin-slice');
const { createPlateProductionFixture, available, missing } = require('./helpers/resin-plate-production');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function damagedCube() {
  const original = [];
  forEachResinTriangle(MODEL, { format: 'stl', units: 'mm' }, points => original.push(points));
  assert.equal(original.length, 12);
  const triangles = original.map((points, index) => index ? points : [points[0], points[2], points[1]]);
  triangles.push(original[0]);
  const bytes = Buffer.alloc(84 + triangles.length * 50);
  bytes.write('Owned frozen paid source: one reversed face and one duplicate'); bytes.writeUInt32LE(triangles.length, 80);
  triangles.forEach((points, face) => points.forEach((point, vertex) => point.forEach((value, axis) => bytes.writeFloatLE(value, 84 + face * 50 + 12 + vertex * 12 + axis * 4))));
  return bytes;
}

for (const actual of [false, true]) {
  test(`${actual ? 'actual reviewed portal' : 'production transport fixture'} binds frozen damaged source through exact repair, two-unit plate qualification and identified completion`, { skip: actual && !available ? missing : false }, async t => {
    // All HTTP and SDCP boundaries are local fixtures. The production transport,
    // repair wrapper, core, outbox and independent packed-raster proof are real.
    // Only native rendering/analysis and physical printer responses are injected.
    const source = damagedCube(), originalSha256 = hash(source), f = await createPlateProductionFixture(t, { actual, quantity: 2, modelBuffer: source });
    const originalOrder = structuredClone(f.current().order), config = { apiMode: 'production', portalUrl: originalOrder.portalUrl, token: 'p'.repeat(43) };
    const options = { fetchImpl: (address, request = {}) => { const url = new URL(address); assert.equal(url.origin, config.portalUrl); assert.equal(request.redirect, 'error'); return f.portal.handle(url, request); } };
    const imported = f.current();
    assert.equal(imported.sha256, originalSha256); assert.equal(imported.order.modelSha256, originalSha256); assert.equal(imported.order.requestedQuantity, 2); assert.equal(imported.order.units, 'mm');
    assert.equal(imported.quantity, 1); assert.equal(imported.status, 'review'); assert.equal(imported.resinRepair, undefined); assert.deepEqual(await fs.readFile(imported.inputPath), source);
    const initialTicket = (await productionClient.getTicket(config, f.portal.id, options)).ticket;
    assert.equal(initialTicket.status, 'preparing'); assert.equal(initialTicket.ticket.specifications.project.quantity, 2);
    const originalDownload = await productionClient.downloadModel(config, initialTicket, options);
    assert.deepEqual(originalDownload.data, source); assert.equal(originalDownload.order.modelSha256, originalSha256);

    const raw = await f.json(f.base + '/resin/slice', { ...CONFIRMED, plate: { copies: 2, gapMm: 1, marginMm: 1 } });
    assert.ok(raw.status >= 400); assert.ok(['RESIN_MESH_WINDING', 'RESIN_MESH_DUPLICATE_FACE'].includes(raw.value.error), JSON.stringify(raw.value));
    assert.equal(f.packed.calls.length, 0); assert.equal(f.current().resinSlice, undefined); assert.equal(f.adapter.calls.length, 0); assert.equal(f.writes.length, 0);

    const repairedJob = await f.ok(f.base + '/resin/repair', { confirmedExactRepair: true }), repair = repairedJob.resinRepair;
    assert.equal(repair.sourceSha256, originalSha256); assert.equal(repair.summary.sourceTriangleCount, 13); assert.equal(repair.summary.outputTriangleCount, 12);
    assert.equal(repair.summary.operations.removedExactDuplicateFaces, 1); assert.equal(repair.summary.operations.reorientedUniqueFaces, 1);
    assert.equal(repair.summary.operations.coordinatesMoved, 0); assert.equal(repair.summary.operations.holesFilled, 0); assert.equal(repair.summary.solidCertified, false);
    assert.notEqual(repair.sha256, originalSha256); assert.deepEqual(repairedJob.order, originalOrder); assert.deepEqual(await fs.readFile(imported.inputPath), source);
    const geometryResponse = await fetch(f.app.url + f.base + '/resin/geometry', { headers: { Authorization: 'Bearer ' + f.app.token } });
    assert.equal(geometryResponse.status, 200); const geometry = await geometryResponse.json();
    assert.equal(geometry.sourceSha256, originalSha256); assert.equal(geometry.geometrySha256, repair.sha256); assert.equal(geometry.repaired, true); assert.equal(geometry.unitScale, 1);
    assert.deepEqual(geometry.sourceDimensionsMm, { x: 3, y: 3, z: 3 }); assert.equal(geometry.repairPreparation.reportSha256, repair.proofFile.sha256);
    const sliced = await f.ok(f.base + '/resin/slice', { confirmedRequirements: true, confirmedSizing: true, expectedGeometrySha256: geometry.geometrySha256,
      sizing: { mode: 'dimension', axis: 'z', millimeters: 6 }, plate: { copies: 2, gapMm: 1, marginMm: 1 } });
    const slice = sliced.resinSlice;
    assert.equal(f.packed.calls.length, 1); assert.equal(f.packed.calls[0].inputPath, repair.filePath); assert.equal(f.packed.calls[0].unitScale, 1);
    assert.equal(slice.sourceSha256, originalSha256); assert.equal(slice.repairedSourceSha256, repair.sha256); assert.equal(slice.repairPreparation.proofSha256, repair.proofSha256);
    assert.equal(slice.repairPreparation.repairToolSha256, repair.tool.executableSha256); assert.notEqual(slice.tool.executableSha256, slice.repairSliceTool.executableSha256);
    assert.equal(slice.modelCopiesPerRun, 2); assert.equal(slice.platePreparation.rasterProof.copiesPerRun, 2); assert.equal(slice.platePreparation.rasterProof.imageEquivalent, true);
    assert.equal(slice.platePreparation.method, 'reference-raster-replication-v1'); assert.equal(slice.printReady, false);
    assert.equal(slice.sizingPlan.uniformScale, 2); assert.deepEqual(measureResinGeometry(await fs.readFile(slice.inputGeometry.filePath), { format: 'stl', units: 'mm' }).sourceDimensionsMm, { x: 6, y: 6, z: 6 });
    assert.equal(f.adapter.calls.length, 0); assert.equal(f.writes.length, 0);

    const deviceFingerprint = fingerprintSDCPDevice(f.printer, await f.adapter.attributes());
    f.portal.qualify({ profileSha256: slice.profileSha256, engineSha256: slice.tool.executableSha256, deviceFingerprint, printerId: f.printer.id, printerModel: slice.printerModel, material: slice.material, format: 'goo' });
    const queued = await f.ok(f.base + '/resin/sync'); await f.poll();
    const command = f.writes.map(body => JSON.parse(body)).find(value => value.action === 'record_slice'); assert.ok(command);
    assert.equal(command.operationId, queued.operationId); assert.equal(command.data.sourceSha256, originalSha256); assert.notEqual(command.data.sourceSha256, repair.sha256);
    assert.equal(command.data.artifact.sha256, slice.sha256); assert.equal(command.data.partsPerRun, 2); assert.equal(command.data.tool.executableSha256, slice.tool.executableSha256);
    const { receipt, qualification } = await productionClient.getReceipt(config, { id: f.portal.id, receiptId: queued.operationId }, options);
    assert.equal(receipt.sourceSha256, originalSha256); assert.equal(receipt.partsPerRun, 2); assert.equal(receipt.artifact.sha256, slice.sha256); assert.equal(receipt.tool.executableSha256, slice.tool.executableSha256);
    assert.equal(receipt.qualified, true); assert.equal(qualification.qualified, true); assert.equal(receipt.printReady, false);
    const stillOriginal = await productionClient.downloadModel(config, (await productionClient.getTicket(config, f.portal.id, options)).ticket, options);
    assert.deepEqual(stillOriginal.data, source);
    const approval = await f.ok(f.base + '/resin/production/approve', { confirmedWholeModel: true }); assert.equal(approval.state, 'confirmed');
    assert.equal(f.current().resinProduction.plan.receiptId, receipt.id); assert.equal(f.current().resinProduction.plan.partsPerRun, 2); assert.equal(f.adapter.calls.length, 0);
    await f.app.service.updateSettings({ resinEngine: { dispatchEnabled: true } });
    await f.ok(f.base + '/resin/production/dispatch', { confirmedReady: true, receiptId: receipt.id, plannedParts: 2 });
    assert.deepEqual(f.adapter.calls.map(call => call.action), ['upload', 'start']);
    const active = f.current().runs.at(-1); assert.equal(active.plannedParts, 2); assert.equal(active.receiptId, receipt.id); assert.equal(active.targetId, f.portal.id);
    assert.equal((await f.portal.current()).status, 'printing');
    const identified = await f.terminal();
    await f.ok(f.base + '/resin/production/reconcile', { runId: identified.id, outcome: 'completed', printedParts: 2 });

    const portal = await f.portal.current(), final = f.current();
    assert.equal(portal.status, 'post_processing'); assert.deepEqual(portal.production.progress, { requestedParts: 2, printedParts: 2, remainingParts: 0, completedRuns: 1, failedRuns: 0 });
    assert.equal(portal.production.totals.printedParts, 2); assert.equal(portal.ticket.specifications.project.quantity, 2); assert.equal(portal.ticket.specifications.file.units, 'mm');
    assert.equal(final.resinProduction.printedParts, 2); assert.equal(final.resinProduction.remainingParts, 0); assert.equal(final.runs.length, 1); assert.equal(final.runs[0].printedParts, 2);
    assert.equal(final.runs[0].terminalEvidence.remoteId, active.remoteId); assert.equal(final.runs[0].terminalEvidence.currentFile, active.fileName);
    assert.equal(final.quantity, 1); assert.equal(final.acceptedQuantity, 0); assert.equal(final.remainingQuantity, 1); assert.ok(final.runs.every(run => !run.acceptedQuantity));
    assert.deepEqual(final.order, originalOrder); assert.equal(final.sha256, originalSha256); assert.deepEqual(await fs.readFile(final.inputPath), source);
    const localOriginal = await fetch(f.app.url + f.base + '/file', { headers: { Authorization: 'Bearer ' + f.app.token } }); assert.equal(localOriginal.status, 200); assert.deepEqual(Buffer.from(await localOriginal.arrayBuffer()), source);
    const finish = f.writes.map(body => JSON.parse(body)).find(value => value.action === 'finish_print'); assert.ok(finish); assert.equal(finish.data.printedParts, 2); assert.equal(finish.data.runId, active.id);
    assert.equal(f.adapter.calls.filter(call => call.action === 'start').length, 1);
  });
}
