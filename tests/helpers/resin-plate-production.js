'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { startServer } = require('../../src/server');
const client = require('../../src/connectors/layr-production-client');
const { LayrOutbox } = require('../../src/connectors/layr-outbox');
const { fingerprintSDCPDevice } = require('../../src/adapters/sdcp-identity');
const { MODEL, CONFIRMED } = require('./resin-slice');
const { createPlateSliceFixture } = require('./resin-plate-slice');

const ORIGIN = 'https://printbylayr.example', TOKEN = 'p'.repeat(43), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
const portalSource = path.resolve(process.env.QUICKPRINT_PORTAL_SOURCE || path.join(__dirname, '../../integrations/printbylayr'));
const privateFiles = ['server/production.mjs', 'server/intake.mjs', 'server/workflow.mjs', 'tests/workflow-fixture.mjs', 'tests/storage-fixture.mjs', 'migrations/0005_production.sql', 'migrations/0006_production_quantities.sql'];
const available = privateFiles.every(file => existsSync(path.join(portalSource, file)));
const missing = 'Private reviewed portal source is absent; set QUICKPRINT_PORTAL_SOURCE. See docs/PRINTBYLAYR-PRODUCTION-INTEGRATION.md.';

function fakePortal(quantity, modelBuffer = MODEL) {
  const id = randomUUID(), createdAt = new Date().toISOString();
  const ticket = { id, reference: 'PBL-' + id, version: 5, status: 'preparing', createdAt, ticketFingerprint: 'a'.repeat(64),
    ticket: { specifications: { project: { name: 'Packed production fixture', quantity }, production: { printType: 'resin', supports: 'allowed', colour: 'grey' }, file: { name: 'source.stl', format: 'stl', sizeBytes: modelBuffer.length, units: 'mm' } } },
    production: { target: { id, kind: 'order', cycle: 0, requiredParts: quantity, authorizedAt: createdAt, qcOperationId: null }, progress: { requestedParts: quantity, printedParts: 0, remainingParts: quantity, completedRuns: 0, failedRuns: 0 }, totals: { printedParts: 0, completedRuns: 0, failedRuns: 0 }, targetHistory: [] } };
  const receipts = new Map(), operations = new Map(), runIds = new Set(); let binding;
  const qualified = receipt => Boolean(binding && receipt && Object.entries(binding).every(([key, value]) => key === 'engineSha256' ? receipt.tool.executableSha256 === value : key === 'format' ? receipt.artifact.format === value : receipt[key] === value));
  const rejected = (code, status = 409) => Response.json({ code }, { status });
  return { id, async close() {}, qualify(value) { binding = clone(value); }, current: () => clone(ticket),
    async handle(url, options) {
      if (url.pathname === '/api/intake') return new Response(modelBuffer);
      const action = url.searchParams.get('action');
      if (options.method !== 'POST') {
        if (action === 'tickets') return Response.json({ tickets: ticket.status === 'preparing' ? [clone(ticket)] : [], nextCursor: null });
        if (action === 'ticket') return Response.json({ ticket: clone(ticket) });
        if (action === 'download') return Response.json({ name: 'source.stl', sizeBytes: modelBuffer.length, url: ORIGIN + '/api/intake?download=private.signature' });
        const receipt = receipts.get(url.searchParams.get('receiptId')); if (!receipt) return rejected('receipt_not_found', 404);
        if (action === 'receipt') return Response.json({ receipt: clone(receipt), qualification: { qualified: qualified(receipt), checkedAt: new Date().toISOString(), qualificationFingerprint: qualified(receipt) ? hash(JSON.stringify(binding)) : null } });
        if (!qualified(receipt)) return rejected('preparation_unqualified');
        if (ticket.status !== 'queued' || ticket.production.approvedReceiptId !== receipt.id || receipt.partsPerRun > ticket.production.progress.remainingParts) return rejected('quantity_plan_mismatch');
        const now = Date.now(), target = ticket.production.target;
        return Response.json({ ticket: clone(ticket), receipt: clone(receipt), authorization: { qualified: true, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString(),
          jobVersion: ticket.version, ticketFingerprint: ticket.ticketFingerprint, receiptId: receipt.id, sourceSha256: receipt.sourceSha256, artifactSha256: receipt.artifact.sha256, profileSha256: receipt.profileSha256, engineSha256: receipt.tool.executableSha256,
          printerId: receipt.printerId, printerModel: receipt.printerModel, material: receipt.material, format: receipt.artifact.format, deviceFingerprint: receipt.deviceFingerprint,
          partsPerRun: receipt.partsPerRun, plannedParts: receipt.partsPerRun, remainingParts: ticket.production.progress.remainingParts, qualificationFingerprint: hash(JSON.stringify(binding)), targetId: target.id, targetKind: target.kind, targetCycle: target.cycle, targetParts: target.requiredParts } });
      }
      const body = JSON.parse(options.body), data = body.data, replay = operations.get(body.operationId);
      if (replay) return replay.body === options.body ? Response.json(clone(replay.result)) : rejected('operation_conflict');
      if (body.version !== ticket.version) return rejected('version_conflict');
      if (data.ticketFingerprint !== ticket.ticketFingerprint) return rejected('ticket_changed');
      let receipt;
      if (body.action === 'record_slice') {
        if (ticket.status !== 'preparing') return rejected('invalid_transition');
        receipt = { id: body.operationId, jobId: id, kind: 'slice', ...clone(data), printReady: false };
        receipt.qualified = receipt.qualifiedAtCapture = qualified(receipt); receipts.set(receipt.id, receipt); ticket.production.sourceSha256 = data.sourceSha256; ticket.production.latestSliceReceiptId = receipt.id;
      } else if (body.action === 'approve_preparation') {
        const captured = receipts.get(data.receiptId);
        if (ticket.status !== 'preparing' || !qualified(captured) || captured.partsPerRun > ticket.production.progress.remainingParts) return rejected('quantity_plan_mismatch');
        ticket.status = 'queued'; ticket.production.approvedReceiptId = captured.id; ticket.production.approvedTargetId = ticket.production.target.id; ticket.preparation = { receiptId: captured.id };
      } else if (body.action === 'start_print') {
        const captured = receipts.get(data.receiptId);
        if (ticket.status !== 'queued' || !qualified(captured) || data.plannedParts !== captured.partsPerRun || data.plannedParts > ticket.production.progress.remainingParts || runIds.has(data.runId)) return rejected('quantity_plan_mismatch');
        runIds.add(data.runId); ticket.status = 'printing'; ticket.production.run = { ...clone(data), status: 'printing', startedAt: data.observedAt };
      } else {
        const run = ticket.production.run, completed = body.action === 'finish_print';
        if (!['finish_print', 'fail_print'].includes(body.action) || ticket.status !== 'printing' || run.runId !== data.runId || run.remoteId !== data.remoteId || data.targetId !== ticket.production.target.id || !Number.isInteger(data.printedParts) || data.printedParts < (completed ? 1 : 0) || data.printedParts > (completed ? run.plannedParts : 0)) return rejected('run_mismatch');
        Object.assign(run, { status: completed ? 'completed' : 'failed', printedParts: data.printedParts, finishedAt: data.observedAt });
        const progress = ticket.production.progress; progress.printedParts += data.printedParts; progress.remainingParts -= data.printedParts;
        progress[completed ? 'completedRuns' : 'failedRuns']++; ticket.production.totals[completed ? 'completedRuns' : 'failedRuns']++; ticket.production.totals.printedParts += data.printedParts;
        ticket.status = completed ? progress.remainingParts === 0 ? 'post_processing' : progress.remainingParts >= run.plannedParts ? 'queued' : 'preparing' : 'preparing';
        if (ticket.status === 'preparing') { ticket.preparation = null; delete ticket.production.approvedReceiptId; delete ticket.production.approvedTargetId; }
      }
      ticket.version++; const result = { ticket: clone(ticket), ...(receipt ? { receipt: clone(receipt) } : {}) };
      operations.set(body.operationId, { body: options.body, result: clone(result) }); return Response.json(result);
    } };
}

async function actualPortal(quantity, modelBuffer = MODEL) {
  const [production, intake, workflow, { SqliteWorkflowD1 }, { FakeB2 }] = await Promise.all(privateFiles.slice(0, 5).map(file => import(pathToFileURL(path.join(portalSource, file)).href)));
  const database = new SqliteWorkflowD1(), bucket = new FakeB2(), id = randomUUID(), now = Date.now();
  for (const file of privateFiles.slice(5)) database.database.exec(readFileSync(path.join(portalSource, file), 'utf8'));
  const model = { fileId: 'owned-model-' + id, size: modelBuffer.length, sha1: createHash('sha1').update(modelBuffer).digest('hex') };
  const record = { id, requestId: 'PBL-' + id.toUpperCase(), origin: ORIGIN, createdAt: new Date(now).toISOString(), model, notification: { accepted: true },
    payload: { client: { fullName: 'Owned fixture customer', email: 'fixture@example.test' }, project: { name: 'Packed production fixture', quantity }, production: { printType: 'resin', supports: 'allowed', colour: 'grey' }, file: { name: 'source.stl', format: 'stl', sizeBytes: modelBuffer.length, units: 'mm' } } };
  database.database.prepare('INSERT INTO intake_requests (id,record_json,model_json,notification_json,created_at) VALUES (?,?,?,?,?)').run(id, JSON.stringify(record), JSON.stringify(model), JSON.stringify(record.notification), record.createdAt);
  bucket.objects.set(model.fileId, { fileId: model.fileId, key: 'requests/' + id + '/model.stl', bytes: modelBuffer, sha1: model.sha1 });
  const env = { WORKFLOW_ENABLED: '1', INTAKE_DB: database, INTAKE_SIGNING_SECRET: 'packed-production-fixture-secret-at-least-32-characters', B2_APPLICATION_KEY_ID: 'test-key-id', B2_APPLICATION_KEY: 'test-key', B2_BUCKET_ID: bucket.bucketId,
    PRODUCTION_TOKEN_SHA256: hash(TOKEN), PRODUCTION_MACHINE_ID: 'packed-fixture-machine', PRODUCTION_QUALIFIED_BINDINGS: '[]' };
  let job = await workflow.ensureJob(env, record, { customerUrl: ORIGIN + '/job#fixture-customer', now });
  const command = (name, data, actor = 'studio') => workflow.commandJob(env, { id, version: job.version, operationId: randomUUID(), command: name, data, actor, now });
  job = await command('issue_quote', { amountCents: 2000, leadTimeDays: 5, expiresAt: new Date(now + 86400000).toISOString(), summary: 'Owned twenty-unit test order.', fulfilment: 'pickup' });
  job = await command('accept_quote', {}, 'customer'); await command('confirm_payment', { amountCents: 2000, reference: 'fixture-payment' });
  return { id, close: () => database.database.close(), qualify: binding => { env.PRODUCTION_QUALIFIED_BINDINGS = JSON.stringify([binding]); }, current: () => workflow.getJob(env, id),
    handle: (url, options) => url.pathname === '/api/production' ? production.handleProduction(new Request(url, options), env, { now: Date.now, log: () => {} }) : intake.handleIntake(new Request(url, options), env, { now: Date.now, storageFetch: bucket.fetch, log: () => {} }) };
}

async function fixture(t, { actual = false, quantity = 20, modelBuffer = MODEL } = {}) {
  assert.ok(Buffer.isBuffer(modelBuffer) && modelBuffer.length, 'The owned source fixture must contain model bytes.');
  const source = Buffer.from(modelBuffer);
  const portal = actual ? await actualPortal(quantity, source) : fakePortal(quantity, source), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-packed-flow-'));
  const packed = await createPlateSliceFixture(path.join(directory, 'profile')), writes = [], faults = { loseReply: null, reject: null, freshTicket: null, beforeFreshTicket: null };
  let app, offset = 0;
  const fetchImpl = async (address, options = {}) => {
    const url = new URL(address); assert.equal(url.origin, ORIGIN); assert.equal(options.redirect, 'error');
    const command = options.method === 'POST' ? JSON.parse(options.body) : null, action = command?.action || url.searchParams.get('action');
    if (command) writes.push(options.body);
    if (faults.reject && faults.reject === action) return Response.json({ code: 'production_unavailable' }, { status: 503 });
    const result = await portal.handle(url, options);
    if (result.ok && faults.loseReply && faults.loseReply === action) { faults.loseReply = null; throw new Error('Fixture reply lost after durable portal commit'); }
    if (action === 'ticket' && (faults.freshTicket || faults.beforeFreshTicket)) {
      const value = await result.json();
      if (value.ticket.status === 'preparing' && value.ticket.production?.progress?.remainingParts === 2) {
        await faults.beforeFreshTicket?.(value.ticket); faults.freshTicket?.(value.ticket);
      }
      return Response.json(value, { status: result.status });
    }
    return result;
  };
  const transport = { ...client };
  for (const name of ['listPreparationJobs', 'downloadModel', 'getTicket', 'getReceipt', 'getAuthorization', 'postEvidence']) transport[name] = (config, ...args) => { const index = name === 'listPreparationJobs' ? 0 : 1; args[index] = { ...args[index], fetchImpl }; return client[name](config, ...args); };
  const attrs = { MainboardID: '0123456789abcdef', BrandName: 'Fixture', MachineName: 'QuickPrint Test', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'fixture-packed-1', Resolution: '64x32', XYZsize: '40x20x30', Capabilities: ['PRINT_CONTROL', 'FILE_TRANSFER'], SupportFileType: ['GOO'] };
  const adapter = { capabilities: { upload: true, start: true, formats: ['goo'] }, calls: [], telemetry: { state: 'idle' }, serial: 0,
    async attributes() { return clone(attrs); }, async status() { return { ...clone(this.telemetry), observedAt: new Date().toISOString() }; },
    async upload(input) { this.calls.push({ action: 'upload', ...input }); this.filename = input.fileName; return { remotePath: input.fileName }; },
    async start(input) { this.calls.push({ action: 'start', ...input }); this.telemetry = { state: 'printing', remoteId: 'packed-task-' + ++this.serial, currentFile: this.filename };
      return { acknowledged: true, ...this.telemetry, observedAt: new Date().toISOString() }; }, async close() {} };
  const open = async () => { app = await startServer({ dataDir: path.join(directory, 'workspace'), port: 0, resinEngine: packed.engine, adapters: () => adapter, layrProductionClient: transport, layrOutbox: new LayrOutbox({ dataDir: path.join(directory, 'workspace'), now: () => Date.now() + offset }) }); };
  await open(); t.after(async () => { await app?.close(); await portal.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const json = async (route, body = {}) => { const result = await fetch(app.url + route, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: result.status, value: await result.json() }; };
  const ok = async (route, body) => { const result = await json(route, body); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value; };
  const printer = await app.service.savePrinter({ name: 'Owned fixture target', type: 'sdcp', host: 'fixture.invalid', mainboardId: attrs.MainboardID, brandId: 'fixture-brand', model: 'QuickPrint Test' });
  await packed.bindPrinter(printer.id); await app.service.updateSettings({ resinEngine: packed.settings });
  const connector = await ok('/api/connectors', { type: 'layr', apiMode: 'production', portalUrl: ORIGIN, token: TOKEN, enabled: true, autoSyncPreparation: false, pollIntervalMs: 3600000 });
  await ok('/api/connectors/' + connector.id + '/poll');
  const job = app.service.snapshot().jobs.find(value => value.order?.portalJobId === portal.id); assert.ok(job);
  const base = '/api/jobs/' + job.id, poll = () => ok('/api/connectors/' + connector.id + '/poll');
  const f = { portal, packed, adapter, writes, faults, printer, connector, id: job.id, base, json, ok, poll, current: () => app.service.getJob(job.id), get app() { return app; },
    async slice(copies = 6) { return ok(base + '/resin/slice', { ...CONFIRMED, plate: { copies, gapMm: 1, marginMm: 1 } }); },
    async reviewed(copies = 6) {
      await this.slice(copies); const slice = this.current().resinSlice;
      portal.qualify({ profileSha256: slice.profileSha256, engineSha256: slice.tool.executableSha256, deviceFingerprint: fingerprintSDCPDevice(printer, attrs), printerId: printer.id, printerModel: slice.printerModel, material: slice.material, format: 'goo' });
      const receipt = await ok(base + '/resin/sync'); await poll();
      const approval = await ok(base + '/resin/production/approve', { confirmedWholeModel: true }); assert.equal(approval.state, 'confirmed');
      await app.service.updateSettings({ resinEngine: { dispatchEnabled: true } }); return { receipt, approval };
    },
    async start() { const current = this.current(); return ok(base + '/resin/production/dispatch', { confirmedReady: true, receiptId: current.resinProduction.plan.receiptId, plannedParts: current.resinSlice.modelCopiesPerRun }); },
    async terminal() { const run = this.current().runs.at(-1); adapter.telemetry = { state: 'idle', outcome: 'completed', progress: 100, remoteId: run.remoteId, currentFile: run.fileName }; await app.service.testPrinter(printer.id); return run; },
    async finish(printedParts = 6) { const run = await this.terminal(); return ok(base + '/resin/production/reconcile', { runId: run.id, outcome: 'completed', printedParts }); },
    async restart() { await app.close(); await open(); }, advance() { offset += 120000; } };
  return f;
}
module.exports = { createPlateProductionFixture: fixture, available, missing };
