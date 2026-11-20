'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { LayrOutbox } = require('../src/connectors/layr-outbox');
const { atomicWrite } = require('../src/core/store');

const PORTAL = 'https://printbylayr.example';
const TOKEN = 'p'.repeat(43);
const NOW = Date.parse('2026-11-19T16:00:00Z');
const CONFIG = { id: 'layr-one', type: 'layr', apiMode: 'production', portalUrl: PORTAL, token: TOKEN };
function input({ id = randomUUID(), version = 5 } = {}) {
  return { connectorId: CONFIG.id, portalUrl: PORTAL, action: 'record_preprocessing', id, version,
    data: { ticketFingerprint: 'a'.repeat(64), sourceSha256: 'b'.repeat(64),
      tool: { name: 'ELEGOO SatelLite', version: '1.0.0', executableSha256: 'c'.repeat(64) },
      outputs: [{ name: 'report.json', sha256: 'd'.repeat(64), sizeBytes: 20, kind: 'report' }],
      operations: { evaluate: true, fix: null, hollowThicknessMm: null } } };
}
function server({ before, loseFirst = false, after } = {}) {
  const operations = new Map(), versions = new Map(), calls = [];
  let applied = 0;
  const client = { postEvidence: async (config, command, options) => {
    const body = JSON.stringify(command);
    calls.push({ config, command: structuredClone(command), body, options });
    await before?.(config, command, options);
    const existing = operations.get(command.operationId);
    if (existing) {
      if (existing.body !== body) throw Object.assign(new Error('operation conflict'), { status: 409 });
      return structuredClone(existing.result);
    }
    const current = versions.get(command.id) ?? command.version;
    if (current !== command.version) throw Object.assign(new Error('version conflict'), { status: 409 });
    const status = { record_preprocessing: 'preparing', record_slice: 'preparing', approve_preparation: 'queued', start_print: 'printing', finish_print: 'post_processing', fail_print: 'preparing' }[command.action];
    const result = {
      ticket: { id: command.id, version: command.version + 1, status, ticketFingerprint: command.data.ticketFingerprint,
        client: { email: 'do-not-store-customer@example.test' }, customerUrl: 'https://private.example/job#secret' },
      ...(['record_preprocessing', 'record_slice'].includes(command.action) ? { receipt: {
        id: command.operationId, jobId: command.id, sourceSha256: command.data.sourceSha256, ticketFingerprint: command.data.ticketFingerprint,
        qualified: command.action === 'record_slice', printReady: false, extraPrivateData: 'do-not-store-private-result',
      } } : {}),
    };
    operations.set(command.operationId, { body, result }); versions.set(command.id, command.version + 1); applied++;
    if (loseFirst && applied === 1) throw new Error(`response lost after commit ${TOKEN}`);
    await after?.(config, command, result);
    return structuredClone(result);
  } };
  return { client, calls, operations, get applied() { return applied; } };
}
async function fixture(t, { write } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-layr-outbox-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let time = NOW;
  let outbox = new LayrOutbox({ service: { dataDir }, now: () => time, ...(write ? { write } : {}) });
  await outbox.init();
  return {
    dataDir, get outbox() { return outbox; }, advance(amount) { time += amount; },
    async restart(options = {}) { outbox = new LayrOutbox({ dataDir, now: () => time, ...options }); await outbox.init(); return outbox; },
    async disk() { return fs.readFile(path.join(dataDir, 'layr-outbox.json'), 'utf8'); },
  };
}

test('enqueue persists one immutable operation UUID per stable evidence key before any RPC', async t => {
  const f = await fixture(t);
  const evidence = input();
  const [one, two] = await Promise.all([f.outbox.enqueue(evidence, 'local-evidence-one'), f.outbox.enqueue(structuredClone(evidence), 'local-evidence-one')]);
  assert.equal(one.operationId, two.operationId);
  assert.equal(one.state, 'pending');
  assert.equal(one.attempts, 0);
  assert.equal(one.bodyJson, undefined); assert.equal(one.data, undefined);
  const disk = JSON.parse(await f.disk());
  assert.equal(disk.operations.length, 1);
  const saved = JSON.parse(disk.operations[0].bodyJson);
  assert.equal(saved.operationId, one.operationId);
  assert.equal(saved.version, evidence.version);
  evidence.data.outputs[0].sha256 = '0'.repeat(64);
  assert.equal(JSON.parse(JSON.parse(await f.disk()).operations[0].bodyJson).data.outputs[0].sha256, 'd'.repeat(64));
  const remote = server({ before: async () => {
    const receipt = JSON.parse(await f.disk()).operations[0];
    assert.equal(receipt.attempts, 1);
    assert.equal(receipt.bodyJson, JSON.stringify(saved));
  } });
  const result = await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 1);
  assert.equal(result[0].state, 'confirmed');
  assert.equal(result[0].confirmation.receiptId, one.operationId);
  assert.equal(result[0].confirmation.version, saved.version + 1);
});

test('lost response after server commit retries the identical persisted body and UUID after restart', async t => {
  const f = await fixture(t);
  const queued = await f.outbox.enqueue(input(), 'lost-response');
  const remote = server({ loseFirst: true });
  let result = await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(result[0].state, 'pending');
  assert.equal(remote.applied, 1);
  assert.equal(remote.calls.length, 1);
  assert.match(result[0].error, /same saved body/);
  assert.ok(!result[0].error.includes(TOKEN));
  await f.restart();
  await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 1, 'retry backoff survives restart');
  f.advance(5001);
  result = await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 2);
  assert.equal(remote.applied, 1);
  assert.equal(remote.calls[0].body, remote.calls[1].body);
  assert.equal(result[0].operationId, queued.operationId);
  assert.equal(result[0].state, 'confirmed');
  assert.equal(result[0].confirmation.version, 6);
  const file = await f.disk();
  for (const secret of [TOKEN, 'do-not-store-customer', 'private.example', 'do-not-store-private-result']) assert.ok(!file.includes(secret));
  assert.deepEqual(Object.keys(result[0].confirmation).sort(), ['confirmedAt', 'qualified', 'receiptId', 'status', 'version']);
});

test('failed enqueue persistence cannot create an in-memory operation or cause RPC', async t => {
  const f = await fixture(t, { write: async () => { throw new Error(`disk failure ${TOKEN}`); } });
  const remote = server();
  await assert.rejects(f.outbox.enqueue(input(), 'not-saved'), error => error.code === 'LAYR_OUTBOX_SAVE' && !error.message.includes(TOKEN));
  assert.deepEqual(f.outbox.status(), []);
  await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 0);
  await assert.rejects(f.disk(), { code: 'ENOENT' });
});

test('failed durable attempt marker prevents RPC even when the operation was already enqueued', async t => {
  let writes = 0;
  const f = await fixture(t, { write: async (file, data) => {
    if (++writes === 2) throw new Error('attempt write failure');
    return atomicWrite(file, data);
  } });
  await f.outbox.enqueue(input(), 'saved-no-attempt');
  const remote = server();
  await assert.rejects(f.outbox.process([CONFIG], { client: remote.client }), { code: 'LAYR_OUTBOX_SAVE' });
  assert.equal(remote.calls.length, 0);
  assert.equal(f.outbox.status()[0].attempts, 0);
});

test('failed confirmation persistence stops later work and retries the committed operation exactly', async t => {
  let writes = 0;
  const f = await fixture(t, { write: async (file, data) => {
    if (++writes === 4) throw new Error('confirmation write failure');
    return atomicWrite(file, data);
  } });
  const first = input();
  await f.outbox.enqueue(first, 'first'); // write1
  await f.outbox.enqueue(input({ id: first.id, version: first.version + 1 }), 'second'); // write2
  const remote = server();
  await assert.rejects(f.outbox.process([CONFIG], { client: remote.client }), { code: 'LAYR_OUTBOX_SAVE' }); // attempt3, confirm4
  assert.equal(remote.calls.length, 1);
  assert.equal(remote.applied, 1);
  assert.equal(f.outbox.status()[0].state, 'pending');
  assert.equal(f.outbox.status()[1].attempts, 0);
  await f.restart(); f.advance(5001);
  await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 3);
  assert.equal(remote.calls[0].body, remote.calls[1].body);
  assert.equal(remote.applied, 2);
  assert.ok(f.outbox.status().every(item => item.state === 'confirmed'));
});

test('unresolved evidence blocks later operations for that job while other jobs can proceed', async t => {
  const f = await fixture(t);
  const first = input(); const other = input();
  await f.outbox.enqueue(first, 'first');
  await f.outbox.enqueue(input({ id: first.id, version: 6 }), 'second');
  await f.outbox.enqueue(other, 'other-job');
  let failOnce = true;
  const remote = server({ before: async (config, command) => {
    if (command.id === first.id && failOnce) { failOnce = false; throw Object.assign(new Error(`timeout ${TOKEN}`), { status: 503 }); }
  } });
  const pending = await f.outbox.process([CONFIG], { client: remote.client });
  assert.deepEqual(remote.calls.map(call => call.command.id), [first.id, other.id]);
  assert.deepEqual(pending.map(operation => operation.state), ['pending', 'pending', 'confirmed']);
  assert.equal(pending[1].attempts, 0);
  f.advance(5001);
  await f.outbox.process([CONFIG], { client: remote.client });
  assert.deepEqual(remote.calls.slice(2).map(call => call.command.version), [5, 6]);
  assert.ok(f.outbox.status().every(operation => operation.state === 'confirmed'));
});

test('concurrent process calls serialize and never submit the same pending operation in parallel', async t => {
  const f = await fixture(t);
  await f.outbox.enqueue(input(), 'concurrent');
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const remote = server({ before: async () => { entered(); await gate; } });
  const first = f.outbox.process([CONFIG], { client: remote.client });
  await started;
  const second = f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(remote.calls.length, 1);
  assert.equal(f.outbox.status()[0].state, 'confirmed');
});

test('removed, disabled, MCP or changed-origin connectors pause operations without redirecting them', async t => {
  const f = await fixture(t);
  await f.outbox.enqueue(input(), 'paused-config');
  const remote = server();
  for (const configs of [[], [{ ...CONFIG, enabled: false }], [{ ...CONFIG, apiMode: 'mcp' }], [{ ...CONFIG, portalUrl: 'https://different.example' }]]) {
    const status = await f.outbox.process(configs, { client: remote.client });
    assert.equal(status[0].state, 'paused');
    assert.equal(status[0].attempts, 0);
    assert.equal(remote.calls.length, 0);
    assert.equal(status[0].portalUrl, PORTAL);
  }
  await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 1);
  assert.equal(remote.calls[0].config.portalUrl, PORTAL);
  assert.equal(f.outbox.status()[0].state, 'confirmed');
});

test('CAS conflicts remain durable and stop later evidence for the same job', async t => {
  const f = await fixture(t);
  const first = input();
  await f.outbox.enqueue(first, 'first');
  await f.outbox.enqueue(input({ id: first.id, version: 6 }), 'second');
  const remote = server({ before: async () => { throw Object.assign(new Error(`version conflict ${TOKEN}`), { status: 409 }); } });
  const status = await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(status[0].state, 'conflict');
  assert.equal(status[1].attempts, 0);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  await f.restart(); f.advance(86400000);
  await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 1);
  assert.equal(f.outbox.status()[0].state, 'conflict');
});

test('auth errors preserve exact operations, request reconnect, and accept repaired credentials after backoff', async t => {
  const f = await fixture(t);
  await f.outbox.enqueue(input(), 'authorization');
  let invalid = true;
  const remote = server({ before: async config => {
    if (invalid) throw Object.assign(new Error(`Authorization Bearer ${config.token}`), { status: 401 });
  } });
  const first = await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(first[0].state, 'auth_required');
  assert.match(first[0].error, /Reconnect/);
  assert.ok(!(await f.disk()).includes(TOKEN));
  invalid = false; f.advance(5001);
  await f.outbox.process([{ ...CONFIG, token: 'n'.repeat(43) }], { client: remote.client });
  assert.equal(remote.calls[0].body, remote.calls[1].body);
  assert.equal(f.outbox.status()[0].state, 'confirmed');
  assert.ok(!(await f.disk()).includes('n'.repeat(43)));
});

test('dedup conflicts cannot rebuild a saved body or version and secrets never enter stored evidence', async t => {
  const f = await fixture(t);
  const original = input();
  const saved = await f.outbox.enqueue(original, `sensitive-key-${TOKEN}`);
  const changed = structuredClone(original); changed.version++;
  await assert.rejects(f.outbox.enqueue(changed, `sensitive-key-${TOKEN}`), { code: 'LAYR_OUTBOX_DEDUP_CONFLICT' });
  assert.equal(f.outbox.status()[0].operationId, saved.operationId);
  assert.equal(f.outbox.status()[0].version, 5);
  for (const mutate of [
    candidate => { candidate.token = TOKEN; },
    candidate => { candidate.data.token = TOKEN; },
    candidate => { candidate.data.tool.password = TOKEN; },
    candidate => { candidate.data.outputs[0].filePath = `C:/private/${TOKEN}`; },
  ]) {
    const candidate = input(); mutate(candidate);
    await assert.rejects(f.outbox.enqueue(candidate, randomUUID()));
  }
  assert.ok(!(await f.disk()).includes(TOKEN));
  const visible = f.outbox.status(); visible[0].state = 'confirmed';
  assert.equal(f.outbox.status()[0].state, 'pending');
});

test('corrupt or tampered outbox files are preserved and block sending instead of resetting', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.outbox.filePath, '{broken');
  const broken = new LayrOutbox({ dataDir: f.dataDir });
  const remote = server();
  await assert.rejects(broken.process([CONFIG], { client: remote.client }), { code: 'LAYR_OUTBOX_CORRUPT' });
  assert.equal(await f.disk(), '{broken');
  assert.equal(remote.calls.length, 0);
  await fs.rm(f.outbox.filePath);
  await f.outbox.enqueue(input(), 'tamper');
  const document = JSON.parse(await f.disk());
  const command = JSON.parse(document.operations[0].bodyJson); command.version++;
  document.operations[0].bodyJson = JSON.stringify(command);
  await fs.writeFile(f.outbox.filePath, JSON.stringify(document));
  await assert.rejects(f.restart(), { code: 'LAYR_OUTBOX_CORRUPT' });
  assert.equal(remote.calls.length, 0);
});

test('aborted processing preserves pending identities and never invents later physical stages', async t => {
  const f = await fixture(t);
  const evidence = input();
  const queued = await f.outbox.enqueue(evidence, 'cancelled-process');
  const cancelled = new AbortController(); cancelled.abort();
  const remote = server();
  await f.outbox.process([CONFIG], { client: remote.client, signal: cancelled.signal });
  assert.equal(remote.calls.length, 0);
  assert.equal(f.outbox.get(queued.operationId).attempts, 0);
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const controller = new AbortController();
  const blocked = { postEvidence: async (config, command, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); started();
  }) };
  const processing = f.outbox.process([CONFIG], { client: blocked, signal: controller.signal });
  await entered; controller.abort(); await processing;
  assert.equal(f.outbox.get(queued.operationId).state, 'pending');
  f.advance(5001);
  await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 1);
  assert.equal(remote.calls[0].command.operationId, queued.operationId);
  assert.equal(remote.calls[0].command.action, 'record_preprocessing');
  assert.equal(f.outbox.status().length, 1);
  assert.equal(f.outbox.status()[0].confirmation.status, 'preparing');
});

test('malformed success acknowledgments remain pending and do not persist customer or private result data', async t => {
  const f = await fixture(t);
  const evidence = input();
  await f.outbox.enqueue(evidence, 'malformed-confirmation');
  const remote = { postEvidence: async () => ({ ticket: { id: evidence.id, version: 999, status: 'printing', client: { email: TOKEN } }, receipt: { id: TOKEN } }) };
  const status = await f.outbox.process([CONFIG], { client: remote });
  assert.equal(status[0].state, 'pending');
  assert.equal(status[0].confirmation, undefined);
  assert.ok(!(await f.disk()).includes(TOKEN));
});

test('hashed-key lookup recovers the original safe operation summary across changed local versions and restart', async t => {
  const f = await fixture(t);
  const evidence = input();
  const key = `private-dedup-key-${TOKEN}`;
  assert.equal(f.outbox.lookup(key), null);
  const original = await f.outbox.enqueue(evidence, key);
  const recovered = f.outbox.lookup(key);
  assert.equal(recovered.operationId, original.operationId);
  assert.equal(recovered.version, evidence.version);
  assert.equal(recovered.bodyJson, undefined);
  assert.equal(recovered.data, undefined);
  assert.equal(recovered.dedupKeyHash, undefined);
  recovered.version++;
  assert.equal(f.outbox.lookup(key).version, 5);
  await f.restart();
  assert.equal(f.outbox.lookup(key).operationId, original.operationId);
  assert.equal(f.outbox.lookup(key).version, 5);
  assert.ok(!(await f.disk()).includes(key));
  assert.ok(!(await f.disk()).includes(TOKEN));
  await assert.rejects(f.outbox.enqueue({ ...evidence, version: 6 }, key), { code: 'LAYR_OUTBOX_DEDUP_CONFLICT' });
  assert.equal(f.outbox.lookup(key).version, 5, 'lookup never rebuilds saved command details from current state');
});

test('lookup rejects ambiguous raw keys across different production scopes without exposing saved bodies', async t => {
  const f = await fixture(t);
  await f.outbox.enqueue(input(), 'not-globally-unique');
  await f.outbox.enqueue(input(), 'not-globally-unique');
  assert.throws(() => f.outbox.lookup('not-globally-unique'), { code: 'LAYR_OUTBOX_DEDUP_AMBIGUOUS' });
  assert.equal(f.outbox.status().length, 2);
});

test('slice evidence metadata permits the native 218451945-byte artifact and 512 MiB boundary only', async t => {
  const f = await fixture(t);
  function slice(sizeBytes) {
    const evidence = input();
    evidence.action = 'record_slice';
    const { outputs, operations, ...common } = evidence.data;
    evidence.data = { ...common, profileSha256: 'e'.repeat(64), printerId: 'saturn4u16k-1', printerModel: 'ELEGOO Saturn 4 Ultra 16K', material: 'Reviewed grey resin',
      artifact: { sha256: 'f'.repeat(64), sizeBytes, format: 'goo' } };
    return evidence;
  }
  for (const sizeBytes of [218451945, 512 * 1024 * 1024]) {
    const evidence = slice(sizeBytes);
    const queued = await f.outbox.enqueue(evidence, `artifact-${sizeBytes}`);
    const saved = JSON.parse(await f.disk()).operations.find(operation => operation.operationId === queued.operationId);
    assert.equal(JSON.parse(saved.bodyJson).data.artifact.sizeBytes, sizeBytes);
  }
  await assert.rejects(f.outbox.enqueue(slice(512 * 1024 * 1024 + 1), 'too-large-artifact'), /artifact hashes/);
  const remote = server();
  await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 2);
  assert.deepEqual(remote.calls.map(call => call.command.data.artifact.sizeBytes), [218451945, 512 * 1024 * 1024]);
  assert.ok(remote.calls.every(call => call.command.action === 'record_slice'));
  assert.ok(f.outbox.status().every(operation => operation.confirmation.status === 'preparing'));
});

test('local review dismissal is durable for definitive conflicts and unblocks later job evidence', async t => {
  const f = await fixture(t);
  const evidence = input();
  const first = await f.outbox.enqueue(evidence, 'held-conflict');
  await f.outbox.enqueue(input({ id: evidence.id, version: 6 }), 'fresh-after-conflict');
  let conflict = true;
  const remote = server({ before: async () => { if (conflict) throw Object.assign(new Error('conflict'), { status: 409 }); } });
  await f.outbox.process([CONFIG], { client: remote.client });
  const dismissed = await f.outbox.dismissOperation(first.operationId, { reason: 'Reviewed the newer portal ticket and replaced stale evidence.' });
  assert.equal(dismissed.state, 'dismissed');
  assert.ok(dismissed.resolution.at);
  assert.deepEqual(await f.outbox.dismissOperation(first.operationId, { reason: dismissed.resolution.reason }), dismissed);
  await assert.rejects(f.outbox.dismissOperation(first.operationId, { reason: 'Different reason' }), { code: 'LAYR_OUTBOX_RESOLUTION_CONFLICT' });
  await f.restart();
  assert.equal(f.outbox.get(first.operationId).state, 'dismissed');
  conflict = false;
  await f.outbox.process([CONFIG], { client: remote.client });
  assert.equal(remote.calls.length, 2);
  assert.equal(remote.calls[1].command.version, 6);
  assert.equal(f.outbox.status()[1].state, 'confirmed');
});

test('only paused never-attempted evidence may be dismissed without replay reconciliation', async t => {
  const f = await fixture(t);
  const queued = await f.outbox.enqueue(input(), 'unsent-paused');
  await assert.rejects(f.outbox.dismissOperation(queued.operationId, { reason: 'Unsent pending is not held yet' }), { code: 'LAYR_OUTBOX_RECONCILIATION_REQUIRED' });
  await f.outbox.process([{ ...CONFIG, enabled: false }], { client: server().client });
  assert.equal((await f.outbox.dismissOperation(queued.operationId, { reason: 'Selected a different reviewed local slice.' })).state, 'dismissed');

  const attempted = await f.outbox.enqueue(input(), 'ambiguous-attempt');
  const remote = server({ loseFirst: true });
  await f.outbox.process([CONFIG], { client: remote.client });
  await assert.rejects(f.outbox.dismissOperation(attempted.operationId, { reason: 'Cannot abandon possible remote success' }), { code: 'LAYR_OUTBOX_RECONCILIATION_REQUIRED' });
  await f.outbox.process([{ ...CONFIG, enabled: false }], { client: remote.client });
  assert.equal(f.outbox.get(attempted.operationId).state, 'paused');
  await assert.rejects(f.outbox.dismissOperation(attempted.operationId, { reason: 'Still attempted while paused' }), { code: 'LAYR_OUTBOX_RECONCILIATION_REQUIRED' });
  f.advance(5001);
  await f.outbox.process([CONFIG], { client: remote.client });
  await assert.rejects(f.outbox.dismissOperation(attempted.operationId, { reason: 'Confirmed is immutable' }), { code: 'LAYR_OUTBOX_RECONCILIATION_REQUIRED' });
});

test('pre-send local integrity checks gate unsent work but cannot block replay of possibly committed evidence', async t => {
  const f = await fixture(t);
  const queued = await f.outbox.enqueue(input(), 'integrity');
  const remote = server({ loseFirst: true });
  let valid = false, checks = 0;
  const beforeSend = async () => { checks++; if (!valid) throw new Error(`changed source ${TOKEN}`); };
  await f.outbox.process([CONFIG], { client: remote.client, beforeSend });
  assert.equal(remote.calls.length, 0);
  assert.equal(f.outbox.get(queued.operationId).state, 'paused');
  assert.equal(f.outbox.get(queued.operationId).attempts, 0);
  valid = true;
  await f.outbox.process([CONFIG], { client: remote.client, beforeSend });
  assert.equal(remote.applied, 1);
  valid = false; f.advance(5001);
  await f.outbox.process([CONFIG], { client: remote.client, beforeSend });
  assert.equal(checks, 2, 'attempted write is reconciled without gating on subsequently changed files');
  assert.equal(remote.calls.length, 2);
  assert.equal(remote.calls[0].body, remote.calls[1].body);
  assert.equal(f.outbox.get(queued.operationId).state, 'confirmed');
  assert.ok(!(await f.disk()).includes(TOKEN));
});

test('connector removal or disable during validation is rechecked before the first RPC', async t => {
  const f = await fixture(t);
  const queued = await f.outbox.enqueue(input(), 'live-authorization');
  const remote = server();
  let configs = [CONFIG];
  await f.outbox.process(configs, { client: remote.client, getConfigs: () => configs,
    beforeSend: async () => { configs = [{ ...CONFIG, enabled: false }]; } });
  assert.equal(remote.calls.length, 0);
  assert.equal(f.outbox.get(queued.operationId).state, 'paused');
  assert.equal(f.outbox.get(queued.operationId).attempts, 0);
});
