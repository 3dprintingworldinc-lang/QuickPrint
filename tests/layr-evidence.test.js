'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { ConnectorManager } = require('../src/connectors');
const productionClient = require('../src/connectors/layr-production-client');
const { buildOrderMetadata } = require('../src/connectors/layr-client');
const { inspectGoo } = require('../src/slicing/goo');

const PORTAL = 'https://printbylayr.example';
const TOKEN = 'p'.repeat(43);
const MODEL = Buffer.from('solid source\nendsolid source\n');
const hash = data => createHash('sha256').update(data).digest('hex');
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// An independent two-layer, 4x2 GOO fixture. Tests exercise file integrity and
// production evidence routing, without invoking a slicer or physical printer.
function goo() {
  const header = Buffer.alloc(195477);
  header.write('V3.0'); Buffer.from([7, 0, 0, 0, 68, 76, 80, 0]).copy(header, 4);
  header.write('Independent evidence fixture', 12); header.write('ELEGOO Test', 92); header.write('DLP', 124); header.write('Test resin', 156);
  header.writeUInt16BE(0x0d0a, 27106); header.writeUInt16BE(0x0d0a, 195308);
  let offset = 195310;
  const byte = value => { header[offset++] = value; };
  const short = value => { header.writeUInt16BE(value, offset); offset += 2; };
  const integer = value => { header.writeUInt32BE(value, offset); offset += 4; };
  const float = value => { header.writeFloatBE(value, offset); offset += 4; };
  integer(2); short(4); short(2); byte(0); byte(1);
  [40, 20, 30, 0.05, 2].forEach(float); byte(1);
  for (let i = 0; i < 7; i++) float(0);
  float(20); integer(1);
  for (let i = 0; i < 16; i++) float(0);
  short(255); short(255); byte(1); offset += 4 * 4 + 8;
  integer(header.length); byte(1); short(0);
  const parts = [header];
  for (let layer = 0; layer < 2; layer++) {
    const record = Buffer.alloc(70);
    record.writeFloatBE(30, 2); record.writeFloatBE((layer + 1) * 0.05, 6); record.writeFloatBE(layer ? 2 : 20, 10);
    record.writeUInt16BE(255, 62); record.writeUInt16BE(0x0d0a, 64); record.writeUInt32BE(3, 66);
    parts.push(record, Buffer.from([0x55, 0xc8, 0x37, 13, 10]));
  }
  parts.push(Buffer.from([0, 0, 0, 7, 0, 0, 0, 68, 76, 80, 0]));
  return Buffer.concat(parts);
}

async function fixture(t, { autoSync = false, config = {}, loseResponse = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-layr-evidence-'));
  let time = Date.parse('2026-11-19T16:00:00Z');
  let hardwareCalls = 0;
  const constructor = { dataDir, adapters: () => { hardwareCalls++; assert.fail('Evidence sync cannot operate hardware'); } };
  let service = new QuickPrintService(constructor);
  await service.init();
  const saved = await service.saveConnector({ type: 'layr', apiMode: 'production', name: 'Production fixture', portalUrl: PORTAL, token: TOKEN,
    autoSyncPreparation: autoSync, enabled: true, pollIntervalMs: 60000, ...config });
  const portalId = randomUUID();
  const frozen = {
    id: portalId, reference: `PBL-${portalId.toUpperCase()}`, status: 'preparing', version: 5,
    payment: { amountCents: 2000, confirmedAt: '2026-11-19T15:00:00Z' },
    ticket: { createdAt: '2026-11-19T15:00:00Z', model: { fileId: 'private-storage-id', size: MODEL.length }, quote: { amountCents: 2000 },
      specifications: {
        client: { email: 'private-customer@example.test' },
        project: { name: 'Reviewed resin model', quantity: 12, notes: 'Check supports.' },
        production: { printType: 'resin', supports: 'allowed', qualityTier: 'standard', properties: 'standard', colour: 'grey' },
        file: { name: 'model.stl', format: 'stl', sizeBytes: MODEL.length, units: 'mm' },
      } },
  };
  const order = { ...buildOrderMetadata(frozen, PORTAL, MODEL), apiMode: 'production' };
  const local = (await service.submit({ source: `layr:${PORTAL}`, sourceId: `${portalId}:${order.ticketFingerprint}`, quantity: 1, order, files: [{ name: 'model.stl', data: MODEL }] })).jobs[0];
  const bytes = goo();
  const filePath = path.join(dataDir, 'jobs', local.id, 'resin-slicing', 'attempt-1', 'prepared.goo');
  await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, bytes);
  const slice = {
    format: 'goo', filePath, bytes: bytes.length, sha256: hash(bytes), sourceSha256: hash(MODEL), profileSha256: 'c'.repeat(64),
    printerId: 'saturn-fixture', printerModel: 'ELEGOO Test', material: 'Reviewed test resin',
    tool: { name: 'PrusaSlicer + UVtools', version: '2.9.7 + 4.4.3', executableSha256: 'd'.repeat(64),
      binaryManifest: [{ name: 'private-binary', path: 'C:/private/install/UVtools.Core.dll', sha256: 'e'.repeat(64) }], executablePath: 'C:/private/install/slicer.exe' },
    analysis: { count: 0, passed: true, issues: [] }, inspection: inspectGoo(bytes), status: 'sliced_pending_qualification', printReady: false, printerCompatible: false,
  };
  await service._mutate(() => { service._job(local.id).resinSlice = structuredClone(slice); });
  const portal = { version: frozen.version, status: 'preparing', operations: new Map(), calls: [], writes: [], downloads: 0, loseResponse,
    blockPost: null, fingerprint: order.ticketFingerprint };
  const projection = () => ({ id: portalId, reference: frozen.reference, version: portal.version, status: portal.status, ticketFingerprint: portal.fingerprint,
    ticket: { createdAt: frozen.ticket.createdAt, specifications: { project: frozen.ticket.specifications.project, production: frozen.ticket.specifications.production, file: frozen.ticket.specifications.file } }, production: null });
  const fetchImpl = async (address, options) => {
    const url = new URL(address); portal.calls.push({ url: address, options });
    assert.equal(url.origin, PORTAL); assert.equal(options.redirect, 'error');
    if (url.pathname === '/api/intake') { portal.downloads++; assert.equal(options.headers, undefined); return new Response(MODEL); }
    assert.equal(url.pathname, '/api/production'); assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); portal.writes.push(options.body);
      assert.equal(body.action, 'record_slice', 'sync must never invent queue/start/finish actions');
      if (portal.blockPost) await portal.blockPost(options.signal);
      const prior = portal.operations.get(body.operationId);
      if (prior) return prior.body === options.body ? Response.json(prior.result) : Response.json({ code: 'operation_conflict' }, { status: 409 });
      if (body.version !== portal.version) return Response.json({ code: 'version_conflict' }, { status: 409 });
      portal.version++;
      const result = { ticket: projection(), receipt: { id: body.operationId, jobId: body.id, kind: 'slice', ticketFingerprint: body.data.ticketFingerprint,
        sourceSha256: body.data.sourceSha256, qualified: false, printReady: false } };
      portal.operations.set(body.operationId, { body: options.body, result });
      if (portal.loseResponse) { portal.loseResponse = false; throw new Error(`lost after portal commit ${TOKEN}`); }
      return Response.json(result);
    }
    switch (url.searchParams.get('action')) {
      case 'tickets': return Response.json({ tickets: portal.status === 'preparing' ? [projection()] : [], nextCursor: null });
      case 'ticket': return Response.json({ ticket: projection() });
      case 'download': return Response.json({ name: 'model.stl', sizeBytes: MODEL.length, url: `${PORTAL}/api/intake?download=private.signature` });
      default: assert.fail('Unexpected read during evidence integration test');
    }
  };
  const transport = {
    ...productionClient,
    listPreparationJobs: (config, options) => productionClient.listPreparationJobs(config, { ...options, fetchImpl }),
    getTicket: (config, id, options) => productionClient.getTicket(config, id, { ...options, fetchImpl }),
    downloadModel: (config, job, options) => productionClient.downloadModel(config, job, { ...options, fetchImpl }),
    postEvidence: (config, command, options) => productionClient.postEvidence(config, command, { ...options, fetchImpl }),
  };
  let manager;
  const start = async () => {
    manager = new ConnectorManager({ service, layrProductionClient: transport, now: () => time, tickMs: 86400000 });
    await manager.start(); return manager;
  };
  await start();
  t.after(async () => { await manager.stop(); await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, connectorId: saved.id, id: local.id, portalId, portal, slice, order, bytes,
    get manager() { return manager; }, get service() { return service; }, get hardwareCalls() { return hardwareCalls; },
    advance(milliseconds) { time += milliseconds; },
    mutate(operation) { return service._mutate(() => operation(service._job(local.id))); },
    async restart() { await manager.stop(); await service.close(); service = new QuickPrintService(constructor); await service.init(); return start(); },
    async outboxFile() { return fs.readFile(manager.outbox.filePath, 'utf8'); },
  };
}

test('manual evidence queues a verified local slice with only whitelisted tool metadata and no hardware stage', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.manager.outbox.status(), []);
  const queued = await f.manager.queueSliceEvidence(f.id);
  assert.equal(queued.state, 'pending');
  assert.equal(queued.action, 'record_slice');
  assert.equal(queued.version, 5);
  assert.equal(f.portal.writes.length, 0, 'queueing itself performs no network write');
  const saved = JSON.parse(await f.outboxFile()).operations[0];
  const body = JSON.parse(saved.bodyJson);
  assert.deepEqual(Object.keys(body.data.tool).sort(), ['executableSha256', 'name', 'version']);
  assert.equal(body.data.sourceSha256, hash(MODEL));
  assert.equal(body.data.artifact.sha256, f.slice.sha256);
  assert.equal(body.data.profileSha256, f.slice.profileSha256);
  assert.equal(body.data.printerId, f.slice.printerId);
  assert.equal(body.data.material, f.slice.material);
  assert.ok(!(await f.outboxFile()).includes('C:/private'));
  assert.ok(!(await f.outboxFile()).includes('binaryManifest'));
  assert.ok(!(await f.outboxFile()).includes(TOKEN));
  assert.equal(f.service.getJob(f.id).status, 'review');
  assert.equal(f.service.getJob(f.id).resinSlice.printReady, false);
  assert.equal(f.hardwareCalls, 0);
  const descriptor = await f.service.getResinSliceDownload(f.id);
  assert.equal(descriptor.filePath, f.slice.filePath);
});

test('review, zero-issue analysis, validated layers and source binding are required before evidence is saved', async t => {
  for (const mutate of [
    job => { job.status = 'cancelled'; },
    job => { job.technology = 'fdm'; },
    job => { job.resinSlice.analysis.passed = false; job.resinSlice.analysis.count = 1; },
    job => { job.resinSlice.analysis.count = 1; },
    job => { job.resinSlice.inspection.validatedLayerData = false; },
    job => { job.resinSlice.sourceSha256 = '0'.repeat(64); },
  ]) {
    const f = await fixture(t); await f.mutate(mutate);
    await assert.rejects(f.manager.queueSliceEvidence(f.id), { code: 'LAYR_EVIDENCE_INVALID' });
    assert.equal(f.manager.outbox.status().length, 0);
    assert.equal(f.portal.writes.length, 0);
    assert.equal(f.hardwareCalls, 0);
  }
});

test('changed original or artifact files and outputs outside the job directory cannot create evidence', async t => {
  const changedOriginal = await fixture(t);
  await fs.appendFile(changedOriginal.service.getJob(changedOriginal.id).inputPath, 'external edit');
  await assert.rejects(changedOriginal.manager.queueSliceEvidence(changedOriginal.id), { code: 'ORIGINAL_CHANGED' });
  assert.equal(changedOriginal.manager.outbox.status().length, 0);

  const changedArtifact = await fixture(t);
  const mutated = Buffer.from(changedArtifact.bytes); mutated[12] ^= 1;
  await fs.writeFile(changedArtifact.slice.filePath, mutated);
  await assert.rejects(changedArtifact.manager.queueSliceEvidence(changedArtifact.id), { code: 'RESIN_ARTIFACT_CHANGED' });
  assert.equal(changedArtifact.manager.outbox.status().length, 0);

  const outside = await fixture(t);
  const external = path.join(outside.dataDir, 'outside.goo'); await fs.writeFile(external, outside.bytes);
  await outside.mutate(job => { job.resinSlice.filePath = external; });
  await assert.rejects(outside.manager.queueSliceEvidence(outside.id), { code: 'INVALID_RESIN_OUTPUT' });
  assert.equal(outside.manager.outbox.status().length, 0);
});

test('MCP, disabled and wrong-origin connectors cannot write; ambiguous matching production inputs require a selection', async t => {
  for (const config of [{ apiMode: 'mcp' }, { enabled: false }, { portalUrl: 'https://other.example' }]) {
    const f = await fixture(t, { config });
    await assert.rejects(f.manager.queueSliceEvidence(f.id), { code: 'LAYR_PRODUCTION_INPUT_REQUIRED' });
    assert.equal(f.manager.outbox.status().length, 0);
    assert.equal(f.portal.writes.length, 0);
  }
  const f = await fixture(t);
  const other = await f.service.saveConnector({ type: 'layr', apiMode: 'production', portalUrl: PORTAL, token: TOKEN });
  await f.manager.reload();
  await assert.rejects(f.manager.queueSliceEvidence(f.id), { code: 'LAYR_PRODUCTION_INPUT_REQUIRED' });
  const chosen = await f.manager.queueSliceEvidence(f.id, { connectorId: other.id });
  assert.equal(chosen.connectorId, other.id);
  assert.equal(f.manager.outbox.status().length, 1);
});

test('valid trailing-slash portal input is normalized so same-origin evidence remains routable', async t => {
  const f = await fixture(t, { config: { portalUrl: `${PORTAL}/` }, autoSync: true });
  assert.equal(f.service.getConnectors()[0].portalUrl, PORTAL);
  const status = await f.manager.pollNow(f.connectorId);
  assert.equal(status.state, 'idle');
  assert.equal(f.portal.writes.length, 1);
  assert.equal(f.manager.outbox.status()[0].state, 'confirmed');
});

test('saved evidence lookup preserves its original body/version after portal version advances', async t => {
  const f = await fixture(t);
  let fileChecks = 0;
  const original = f.service.getResinSliceDownload.bind(f.service);
  f.service.getResinSliceDownload = async id => { fileChecks++; return original(id); };
  const queued = await f.manager.queueSliceEvidence(f.id, { version: 5 });
  const firstBody = JSON.parse(await f.outboxFile()).operations[0].bodyJson;
  const lookedUp = await f.manager.queueSliceEvidence(f.id, { version: 6 });
  assert.equal(lookedUp.operationId, queued.operationId);
  assert.equal(lookedUp.version, 5);
  assert.equal(fileChecks, 2, 'current file integrity is revalidated while the original saved version/body remains unchanged');
  assert.equal(JSON.parse(await f.outboxFile()).operations[0].bodyJson, firstBody);
});

test('automatic preparation sync records only matching reviewed tickets and leaves production unqualified', async t => {
  const f = await fixture(t, { autoSync: true });
  assert.equal((await f.manager.pollNow(f.connectorId)).state, 'idle');
  assert.equal(f.portal.writes.length, 1);
  assert.equal(JSON.parse(f.portal.writes[0]).action, 'record_slice');
  assert.equal(f.manager.outbox.status()[0].state, 'confirmed');
  assert.equal(f.manager.outbox.status()[0].confirmation.qualified, false);
  assert.equal(f.service.getJob(f.id).status, 'review');
  assert.equal(f.service.getJob(f.id).runs.length, 0);
  await f.manager.pollNow(f.connectorId);
  assert.equal(f.portal.writes.length, 1);
  assert.equal(f.hardwareCalls, 0);
  const noPreparationTicket = await fixture(t, { autoSync: true });
  noPreparationTicket.portal.status = 'queued';
  await noPreparationTicket.manager.pollNow(noPreparationTicket.connectorId);
  assert.equal(noPreparationTicket.portal.writes.length, 0);
  assert.equal(noPreparationTicket.manager.outbox.status().length, 0);
});

test('automatic evidence sync remains opt-in while explicitly queued evidence is processed by production polling', async t => {
  const f = await fixture(t, { autoSync: false });
  await f.manager.pollNow(f.connectorId);
  assert.equal(f.portal.writes.length, 0);
  assert.equal(f.manager.outbox.status().length, 0);
  const queued = await f.manager.queueSliceEvidence(f.id);
  assert.equal(queued.state, 'pending');
  await f.manager.pollNow(f.connectorId);
  assert.equal(f.portal.writes.length, 1);
  assert.equal(f.manager.outbox.get(queued.operationId).state, 'confirmed');
  assert.equal(f.hardwareCalls, 0);
});

test('polling retries a lost applied receipt after restart with the same UUID/body despite a newer portal version', async t => {
  const f = await fixture(t, { autoSync: true, loseResponse: true });
  await f.manager.pollNow(f.connectorId);
  const pending = f.manager.outbox.status()[0];
  assert.equal(pending.state, 'pending');
  assert.equal(f.portal.version, 6);
  assert.equal(f.portal.operations.size, 1);
  await f.restart(); f.advance(5001);
  await f.manager.pollNow(f.connectorId);
  const confirmed = f.manager.outbox.status()[0];
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.operationId, pending.operationId);
  assert.equal(confirmed.version, 5);
  assert.equal(f.portal.writes.length, 2);
  assert.equal(f.portal.writes[0], f.portal.writes[1]);
  assert.equal(f.portal.operations.size, 1);
  assert.equal(f.hardwareCalls, 0);
  assert.ok(!(await f.outboxFile()).includes(TOKEN));
});

test('automatic sync quarantines previously queued evidence while its artifact has changed on disk', async t => {
  const f = await fixture(t, { autoSync: true });
  const queued = await f.manager.queueSliceEvidence(f.id);
  const originalBody = JSON.parse(await f.outboxFile()).operations[0].bodyJson;
  const mutated = Buffer.from(f.bytes); mutated[12] ^= 1;
  await fs.writeFile(f.slice.filePath, mutated);
  const status = await f.manager.pollNow(f.connectorId);
  assert.equal(status.state, 'error');
  assert.equal(f.portal.writes.length, 0);
  assert.equal(f.manager.outbox.get(queued.operationId).attempts, 0);
  assert.equal(f.manager.outbox.get(queued.operationId).state, 'paused');
  assert.equal(JSON.parse(await f.outboxFile()).operations[0].bodyJson, originalBody);
  await fs.writeFile(f.slice.filePath, f.bytes);
  await f.manager.pollNow(f.connectorId);
  assert.equal(f.portal.writes.length, 1);
  assert.equal(f.manager.outbox.get(queued.operationId).state, 'confirmed');
  assert.equal(f.hardwareCalls, 0);
});

test('manager stop waits for tracked evidence validation so backup cannot overtake a pending helper', async t => {
  const f = await fixture(t);
  const entered = gate(), release = gate();
  const original = f.service.getResinSliceDownload.bind(f.service);
  f.service.getResinSliceDownload = async id => { entered.resolve(); await release.promise; return original(id); };
  const queued = f.manager.queueSliceEvidence(f.id);
  const rejected = assert.rejects(queued, { code: 'LAYR_OUTBOX_STOPPED' });
  await entered.promise;
  assert.ok(f.manager.inFlight.has(`resin-evidence:${f.id}`));
  let stopped = false;
  const stopping = f.manager.stop().then(() => { stopped = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
  } finally { release.resolve(); }
  await rejected; await stopping;
  assert.equal(f.manager.inFlight.size, 0);
  assert.equal(f.manager.outbox.status().length, 0);
  assert.equal(f.portal.writes.length, 0);
});

test('manager stop aborts an in-flight evidence POST and retains its stable operation for retry', async t => {
  const f = await fixture(t, { autoSync: true });
  const entered = gate();
  f.portal.blockPost = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered.resolve();
  });
  const polling = f.manager.pollNow(f.connectorId);
  await entered.promise;
  assert.ok(f.manager.inFlight.has(f.connectorId));
  await f.manager.stop(); await polling;
  assert.equal(f.manager.inFlight.size, 0);
  assert.equal(f.manager.controllers.size, 0);
  assert.equal(f.manager.outbox.status()[0].state, 'pending');
  assert.equal(f.portal.operations.size, 0);
  assert.equal(f.hardwareCalls, 0);
});

async function replaceSlice(f) {
  const bytes = Buffer.from(f.bytes); bytes.write('New creator', 12);
  await fs.writeFile(f.slice.filePath, bytes);
  await f.mutate(job => {
    job.resinSlice.sha256 = hash(bytes);
    job.resinSlice.bytes = bytes.length;
    job.resinSlice.inspection = inspectGoo(bytes);
  });
}

test('a later manually queued slice reads the current portal version instead of the imported ticket version', async t => {
  const f = await fixture(t);
  const first = await f.manager.queueSliceEvidence(f.id);
  await f.manager.pollNow(f.connectorId);
  assert.equal(f.portal.version, 6);
  assert.equal(f.service.getJob(f.id).order.portalVersion, 5);
  await replaceSlice(f);
  const second = await f.manager.queueSliceEvidence(f.id);
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(second.version, 6);
  await f.manager.pollNow(f.connectorId);
  assert.equal(f.manager.outbox.get(second.operationId).state, 'confirmed');
  assert.equal(f.portal.version, 7);
  assert.equal(f.portal.operations.size, 2);
});

test('ambiguous prior receipt is replayed before a newly captured slice is sent at its fresh version', async t => {
  const f = await fixture(t, { autoSync: true, loseResponse: true });
  await f.manager.pollNow(f.connectorId);
  const first = f.manager.outbox.status()[0];
  assert.equal(first.state, 'pending');
  assert.equal(first.attempts, 1);
  assert.equal(f.portal.version, 6);
  await replaceSlice(f); f.advance(5001);
  await f.manager.pollNow(f.connectorId);
  const operations = f.manager.outbox.status();
  assert.equal(operations.length, 2);
  assert.ok(operations.every(operation => operation.state === 'confirmed'));
  assert.equal(operations[0].operationId, first.operationId);
  assert.equal(f.portal.writes[0], f.portal.writes[1]);
  assert.equal(JSON.parse(f.portal.writes[2]).version, 6);
  assert.equal(f.portal.version, 7);
  assert.equal(f.portal.operations.size, 2);
  assert.equal(f.hardwareCalls, 0);
});

test('manually queued unsent evidence is paused if files change even when automatic queueing is disabled', async t => {
  const f = await fixture(t, { autoSync: false });
  const queued = await f.manager.queueSliceEvidence(f.id);
  const bytes = Buffer.from(f.bytes); bytes[12] ^= 1;
  await fs.writeFile(f.slice.filePath, bytes);
  await f.manager.pollNow(f.connectorId);
  assert.equal(f.portal.writes.length, 0);
  assert.equal(f.manager.outbox.get(queued.operationId).state, 'paused');
  assert.equal(f.manager.outbox.get(queued.operationId).attempts, 0);
});

test('reviewed conflict dismissal permits a fresh receipt without rewriting old evidence history', async t => {
  const f = await fixture(t);
  const old = await f.manager.queueSliceEvidence(f.id);
  const originalBody = JSON.parse(await f.outboxFile()).operations[0].bodyJson;
  f.portal.version = 6;
  await f.manager.pollNow(f.connectorId);
  assert.equal(f.manager.outbox.get(old.operationId).state, 'conflict');
  const resolved = await f.manager.dismissOperation(old.operationId, { reason: `Reviewed stale portal version; credential ${TOKEN}` });
  assert.equal(resolved.state, 'dismissed');
  assert.ok(!resolved.resolution.reason.includes(TOKEN));
  const fresh = await f.manager.queueSliceEvidence(f.id);
  assert.notEqual(fresh.operationId, old.operationId);
  assert.equal(fresh.version, 6);
  await f.manager.pollNow(f.connectorId);
  assert.equal(f.manager.outbox.get(fresh.operationId).state, 'confirmed');
  const lookup = await f.manager.queueSliceEvidence(f.id);
  assert.equal(lookup.operationId, fresh.operationId);
  assert.equal(JSON.parse(await f.outboxFile()).operations[0].bodyJson, originalBody);
  assert.ok(!(await f.outboxFile()).includes(TOKEN));
});
