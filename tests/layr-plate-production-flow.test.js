'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { MODEL, CONFIRMED } = require('./helpers/resin-slice');
const { createPlateProductionFixture: fixture, available, missing } = require('./helpers/resin-plate-production');

function noQualityCredit(job) { assert.equal(job.quantity, 1); assert.equal(job.acceptedQuantity, 0); assert.equal(job.remainingQuantity, 1); assert.ok(job.runs.every(run => !run.acceptedQuantity)); }

for (const actual of [false, true]) {
  test(`${actual ? 'actual reviewed portal' : 'production transport fixture'} preserves twenty-unit production across three six-unit plates and a newly verified two-unit remainder`, { skip: actual && !available ? missing : false }, async t => {
    const f = await fixture(t, { actual }); const initial = await f.reviewed();
    assert.equal(f.adapter.calls.length, 0); const first = f.current().resinSlice;
    assert.equal(first.modelCopiesPerRun, 6); assert.equal(first.platePreparation.rasterProof.copiesPerRun, 6);
    for (const request of [{ confirmedReady: true }, { confirmedReady: true, receiptId: randomUUID(), plannedParts: 6 }, { confirmedReady: true, receiptId: f.current().resinProduction.plan.receiptId, plannedParts: 5 }]) {
      const rejected = await f.json(f.base + '/resin/production/dispatch', request); assert.equal(rejected.status, 409); assert.equal(rejected.value.error, 'LAYR_PLATE_REVIEW_STALE');
      assert.equal(f.adapter.calls.length, 0, 'stale UI plate confirmation must fail before any hardware mutation');
    }
    for (let index = 0; index < 3; index++) {
      await f.start(); assert.equal(f.current().runs.at(-1).plannedParts, 6); await f.finish(6);
      assert.equal(f.current().resinProduction.printedParts, (index + 1) * 6); noQualityCredit(f.current());
    }
    let remote = await f.portal.current(); assert.equal(remote.status, 'preparing'); assert.equal(remote.production.progress.remainingParts, 2);
    assert.equal(f.current().resinProduction.plan.approvalState, undefined);
    assert.equal(f.current().resinProduction.remainderRelease.runId, f.current().runs.at(-1).id);
    const before = f.adapter.calls.length; await assert.rejects(f.app.service.sliceResinJob(f.id, { ...CONFIRMED, plate: { copies: 6, gapMm: 1, marginMm: 1 } }), { code: 'QUANTITY_EXCEEDED' }); assert.equal(f.adapter.calls.length, before);
    const remainder = await f.reviewed(2); assert.notEqual(remainder.receipt.operationId, initial.receipt.operationId); assert.notEqual(remainder.approval.operationId, initial.approval.operationId);
    assert.equal(f.current().resinSlice.modelCopiesPerRun, 2); assert.notEqual(f.current().resinSlice.sha256, first.sha256);
    await f.start(); await f.finish(2); remote = await f.portal.current();
    assert.equal(remote.status, 'post_processing'); assert.equal(remote.production.progress.printedParts, 20); assert.equal(remote.production.progress.remainingParts, 0);
    assert.equal(remote.production.totals.printedParts, 20); assert.equal(remote.production.target.id, f.portal.id);
    assert.equal(f.current().resinProduction.printedParts, 20); assert.deepEqual(f.current().runs.map(run => run.plannedParts), [6,6,6,2]);
    assert.deepEqual(f.current().runs.map(run => run.printedParts), [6,6,6,2]); assert.equal(new Set(f.current().runs.map(run => run.id)).size, 4);
    assert.equal(f.adapter.calls.filter(call => call.action === 'start').length, 4); assert.deepEqual(await fs.readFile(f.current().inputPath), MODEL); noQualityCredit(f.current());
  });
}

test('an identified completed plate may contribute four of six planned units, while overcounts and missing telemetry cannot contribute', async t => {
  const f = await fixture(t); await f.reviewed(); await f.start(); const run = f.current().runs.at(-1);
  for (const printedParts of [7,21]) { const result = await f.json(f.base + '/resin/production/reconcile', { runId: run.id, outcome: 'completed', printedParts }); assert.ok(result.status >= 400); }
  const beforeTelemetry = await f.json(f.base + '/resin/production/reconcile', { runId: run.id, outcome: 'completed', printedParts: 4 }); assert.equal(beforeTelemetry.status, 409);
  assert.equal(f.current().resinProduction.printedParts, 0); await f.finish(4);
  const remote = await f.portal.current(); assert.equal(remote.production.progress.printedParts, 4); assert.equal(remote.production.progress.remainingParts, 16); assert.equal(remote.status, 'queued');
  assert.equal(f.current().runs[0].plannedParts, 6); assert.equal(f.current().runs[0].printedParts, 4); noQualityCredit(f.current());
});

test('a missing copy, missing proof or forged instance count cannot become a prepared production plate', async t => {
  const f = await fixture(t);
  for (const [key, value] of [['omitLastCopy', true], ['removeProof', true], ['claimedCopies', 7]]) {
    f.packed.faults[key] = value;
    const rejected = await f.json(f.base + '/resin/slice', { ...CONFIRMED, plate: { copies: 6, gapMm: 1, marginMm: 1 } });
    assert.ok(rejected.status >= 400, key); assert.equal(f.current().resinSlice, undefined, key); assert.equal(f.adapter.calls.length, 0, key);
    f.packed.faults[key] = key === 'claimedCopies' ? null : false;
  }
  assert.equal(f.writes.length, 0); assert.equal(f.current().resinProduction?.printedParts || 0, 0); noQualityCredit(f.current());
});

for (const actual of [false, true]) {
  test(`${actual ? 'actual reviewed portal' : 'production transport fixture'} replays a lost final-six receipt after restart without another hardware start or premature approval release`, { skip: actual && !available ? missing : false }, async t => {
    const f = await fixture(t, { actual, quantity: 8 }); await f.reviewed(); await f.start();
    f.faults.loseReply = 'finish_print'; await f.finish(6);
    const command = f.writes.map(body => JSON.parse(body)).findLast(value => value.action === 'finish_print');
    assert.equal((await f.portal.current()).status, 'preparing'); assert.equal(f.current().resinProduction.plan.approvalState, 'approved');
    assert.equal(f.current().resinProduction.remainderRelease, undefined);
    await assert.rejects(f.app.service.sliceResinJob(f.id, { ...CONFIRMED, plate: { copies: 2, gapMm: 1, marginMm: 1 } }), { code: 'RESIN_APPROVAL_LOCKED' });
    const hardware = f.adapter.calls.length; await f.restart(); f.advance(); await f.poll();
    const replays = f.writes.map(body => JSON.parse(body)).filter(value => value.action === 'finish_print');
    assert.equal(replays.length, 2); assert.deepEqual(replays[1], command); assert.equal(f.adapter.calls.length, hardware);
    assert.equal(f.current().resinProduction.plan.approvalState, undefined); assert.equal(f.current().resinProduction.remainingParts, 2);
    await f.slice(2); assert.equal(f.current().resinSlice.modelCopiesPerRun, 2); assert.equal(f.adapter.calls.length, hardware); noQualityCredit(f.current());
  });
}

for (const kind of ['stale-projection', 'newer-approval', 'different-target']) {
  test(`a confirmed short remainder cannot release the local plate hold using ${kind}`, async t => {
    const f = await fixture(t, { quantity: 8 }); await f.reviewed(); await f.start();
    if (kind === 'newer-approval') f.faults.beforeFreshTicket = async ticket => { await f.app.service._mutate(() => { f.app.service._job(f.id).resinProduction.plan.approvalExpectedVersion = ticket.version + 1; }); };
    else f.faults.freshTicket = ticket => {
      if (kind === 'stale-projection') ticket.version = 1;
      else {
        const initial = ticket.production.target, next = randomUUID();
        ticket.production.targetHistory = [{ ...initial, progress: { requestedParts: 8, printedParts: 8, remainingParts: 0, completedRuns: 2, failedRuns: 0 } }];
        ticket.production.target = { id: next, kind: 'replacement', cycle: 1, requiredParts: 2, authorizedAt: new Date().toISOString(), qcOperationId: next };
        ticket.production.progress = { requestedParts: 2, printedParts: 0, remainingParts: 2, completedRuns: 0, failedRuns: 0 }; ticket.production.totals = { printedParts: 8, completedRuns: 2, failedRuns: 0 };
      }
    };
    await f.finish(6);
    assert.equal(f.current().resinProduction.plan.approvalState, 'approved'); assert.equal(f.current().resinProduction.remainderRelease, undefined);
    const hardware = f.adapter.calls.length;
    await assert.rejects(f.app.service.sliceResinJob(f.id, { ...CONFIRMED, plate: { copies: 2, gapMm: 1, marginMm: 1 } }), { code: 'RESIN_APPROVAL_LOCKED' }); assert.equal(f.adapter.calls.length, hardware);
    noQualityCredit(f.current());
  });
}
