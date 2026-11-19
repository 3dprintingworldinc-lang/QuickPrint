'use strict';

// Local HTTP + manager + core tests. Native providers and printer transports are
// always injected. Optional private-source cases run the actual portal handlers
// and SQLite transactions, not an Internet portal or physical printer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { startServer } = require('../src/server');
const { LayrOutbox } = require('../src/connectors/layr-outbox');
const client = require('../src/connectors/layr-production-client');
const { fingerprintSDCPDevice } = require('../src/adapters/sdcp-identity');
const { MODEL, CONFIRMED, createProfile, makeSlice, deferred } = require('./helpers/resin-slice');

const ORIGIN = 'https://printbylayr.example';
const TOKEN = 'p'.repeat(43);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const source = process.env.QUICKPRINT_PORTAL_SOURCE ? path.resolve(process.env.QUICKPRINT_PORTAL_SOURCE) : path.resolve(__dirname, '../integrations/printbylayr');
const portalAvailable = ['server/production.mjs', 'tests/workflow-fixture.mjs', 'tests/storage-fixture.mjs', 'migrations/0005_production.sql', 'migrations/0006_production_quantities.sql'].every(file => existsSync(path.join(source, file)));
const sourceSkip = 'Private portal source is absent; set QUICKPRINT_PORTAL_SOURCE or materialize the reviewed checkout. See docs/PRINTBYLAYR-PRODUCTION-INTEGRATION.md.';
let portalModules;
async function modules() {
  portalModules ||= Promise.all(['server/production.mjs', 'server/intake.mjs', 'server/workflow.mjs', 'tests/workflow-fixture.mjs', 'tests/storage-fixture.mjs'].map(file => import(pathToFileURL(path.join(source, file)).href)));
  return portalModules;
}

function fakePortal() {
  const id = randomUUID();
  const ticket = {
    id, reference: `PBL-${id}`, version: 5, status: 'preparing', ticketFingerprint: 'a'.repeat(64),
    ticket: { specifications: { project: { name: 'Two units', quantity: 2, notes: 'Review supports.' }, production: { printType: 'resin', supports: 'allowed', colour: 'grey' }, file: { name: 'production.stl', format: 'stl', sizeBytes: MODEL.length, units: 'mm' } } },
    production: { progress: { requestedParts: 2, printedParts: 0, remainingParts: 2, completedRuns: 0, failedRuns: 0 } },
  };
  const receipts = new Map(), operations = new Map();
  let binding;
  const qualified = receipt => Boolean(binding && receipt && Object.entries(binding).every(([key, value]) => key === 'engineSha256' ? receipt.tool.executableSha256 === value : key === 'format' ? receipt.artifact.format === value : receipt[key] === value));
  const error = (code, status = 409) => Response.json({ code }, { status });
  const api = {
    id, close() {}, qualify(value) { binding = clone(value); }, revoke() { binding = null; },
    async handle(address, options) {
      if (address.pathname === '/api/intake') return new Response(MODEL);
      const action = address.searchParams.get('action');
      if (options.method !== 'POST') {
        if (action === 'tickets') return Response.json({ tickets: ticket.status === 'preparing' ? [clone(ticket)] : [], nextCursor: null });
        if (action === 'ticket') return Response.json({ ticket: clone(ticket) });
        if (action === 'download') return Response.json({ name: 'production.stl', sizeBytes: MODEL.length, url: `${ORIGIN}/api/intake?download=private.signature` });
        const receipt = receipts.get(address.searchParams.get('receiptId'));
        if (!receipt) return error('receipt_not_found', 404);
        const current = qualified(receipt);
        if (action === 'receipt') return Response.json({ receipt: clone(receipt), qualification: { qualified: current, checkedAt: new Date().toISOString(), qualificationFingerprint: current ? sha256(JSON.stringify(binding)) : null } });
        if (action === 'authorization') {
          if (!current) return error('preparation_unqualified');
          if (ticket.status !== 'queued' || ticket.production.approvedReceiptId !== receipt.id) return error('invalid_transition');
          if (receipt.deviceFingerprint !== address.searchParams.get('deviceFingerprint')) return error('printer_binding_mismatch');
          const now = Date.now();
          return Response.json({ ticket: clone(ticket), receipt: clone(receipt), authorization: {
            qualified: true, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString(),
            jobVersion: ticket.version, ticketFingerprint: ticket.ticketFingerprint, receiptId: receipt.id,
            sourceSha256: receipt.sourceSha256, artifactSha256: receipt.artifact.sha256, profileSha256: receipt.profileSha256,
            engineSha256: receipt.tool.executableSha256, deviceFingerprint: receipt.deviceFingerprint,
            printerId: receipt.printerId, printerModel: receipt.printerModel, material: receipt.material, format: receipt.artifact.format,
            partsPerRun: 1, plannedParts: 1, remainingParts: ticket.production.progress.remainingParts, qualificationFingerprint: sha256(JSON.stringify(binding)),
          } });
        }
        assert.fail(`Unexpected production read ${action}`);
      }
      const command = JSON.parse(options.body), data = command.data;
      const prior = operations.get(command.operationId);
      if (prior) return prior.body === options.body ? Response.json(clone(prior.result)) : error('operation_conflict');
      if (command.version !== ticket.version) return error('version_conflict');
      if (data.ticketFingerprint !== ticket.ticketFingerprint) return error('ticket_changed');
      let receipt;
      if (command.action === 'record_slice') {
        if (ticket.status !== 'preparing') return error('invalid_transition');
        receipt = { id: command.operationId, jobId: id, kind: 'slice', ...clone(data), printReady: false };
        receipt.qualified = receipt.qualifiedAtCapture = qualified(receipt);
        receipts.set(receipt.id, receipt); ticket.production.sourceSha256 = data.sourceSha256;
      } else if (command.action === 'approve_preparation') {
        receipt = receipts.get(data.receiptId);
        if (!qualified(receipt)) return error('preparation_unqualified');
        if (ticket.status !== 'preparing') return error('invalid_transition');
        ticket.status = 'queued'; ticket.production.approvedReceiptId = receipt.id; ticket.preparation = { receiptId: receipt.id }; receipt = null;
      } else if (command.action === 'start_print') {
        const approved = receipts.get(ticket.production.approvedReceiptId);
        if (!qualified(approved)) return error('preparation_unqualified');
        if (ticket.status !== 'queued') return error('invalid_transition');
        assert.equal(data.plannedParts, 1); assert.equal(data.deviceFingerprint, approved.deviceFingerprint);
        ticket.status = 'printing'; ticket.production.run = { ...clone(data), status: 'printing', startedAt: data.observedAt };
      } else {
        const run = ticket.production.run;
        if (ticket.status !== 'printing' || run.runId !== data.runId || run.remoteId !== data.remoteId) return error('run_mismatch');
        assert.ok(['finish_print', 'fail_print'].includes(command.action));
        const completed = command.action === 'finish_print';
        assert.equal(data.printedParts, completed ? 1 : 0);
        Object.assign(run, { status: completed ? 'completed' : 'failed', printedParts: data.printedParts, finishedAt: data.observedAt });
        ticket.production.progress.printedParts += data.printedParts;
        ticket.production.progress.remainingParts -= data.printedParts;
        ticket.production.progress[completed ? 'completedRuns' : 'failedRuns']++;
        ticket.status = completed && ticket.production.progress.remainingParts === 0 ? 'post_processing' : 'queued';
      }
      ticket.version++;
      const result = { ticket: clone(ticket), ...(receipt ? { receipt: clone(receipt) } : {}) };
      operations.set(command.operationId, { body: options.body, result: clone(result) });
      return Response.json(result);
    },
  };
  return api;
}

async function actualPortal() {
  const [production, intake, workflow, { SqliteWorkflowD1 }, { FakeB2 }] = await modules();
  const database = new SqliteWorkflowD1(), b2 = new FakeB2();
  for (const migration of ['0005_production.sql', '0006_production_quantities.sql']) database.database.exec(readFileSync(path.join(source, 'migrations', migration), 'utf8'));
  const env = { WORKFLOW_ENABLED: '1', INTAKE_DB: database, INTAKE_SIGNING_SECRET: 'fixture-production-signing-secret-at-least-32-characters',
    PRODUCTION_MACHINE_ID: 'quickprint-flow-test', PRODUCTION_TOKEN_SHA256: sha256(TOKEN),
    B2_APPLICATION_KEY_ID: 'test-key-id', B2_APPLICATION_KEY: 'test-key', B2_BUCKET_ID: 'test-bucket' };
  const id = randomUUID(), now = Date.now(), createdAt = new Date(now).toISOString();
  const record = { id, requestId: `PBL-${id.toUpperCase()}`, origin: ORIGIN, createdAt,
    model: { fileId: `private-${id}`, size: MODEL.length, sha1: createHash('sha1').update(MODEL).digest('hex') }, notification: { accepted: true },
    payload: { client: { fullName: 'Fixture customer', email: 'private@example.test' }, project: { name: 'Two units', quantity: 2, notes: 'Review supports.' },
      production: { printType: 'resin', qualityTier: 'standard', supports: 'allowed', colour: 'grey', properties: 'standard' },
      file: { name: 'production.stl', format: 'stl', sizeBytes: MODEL.length, units: 'mm' } } };
  b2.objects.set(record.model.fileId, { fileId: record.model.fileId, key: `requests/${id}/model.stl`, bytes: MODEL, sha1: record.model.sha1 });
  database.database.prepare('INSERT INTO intake_requests(id,record_json,model_json,notification_json,created_at) VALUES(?,?,?,?,?)').run(id, JSON.stringify(record), JSON.stringify(record.model), JSON.stringify(record.notification), createdAt);
  let job = await workflow.ensureJob(env, record, { customerUrl: `${ORIGIN}/job#private`, now });
  const action = async (command, data, actor = 'studio') => { job = await workflow.commandJob(env, { id, version: job.version, operationId: randomUUID(), command, data, actor, now }); };
  await action('issue_quote', { amountCents: 2500, leadTimeDays: 5, expiresAt: new Date(now + 86400000).toISOString(), summary: 'Fixture quote', fulfilment: 'pickup' });
  await action('accept_quote', {}, 'customer'); await action('confirm_payment', { amountCents: 2500, reference: 'fixture-payment' });
  return { id, database, env, qualify(binding) { env.PRODUCTION_QUALIFIED_BINDINGS = JSON.stringify([binding]); }, revoke() { env.PRODUCTION_QUALIFIED_BINDINGS = '[]'; }, close() { database.database.close(); },
    handle(address, options) {
      if (address.pathname === '/api/production') return production.handleProduction(new Request(address, options), env, { now: Date.now, log: () => {} });
      return intake.handleIntake(new Request(address, options), env, { now: Date.now, storageFetch: b2.fetch, log: () => {} });
    } };
}

async function fixture(t, { actual = false, qualify = false } = {}) {
  const portal = actual ? await actualPortal() : fakePortal();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-production-flow-'));
  const settings = await createProfile(dataDir), events = [], writes = [], faults = { loseReply: null, reject: null, rejectStatus: 503, beforeRequest: null, transform: null };
  let app, outbox, retryOffset = 0;
  const fetchImpl = async (url, options = {}) => {
    const address = new URL(url); assert.equal(address.origin, ORIGIN); assert.equal(options.redirect, 'error');
    const command = options.method === 'POST' ? JSON.parse(options.body) : null;
    const action = command?.action || address.searchParams.get('action') || 'download-model';
    events.push(`portal:${action}`);
    if (address.pathname === '/api/production') assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    else { assert.equal(address.pathname, '/api/intake'); assert.equal(options.headers, undefined); }
    if (command) writes.push(options.body);
    if (faults.beforeRequest) await faults.beforeRequest({ action, command, address, options });
    if (faults.reject === action) return Response.json({ code: faults.rejectStatus === 409 ? 'version_conflict' : 'production_unavailable' }, { status: faults.rejectStatus });
    const response = await portal.handle(address, options);
    if (response.ok && faults.loseReply === action) { faults.loseReply = null; throw new Error('Fixture lost reply after committed portal operation'); }
    return faults.transform ? faults.transform(response, { action, command, address, options }) : response;
  };
  const transport = { ...client };
  for (const name of ['listPreparationJobs', 'downloadModel', 'getTicket', 'getReceipt', 'getAuthorization', 'postEvidence']) transport[name] = (config, ...args) => {
    const withOptions = ['listPreparationJobs'].includes(name) ? 0 : 1;
    const options = args[withOptions] || {}; args[withOptions] = { ...options, fetchImpl };
    return client[name](config, ...args);
  };
  const attributes = { MainboardID: '0123456789abcdef', BrandName: 'Fixture', MachineName: 'QuickPrint Test', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'fixture-1', Resolution: '4x2', XYZsize: '40x20x30', Capabilities: ['FILE_TRANSFER', 'PRINT_CONTROL'], SupportFileType: ['GOO'] };
  const adapter = { capabilities: { upload: true, start: true, formats: ['goo'] }, telemetry: { state: 'idle' }, calls: [], startMode: 'normal', onUpload: null, onAttributes: null,
    async attributes() { events.push('hardware:attributes'); if (this.onAttributes) await this.onAttributes(); return clone(attributes); },
    async status() { return { ...clone(this.telemetry), observedAt: new Date().toISOString() }; },
    async upload(value) { this.calls.push({ action: 'upload', ...value }); events.push('hardware:upload'); this.fileName = value.fileName; if (this.onUpload) await this.onUpload(); return { remotePath: value.fileName }; },
    async start(value) { this.calls.push({ action: 'start', ...value }); events.push('hardware:start'); const remoteId = `fixture-task-${this.calls.filter(call => call.action === 'start').length}`;
      this.telemetry = { state: 'printing', remoteId, currentFile: this.fileName, progress: 1 };
      if (this.startMode === 'uncertain') throw Object.assign(new Error('Fixture unconfirmed printer acknowledgement'), { code: 'SDCP_START_UNCERTAIN', status: 504, uncertain: true });
      return { acknowledged: this.startMode !== 'missing-ack', remoteId, currentFile: this.fileName, observedAt: new Date().toISOString() }; },
    async close() {} };
  const engine = { prepareResin: makeSlice };
  const open = async () => {
    outbox = new LayrOutbox({ dataDir, now: () => Date.now() + retryOffset });
    app = await startServer({ dataDir, adapters: () => adapter, resinEngine: engine, layrProductionClient: transport, layrOutbox: outbox });
  };
  await open();
  t.after(async () => { await app?.close(); portal.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = (route, options = {}) => fetch(app.url + route, { ...options, headers: { Authorization: `Bearer ${app.token}`, ...options.headers } });
  const json = async (route, body, method = 'POST') => { const response = await request(route, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
  const ok = async (route, body, method) => { const result = await json(route, body, method); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value; };
  const printer = await ok('/api/printers', { name: 'Fixture physical printer', type: 'sdcp', host: 'fixture-printer.invalid', mainboardId: attributes.MainboardID, brandId: 'fixture-brand', model: 'QuickPrint Test' });
  const profile = JSON.parse(await fs.readFile(settings.profilePath, 'utf8')); profile.printerId = printer.id; await fs.writeFile(settings.profilePath, JSON.stringify(profile));
  await ok('/api/settings', { resinEngine: settings }, 'PUT');
  const connector = await ok('/api/connectors', { type: 'layr', apiMode: 'production', portalUrl: ORIGIN, token: TOKEN, enabled: true, autoSyncPreparation: false, pollIntervalMs: 60000 });
  await ok(`/api/connectors/${connector.id}/poll`, {});
  const job = app.service.snapshot().jobs.find(value => value.order?.portalJobId === portal.id); assert.ok(job, 'paid portal ticket must be imported through the manager');
  await ok(`/api/jobs/${job.id}/resin/slice`, CONFIRMED);
  const slice = app.service.getJob(job.id).resinSlice, deviceFingerprint = fingerprintSDCPDevice(printer, attributes);
  const binding = { profileSha256: slice.profileSha256, engineSha256: slice.tool.executableSha256, deviceFingerprint, printerId: printer.id, printerModel: slice.printerModel, material: slice.material, format: 'goo' };
  if (qualify) portal.qualify(binding);
  const base = `/api/jobs/${job.id}/resin/production`;
  return { portal, adapter, engine, attributes, settings, binding, dataDir, events, writes, faults, id: job.id, printer, connector, base, json, ok,
    get app() { return app; }, get outbox() { return outbox; }, current() { return app.service.getJob(job.id); },
    ticket() { return transport.getTicket({ apiMode: 'production', portalUrl: ORIGIN, token: TOKEN }, portal.id); },
    enable() { return ok('/api/settings', { resinEngine: { dispatchEnabled: true } }, 'PUT'); },
    poll() { return ok(`/api/connectors/${connector.id}/poll`, {}); },
    async syncSlice() { const entry = await ok(`/api/jobs/${job.id}/resin/sync`, {}); await this.poll(); return outbox.get(entry.operationId); },
    async approve() { return ok(base + '/approve', { confirmedWholeModel: true }); },
    async finish(printedParts = 1) { const run = this.current().runs.at(-1); adapter.telemetry = { state: 'idle', remoteId: run.remoteId, currentFile: run.fileName, progress: 100, outcome: 'completed' }; await app.service.testPrinter(printer.id); return ok(base + '/reconcile', { runId: run.id, outcome: 'completed', printedParts }); },
    advanceRetries() { retryOffset += 60000; },
    async restart() { await app.close(); await open(); },
  };
}

function noHardwareWrites(f) { assert.equal(f.adapter.calls.length, 0, 'qualification reads cannot upload or start a printer'); }
function noQC(job) { assert.equal(job.quantity, 1); assert.equal(job.acceptedQuantity, 0); assert.equal(job.remainingQuantity, 1); assert.ok(job.runs.every(run => !run.acceptedQuantity)); }
async function prepared(t, options = {}) { const f = await fixture(t, { ...options, qualify: true }); assert.equal((await f.syncSlice()).state, 'confirmed'); assert.equal((await f.approve()).state, 'confirmed'); return f; }

async function twoUnitFlow(t, options) {
  const f = await fixture(t, options); noHardwareWrites(f);
  assert.equal(f.app.service.getSettings().resinEngine.dispatchEnabled, false);
  const receipt = await f.syncSlice(); assert.equal(receipt.state, 'confirmed');
  const forged = await f.json(f.base + '/approve', { confirmedWholeModel: true, qualified: true, authorization: { qualified: true }, receipt: { qualified: true } });
  assert.equal(forged.status, 409); assert.equal(forged.value.error, 'LAYR_PREPARATION_UNQUALIFIED'); noHardwareWrites(f);
  assert.equal(f.app.service._resinDispatchPermits.size, 0, 'HTTP-supplied authority must never mint a permit');
  f.portal.qualify(f.binding);
  const review = await f.ok(f.base, undefined, 'GET'); assert.equal(review.qualified, true); assert.equal(review.remainingParts, 2); assert.equal(review.partsPerRun, 1);
  assert.equal((await f.approve()).state, 'confirmed');
  const disabled = await f.json(f.base + '/dispatch', { confirmedReady: true }); assert.equal(disabled.status, 409); assert.equal(disabled.value.error, 'RESIN_DISPATCH_DISABLED'); noHardwareWrites(f);
  await f.enable();
  const noConfirmation = await f.json(f.base + '/dispatch', {}); assert.equal(noConfirmation.status, 409); noHardwareWrites(f);
  await f.ok(f.base + '/dispatch', { confirmedReady: true });
  const first = f.current().runs.at(-1); assert.equal(first.plannedParts, 1); assert.ok(first.startEvidence); noQC(f.current());
  const firstUpload = f.events.indexOf('hardware:upload'); assert.ok(f.events.slice(0, firstUpload).includes('portal:authorization'), 'fresh server authorization must precede upload');
  assert.ok(f.events.slice(firstUpload + 1, f.events.indexOf('hardware:start')).includes('portal:authorization'), 'upload must be followed by renewed authorization before start');
  assert.equal((await f.ticket()).ticket.status, 'printing');
  await f.finish();
  const partial = (await f.ticket()).ticket; assert.equal(partial.status, 'queued'); assert.equal(partial.production.progress.printedParts, 1); assert.equal(partial.production.progress.remainingParts, 1);
  assert.equal(f.adapter.calls.filter(call => call.action === 'start').length, 1, 'first completion cannot automatically start the remainder'); noQC(f.current());
  assert.equal((await f.json(f.base + '/dispatch', {})).status, 409);
  await f.ok(f.base + '/dispatch', { confirmedReady: true });
  const second = f.current().runs.at(-1); assert.notEqual(second.id, first.id); assert.notEqual(second.remoteId, first.remoteId); assert.notEqual(second.fileName, first.fileName);
  await f.finish();
  const complete = (await f.ticket()).ticket; assert.equal(complete.status, 'post_processing'); assert.equal(complete.production.progress.printedParts, 2); assert.equal(complete.production.progress.remainingParts, 0);
  assert.equal(f.current().resinProduction.printedParts, 2); assert.equal(f.adapter.calls.filter(call => call.action === 'start').length, 2); noQC(f.current());
  const before = f.adapter.calls.length; assert.notEqual((await f.json(f.base + '/dispatch', { confirmedReady: true })).status, 200); assert.equal(f.adapter.calls.length, before);
}

test('production HTTP/manager contract requires separate qualified starts for two units and never fabricates QC credit', t => twoUnitFlow(t, { actual: false }));
test('actual private portal + SQLite completes two separately confirmed unit runs and retains post-processing/QC boundary', { skip: portalAvailable ? false : sourceSkip }, t => twoUnitFlow(t, { actual: true }));

test('production HTTP routes require local authentication and client flags cannot mint a dispatch permit', async t => {
  const f = await fixture(t);
  for (const suffix of ['', '/approve', '/dispatch', '/reconcile']) {
    const result = await fetch(f.app.url + f.base + suffix, { method: suffix ? 'POST' : 'GET', ...(suffix ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmedReady: true, confirmedWholeModel: true, qualified: true }) } : {}) });
    assert.equal(result.status, 401);
  }
  await f.syncSlice(); await f.enable();
  const forged = await f.json(f.base + '/dispatch', { confirmedReady: true, approved: true, authorization: { qualified: true }, permitId: randomUUID() });
  assert.equal(forged.status, 409); noHardwareWrites(f); assert.equal(f.app.service._resinDispatchPermits.size, 0);
});

test('changed original, profile, device or revoked server qualification blocks upload after approval', async t => {
  for (const change of ['source', 'profile', 'device', 'qualification']) {
    await t.test(change, async child => {
      const f = await prepared(child); await f.enable();
      if (change === 'source') await fs.appendFile(f.current().inputPath, 'changed');
      if (change === 'profile') { const value = JSON.parse(await fs.readFile(f.settings.profilePath, 'utf8')); value.material = 'Changed material'; await fs.writeFile(f.settings.profilePath, JSON.stringify(value)); }
      if (change === 'device') f.attributes.FirmwareVersion = 'fixture-2';
      if (change === 'qualification') f.portal.revoke();
      const result = await f.json(f.base + '/dispatch', { confirmedReady: true }); assert.notEqual(result.status, 200, JSON.stringify(result)); noHardwareWrites(f); assert.equal(f.current().runs.length, 0);
    });
  }
});

test('qualification revoked during upload prevents start and creates no portal physical-start evidence', async t => {
  const f = await prepared(t); await f.enable(); f.adapter.onUpload = () => f.portal.revoke();
  const result = await f.json(f.base + '/dispatch', { confirmedReady: true }); assert.equal(result.status, 409);
  assert.equal(f.adapter.calls.filter(call => call.action === 'upload').length, 1); assert.equal(f.adapter.calls.filter(call => call.action === 'start').length, 0);
  assert.equal(f.current().runs.at(-1).outcome, 'not_started'); assert.ok(!f.writes.some(body => JSON.parse(body).action === 'start_print')); noQC(f.current());
});

test('HTTP completion claims need matched terminal telemetry and an explicit bounded operator count', async t => {
  const f = await prepared(t); await f.enable(); await f.ok(f.base + '/dispatch', { confirmedReady: true });
  const run = f.current().runs.at(-1);
  const forged = { runId: run.id, outcome: 'completed', printedParts: 1, terminalEvidence: { outcome: 'completed', remoteId: run.remoteId, currentFile: run.fileName } };
  assert.equal((await f.json(f.base + '/reconcile', forged)).status, 409);
  for (const telemetry of [
    { state: 'idle', remoteId: run.remoteId, currentFile: run.fileName, progress: 100 },
    { state: 'idle', remoteId: 'unrelated-task', currentFile: run.fileName, progress: 100, outcome: 'completed' },
    { state: 'idle', remoteId: run.remoteId, currentFile: 'unrelated.goo', progress: 100, outcome: 'completed' },
  ]) {
    f.adapter.telemetry = telemetry; await f.app.service.testPrinter(f.printer.id);
    assert.equal((await f.json(f.base + '/reconcile', forged)).status, 409);
    assert.equal(f.current().resinProduction.printedParts, 0);
    assert.ok(!f.writes.some(body => JSON.parse(body).action === 'finish_print')); noQC(f.current());
  }
  f.adapter.telemetry = { state: 'idle', remoteId: run.remoteId, currentFile: run.fileName, progress: 100, outcome: 'completed' };
  await f.app.service.testPrinter(f.printer.id);
  assert.equal(f.current().resinProduction.printedParts, 0, 'matched telemetry alone cannot invent an operator unit count');
  assert.equal((await f.ticket()).ticket.status, 'printing');
  assert.equal((await f.json(f.base + '/reconcile', { runId: run.id, outcome: 'completed', printedParts: 2 })).status, 400);
  await f.ok(f.base + '/reconcile', { runId: run.id, outcome: 'completed', printedParts: 1 });
  assert.equal(f.current().resinProduction.printedParts, 1); noQC(f.current());
});

test('missing or uncertain printer acknowledgement cannot claim a portal start or retry through polling/restart', async t => {
  for (const mode of ['missing-ack', 'uncertain']) await t.test(mode, async child => {
    const f = await prepared(child); await f.enable(); f.adapter.startMode = mode;
    const response = await f.json(f.base + '/dispatch', { confirmedReady: true }); assert.ok(response.status >= 500);
    const held = f.current(), runId = held.currentRunId; assert.equal(held.status, 'needs_attention'); assert.equal(held.runs.at(-1).phase, 'result_unknown'); assert.equal(held.runs.at(-1).startEvidence, undefined);
    assert.ok(!f.writes.some(body => JSON.parse(body).action === 'start_print'));
    await f.poll(); await f.restart(); await f.poll();
    assert.notEqual((await f.json(f.base + '/dispatch', { confirmedReady: true })).status, 200);
    assert.equal(f.current().currentRunId, runId); assert.equal(f.current().runs.length, 1); assert.equal(f.adapter.calls.filter(call => call.action === 'start').length, 1); noQC(f.current());
    assert.equal((await f.ticket()).ticket.status, 'queued');
  });
});

test('lost slice response replays exactly the same saved UUID/body after restart without hardware work', async t => {
  const f = await fixture(t, { qualify: true }); f.faults.loseReply = 'record_slice';
  const pending = await f.syncSlice(); assert.equal(pending.state, 'pending'); assert.equal(pending.attempts, 1); noHardwareWrites(f);
  await f.restart(); f.advanceRetries(); await f.poll();
  const copies = f.writes.filter(body => JSON.parse(body).action === 'record_slice'); assert.equal(copies.length, 2); assert.equal(copies[1], copies[0]);
  assert.equal(f.outbox.get(pending.operationId).state, 'confirmed'); assert.equal((await f.ticket()).ticket.version, 6); noHardwareWrites(f);
});

async function lostStartFlow(t, options) {
  const f = await prepared(t, options); await f.enable(); f.faults.loseReply = 'start_print';
  await f.ok(f.base + '/dispatch', { confirmedReady: true }); const run = f.current().runs.at(-1);
  assert.ok(run.startEvidence); assert.equal((await f.ticket()).ticket.status, 'printing');
  const pending = f.outbox.status().find(value => value.action === 'start_print'); assert.equal(pending.state, 'pending');
  await f.finish(); assert.equal(f.current().resinProduction.printedParts, 1); assert.equal((await f.ticket()).ticket.production.progress.printedParts, 0, 'unconfirmed start receipt must block later finish evidence');
  assert.notEqual((await f.json(f.base + '/dispatch', { confirmedReady: true })).status, 200); assert.equal(f.adapter.calls.filter(call => call.action === 'start').length, 1);
  await f.restart(); f.advanceRetries(); await f.poll();
  const starts = f.writes.filter(body => JSON.parse(body).action === 'start_print'); assert.equal(starts.length, 2); assert.equal(starts[0], starts[1]);
  assert.equal(f.outbox.get(pending.operationId).state, 'confirmed');
  const ticket = (await f.ticket()).ticket; assert.equal(ticket.status, 'queued'); assert.equal(ticket.production.progress.printedParts, 1); assert.equal(ticket.production.progress.remainingParts, 1);
  assert.equal(f.adapter.calls.filter(call => call.action === 'start').length, 1); noQC(f.current());
}
test('lost physical-start portal reply holds finish and further hardware until exact replay confirms progress', t => lostStartFlow(t, { actual: false }));
test('actual private portal lost-reply replay preserves a single physical start and commits one printed unit', { skip: portalAvailable ? false : sourceSkip }, t => lostStartFlow(t, { actual: true }));

test('concurrent reconciliation with conflicting details returns 409 rather than sharing the first result', async t => {
  const f = await prepared(t); await f.enable(); await f.ok(f.base + '/dispatch', { confirmedReady: true });
  const run = f.current().runs.at(-1), entered = deferred(), release = deferred();
  f.adapter.telemetry = { state: 'idle', remoteId: run.remoteId, currentFile: run.fileName, outcome: 'completed' };
  await f.app.service.testPrinter(f.printer.id);
  const reconcile = f.app.service.reconcileResinRun.bind(f.app.service);
  f.app.service.reconcileResinRun = async (...args) => { entered.resolve(); await release.promise; return reconcile(...args); };
  const first = f.json(f.base + '/reconcile', { runId: run.id, outcome: 'completed', printedParts: 1, notes: 'first review' });
  try {
    await entered.promise;
    let timer;
    const conflict = await Promise.race([
      f.json(f.base + '/reconcile', { runId: run.id, outcome: 'failed', printedParts: 0, notes: 'conflicting review' }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'blocked' }), 2500); }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(conflict.status, 409, 'a conflicting request must return while the first reconciliation is still pending');
    assert.equal(conflict.value.error, 'LAYR_PRODUCTION_CONFLICT');
  } finally { release.resolve(); }
  assert.equal((await first).status, 200);
  assert.equal(f.current().runs.at(-1).reconciliation.printedParts, 1); assert.equal(f.current().resinProduction.printedParts, 1);
});

test('dismissed physical start or result evidence blocks further hardware even when the local run credits zero', async t => {
  for (const action of ['start_print', 'fail_print']) await t.test(action, async child => {
    const f = await prepared(child); await f.enable();
    f.faults.reject = action; f.faults.rejectStatus = 409;
    await f.ok(f.base + '/dispatch', { confirmedReady: true });
    await f.finish(0);
    const entry = f.outbox.status().find(value => value.action === action);
    assert.ok(entry); assert.equal(entry.state, 'conflict');
    await f.ok(`/api/integrations/layr/outbox/${entry.operationId}/dismiss`, { reason: 'Fixture operator reviewed definite conflict; remote reconciliation still required.' });
    assert.equal(f.outbox.get(entry.operationId).state, 'dismissed');
    assert.equal(f.current().resinProduction.printedParts, 0);
    assert.equal(f.current().resinProduction.plan.approvalState, undefined, 'zero-unit reconciliation releases the local preparation hold');
    f.faults.reject = null;
    const before = f.adapter.calls.length, result = await f.json(f.base + '/dispatch', { confirmedReady: true });
    assert.equal(result.status, 409); assert.equal(result.value.error, 'LAYR_PHYSICAL_EVIDENCE_HELD');
    assert.equal(f.adapter.calls.length, before); assert.equal(f.adapter.calls.filter(value => value.action === 'start').length, 1); noQC(f.current());
  });
});

test('remote run printer, device and planned-count mismatches cannot queue finish evidence', async t => {
  for (const [field, value] of [['printerId', randomUUID()], ['deviceFingerprint', '0'.repeat(64)], ['plannedParts', 2]]) await t.test(field, async child => {
    const f = await prepared(child); await f.enable(); await f.ok(f.base + '/dispatch', { confirmedReady: true });
    f.faults.transform = async (response, { action }) => {
      if (action !== 'ticket' || !response.ok) return response;
      const body = await response.json(); body.ticket.production.run[field] = value; return Response.json(body);
    };
    const result = await f.finish(); assert.ok(result.syncError);
    assert.equal(f.current().resinProduction.printedParts, 1, 'local identified production stays recorded independently of rejected portal synchronization');
    assert.ok(!f.writes.some(body => JSON.parse(body).action === 'finish_print'));
    assert.ok(!f.outbox.status().some(entry => entry.action === 'finish_print'));
    const before = f.adapter.calls.length, next = await f.json(f.base + '/dispatch', { confirmedReady: true });
    assert.equal(next.status, 409); assert.equal(next.value.error, 'LAYR_RUN_MISMATCH'); assert.equal(f.adapter.calls.length, before);
  });
});

test('approval delayed by a device read cannot approve a replacement current slice', async t => {
  const f = await fixture(t, { qualify: true }); await f.syncSlice();
  const oldHash = f.current().resinSlice.sha256, entered = deferred(), release = deferred();
  let once = true;
  f.adapter.onAttributes = async () => { if (once) { once = false; entered.resolve(); await release.promise; } };
  const approval = f.json(f.base + '/approve', { confirmedWholeModel: true });
  try {
    await entered.promise;
    f.engine.prepareResin = async input => {
      const result = await makeSlice(input), bytes = await fs.readFile(result.filePath);
      bytes[12] ^= 1; await fs.writeFile(result.filePath, bytes);
      return { ...result, sha256: sha256(bytes) };
    };
    await f.ok(`/api/jobs/${f.id}/resin/slice`, CONFIRMED);
    assert.notEqual(f.current().resinSlice.sha256, oldHash);
  } finally { release.resolve(); }
  const result = await approval; assert.equal(result.status, 409);
  assert.equal(result.value.error, 'RESIN_RECEIPT_MISMATCH');
  assert.ok(!f.writes.some(body => JSON.parse(body).action === 'approve_preparation')); noHardwareWrites(f);
});

test('approval RPC retains the job lock and a queued replacement slice rejects after acknowledgement', async t => {
  const f = await fixture(t, { qualify: true }); await f.syncSlice();
  const entered = deferred(), release = deferred(), oldHash = f.current().resinSlice.sha256;
  f.faults.beforeRequest = async ({ command }) => { if (command?.action === 'approve_preparation') { entered.resolve(); await release.promise; } };
  const approval = f.json(f.base + '/approve', { confirmedWholeModel: true });
  let replacement;
  try {
    await entered.promise;
    assert.equal(f.current().resinProduction.plan.approvalState, 'pending');
    let settled = false;
    replacement = f.app.service.sliceResinJob(f.id, CONFIRMED).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'reslicing must wait behind the approval RPC job lock');
  } finally { release.resolve(); }
  const approved = await approval; assert.equal(approved.status, 200); assert.equal(approved.value.state, 'confirmed');
  const blocked = await replacement; assert.equal(blocked.error?.code, 'RESIN_APPROVAL_LOCKED');
  assert.equal(f.current().resinSlice.sha256, oldHash); assert.equal(f.current().resinProduction.plan.approvalState, 'approved'); noHardwareWrites(f);
});

test('first approval guard failure is durably paused with zero attempts and never calls the approval RPC', async t => {
  const f = await fixture(t, { qualify: true }); await f.syncSlice();
  let receiptReads = 0;
  f.faults.beforeRequest = async ({ action }) => {
    if (action === 'receipt' && ++receiptReads === 3) await fs.appendFile(f.current().inputPath, 'changed immediately before the locked send guard');
  };
  const result = await f.approve();
  assert.equal(receiptReads, 3); assert.equal(result.state, 'paused'); assert.equal(result.attempts, 0);
  assert.ok(!f.writes.some(body => JSON.parse(body).action === 'approve_preparation'));
  assert.equal((await f.ticket()).ticket.status, 'preparing'); noHardwareWrites(f);
});

test('ambiguous approval preserves its preparation hold and permits exact replay after local source changes', async t => {
  const f = await fixture(t, { qualify: true }); await f.syncSlice(); f.faults.loseReply = 'approve_preparation';
  const operation = await f.approve(); assert.equal(operation.state, 'pending'); assert.equal(operation.attempts, 1);
  assert.equal(f.current().resinProduction.plan.approvalState, 'pending');
  assert.equal((await f.ticket()).ticket.status, 'queued', 'the fixture lost only the reply, after portal approval committed');
  const replace = await f.json(`/api/jobs/${f.id}/resin/slice`, CONFIRMED);
  assert.equal(replace.status, 409); assert.equal(replace.value.error, 'RESIN_APPROVAL_LOCKED');
  await fs.appendFile(f.current().inputPath, 'external change after the ambiguous committed approval');
  await f.restart(); f.advanceRetries(); await f.poll();
  const bodies = f.writes.filter(body => JSON.parse(body).action === 'approve_preparation');
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal(f.outbox.get(operation.operationId).state, 'confirmed');
  assert.ok(['pending', 'approved'].includes(f.current().resinProduction.plan.approvalState)); noHardwareWrites(f);
  await f.enable(); assert.notEqual((await f.json(f.base + '/dispatch', { confirmedReady: true })).status, 200); noHardwareWrites(f);
});
