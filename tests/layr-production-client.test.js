'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const client = require('../src/connectors/layr-production-client');

const ORIGIN = 'https://printbylayr.example';
const TOKEN = 'p'.repeat(43);
const MODEL = Buffer.from('solid production\nendsolid production\n');
const CONFIG = { apiMode: 'production', portalUrl: ORIGIN, token: TOKEN };
const NOW = Date.parse('2026-11-19T16:00:00Z');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const source = process.env.QUICKPRINT_PORTAL_SOURCE ? path.resolve(process.env.QUICKPRINT_PORTAL_SOURCE) : path.resolve(__dirname, '../integrations/printbylayr');
const portalAvailable = ['server/production.mjs', 'tests/workflow-fixture.mjs', 'migrations/0005_production.sql', 'migrations/0006_production_quantities.sql'].every(file => existsSync(path.join(source, file)));
const portalTest = (name, run) => test(name, { skip: portalAvailable ? false : 'Reviewed private portal source is absent or incomplete; set QUICKPRINT_PORTAL_SOURCE or materialize the reviewed v2 checkout. See docs/PRINTBYLAYR-PRODUCTION-INTEGRATION.md.' }, run);
let imports;
async function modules() {
  imports ||= Promise.all([
    import(pathToFileURL(path.join(source, 'server/production.mjs')).href),
    import(pathToFileURL(path.join(source, 'server/intake.mjs')).href),
    import(pathToFileURL(path.join(source, 'server/workflow.mjs')).href),
    import(pathToFileURL(path.join(source, 'tests/workflow-fixture.mjs')).href),
    import(pathToFileURL(path.join(source, 'tests/storage-fixture.mjs')).href),
    import('node:fs'),
  ]);
  return imports;
}
async function fixture(t) {
  const [production, intake, workflow, { SqliteWorkflowD1 }, { FakeB2 }, { readFileSync }] = await modules();
  const database = new SqliteWorkflowD1();
  database.database.exec(readFileSync(path.join(source, 'migrations/0005_production.sql'), 'utf8'));
  database.database.exec(readFileSync(path.join(source, 'migrations/0006_production_quantities.sql'), 'utf8'));
  t.after(() => database.database.close());
  const b2 = new FakeB2();
  const env = {
    WORKFLOW_ENABLED: '1', INTAKE_DB: database,
    INTAKE_SIGNING_SECRET: 'test-production-client-signing-secret-at-least-32-characters',
    PRODUCTION_MACHINE_ID: 'quickprint-client-test', PRODUCTION_TOKEN_SHA256: sha256(TOKEN),
    B2_APPLICATION_KEY_ID: 'test-key-id', B2_APPLICATION_KEY: 'test-key', B2_BUCKET_ID: 'test-bucket',
  };
  const calls = [];
  let transform;
  const options = { fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    const address = new URL(url);
    let result;
    if (address.origin !== ORIGIN) assert.fail('Unexpected external destination');
    if (address.pathname === '/api/production') {
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(options.redirect, 'error');
      result = await production.handleProduction(new Request(url, options), env, { now: () => NOW, log: () => {} });
    } else if (address.pathname === '/api/intake') {
      assert.equal(options.headers, undefined, 'never forward production bearer to model URL');
      assert.equal(options.redirect, 'error');
      result = await intake.handleIntake(new Request(url, options), env, { now: () => NOW, storageFetch: b2.fetch, log: () => {} });
    } else assert.fail('Unexpected portal path');
    return transform ? transform(result, address, options) : result;
  } };
  const create = async ({ paid = true, printType = 'resin', createdAt = new Date(NOW).toISOString(), quantity = 12 } = {}) => {
    const id = randomUUID();
    const record = {
      id, requestId: `PBL-${id.toUpperCase()}`, origin: ORIGIN, createdAt,
      model: { fileId: `private-${id}`, size: MODEL.length, sha1: createHash('sha1').update(MODEL).digest('hex') }, notification: { accepted: true },
      payload: {
        client: { fullName: 'Private Customer', email: 'private-client@example.test' },
        project: { name: 'Production model', quantity, scale: '1:100', notes: 'Review supports.' },
        production: { printType, qualityTier: 'presentation', supports: 'allowed', colour: 'grey', properties: 'standard' },
        file: { name: 'production.stl', format: 'stl', sizeBytes: MODEL.length, units: 'mm' },
      },
    };
    b2.objects.set(record.model.fileId, { fileId: record.model.fileId, key: `requests/${id}/model.stl`, bytes: MODEL, sha1: record.model.sha1 });
    database.database.prepare('INSERT INTO intake_requests(id,record_json,model_json,notification_json,created_at) VALUES(?,?,?,?,?)')
      .run(id, JSON.stringify(record), JSON.stringify(record.model), JSON.stringify(record.notification), createdAt);
    let job = await workflow.ensureJob(env, record, { customerUrl: `${ORIGIN}/job#private-customer-link`, now: NOW });
    if (!paid) return job;
    const action = (command, data, actor = 'studio') => workflow.commandJob(env, { id, version: job.version, operationId: randomUUID(), command, data, actor, now: NOW });
    job = await action('issue_quote', { amountCents: 2500, leadTimeDays: 5, expiresAt: new Date(NOW + 86400000).toISOString(), summary: 'Approved fixture.', fulfilment: 'pickup' });
    job = await action('accept_quote', {}, 'customer');
    return action('confirm_payment', { amountCents: 2500, reference: 'private-bank-reference' });
  };
  const evidence = job => ({
    action: 'record_preprocessing', id: job.id, version: job.version, operationId: randomUUID(),
    data: { ticketFingerprint: job.ticketFingerprint, sourceSha256: sha256(MODEL),
      tool: { name: 'ELEGOO SatelLite', version: '1.0.0', executableSha256: 'e'.repeat(64) },
      outputs: [{ name: 'report.json', sha256: 'f'.repeat(64), sizeBytes: 20, kind: 'report' }],
      operations: { evaluate: true, fix: null, hollowThicknessMm: null } },
  });
  return { env, database, b2, options, calls, create, evidence, workflow, production, setTransform(value) { transform = value; } };
}

test('production config requires scoped HTTPS origin and token and never accepts URLs with paths or secrets', () => {
  assert.deepEqual(client.validateLayrConfig(CONFIG), CONFIG);
  for (const portalUrl of ['http://localhost:9999', `${ORIGIN}/mcp`, `${ORIGIN}/?token=x`, `${ORIGIN}/#x`, 'https://secret:token@example.test']) {
    assert.throws(() => client.validateLayrConfig({ ...CONFIG, portalUrl }), { status: 400 });
  }
  assert.throws(() => client.validateLayrConfig({ ...CONFIG, token: 'invalid' }), { status: 400 });
  assert.throws(() => client.validateLayrConfig({ ...CONFIG, apiMode: 'mcp' }), { status: 400 });
});

portalTest('actual production handler pages beyond 100 eligible jobs without leaking private ticket fields', async t => {
  const f = await fixture(t);
  const oldest = await f.create();
  for (let i = 0; i < 100; i++) {
    const job = structuredClone(oldest); job.id = randomUUID(); job.reference = `PBL-${job.id}`;
    job.createdAt = new Date(NOW - i * 1000).toISOString();
    const { events, ...snapshot } = job;
    f.database.database.prepare('INSERT INTO workflow_jobs(id,job_json,version,status,created_at,updated_at,last_operation_id) VALUES(?,?,?,?,?,?,?)')
      .run(job.id, JSON.stringify(snapshot), job.version, job.status, job.createdAt, job.updatedAt, `fixture-${job.id}`);
  }
  await f.create({ paid: false });
  await f.create({ printType: 'fdm-standard' });
  const jobs = await client.listPreparationJobs(CONFIG, f.options);
  assert.equal(jobs.length, 101);
  assert.equal(new Set(jobs.map(job => job.id)).size, 101);
  assert.equal(f.calls.length, 2);
  const projected = jobs.find(job => job.id === oldest.id);
  assert.equal(client.ticketFingerprint(projected), await f.production.productionTicketFingerprint(oldest.ticket));
  assert.notEqual(client.ticketFingerprint(projected), sha256(JSON.stringify(projected.ticket)), 'sanitized ticket is not re-hashed');
  for (const secret of ['private-client', 'private-bank', 'private-customer-link', 'fileId']) assert.ok(!JSON.stringify(jobs).includes(secret));
});

portalTest('actual private model download retains authoritative fingerprint and separate requested part quantity', async t => {
  const f = await fixture(t);
  const original = await f.create();
  const [job] = await client.listPreparationJobs(CONFIG, f.options);
  const downloaded = await client.downloadModel(CONFIG, job, f.options);
  assert.equal(downloaded.name, 'production.stl');
  assert.deepEqual(downloaded.data, MODEL);
  assert.equal(downloaded.order.portalJobId, original.id);
  assert.equal(downloaded.order.portalVersion, original.version);
  assert.equal(downloaded.order.ticketFingerprint, job.ticketFingerprint);
  assert.equal(downloaded.order.modelSha256, sha256(MODEL));
  assert.equal(downloaded.order.apiMode, 'production');
  assert.equal(downloaded.order.requestedQuantity, 12);
  assert.equal(downloaded.order.quantity, undefined);
  assert.equal(downloaded.order.units, 'mm');
  assert.equal(f.b2.calls.at(-1).operation, 'b2_download_file_by_id');
  assert.equal(f.calls.at(-1).options.headers, undefined);
});

portalTest('version or frozen ticket changes are refused before model downloading', async t => {
  const f = await fixture(t);
  const original = await f.create();
  const [job] = await client.listPreparationJobs(CONFIG, f.options);
  await f.workflow.commandJob(f.env, { id: original.id, version: original.version, operationId: randomUUID(), command: 'add_note', data: { note: 'Changed during import' }, actor: 'studio', now: NOW });
  await assert.rejects(client.downloadModel(CONFIG, job, f.options), { status: 409 });
  assert.ok(!f.calls.some(call => new URL(call.url).pathname === '/api/intake'));
});

portalTest('private links cannot redirect credentials or select unrestricted external URLs', async t => {
  const f = await fixture(t);
  await f.create();
  const [job] = await client.listPreparationJobs(CONFIG, f.options);
  for (const replacement of [
    'https://evil.example/api/intake?download=private.signature',
    `${ORIGIN}/api/operations?download=private.signature`,
    `${ORIGIN}/api/intake?download=unsigned`,
    `${ORIGIN}/api/intake?download=private.signature&other=1`,
    `${ORIGIN}/api/intake?download=private.signature#fragment`,
  ]) {
    f.setTransform(async (response, url) => url.searchParams.get('action') === 'download' ? Response.json({ ...await response.json(), url: replacement }) : response);
    await assert.rejects(client.downloadModel(CONFIG, job, f.options), /model link/);
  }
  assert.ok(!f.calls.some(call => new URL(call.url).pathname === '/api/intake'));
});

portalTest('declared and streamed size overflows cancel downloads; truncated bodies never become models', async t => {
  const f = await fixture(t);
  await f.create();
  const [job] = await client.listPreparationJobs(CONFIG, f.options);
  let cancelled = false;
  f.setTransform((response, url) => url.pathname === '/api/intake' ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': String(client.MAX_MODEL_BYTES + 1) } }) : response);
  await assert.rejects(client.downloadModel(CONFIG, job, f.options), { code: 'LAYR_TOO_LARGE' });
  assert.equal(cancelled, true);
  cancelled = false;
  f.setTransform((response, url) => url.pathname === '/api/intake' ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MODEL.length + 1)); }, cancel() { cancelled = true; },
  })) : response);
  await assert.rejects(client.downloadModel(CONFIG, job, f.options), { code: 'LAYR_TOO_LARGE' });
  assert.equal(cancelled, true);
  f.setTransform((response, url) => url.pathname === '/api/intake' ? new Response(MODEL.subarray(1)) : response);
  await assert.rejects(client.downloadModel(CONFIG, job, f.options), /size differs/);
  const large = structuredClone(job); large.ticket.specifications.file.sizeBytes = client.MAX_MODEL_BYTES + 1;
  const before = f.calls.length;
  await assert.rejects(client.downloadModel(CONFIG, large, f.options), /100 MiB/);
  assert.equal(f.calls.length, before);
});

portalTest('production evidence writes actual immutable receipts and replays caller operation IDs exactly', async t => {
  const f = await fixture(t);
  const original = await f.create();
  const [job] = await client.listPreparationJobs(CONFIG, f.options);
  const command = f.evidence(job);
  const recorded = await client.postEvidence(CONFIG, command, f.options);
  assert.equal(recorded.receipt.id, command.operationId);
  assert.equal(recorded.receipt.qualified, false);
  assert.equal(recorded.receipt.printReady, false);
  assert.equal(recorded.ticket.version, original.version + 1);
  assert.deepEqual(await client.postEvidence(CONFIG, command, f.options), recorded);
  const writes = f.calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].options.body, JSON.stringify(command));
  assert.equal(writes[1].options.body, writes[0].options.body);
  const changed = structuredClone(command); changed.data.outputs[0].sha256 = '0'.repeat(64);
  await assert.rejects(client.postEvidence(CONFIG, changed, f.options), error => error.status === 409 && error.portalCode === 'operation_conflict');
  assert.equal(Number(f.database.database.prepare('SELECT COUNT(*) n FROM production_receipts').get().n), 1);
});

portalTest('native artifact metadata reaches the actual portal at 218451945 bytes and 512 MiB without becoming qualified automatically', async t => {
  const f = await fixture(t);
  for (const sizeBytes of [218451945, 512 * 1024 * 1024, 512 * 1024 * 1024 + 1]) {
    const original = await f.create();
    const job = (await client.listPreparationJobs(CONFIG, f.options)).find(candidate => candidate.id === original.id);
    const command = f.evidence(job); command.action = 'record_slice';
    const { outputs, operations, ...common } = command.data;
    command.data = { ...common, profileSha256: 'c'.repeat(64), printerId: 'saturn4u16k-fixture', printerModel: 'ELEGOO Saturn 4 Ultra 16K', material: 'Reviewed test resin',
      artifact: { sha256: 'd'.repeat(64), sizeBytes, format: 'goo' } };
    if (sizeBytes > 512 * 1024 * 1024) {
      await assert.rejects(client.postEvidence(CONFIG, command, f.options), error => error.status === 400 && error.ambiguous === false);
      assert.equal((await f.workflow.getJob(f.env, original.id)).version, original.version);
    } else {
      const result = await client.postEvidence(CONFIG, command, f.options);
      assert.equal(result.receipt.artifact.sizeBytes, sizeBytes);
      assert.equal(result.receipt.qualified, false, 'a native artifact size does not create a server qualification binding');
      assert.equal(result.receipt.printReady, false);
    }
  }
});

portalTest('lost write response is marked ambiguous without auto retry and reconciles through receipt lookup', async t => {
  const f = await fixture(t);
  await f.create();
  const [job] = await client.listPreparationJobs(CONFIG, f.options);
  const command = f.evidence(job);
  f.setTransform((response, url, options) => {
    if (options.method === 'POST') throw new Error(`lost response ${TOKEN}`);
    return response;
  });
  await assert.rejects(client.postEvidence(CONFIG, command, f.options), error => error.ambiguous === true && !error.message.includes(TOKEN));
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
  f.setTransform(null);
  const reconciled = await client.getReceipt(CONFIG, { id: job.id, receiptId: command.operationId }, f.options);
  assert.equal(reconciled.receipt.id, command.operationId);
  const retry = await client.postEvidence(CONFIG, command, f.options);
  assert.deepEqual(retry.receipt, reconciled.receipt);
  assert.equal(Number(f.database.database.prepare('SELECT COUNT(*) n FROM production_receipts').get().n), 1);
});

test('write scope and stable operation requirements reject invalid calls before network access', async () => {
  let calls = 0;
  const options = { fetchImpl: async () => { calls++; assert.fail('No network expected'); } };
  const base = { action: 'record_preprocessing', id: randomUUID(), version: 5, operationId: randomUUID(), data: { ticketFingerprint: 'a'.repeat(64) } };
  for (const patch of [{ action: 'confirm_payment' }, { action: 'cancel_job' }, { operationId: undefined }, { version: 0 }, { extra: 'unsupported' }]) {
    await assert.rejects(client.postEvidence(CONFIG, { ...base, ...patch }, options), { status: 400 });
  }
  await assert.rejects(client.postEvidence(CONFIG, { ...base, data: { ...base.data, excessive: 'x'.repeat(32768) } }, options), { status: 413 });
  assert.equal(calls, 0);
});

portalTest('malformed successful write responses remain ambiguous and do not fabricate confirmation', async t => {
  const f = await fixture(t);
  await f.create();
  const [job] = await client.listPreparationJobs(CONFIG, f.options);
  const command = f.evidence(job);
  f.setTransform(async (response, url, options) => {
    if (options.method !== 'POST') return response;
    const result = await response.json(); result.ticket.status = 'printing'; return Response.json(result);
  });
  await assert.rejects(client.postEvidence(CONFIG, command, f.options), error => error.ambiguous === true);
});

portalTest('invalid credentials and redirect responses are redacted and never followed', async t => {
  const f = await fixture(t);
  f.env.PRODUCTION_TOKEN_SHA256 = '0'.repeat(64);
  await assert.rejects(client.listPreparationJobs(CONFIG, f.options), error => error.code === 'LAYR_AUTH' && !error.message.includes(TOKEN));
  await assert.rejects(client.listPreparationJobs(CONFIG, { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(null, { status: 302, headers: { Location: 'https://evil.example' } });
  } }));
});

test('repeated cursors and malformed projection fingerprints fail the entire scan visibly', async () => {
  const ticket = {
    id: randomUUID(), reference: 'PBL-fixture', version: 5, status: 'preparing', ticketFingerprint: 'a'.repeat(64),
    ticket: { specifications: { production: { printType: 'resin' }, project: { name: 'Fixture', quantity: 1 }, file: { name: 'part.stl', format: 'stl', sizeBytes: 1, units: 'mm' } } },
  };
  let count = 0;
  await assert.rejects(client.listPreparationJobs(CONFIG, { fetchImpl: async () => Response.json({ tickets: [{ ...ticket, id: count++ ? randomUUID() : ticket.id }], nextCursor: 'repeated' }) }), /cursor/);
  await assert.rejects(client.listPreparationJobs(CONFIG, { fetchImpl: async () => Response.json({ tickets: [{ ...ticket, ticketFingerprint: undefined }], nextCursor: null }) }), /fingerprint/);
});

// Public contract fixtures keep transport coverage runnable without access to
// the private portal repository. The optional tests above exercise the actual
// reviewed server handlers, SQL and storage implementation when materialized.
function contractFixture() {
  const ticket = {
    id: randomUUID(), reference: 'PBL-CONTRACT', version: 5, status: 'preparing', ticketFingerprint: 'a'.repeat(64),
    ticket: { specifications: {
      production: { printType: 'resin', supports: 'allowed' }, project: { name: 'Fixture', quantity: 12, notes: 'Review geometry.' },
      file: { name: 'part.stl', format: 'stl', sizeBytes: MODEL.length, units: 'mm' },
    } },
  };
  const operations = new Map();
  const calls = [];
  let loseWrite = false, customModel, customLink;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    assert.equal(parsed.origin, ORIGIN);
    assert.equal(options.redirect, 'error');
    if (parsed.pathname === '/api/intake') {
      assert.equal(options.headers, undefined);
      return customModel ? customModel() : new Response(MODEL);
    }
    assert.equal(parsed.pathname, '/api/production');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (options.method === 'POST') {
      const command = JSON.parse(options.body);
      assert.equal(command.action, 'record_preprocessing');
      const existing = operations.get(command.operationId);
      if (existing && existing.body !== options.body) return Response.json({ code: 'operation_conflict' }, { status: 409 });
      if (existing) return Response.json(existing.result);
      if (command.version !== ticket.version) return Response.json({ code: 'version_conflict' }, { status: 409 });
      const receipt = { id: command.operationId, jobId: ticket.id, kind: 'preprocessing', ticketFingerprint: ticket.ticketFingerprint,
        sourceSha256: command.data.sourceSha256, qualified: false, printReady: false };
      const result = { ticket: { ...ticket, version: ticket.version + 1 }, receipt };
      operations.set(command.operationId, { body: options.body, result });
      if (loseWrite) { loseWrite = false; throw new Error(`lost response ${TOKEN}`); }
      return Response.json(result);
    }
    switch (parsed.searchParams.get('action')) {
      case 'tickets': return Response.json({ tickets: [ticket], nextCursor: null });
      case 'ticket': return Response.json({ ticket });
      case 'download':
        assert.equal(parsed.searchParams.get('version'), String(ticket.version));
        assert.equal(parsed.searchParams.get('ticketFingerprint'), ticket.ticketFingerprint);
        return Response.json({ name: ticket.ticket.specifications.file.name, sizeBytes: ticket.ticket.specifications.file.sizeBytes, url: customLink || `${ORIGIN}/api/intake?download=private.signature` });
      case 'receipt': {
        const recorded = operations.get(parsed.searchParams.get('receiptId'));
        return recorded ? Response.json({ receipt: recorded.result.receipt }) : Response.json({ code: 'receipt_not_found' }, { status: 404 });
      }
      default: assert.fail('Unexpected production action');
    }
  };
  const command = {
    action: 'record_preprocessing', id: ticket.id, version: ticket.version, operationId: randomUUID(),
    data: { ticketFingerprint: ticket.ticketFingerprint, sourceSha256: sha256(MODEL), tool: { name: 'Fixture', version: '1', executableSha256: 'e'.repeat(64) },
      outputs: [{ name: 'report.json', sha256: 'f'.repeat(64), sizeBytes: 20, kind: 'report' }], operations: { evaluate: true, fix: null, hollowThicknessMm: null } },
  };
  return { ticket, command, calls, options: { fetchImpl }, loseNextWrite() { loseWrite = true; }, setModel(value) { customModel = value; }, setLink(value) { customLink = value; } };
}

test('standalone contract transports tickets and models with production bearer confined to the API', async () => {
  const f = contractFixture();
  const [ticket] = await client.listPreparationJobs(CONFIG, f.options);
  assert.equal(client.ticketFingerprint(ticket), f.ticket.ticketFingerprint);
  const result = await client.downloadModel(CONFIG, ticket, f.options);
  assert.deepEqual(result.data, MODEL);
  assert.equal(result.order.requestedQuantity, 12);
  assert.equal(result.order.quantity, undefined);
  assert.equal(result.order.modelSha256, sha256(MODEL));
  assert.equal(result.order.ticketFingerprint, ticket.ticketFingerprint);
  assert.equal(result.order.apiMode, 'production');
  assert.equal(f.calls.at(-1).options.headers, undefined);
});

test('standalone production transport accepts STEP and STP source tickets without claiming mesh conversion', async () => {
  const bytes = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
  for (const format of ['step', 'stp']) {
    const f = contractFixture();
    Object.assign(f.ticket.ticket.specifications.file, { name: `assembly.${format.toUpperCase()}`, format, sizeBytes: bytes.length });
    f.setModel(() => new Response(bytes));
    const [ticket] = await client.listPreparationJobs(CONFIG, f.options);
    const result = await client.downloadModel(CONFIG, ticket, f.options);
    assert.equal(result.name, ticket.ticket.specifications.file.name); assert.deepEqual(result.data, bytes);
    assert.equal(result.order.modelSha256, sha256(bytes)); assert.equal(result.order.requestedQuantity, 12);
    assert.equal(result.order.portalJobId, ticket.id); assert.equal(result.order.apiMode, 'production');
  }
});

test('unknown and malformed formats reject the entire production scan after an earlier valid page', async () => {
  for (const file of [{ name: 'part.dxf', format: 'dxf' }, { name: 'part.step', format: 'stp' }, { name: '../part.stp', format: 'stp' }]) {
    const first = contractFixture().ticket, later = structuredClone(first); later.id = randomUUID();
    Object.assign(later.ticket.specifications.file, file);
    const actions = [];
    await assert.rejects(client.listPreparationJobs(CONFIG, { fetchImpl: async url => {
      const address = new URL(url); actions.push(address.searchParams.get('action'));
      return Response.json(address.searchParams.has('cursor') ? { tickets: [later], nextCursor: null } : { tickets: [first], nextCursor: 'second_page' });
    } }), { code: 'LAYR_TRANSPORT' });
    assert.deepEqual(actions, ['tickets', 'tickets']);
  }
});

test('standalone contract preserves ambiguous writes for exact retry and receipt reconciliation', async () => {
  const f = contractFixture();
  f.loseNextWrite();
  await assert.rejects(client.postEvidence(CONFIG, f.command, f.options), error => error.ambiguous === true && !error.message.includes(TOKEN));
  assert.equal(f.calls.length, 1, 'a write is never retried automatically');
  const reconciled = await client.lookupReceipt(CONFIG, { id: f.ticket.id, receiptId: f.command.operationId }, f.options);
  const replay = await client.postEvidence(CONFIG, f.command, f.options);
  assert.deepEqual(replay.receipt, reconciled.receipt);
  const writes = f.calls.filter(call => call.options.method === 'POST');
  assert.equal(writes[0].options.body, writes[1].options.body);
  const conflict = structuredClone(f.command); conflict.data.outputs[0].sha256 = '0'.repeat(64);
  await assert.rejects(client.postEvidence(CONFIG, conflict, f.options), error => error.code === 'LAYR_CONFLICT' && error.portalCode === 'operation_conflict' && error.ambiguous === false);
});

test('standalone contract enforces signed link and streamed size boundaries', async () => {
  const f = contractFixture();
  f.setLink('https://evil.example/api/intake?download=private.signature');
  await assert.rejects(client.downloadModel(CONFIG, f.ticket, f.options), /model link/);
  f.setLink(null);
  let cancelled = false;
  f.setModel(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MODEL.length + 1)); }, cancel() { cancelled = true; },
  })));
  await assert.rejects(client.downloadModel(CONFIG, f.ticket, f.options), { code: 'LAYR_TOO_LARGE' });
  assert.equal(cancelled, true);
  f.setModel(() => new Response(MODEL.subarray(1)));
  await assert.rejects(client.downloadModel(CONFIG, f.ticket, f.options), /size differs/);
});

test('standalone transport redacts untrusted errors and rejects false write acknowledgments', async () => {
  const f = contractFixture();
  await assert.rejects(client.listPreparationJobs(CONFIG, { fetchImpl: async () => Response.json({ error: TOKEN, code: TOKEN }, { status: 401 }) }), error =>
    error.code === 'LAYR_AUTH' && error.portalCode === undefined && !JSON.stringify(error).includes(TOKEN) && !error.message.includes(TOKEN));
  await assert.rejects(client.postEvidence(CONFIG, f.command, { fetchImpl: async () => Response.json({
    ticket: { ...f.ticket, status: 'printing', version: f.ticket.version + 1 }, receipt: { id: f.command.operationId },
  }) }), error => error.ambiguous === true);
});

function authorizationContract() {
  const ticket = contractFixture().ticket, receiptId = randomUUID(), deviceFingerprint = '6'.repeat(64);
  ticket.status = 'queued';
  ticket.production = { approvedReceiptId: receiptId, progress: { requestedParts: 12, printedParts: 2, remainingParts: 10, completedRuns: 2, failedRuns: 0 } };
  const receipt = { id: receiptId, jobId: ticket.id, kind: 'slice', ticketFingerprint: ticket.ticketFingerprint, sourceSha256: 'b'.repeat(64),
    profileSha256: 'c'.repeat(64), tool: { name: 'Fixture', version: '1', executableSha256: 'e'.repeat(64) },
    printerId: 'qualified-printer', printerModel: 'Qualified model', material: 'Qualified resin', artifact: { sha256: 'd'.repeat(64), sizeBytes: 100, format: 'goo' },
    deviceFingerprint, partsPerRun: 1, qualifiedAtCapture: false, qualified: false, printReady: false };
  const authorization = { qualified: true, deviceFingerprint, checkedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 30000).toISOString(),
    jobVersion: ticket.version, ticketFingerprint: ticket.ticketFingerprint, receiptId, sourceSha256: receipt.sourceSha256, artifactSha256: receipt.artifact.sha256,
    profileSha256: receipt.profileSha256, engineSha256: receipt.tool.executableSha256, printerId: receipt.printerId, printerModel: receipt.printerModel, material: receipt.material, format: receipt.artifact.format,
    partsPerRun: 1, plannedParts: 1, remainingParts: 10, qualificationFingerprint: 'f'.repeat(64) };
  return { result: { ticket, receipt, authorization }, params: { id: ticket.id, receiptId, deviceFingerprint } };
}

test('standalone authorization read validates exact device/receipt/plan binding and bounded fresh expiry', async () => {
  const fixture = authorizationContract();
  const result = await client.getAuthorization(CONFIG, fixture.params, { now: () => NOW, fetchImpl: async (url, options) => {
    const address = new URL(url);
    assert.equal(address.pathname, '/api/production');
    assert.equal(address.searchParams.get('action'), 'authorization');
    assert.equal(address.searchParams.get('deviceFingerprint'), fixture.params.deviceFingerprint);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    return Response.json(fixture.result);
  } });
  assert.equal(result.authorization.qualified, true);
  assert.equal(result.receipt.qualifiedAtCapture, false, 'current qualification is separate from historical capture status');
  const mutations = [
    value => { value.ticket.status = 'printing'; },
    value => { value.ticket.production.approvedReceiptId = randomUUID(); },
    value => { value.ticket.production.progress.remainingParts = 999; },
    value => { value.receipt.deviceFingerprint = '0'.repeat(64); },
    value => { value.authorization.deviceFingerprint = '0'.repeat(64); },
    value => { value.authorization.profileSha256 = '0'.repeat(64); },
    value => { value.authorization.engineSha256 = '0'.repeat(64); },
    value => { value.authorization.artifactSha256 = '0'.repeat(64); },
    value => { value.authorization.printerId = 'different-printer'; },
    value => { delete value.receipt.material; delete value.authorization.material; },
    value => { value.authorization.jobVersion++; },
    value => { value.authorization.plannedParts = 2; },
    value => { value.authorization.qualified = false; },
    value => { value.authorization.qualificationFingerprint = 'invalid'; },
    value => { value.authorization.expiresAt = new Date(NOW + 30001).toISOString(); },
    value => { value.authorization.checkedAt = new Date(NOW - 40000).toISOString(); value.authorization.expiresAt = new Date(NOW - 10000).toISOString(); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(fixture.result); mutate(value);
    await assert.rejects(client.getAuthorization(CONFIG, fixture.params, { now: () => NOW, fetchImpl: async () => Response.json(value) }));
  }
});

portalTest('actual fresh authorization is revoked independently of an immutable qualified slice receipt', async t => {
  const f = await fixture(t);
  const original = await f.create({ quantity: 2 });
  const job = (await client.listPreparationJobs(CONFIG, f.options)).find(candidate => candidate.id === original.id);
  const deviceFingerprint = '6'.repeat(64), profileSha256 = 'c'.repeat(64), engineSha256 = 'e'.repeat(64);
  const binding = { deviceFingerprint, profileSha256, engineSha256, printerId: 'physical-printer', printerModel: 'Qualified test model', material: 'Qualified test resin', format: 'goo' };
  f.env.PRODUCTION_QUALIFIED_BINDINGS = JSON.stringify([binding]);
  const command = f.evidence(job); command.action = 'record_slice';
  const { outputs, operations, ...common } = command.data;
  command.data = { ...common, partsPerRun: 1, deviceFingerprint, profileSha256, printerId: binding.printerId, printerModel: binding.printerModel, material: binding.material,
    artifact: { sha256: 'd'.repeat(64), sizeBytes: 100, format: 'goo' } };
  const capture = await client.postEvidence(CONFIG, command, f.options);
  assert.equal(capture.receipt.qualifiedAtCapture, true);
  let approval = await client.postEvidence(CONFIG, { action: 'approve_preparation', id: job.id, version: capture.ticket.version, operationId: randomUUID(),
    data: { ticketFingerprint: job.ticketFingerprint, receiptId: capture.receipt.id } }, f.options);
  const params = { id: job.id, receiptId: capture.receipt.id, deviceFingerprint };
  const withdraw = { action: 'withdraw_preparation', id: job.id, version: approval.ticket.version, operationId: randomUUID(),
    data: { ticketFingerprint: job.ticketFingerprint, receiptId: capture.receipt.id, reason: 'Review current qualification before releasing this plan.' } };
  const withdrawn = await client.postEvidence(CONFIG, withdraw, f.options);
  assert.equal(withdrawn.ticket.status, 'preparing');
  assert.equal(withdrawn.ticket.production.target.id, job.id);
  await assert.rejects(client.getAuthorization(CONFIG, params, { ...f.options, now: () => NOW }), { status: 409 });
  approval = await client.postEvidence(CONFIG, { action: 'approve_preparation', id: job.id, version: withdrawn.ticket.version, operationId: randomUUID(),
    data: { ticketFingerprint: job.ticketFingerprint, receiptId: capture.receipt.id } }, f.options);
  assert.deepEqual(await client.postEvidence(CONFIG, withdraw, f.options), withdrawn, 'exact withdrawal replay stays historic after reapproval');
  const proof = await client.getAuthorization(CONFIG, params, { ...f.options, now: () => NOW });
  assert.equal(proof.authorization.jobVersion, approval.ticket.version);
  assert.equal(proof.authorization.remainingParts, 2);
  f.env.PRODUCTION_QUALIFIED_BINDINGS = '[]';
  await assert.rejects(client.getAuthorization(CONFIG, params, { ...f.options, now: () => NOW }), error => error.status === 409 && error.portalCode === 'preparation_unqualified');
  const receipt = await client.getReceipt(CONFIG, { id: job.id, receiptId: capture.receipt.id }, f.options);
  assert.equal(receipt.receipt.qualifiedAtCapture, true);
  assert.equal(receipt.qualification.qualified, false);

  f.env.PRODUCTION_QUALIFIED_BINDINGS = JSON.stringify([binding]);
  let current = approval.ticket;
  for (let index = 0; index < 2; index++) {
    const runId = randomUUID(), remoteId = `remote-${runId}`;
    const started = await client.postEvidence(CONFIG, { action: 'start_print', id: job.id, version: current.version, operationId: randomUUID(),
      data: { ticketFingerprint: job.ticketFingerprint, receiptId: capture.receipt.id, runId, remoteId, observedAt: new Date(NOW).toISOString(),
        artifactSha256: command.data.artifact.sha256, printerId: binding.printerId, plannedParts: 1, deviceFingerprint } }, f.options);
    const finished = await client.postEvidence(CONFIG, { action: 'finish_print', id: job.id, version: started.ticket.version, operationId: randomUUID(),
      data: { ticketFingerprint: job.ticketFingerprint, runId, remoteId, observedAt: new Date(NOW).toISOString(), printedParts: 1 } }, f.options);
    assert.equal(finished.ticket.status, index === 0 ? 'queued' : 'post_processing');
    assert.equal(finished.ticket.production.progress.printedParts, index + 1);
    current = finished.ticket;
  }
  assert.equal(Number(f.database.database.prepare('SELECT COUNT(*) n FROM production_run_results').get().n), 2);
  let serverJob = await f.workflow.getJob(f.env, job.id);
  serverJob = await f.workflow.commandJob(f.env, { id: job.id, version: serverJob.version, operationId: randomUUID(), command: 'finish_processing', actor: 'studio', now: NOW });
  const qcOperationId = randomUUID();
  await f.workflow.commandJob(f.env, { id: job.id, version: serverJob.version, operationId: qcOperationId, command: 'qc_fail', actor: 'studio', now: NOW,
    data: { notes: 'One replacement required after physical inspection.', replacementQuantity: 1 } });
  current = (await client.getTicket(CONFIG, job.id, f.options)).ticket;
  assert.equal(current.production.target.id, qcOperationId); assert.equal(current.production.progress.requestedParts, 1);
  assert.equal(current.ticket.specifications.project.quantity, 2); assert.equal(current.production.totals.printedParts, 2);
  approval = await client.postEvidence(CONFIG, { action: 'approve_preparation', id: job.id, version: current.version, operationId: randomUUID(),
    data: { ticketFingerprint: job.ticketFingerprint, receiptId: capture.receipt.id } }, f.options);
  const replacement = await client.getAuthorization(CONFIG, params, { ...f.options, now: () => NOW });
  assert.equal(replacement.authorization.targetId, qcOperationId); assert.equal(replacement.authorization.targetParts, 1);
  const runId = randomUUID(), remoteId = `replacement-${runId}`;
  const started = await client.postEvidence(CONFIG, { action: 'start_print', id: job.id, version: approval.ticket.version, operationId: randomUUID(),
    data: { ticketFingerprint: job.ticketFingerprint, targetId: qcOperationId, receiptId: capture.receipt.id, runId, remoteId, observedAt: new Date(NOW).toISOString(),
      artifactSha256: command.data.artifact.sha256, printerId: binding.printerId, plannedParts: 1, deviceFingerprint } }, f.options);
  const completed = await client.postEvidence(CONFIG, { action: 'finish_print', id: job.id, version: started.ticket.version, operationId: randomUUID(),
    data: { ticketFingerprint: job.ticketFingerprint, targetId: qcOperationId, runId, remoteId, observedAt: new Date(NOW).toISOString(), printedParts: 1 } }, f.options);
  assert.equal(completed.ticket.status, 'post_processing'); assert.equal(completed.ticket.production.totals.printedParts, 3);
  assert.equal(completed.ticket.production.progress.printedParts, 1); assert.equal(completed.ticket.ticket.specifications.project.quantity, 2);
  assert.equal(Number(f.database.database.prepare('SELECT COUNT(*) n FROM production_run_results').get().n), 3);
});

test('physical completion confirmation accepts nonfinal queued progress but rejects premature finishing or quantity credit', async () => {
  const fixture = contractFixture();
  const runId = randomUUID(), remoteId = 'reported-completed-task';
  const command = { action: 'finish_print', id: fixture.ticket.id, version: fixture.ticket.version, operationId: randomUUID(),
    data: { ticketFingerprint: fixture.ticket.ticketFingerprint, runId, remoteId, observedAt: new Date(NOW).toISOString(), printedParts: 1 } };
  const result = { ticket: { ...fixture.ticket, status: 'queued', version: fixture.ticket.version + 1, production: {
    progress: { requestedParts: 12, printedParts: 1, remainingParts: 11, completedRuns: 1, failedRuns: 0 },
    run: { runId, remoteId, plannedParts: 1, printedParts: 1, status: 'completed', finishedAt: new Date(NOW).toISOString() },
  } } };
  assert.equal((await client.postEvidence(CONFIG, command, { fetchImpl: async () => Response.json(result) })).ticket.status, 'queued');
  for (const mutate of [
    value => { value.ticket.status = 'post_processing'; },
    value => { value.ticket.production.progress.remainingParts = 0; },
    value => { value.ticket.production.run.printedParts = 2; },
    value => { value.ticket.production.run.runId = randomUUID(); },
    value => { value.ticket.production.run.plannedParts = 0; },
    value => { value.ticket.production.progress.acceptedParts = 1; },
  ]) {
    const value = structuredClone(result); mutate(value);
    await assert.rejects(client.postEvidence(CONFIG, command, { fetchImpl: async () => Response.json(value) }), error => error.ambiguous === true);
  }
});

test('standalone withdrawal preserves the exact saved operation and refuses incomplete or active-run confirmations', async () => {
  const fixture = contractFixture(), receiptId = randomUUID();
  const command = { action: 'withdraw_preparation', id: fixture.ticket.id, version: fixture.ticket.version, operationId: randomUUID(),
    data: { ticketFingerprint: fixture.ticket.ticketFingerprint, receiptId, reason: 'Review the revised profile before another physical unit.' } };
  const result = { ticket: { ...fixture.ticket, version: fixture.ticket.version + 1, status: 'preparing', production: {
    progress: { requestedParts: 12, printedParts: 2, remainingParts: 10, completedRuns: 2, failedRuns: 0 },
    run: { runId: randomUUID(), status: 'completed', printedParts: 1 },
  } } };
  let calls = 0;
  const options = { fetchImpl: async (url, init) => {
    calls++; assert.equal(init.body, JSON.stringify(command)); assert.equal(init.redirect, 'error');
    if (calls === 1) throw new Error('The remote commit may have succeeded.');
    return Response.json(result);
  } };
  await assert.rejects(client.postEvidence(CONFIG, command, options), error => error.ambiguous === true);
  assert.equal(calls, 1, 'transport does not generate or retry a withdrawal');
  assert.deepEqual(await client.postEvidence(CONFIG, command, options), result);
  for (const patch of [{ reason: '' }, { reason: 'line\nbreak' }, { reason: 'x'.repeat(2001) }, { receiptId: 'invalid' }, { replacementQuantity: 1 }]) {
    await assert.rejects(client.postEvidence(CONFIG, { ...command, data: { ...command.data, ...patch } }, options), { status: 400 });
  }
  assert.equal(calls, 2);
  for (const patch of [{ approvedReceiptId: receiptId }, { approvedTargetId: fixture.ticket.id }, { run: { status: 'printing' } }]) {
    const value = structuredClone(result); Object.assign(value.ticket.production, patch);
    await assert.rejects(client.postEvidence(CONFIG, command, { fetchImpl: async () => Response.json(value) }), error => error.ambiguous === true);
  }
});

function replacementContract() {
  const fixture = authorizationContract(), { ticket, authorization } = fixture.result;
  const id = randomUUID(), original = ticket.ticket.specifications.project.quantity;
  const initial = { id: ticket.id, kind: 'order', cycle: 0, requiredParts: original, authorizedAt: new Date(NOW - 60000).toISOString(), qcOperationId: null };
  ticket.production.target = { id, kind: 'replacement', cycle: 1, requiredParts: 2, authorizedAt: new Date(NOW).toISOString(), qcOperationId: id };
  ticket.production.targetHistory = [{ ...initial, progress: { requestedParts: original, printedParts: original, remainingParts: 0, completedRuns: original, failedRuns: 1 } }];
  ticket.production.progress = { requestedParts: 2, printedParts: 0, remainingParts: 2, completedRuns: 0, failedRuns: 0 };
  ticket.production.totals = { printedParts: original, completedRuns: original, failedRuns: 1 };
  ticket.production.approvedTargetId = id;
  Object.assign(authorization, { targetId: id, targetKind: 'replacement', targetCycle: 1, targetParts: 2, remainingParts: 2 });
  return fixture;
}

test('replacement authorization binds its explicit studio target while retaining original order and lifetime counts', async () => {
  const fixture = replacementContract();
  const read = value => client.getAuthorization(CONFIG, fixture.params, { now: () => NOW, fetchImpl: async () => Response.json(value) });
  const result = await read(fixture.result);
  assert.equal(result.ticket.ticket.specifications.project.quantity, 12);
  assert.equal(result.ticket.production.progress.requestedParts, 2);
  assert.equal(result.ticket.production.totals.printedParts, 12);
  assert.equal(result.authorization.targetId, result.ticket.production.target.id);
  for (const mutate of [
    value => { delete value.authorization.targetId; },
    value => { value.authorization.targetId = value.ticket.id; },
    value => { value.authorization.targetKind = 'order'; },
    value => { value.authorization.targetCycle = 0; },
    value => { value.authorization.targetParts = 12; },
    value => { delete value.ticket.production.approvedTargetId; },
    value => { value.ticket.production.target.qcOperationId = randomUUID(); },
    value => { value.ticket.production.target.requiredParts = 13; },
    value => { value.ticket.production.progress.requestedParts = 12; },
    value => { value.ticket.production.targetHistory = []; },
    value => { value.ticket.production.totals.printedParts = 0; },
  ]) {
    const value = structuredClone(fixture.result); mutate(value);
    await assert.rejects(read(value));
  }
});

test('replacement completion acknowledgments must retain the exact target and lifetime evidence', async () => {
  const fixture = replacementContract(), ticket = fixture.result.ticket, targetId = ticket.production.target.id;
  const command = { action: 'finish_print', id: ticket.id, version: ticket.version, operationId: randomUUID(),
    data: { ticketFingerprint: ticket.ticketFingerprint, targetId, runId: randomUUID(), remoteId: 'replacement-completed', observedAt: new Date(NOW).toISOString(), printedParts: 1 } };
  const result = { ticket: structuredClone(ticket) };
  result.ticket.status = 'queued'; result.ticket.version++;
  result.ticket.production.progress = { requestedParts: 2, printedParts: 1, remainingParts: 1, completedRuns: 1, failedRuns: 0 };
  result.ticket.production.totals.printedParts++; result.ticket.production.totals.completedRuns++;
  result.ticket.production.run = { runId: command.data.runId, remoteId: command.data.remoteId, targetId, plannedParts: 1, printedParts: 1, status: 'completed', finishedAt: command.data.observedAt };
  assert.equal((await client.postEvidence(CONFIG, command, { fetchImpl: async () => Response.json(result) })).ticket.status, 'queued');
  for (const mutate of [
    value => { delete value.ticket.production.run.targetId; },
    value => { value.ticket.production.run.targetId = ticket.id; },
    value => { value.ticket.production.target.id = randomUUID(); },
    value => { value.ticket.status = 'post_processing'; },
    value => { value.ticket.production.totals.printedParts = 1; },
  ]) {
    const value = structuredClone(result); mutate(value);
    await assert.rejects(client.postEvidence(CONFIG, command, { fetchImpl: async () => Response.json(value) }), error => error.ambiguous === true);
  }
});
