'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LayrOutbox } = require('../src/connectors/layr-outbox');
const CONFIG = { id: 'machine', type: 'layr', apiMode: 'production', enabled: true, portalUrl: 'https://printbylayr.example', token: 'p'.repeat(43) };
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-production-outbox-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const outbox = new LayrOutbox({ dataDir }); await outbox.init();
  const id = randomUUID(), runId = randomUUID(), receiptId = randomUUID(), observedAt = new Date().toISOString();
  const common = { connectorId: CONFIG.id, portalUrl: CONFIG.portalUrl, id };
  const start = { ...common, action: 'start_print', version: 7, data: { ticketFingerprint: 'a'.repeat(64), receiptId, runId, artifactSha256: 'b'.repeat(64), printerId: 'fixture-printer', remoteId: 'actual-task-fixture', observedAt, plannedParts: 1, deviceFingerprint: 'd'.repeat(64) } };
  const finish = { ...common, action: 'finish_print', version: 8, data: { ticketFingerprint: start.data.ticketFingerprint, runId, remoteId: start.data.remoteId, observedAt, printedParts: 1 } };
  const result = (command, { status, printedParts = 0, completedRuns = 0, failedRuns = 0, run = {} } = {}) => ({ ticket: { id, version: command.version + 1, status: status || (command.action === 'start_print' ? 'printing' : command.action === 'fail_print' ? 'preparing' : 'queued'), ticketFingerprint: start.data.ticketFingerprint,
    ticket: { specifications: { project: { quantity: 2 } } }, production: { progress: { requestedParts: 2, printedParts, remainingParts: 2 - printedParts, completedRuns, failedRuns },
      run: { runId, receiptId, artifactSha256: start.data.artifactSha256, printerId: start.data.printerId, remoteId: start.data.remoteId, deviceFingerprint: start.data.deviceFingerprint, plannedParts: 1,
        status: command.action === 'start_print' ? 'printing' : command.action === 'fail_print' ? 'failed' : 'completed', startedAt: observedAt,
        ...(command.action !== 'start_print' ? { finishedAt: observedAt, printedParts: command.data.printedParts } : {}), ...run } } } });
  return { dataDir, outbox, start, finish, result };
}

test('identified run completion preserves the remaining order units and its confirmation across restart', async t => {
  const f = await fixture(t);
  await f.outbox.enqueue(f.start, 'physical-start'); await f.outbox.enqueue(f.finish, 'physical-result');
  const calls = [];
  await f.outbox.process([CONFIG], { client: { postEvidence: async (_, command) => { calls.push(command); return f.result(command, command.action === 'finish_print' ? { printedParts: 1, completedRuns: 1 } : {}); } } });
  assert.deepEqual(calls.map(command => command.action), ['start_print', 'finish_print']);
  assert.ok(f.outbox.status().every(entry => entry.state === 'confirmed'));
  assert.equal(f.outbox.status()[1].confirmation.status, 'queued');
  assert.deepEqual(f.outbox.status()[1].confirmation.progress, { requestedParts: 2, printedParts: 1, remainingParts: 1, completedRuns: 1, failedRuns: 0 });
  const restored = new LayrOutbox({ dataDir: f.dataDir }); await restored.init();
  assert.deepEqual(restored.status(), f.outbox.status());
});

test('false task identities and unsupported quantity credit remain unconfirmed and preserve the exact operation', async t => {
  for (const change of [
    result => { result.ticket.production.run.remoteId = 'different-task'; },
    result => { result.ticket.production.run.deviceFingerprint = '0'.repeat(64); },
    result => { result.ticket.production.progress.remainingParts = 500; },
  ]) {
    const f = await fixture(t); const entry = await f.outbox.enqueue(f.start, 'physical-start');
    await f.outbox.process([CONFIG], { client: { postEvidence: async (_, command) => { const result = f.result(command); change(result); return result; } } });
    assert.equal(f.outbox.get(entry.operationId).state, 'pending'); assert.equal(f.outbox.get(entry.operationId).confirmation, undefined);
  }
  const f = await fixture(t); const invalid = { ...f.finish, data: { ...f.finish.data, printedParts: 2 } };
  const entry = await f.outbox.enqueue(invalid, 'overcredited-result');
  await f.outbox.process([CONFIG], { client: { postEvidence: async (_, command) => f.result(command, { printedParts: 2, completedRuns: 1, status: 'post_processing' }) } });
  assert.equal(f.outbox.get(entry.operationId).state, 'pending'); assert.equal(f.outbox.get(entry.operationId).confirmation, undefined);
});

test('failed production results preserve zero unit credit and require an explicit failed run identity', async t => {
  const f = await fixture(t); const failed = { ...f.finish, action: 'fail_print', data: { ...f.finish.data, printedParts: 0 } };
  const entry = await f.outbox.enqueue(failed, 'physical-failure');
  await f.outbox.process([CONFIG], { client: { postEvidence: async (_, command) => f.result(command, { failedRuns: 1 }) } });
  assert.equal(f.outbox.get(entry.operationId).state, 'confirmed'); assert.equal(f.outbox.get(entry.operationId).confirmation.progress.printedParts, 0);
  await assert.rejects(f.outbox.enqueue({ ...failed, data: { ...failed.data, printedParts: 1 } }, 'false-failure-credit'), /cannot credit/);
});

test('new physical evidence requires explicit device, planned-unit and completed-unit fields', async t => {
  const f = await fixture(t);
  for (const field of ['plannedParts', 'deviceFingerprint']) { const command = structuredClone(f.start); delete command.data[field]; await assert.rejects(f.outbox.enqueue(command, `missing-${field}`)); }
  const command = structuredClone(f.finish); delete command.data.printedParts; await assert.rejects(f.outbox.enqueue(command, 'missing-printed-parts'));
});

test('a local locked guard can pause a definitely unsent operation but cannot erase a real RPC attempt', async t => {
  const f = await fixture(t); let calls = 0;
  const entry = await f.outbox.enqueue(f.start, 'guarded-start');
  const client = { postEvidence: async () => { calls++; throw new Error('Response lost after a possible commit'); } };
  await f.outbox.process([CONFIG], { client, sendRequest: async () => { throw Object.assign(new Error('Changed local snapshot'), { definitelyUnsent: true }); } });
  assert.equal(calls, 0); assert.equal(f.outbox.get(entry.operationId).attempts, 0); assert.equal(f.outbox.get(entry.operationId).state, 'paused');
  await f.outbox.process([CONFIG], { client, sendRequest: async (_, command, send) => {
    try { await send(); } catch (error) { error.definitelyUnsent = true; throw error; }
  } });
  assert.equal(calls, 1); assert.equal(f.outbox.get(entry.operationId).attempts, 1); assert.equal(f.outbox.get(entry.operationId).state, 'pending');
  await assert.rejects(f.outbox.dismissOperation(entry.operationId, { reason: 'Cannot discard a possible remote write' }), { code: 'LAYR_OUTBOX_RECONCILIATION_REQUIRED' });
});

test('the send hook cannot change the durably saved request body', async t => {
  const f = await fixture(t); await f.outbox.enqueue(f.start, 'immutable-guarded-start'); let sent;
  await f.outbox.process([CONFIG], { client: { postEvidence: async (_, command) => { sent = command; return f.result(command); } }, sendRequest: async (_, command, send) => {
    command.data.remoteId = 'accidental-hook-mutation'; return send();
  } });
  assert.equal(sent.data.remoteId, f.start.data.remoteId); assert.equal(f.outbox.status()[0].state, 'confirmed');
});

test('withdrawal persists exact review details and replays a lost response without losing counted production', async t => {
  const f = await fixture(t), reason = 'Review supports before the remaining order unit.';
  const command = { ...f.start, action: 'withdraw_preparation', data: { ticketFingerprint: f.start.data.ticketFingerprint, receiptId: f.start.data.receiptId, reason } };
  const entry = await f.outbox.enqueue(command, 'withdraw-current-preparation'), bodies = [];
  const result = body => ({ ticket: { id: body.id, version: body.version + 1, status: 'preparing', ticketFingerprint: body.data.ticketFingerprint,
    production: { progress: { requestedParts: 2, printedParts: 1, remainingParts: 1, completedRuns: 1, failedRuns: 0 }, run: { status: 'completed' } } } });
  await f.outbox.process([CONFIG], { client: { postEvidence: async (_, body) => { bodies.push(JSON.stringify(body)); throw new Error('Reply lost after remote commit.'); } } });
  assert.equal(f.outbox.get(entry.operationId).state, 'pending');
  const restored = new LayrOutbox({ dataDir: f.dataDir, now: () => Date.now() + 60000 }); await restored.init();
  await restored.process([CONFIG], { client: { postEvidence: async (_, body) => { bodies.push(JSON.stringify(body)); return result(body); } } });
  assert.equal(bodies[0], bodies[1]); assert.equal(restored.get(entry.operationId).state, 'confirmed');
  assert.equal(restored.get(entry.operationId).confirmation.progress.printedParts, 1);
  assert.ok(!JSON.stringify(restored.status()).includes(reason), 'safe public summary does not expose the saved reason/body');
  for (const patch of [{ reason: '' }, { reason: 'line\nbreak' }, { reason: 'x'.repeat(2001) }, { receiptId: 'invalid' }, { replacementQuantity: 1 }]) {
    await assert.rejects(restored.enqueue({ ...command, data: { ...command.data, ...patch } }, `invalid-${JSON.stringify(patch)}`));
  }
});

test('replacement confirmations bind target identity and current quantity independently of the frozen original quantity', async t => {
  const f = await fixture(t), targetId = randomUUID();
  const command = { ...f.finish, data: { ...f.finish.data, targetId } };
  const result = body => {
    const value = f.result(body, { status: 'post_processing', printedParts: 1, completedRuns: 1 });
    value.ticket.production.target = { id: targetId, kind: 'replacement', cycle: 1, requiredParts: 1, authorizedAt: new Date().toISOString(), qcOperationId: targetId };
    value.ticket.production.progress.requestedParts = 1; value.ticket.production.progress.remainingParts = 0; value.ticket.production.run.targetId = targetId;
    return value;
  };
  const entry = await f.outbox.enqueue(command, 'replacement-result');
  await f.outbox.process([CONFIG], { client: { postEvidence: async (_, body) => result(body) } });
  assert.equal(f.outbox.get(entry.operationId).state, 'confirmed');
  assert.deepEqual(f.outbox.get(entry.operationId).confirmation.target, { id: targetId, kind: 'replacement', cycle: 1, requiredParts: 1 });
  const restored = new LayrOutbox({ dataDir: f.dataDir }); await restored.init(); assert.deepEqual(restored.status(), f.outbox.status());
  for (const mutate of [
    value => { value.ticket.production.run.targetId = f.start.id; },
    value => { delete value.ticket.production.run.targetId; },
    value => { value.ticket.production.progress.requestedParts = 2; value.ticket.production.progress.remainingParts = 1; },
    value => { value.ticket.production.target.qcOperationId = randomUUID(); },
  ]) {
    const other = await fixture(t), queued = await other.outbox.enqueue({ ...command, id: other.start.id }, randomUUID());
    await other.outbox.process([CONFIG], { client: { postEvidence: async (_, body) => { const value = result(body); value.ticket.id = body.id; mutate(value); return value; } } });
    assert.equal(other.outbox.get(queued.operationId).state, 'pending');
  }
});

test('withdrawal cannot confirm retained approval or an active physical run', async t => {
  for (const patch of [{ approvedReceiptId: randomUUID() }, { approvedTargetId: randomUUID() }, { run: { status: 'printing' } }]) {
    const f = await fixture(t), command = { ...f.start, action: 'withdraw_preparation', data: { ticketFingerprint: f.start.data.ticketFingerprint, receiptId: f.start.data.receiptId, reason: 'Requires fresh preparation review.' } };
    const entry = await f.outbox.enqueue(command, 'false-withdrawal');
    await f.outbox.process([CONFIG], { client: { postEvidence: async (_, saved) => ({ ticket: { id: saved.id, version: saved.version + 1, status: 'preparing', ticketFingerprint: saved.data.ticketFingerprint,
      production: { progress: { requestedParts: 2, printedParts: 1, remainingParts: 1, completedRuns: 1, failedRuns: 0 }, ...patch } } }) } });
    assert.equal(f.outbox.get(entry.operationId).state, 'pending'); assert.equal(f.outbox.get(entry.operationId).confirmation, undefined);
  }
});
