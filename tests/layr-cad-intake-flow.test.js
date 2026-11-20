'use strict';

// Actual reviewed portal handlers + SQL + local HTTP/core/manager. Storage,
// notifications and native process boundaries are fixtures; no public service
// or physical printer is contacted. Native CAD probes are separate tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');
const { startServer } = require('../src/server');
const productionClient = require('../src/connectors/layr-production-client');
const { STEP, createCadFixture } = require('./helpers/resin-cad');
const { CONFIRMED, createProfile, makeSlice } = require('./helpers/resin-slice');

const ORIGIN = 'https://printbylayr.example', TOKEN = 'c'.repeat(43);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = path.resolve(process.env.QUICKPRINT_PORTAL_SOURCE || path.join(__dirname, '../integrations/printbylayr'));
const files = ['server/production.mjs', 'server/intake.mjs', 'server/workflow.mjs', 'tests/workflow-fixture.mjs', 'tests/storage-fixture.mjs', 'migrations/0005_production.sql', 'migrations/0006_production_quantities.sql'];
const available = files.every(file => existsSync(path.join(source, file)));
const skip = 'Private portal source is absent; set QUICKPRINT_PORTAL_SOURCE or materialize the reviewed checkout described in docs/PRINTBYLAYR-PRODUCTION-INTEGRATION.md.';
let loaded;
const modules = () => loaded ||= Promise.all(files.slice(0, 5).map(file => import(pathToFileURL(path.join(source, file)).href)));

for (const [format, units] of [['step', 'in'], ['stp', 'm']]) {
  test(`actual resin ${format.toUpperCase()} intake reaches verified local CAD/slice evidence without double unit conversion or physical authorization`, { skip: available ? false : skip }, async t => {
    const [production, intake, workflow, { SqliteWorkflowD1 }, { FakeB2 }] = await modules();
    const database = new SqliteWorkflowD1(), bucket = new FakeB2(), notifications = [], remoteCalls = [];
    for (const migration of files.slice(5)) database.database.exec(readFileSync(path.join(source, migration), 'utf8'));
    const now = Date.now(), env = {
      WORKFLOW_ENABLED: '1', INTAKE_DB: database,
      INTAKE_SIGNING_SECRET: 'public-cad-intake-fixture-secret-at-least-32-characters',
      B2_APPLICATION_KEY_ID: 'test-key-id', B2_APPLICATION_KEY: 'test-key', B2_BUCKET_ID: bucket.bucketId,
      INTAKE_GUARD: { fetch: async () => Response.json({ allowed: true }) },
      QUOTE_FROM: 'studio@example.test', QUOTE_EMAIL: { fetch: async request => { notifications.push(await request.json()); return Response.json({ accepted: true, messageId: 'fixture-only' }); } },
      PRODUCTION_TOKEN_SHA256: hash(TOKEN), PRODUCTION_MACHINE_ID: 'public-cad-intake-fixture', PRODUCTION_QUALIFIED_BINDINGS: '[]',
    };
    const dependencies = { now: () => now, storageFetch: bucket.fetch, log: () => {} };
    const intakePost = body => intake.handleIntake(new Request(ORIGIN + '/api/intake', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, dependencies);
    const payload = {
      client: { type: 'student', segment: 'student', fullName: 'Owned fixture customer', email: 'fixture@example.test', phone: '', instagram: '', orgName: '' },
      project: { name: 'CAD intake connection', deadline: new Date(now + 30 * 86400000).toISOString().slice(0, 10), intendedUse: 'prototype', quantity: 20, scale: '1:1', targetDims: 'Review embedded units', notes: 'Preserve original CAD.' },
      production: { printType: 'resin', qualityTier: 'standard', colour: 'grey', properties: 'standard', supports: 'allowed' },
      file: { name: 'owned-source.' + format, format, sizeBytes: STEP.length, units }, clientValidation: null,
    };
    let app;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-cad-intake-flow-'));
    t.after(async () => { await app?.close(); database.database.close(); await fs.rm(directory, { recursive: true, force: true }); });
    assert.equal(database.database.prepare('SELECT COUNT(*) AS n FROM intake_requests').get().n, 0, 'this flow must begin at intake, never a seeded production job');
    const started = await intakePost({ action: 'start', payload }); assert.equal(started.status, 200, await started.clone().text());
    const session = await started.json();
    const part = await intake.handleIntake(new Request(ORIGIN + '/api/intake?part=1', { method: 'PUT', headers: { Origin: ORIGIN, Authorization: 'Bearer ' + session.uploadToken }, body: STEP }), env, dependencies);
    assert.equal(part.status, 200, await part.clone().text());
    const completed = await intakePost({ action: 'complete', uploadToken: session.uploadToken, parts: [await part.json()] });
    assert.equal(completed.status, 200, await completed.clone().text()); assert.ok((await completed.json()).customerUrl);
    const portalId = session.requestId.slice(4).toLowerCase();
    let remote = await workflow.getJob(env, portalId);
    const command = (name, data, actor = 'studio') => workflow.commandJob(env, { id: portalId, version: remote.version, operationId: randomUUID(), command: name, data, actor, now });
    remote = await command('issue_quote', { amountCents: 4200, leadTimeDays: 5, expiresAt: new Date(now + 86400000).toISOString(), summary: 'Twenty resin units after CAD conversion review.', fulfilment: 'pickup' });
    remote = await command('accept_quote', {}, 'customer');
    remote = await command('confirm_payment', { amountCents: 4200, reference: 'fixture-payment' });
    const frozen = structuredClone(remote.ticket), fingerprint = await production.productionTicketFingerprint(frozen);
    assert.equal(remote.status, 'preparing'); assert.deepEqual(frozen.specifications.file, payload.file); assert.equal(notifications.length, 1);

    const fetchImpl = async (address, options = {}) => {
      const url = new URL(address); assert.equal(url.origin, ORIGIN); assert.equal(options.redirect, 'error');
      if (url.pathname === '/api/production') {
        assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
        remoteCalls.push({ action: options.method === 'POST' ? JSON.parse(options.body).action : url.searchParams.get('action'), query: url.searchParams, body: options.body });
        return production.handleProduction(new Request(url, options), env, dependencies);
      }
      assert.equal(url.pathname, '/api/intake'); assert.equal(options.headers, undefined, 'private signed downloads must not forward the bearer');
      remoteCalls.push({ action: 'download-model' });
      return intake.handleIntake(new Request(url, options), env, dependencies);
    };
    const transport = { ...productionClient };
    for (const name of ['listPreparationJobs', 'downloadModel', 'getTicket', 'getReceipt', 'getAuthorization', 'postEvidence']) transport[name] = (config, ...args) => {
      const index = name === 'listPreparationJobs' ? 0 : 1; args[index] = { ...args[index], fetchImpl };
      return productionClient[name](config, ...args);
    };
    const cad = await createCadFixture(path.join(directory, 'provider')), sliceInputs = [];
    app = await startServer({ dataDir: path.join(directory, 'workspace'), port: 0, layrProductionClient: transport, resinCad: cad.implementation,
      resinEngine: { prepareResin: input => { sliceInputs.push(input); return makeSlice(input); } },
      adapters: () => { assert.fail('An unbound intake/preparation flow must never reach printer hardware.'); } });
    await app.service.updateSettings({ resinEngine: { ...(await createProfile(directory)), freecadExecutable: cad.options.freecadExecutable, cadAuditPath: cad.options.cadAuditPath } });
    const local = async (route, body) => {
      const result = await fetch(app.url + route, { method: 'POST', headers: { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(result.status, 200, await result.clone().text()); return result.json();
    };
    const connector = await local('/api/connectors', { type: 'layr', apiMode: 'production', portalUrl: ORIGIN, token: TOKEN, enabled: true, autoSyncPreparation: false, pollIntervalMs: 60000 });
    await local('/api/connectors/' + connector.id + '/poll', {});
    const jobs = app.service.snapshot().jobs; assert.equal(jobs.length, 1);
    const job = jobs[0]; assert.equal(job.sha256, hash(STEP)); assert.deepEqual(await fs.readFile(job.inputPath), STEP);
    assert.equal(job.quantity, 1); assert.equal(job.order.requestedQuantity, 20); assert.equal(job.order.units, units); assert.equal(job.order.ticketFingerprint, fingerprint);
    assert.ok(remoteCalls.some(call => call.action === 'tickets' && call.query.has('limit')), 'the real paginated production client must list the paid ticket');
    assert.ok(remoteCalls.some(call => call.action === 'download-model'));
    await assert.rejects(app.service.sliceResinJob(job.id, CONFIRMED), { code: 'RESIN_CAD_REQUIRED' }); assert.equal(sliceInputs.length, 0);
    const prepared = await local('/api/jobs/' + job.id + '/resin/cad', { confirmedEmbeddedUnits: true });
    assert.equal(prepared.resinCad.sourceSha256, hash(STEP)); assert.equal(prepared.resinCad.coordinateUnits, 'mm'); assert.equal(prepared.resinCad.embeddedUnitsConverted, true);
    assert.equal(prepared.resinCad.operatorReview.ticketUnits, units); assert.equal(cad.calls.length, 2);
    const sliced = await local('/api/jobs/' + job.id + '/resin/slice', { ...CONFIRMED, expectedGeometrySha256: prepared.resinCad.sha256 });
    const slice = sliced.resinSlice;
    assert.equal(sliceInputs.length, 1); assert.equal(sliceInputs[0].inputPath, prepared.resinCad.filePath); assert.equal(sliceInputs[0].unitScale, 1);
    assert.equal(slice.sourceSha256, hash(STEP)); assert.equal(slice.meshSourceSha256, prepared.resinCad.sha256);
    assert.equal(slice.operatorReview.ticketUnits, units); assert.equal(slice.operatorReview.units, 'mm'); assert.equal(slice.operatorReview.embeddedUnits, true);
    assert.notEqual(slice.tool.executableSha256, slice.rawSliceTool.executableSha256, 'the receipt engine fingerprint must include verified CAD provider evidence');
    assert.equal(slice.printReady, false); assert.deepEqual(await fs.readFile(job.inputPath), STEP);
    const queued = await local('/api/jobs/' + job.id + '/resin/sync', {});
    await local('/api/connectors/' + connector.id + '/poll', {});
    const receiptRead = await transport.getReceipt({ apiMode: 'production', portalUrl: ORIGIN, token: TOKEN }, { id: portalId, receiptId: queued.operationId });
    const receipt = receiptRead.receipt;
    assert.equal(receipt.sourceSha256, hash(STEP)); assert.equal(receipt.ticketFingerprint, fingerprint); assert.equal(receipt.tool.executableSha256, slice.tool.executableSha256);
    assert.equal(receipt.artifact.sha256, slice.sha256); assert.equal(receipt.partsPerRun, 1); assert.equal(receipt.deviceFingerprint, null);
    assert.equal(receipt.qualified, false); assert.equal(receipt.printReady, false); assert.equal(receiptRead.qualification.qualified, false);
    const current = app.service.getJob(job.id), portalJob = await workflow.getJob(env, portalId);
    assert.deepEqual(portalJob.ticket, frozen); assert.equal(portalJob.status, 'preparing'); assert.equal(portalJob.production.progress.printedParts, 0); assert.equal(portalJob.production.run, undefined);
    assert.equal(current.status, 'review'); assert.equal(current.acceptedQuantity, 0); assert.deepEqual(current.runs, []);
    assert.equal(app.service.getSettings().resinEngine.dispatchEnabled, false); assert.equal(app.service._resinDispatchPermits.size, 0);
    assert.deepEqual(remoteCalls.filter(call => call.body).map(call => JSON.parse(call.body).action), ['record_slice']);
    assert.equal(notifications.length, 1, 'fixture notifications are never sent by machine preparation');
  });
}
