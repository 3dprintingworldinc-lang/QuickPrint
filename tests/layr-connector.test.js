'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { ConnectorManager } = require('../src/connectors');
const transport = require('../src/connectors/layr-client');
const productionTransport = require('../src/connectors/layr-production-client');

const PORTAL = 'https://printbylayr.example';
const TOKEN = 'a'.repeat(43);
const REFRESH = 'r'.repeat(43);
const MODEL = Buffer.from('solid approved\nendsolid approved\n');
const JOB_ID = 'f5bb06b2-cf61-4c74-8393-ad120c8d6a7a';
const hash = data => createHash('sha256').update(data).digest('hex');
function portalJob() {
  return {
    id: JOB_ID, reference: `PBL-${JOB_ID.toUpperCase()}`, version: 5, status: 'preparing',
    payment: { amountCents: 2150, confirmedAt: '2026-11-19T15:00:00Z' },
    payload: { production: { printType: 'fdm-standard' }, project: { quantity: 500 } },
    ticket: {
      createdAt: '2026-11-19T15:00:00Z', quote: { amountCents: 2150, currency: 'CAD' },
      model: { fileId: 'private-storage-id', size: MODEL.length },
      specifications: {
        client: { email: 'private-customer@example.test' },
        file: { name: 'approved.stl', format: 'stl', sizeBytes: MODEL.length, units: 'mm' },
        project: { name: 'Approved study model', quantity: 12, scale: '1:100', notes: 'Inspect supports.' },
        production: { printType: 'resin', supports: 'no-visible', qualityTier: 'presentation', colour: 'grey', properties: 'standard' },
      },
    },
  };
}

function portalFixture({ job = portalJob(), onRpc, rpcStatus, block } = {}) {
  const calls = [];
  let downloads = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/mcp')) {
      await onRpc?.(options);
      if (block) return block(options.signal);
      if (rpcStatus) return new Response(TOKEN, { status: rpcStatus });
      const request = JSON.parse(options.body);
      let value;
      if (request.params.name === 'list_jobs') value = { count: 1, jobs: [{ id: job.id, version: job.version, status: job.status }] };
      else if (request.params.name === 'get_job') value = job;
      else if (request.params.name === 'model_download_link') value = { file: 'approved.stl', url: `${PORTAL}/api/intake?download=private.signature` };
      else assert.fail(`Unexpected portal mutation ${request.params.name}`);
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
    }
    downloads++;
    assert.equal(options.headers, undefined);
    return new Response(MODEL);
  };
  const layrClient = {
    ...transport,
    listPreparationJobs: (config, options) => transport.listPreparationJobs(config, { ...options, fetchImpl }),
    downloadModel: (config, job, options) => transport.downloadModel(config, job, { ...options, fetchImpl }),
  };
  return { layrClient, calls, get downloads() { return downloads; } };
}

async function fixture(t, { config = {}, portal = portalFixture(), layrOAuth, layrProductionClient } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-layr-'));
  let service = new QuickPrintService({ dataDir });
  await service.init();
  const saved = await service.saveConnector({ type: 'layr', name: 'Layr studio', portalUrl: PORTAL, token: TOKEN, pollIntervalMs: 60000, ...config });
  let time = Date.parse('2026-11-19T16:00:00Z');
  let manager;
  const makeManager = async () => {
    manager = new ConnectorManager({ service, layrClient: portal.layrClient, layrProductionClient, layrOAuth, now: () => time, tickMs: 86400000 });
    await manager.start();
    return manager;
  };
  t.after(async () => { await manager?.stop(); await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, id: saved.id, portal, makeManager, get manager() { return manager; }, get service() { return service; },
    advance(milliseconds) { time += milliseconds; },
    async reopen() { await manager?.stop(); await service.close(); service = new QuickPrintService({ dataDir }); await service.init(); return makeManager(); },
  };
}

test('polling automatically imports paid resin ticket with source hash and separate requested part quantity', async t => {
  const f = await fixture(t);
  const manager = await f.makeManager();
  manager.tick();
  const status = await manager.pollNow(f.id);
  assert.equal(status.state, 'idle');
  assert.equal(status.importedCount, 1);
  const [job] = f.service.snapshot().jobs;
  assert.equal(job.status, 'review');
  assert.equal(job.technology, 'resin');
  assert.equal(job.quantity, 1);
  assert.equal(job.remainingQuantity, 1);
  assert.equal(job.order.requestedQuantity, 12);
  assert.equal(job.order.production.printType, 'resin');
  assert.equal(job.order.project.name, 'Approved study model');
  assert.equal(job.order.project.notes, 'Inspect supports.');
  assert.equal(job.order.modelSha256, hash(MODEL));
  assert.equal(job.sha256, job.order.modelSha256);
  assert.equal(job.source, `layr:${PORTAL}`);
  assert.equal(job.sourceId, `${JOB_ID}:${transport.ticketFingerprint(portalJob())}`);
  assert.deepEqual(await fs.readFile(job.inputPath), MODEL);
  assert.equal(job.printerId, undefined);
  assert.ok(!JSON.stringify(job.order).includes('private-customer'));
  await assert.rejects(f.service.prepareJob(job.id, 'fdm-printer'), { code: 'RESIN_SLICING_UNAVAILABLE' });
  assert.ok(f.portal.calls.filter(call => call.url.endsWith('/mcp')).every(call => ['list_jobs', 'get_job', 'model_download_link'].includes(JSON.parse(call.options.body).params.name)));
});

test('polling and full restart deduplicate ticket identity before re-downloading and retain metadata', async t => {
  const f = await fixture(t);
  let manager = await f.makeManager();
  await manager.pollNow(f.id);
  const first = f.service.snapshot().jobs[0];
  await manager.pollNow(f.id);
  assert.equal(f.portal.downloads, 1);
  manager = await f.reopen();
  await manager.pollNow(f.id);
  assert.equal(f.portal.downloads, 1);
  assert.equal(f.service.snapshot().jobs.length, 1);
  assert.deepEqual(f.service.snapshot().jobs[0].order, first.order);
  const checkpoint = await fs.readFile(manager.stateFile, 'utf8');
  const state = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  for (const raw of [checkpoint, state]) assert.ok(!raw.includes(TOKEN));
  assert.ok(!checkpoint.includes('private-customer'));
  assert.ok(!checkpoint.includes('private.signature'));
  assert.ok(checkpoint.includes(first.order.ticketFingerprint));
});

test('service receipt identity still prevents duplicate jobs after a checkpoint-save failure', async t => {
  const f = await fixture(t);
  let manager = await f.makeManager();
  manager.persist = async () => { throw new Error('fixture disk failure'); };
  assert.equal((await manager.pollNow(f.id)).state, 'error');
  assert.equal(f.service.snapshot().jobs.length, 1);
  manager = await f.reopen();
  assert.equal((await manager.pollNow(f.id)).state, 'idle');
  assert.equal(f.service.snapshot().jobs.length, 1);
  assert.equal(f.portal.downloads, 2, 'without a saved checkpoint a retry may fetch again, but cannot create another job');
});

test('rotating refresh credentials are durably encrypted before any portal RPC', async t => {
  const newToken = 'b'.repeat(43);
  const newRefresh = 's'.repeat(43);
  let f;
  let refreshes = 0;
  const portal = portalFixture({ onRpc: async options => {
    assert.equal(options.headers.Authorization, `Bearer ${newToken}`);
    const [saved] = f.service.getConnectors({ secrets: true });
    assert.equal(saved.token, newToken);
    assert.equal(saved.refreshToken, newRefresh);
    const disk = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
    assert.ok(!disk.includes(newToken));
    assert.ok(!disk.includes(newRefresh));
    assert.equal(JSON.parse(disk).connectors[0].refreshToken.protected, true);
  } });
  const layrOAuth = { refresh: async (config, { signal }) => {
    refreshes++;
    assert.equal(config.refreshToken, REFRESH);
    assert.equal(signal.aborted, false);
    return { ...config, token: newToken, refreshToken: newRefresh, expiresAt: '2026-11-19T17:00:00Z' };
  } };
  f = await fixture(t, { portal, layrOAuth, config: { refreshToken: REFRESH, clientId: `pbl_${'c'.repeat(22)}`, expiresAt: '2026-11-19T15:59:00Z' } });
  const manager = await f.makeManager();
  assert.equal((await manager.pollNow(f.id)).state, 'idle');
  assert.equal(refreshes, 1);
  await manager.pollNow(f.id);
  assert.equal(refreshes, 1);
  assert.ok(!JSON.stringify(f.service.snapshot()).includes(newToken));
  assert.ok(!JSON.stringify(f.service.snapshot()).includes(newRefresh));
});

test('failed persistence of rotated credentials prevents portal requests', async t => {
  const portal = portalFixture();
  const layrOAuth = { refresh: async config => ({ ...config, token: 'b'.repeat(43), refreshToken: 's'.repeat(43) }) };
  const f = await fixture(t, { portal, layrOAuth, config: { refreshToken: REFRESH, expiresAt: '2026-11-19T15:00:00Z' } });
  const manager = await f.makeManager();
  f.service.saveConnector = async () => { throw new Error(`disk error ${REFRESH}`); };
  const status = await manager.pollNow(f.id);
  assert.equal(status.state, 'error');
  assert.equal(portal.calls.length, 0);
  assert.ok(!JSON.stringify([status, f.service.snapshot().events]).includes(REFRESH));
});

test('authentication and size failures remain visible and redact credentials with retry backoff', async t => {
  const f = await fixture(t, { portal: portalFixture({ rpcStatus: 401 }) });
  const manager = await f.makeManager();
  const first = await manager.pollNow(f.id);
  assert.equal(first.state, 'error');
  assert.match(first.error, /authorization expired|reconnect/i);
  const second = await manager.pollNow(f.id);
  assert.ok(new Date(second.nextPollAt) > new Date(first.nextPollAt));
  assert.equal(f.service.snapshot().events.filter(event => event.type === 'connector.import_failed').length, 1);
  assert.ok(!JSON.stringify([manager.status(), f.service.snapshot().events]).includes(TOKEN));

  const large = portalJob();
  large.ticket.model.size = large.ticket.specifications.file.sizeBytes = transport.MAX_MODEL_BYTES + 1;
  const oversized = portalFixture({ job: large });
  manager.layrClient = oversized.layrClient;
  assert.match((await manager.pollNow(f.id)).error, /100 MiB/);
  assert.equal(oversized.downloads, 0);
  assert.equal(f.service.snapshot().jobs.length, 0);
});

test('stopping a manager aborts in-flight portal requests without importing files', async t => {
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  let aborted = false;
  const portal = portalFixture({ block: signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    requestStarted();
  }) });
  const f = await fixture(t, { portal });
  const manager = await f.makeManager();
  const polling = manager.pollNow(f.id);
  await started;
  await manager.stop();
  await polling;
  assert.equal(aborted, true);
  assert.equal(f.service.snapshot().jobs.length, 0);
  assert.equal(manager.controllers.size, 0);
  await assert.rejects(manager.pollNow(f.id), { status: 409 });
});

test('service rejects mismatched model receipts, FDM metadata and plate quantity overrides atomically', async t => {
  const f = await fixture(t);
  const order = transport.buildOrderMetadata(portalJob(), PORTAL, MODEL);
  const request = { source: `layr:${PORTAL}`, sourceId: `${JOB_ID}:${order.ticketFingerprint}`, quantity: 1, order, files: [{ name: 'approved.stl', data: MODEL }] };
  for (const mutate of [
    input => { input.order.production.printType = 'fdm-standard'; },
    input => { input.order.requestedQuantity = 0; },
    input => { input.order.ticketFingerprint = 'invalid'; },
    input => { input.order.modelSha256 = '0'.repeat(64); },
    input => { input.quantity = 12; },
    input => { input.files[0].quantity = 12; },
  ]) {
    const input = { ...structuredClone(request), files: [{ name: 'approved.stl', data: Buffer.from(MODEL) }] };
    mutate(input);
    await assert.rejects(f.service.submit(input), error => ['INVALID_PRODUCTION_TICKET', 'MODEL_RECEIPT_MISMATCH'].includes(error.code));
    assert.equal(f.service.snapshot().jobs.length, 0);
  }
  assert.equal((await f.service.submit(request)).duplicate, false);
  assert.equal((await f.service.submit(request)).duplicate, true);
});

function productionPortalFixture() {
  const full = portalJob();
  const ticket = {
    id: full.id, reference: full.reference, status: full.status, version: full.version,
    ticketFingerprint: transport.ticketFingerprint(full),
    ticket: { specifications: {
      project: structuredClone(full.ticket.specifications.project), production: structuredClone(full.ticket.specifications.production),
      file: structuredClone(full.ticket.specifications.file),
    } }, production: null,
  };
  let downloads = 0, writes = 0;
  const calls = [];
  const fetchImpl = async (address, options) => {
    const url = new URL(address);
    calls.push({ url: address, options });
    assert.equal(options.method, 'GET', 'polling is read-only in both transport modes');
    if (url.pathname === '/api/intake') {
      downloads++;
      assert.equal(options.headers, undefined);
      return new Response(MODEL);
    }
    assert.equal(url.pathname, '/api/production');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    switch (url.searchParams.get('action')) {
      case 'tickets': return Response.json({ tickets: [ticket], nextCursor: null });
      case 'ticket': return Response.json({ ticket });
      case 'download': return Response.json({ name: 'approved.stl', sizeBytes: MODEL.length, url: `${PORTAL}/api/intake?download=private.signature` });
      default: assert.fail('Unexpected production polling operation');
    }
  };
  const layrProductionClient = {
    ...productionTransport,
    listPreparationJobs: (config, options) => productionTransport.listPreparationJobs(config, { ...options, fetchImpl }),
    downloadModel: (config, job, options) => productionTransport.downloadModel(config, job, { ...options, fetchImpl }),
    postEvidence: () => { writes++; assert.fail('Polling must not generate production evidence'); },
  };
  return { calls, layrProductionClient, get downloads() { return downloads; }, get writes() { return writes; } };
}

test('production mode selects the scoped read client, imports metadata, and never uses OAuth or generates writeback', async t => {
  const production = productionPortalFixture();
  const mcp = portalFixture();
  const f = await fixture(t, { portal: mcp, layrProductionClient: production.layrProductionClient,
    config: { apiMode: 'production', refreshToken: REFRESH, expiresAt: '2026-11-19T15:00:00Z' },
    layrOAuth: { refresh: async () => assert.fail('Scoped machine tokens do not use studio OAuth refresh') } });
  let manager = await f.makeManager();
  assert.equal((await manager.pollNow(f.id)).state, 'idle');
  assert.equal(mcp.calls.length, 0);
  const [job] = f.service.snapshot().jobs;
  assert.equal(job.order.apiMode, 'production');
  assert.equal(job.order.requestedQuantity, 12);
  assert.equal(job.quantity, 1);
  assert.equal(job.order.ticketFingerprint, transport.ticketFingerprint(portalJob()));
  assert.equal(job.order.modelSha256, hash(MODEL));
  assert.equal(job.sourceId, `${JOB_ID}:${job.order.ticketFingerprint}`);
  assert.equal(production.downloads, 1);
  assert.equal(production.writes, 0);
  assert.equal(f.service.getConnectors()[0].apiMode, 'production');
  const disk = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  assert.ok(!disk.includes(TOKEN));
  assert.equal(JSON.parse(disk).connectors[0].token.protected, true);
  await manager.pollNow(f.id);
  manager = await f.reopen();
  await manager.pollNow(f.id);
  assert.equal(production.downloads, 1);
  assert.equal(f.service.snapshot().jobs.length, 1);
  assert.equal(f.service.snapshot().jobs[0].order.apiMode, 'production');
});

test('transport mode has its own polling checkpoint while the service deduplicates the same approved ticket across modes', async t => {
  const production = productionPortalFixture();
  const f = await fixture(t, { layrProductionClient: production.layrProductionClient });
  const manager = await f.makeManager();
  await manager.pollNow(f.id);
  assert.equal(f.portal.downloads, 1);
  const mcpLocation = manager.checkpoints.connectors[f.id].location;
  await f.service.saveConnector({ id: f.id, apiMode: 'production' });
  await manager.reload();
  await manager.pollNow(f.id);
  assert.notEqual(manager.checkpoints.connectors[f.id].location, mcpLocation);
  assert.equal(production.downloads, 1, 'transport mode starts its own receipt checkpoint');
  assert.equal(f.service.snapshot().jobs.length, 1, 'source/ticket identity prevents duplicate local jobs');
  assert.equal(production.writes, 0);
  await manager.pollNow(f.id);
  assert.equal(production.downloads, 1);
});

test('connector validation accepts default or explicit MCP and production, and refuses unknown API modes', () => {
  const { validateConnector } = require('../src/connectors');
  for (const apiMode of [undefined, 'mcp', 'production']) {
    assert.doesNotThrow(() => validateConnector({ type: 'layr', portalUrl: PORTAL, token: TOKEN, ...(apiMode ? { apiMode } : {}) }));
  }
  for (const apiMode of ['', 'studio', 'unknown', null, true]) {
    assert.throws(() => validateConnector({ type: 'layr', portalUrl: PORTAL, token: TOKEN, apiMode }), { status: 400 });
  }
});

test('an oversized first ticket does not starve later imports or exact replay of an applied receipt', async t => {
  const oversized = portalJob(); oversized.id = 'a39e3dab-7e63-4a5f-89ca-b994ecbe963a';
  oversized.ticket.model.size = oversized.ticket.specifications.file.sizeBytes = transport.MAX_MODEL_BYTES + 1;
  const good = portalJob(); good.id = '17858974-0650-44cf-bc20-c973104e722b';
  const downloads = [], writes = [], operations = new Map();
  let loseNext = true, listFailure = false;
  const scoped = {
    ticketFingerprint: transport.ticketFingerprint,
    listPreparationJobs: async () => { if (listFailure) throw new Error(`listing unavailable ${TOKEN}`); return [oversized, good]; },
    downloadModel: async (config, job) => {
      downloads.push(job.id);
      if (job.id === oversized.id) throw Object.assign(new Error(`too large ${TOKEN}`), { status: 413, code: 'LAYR_TOO_LARGE' });
      return { name: 'approved.stl', data: MODEL, order: { ...transport.buildOrderMetadata(job, PORTAL, MODEL), apiMode: 'production' } };
    },
    postEvidence: async (config, command) => {
      const body = JSON.stringify(command); writes.push(body);
      const prior = operations.get(command.operationId);
      if (prior) { assert.equal(prior.body, body); return prior.result; }
      const result = { ticket: { id: command.id, version: command.version + 1, status: 'preparing', ticketFingerprint: command.data.ticketFingerprint },
        receipt: { id: command.operationId, jobId: command.id, ticketFingerprint: command.data.ticketFingerprint, sourceSha256: command.data.sourceSha256, qualified: false, printReady: false } };
      operations.set(command.operationId, { body, result });
      if (loseNext) { loseNext = false; throw new Error(`lost applied response ${TOKEN}`); }
      return result;
    },
  };
  const f = await fixture(t, { config: { apiMode: 'production' }, layrProductionClient: scoped });
  const manager = await f.makeManager();
  const evidence = version => ({ connectorId: f.id, portalUrl: PORTAL, action: 'record_preprocessing', id: JOB_ID, version,
    data: { ticketFingerprint: 'a'.repeat(64), sourceSha256: hash(MODEL), tool: { name: 'Fixture evaluator', version: '1', executableSha256: 'e'.repeat(64) },
      outputs: [{ name: 'report.json', sha256: 'f'.repeat(64), sizeBytes: 20, kind: 'report' }], operations: { evaluate: true, fix: null, hollowThicknessMm: null } } });
  const first = await manager.outbox.enqueue(evidence(5), 'applied-before-backlog');
  await manager.outbox.process(f.service.getConnectors({ secrets: true }), { client: scoped });
  assert.equal(manager.outbox.get(first.operationId).state, 'pending');
  f.advance(5001);
  const status = await manager.pollNow(f.id);
  assert.equal(status.state, 'error');
  assert.match(status.error, /100 MiB/);
  assert.deepEqual(downloads, [oversized.id, good.id]);
  assert.equal(f.service.snapshot().jobs.length, 1);
  assert.equal(f.service.snapshot().jobs[0].order.portalJobId, good.id);
  assert.equal(manager.outbox.get(first.operationId).state, 'confirmed');
  assert.equal(writes[0], writes[1]);
  assert.equal(Object.keys(manager.checkpoints.connectors[f.id].receipts).length, 1);
  assert.ok(!Object.keys(manager.checkpoints.connectors[f.id].receipts).some(key => key.startsWith(oversized.id)));

  // Listing can also fail independently after an earlier write was applied.
  const second = await manager.outbox.enqueue(evidence(6), 'applied-before-list-failure');
  loseNext = true;
  await manager.outbox.process(f.service.getConnectors({ secrets: true }), { client: scoped });
  f.advance(5001); listFailure = true;
  assert.equal((await manager.pollNow(f.id)).state, 'error');
  assert.equal(manager.outbox.get(second.operationId).state, 'confirmed');
  assert.equal(writes[2], writes[3]);
  assert.ok(!JSON.stringify(manager.status()).includes(TOKEN));
});
