'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validateLayrConfig, listPreparationJobs, downloadModel, buildOrderMetadata, MAX_MODEL_BYTES } = require('../src/connectors/layr-client');

const CONFIG = { portalUrl: 'https://printbylayr.example', token: 'a'.repeat(43) };
const MODEL = Buffer.from('solid part\nendsolid part\n');
const ID = 'f5bb06b2-cf61-4c74-8393-ad120c8d6a7a';
function fixtureJob() {
  return {
    id: ID, version: 5, reference: `PBL-${ID.toUpperCase()}`, status: 'preparing',
    payment: { amountCents: 2150, reference: 'bank-fixture', confirmedAt: '2026-11-19T15:00:00.000Z' },
    // Deliberately different mutable intake values verify frozen-ticket use.
    payload: { production: { printType: 'fdm-standard' }, project: { quantity: 500 } },
    ticket: {
      createdAt: '2026-11-19T15:00:00.000Z', quote: { amountCents: 2150, currency: 'CAD' },
      model: { fileId: 'private-b2-id', size: MODEL.length },
      specifications: {
        client: { email: 'private@example.test', fullName: 'Private Customer' },
        file: { name: 'part.stl', format: 'stl', sizeBytes: MODEL.length, units: 'in' },
        production: { printType: 'resin', qualityTier: 'presentation', supports: 'no-visible', colour: 'grey', properties: 'standard' },
        project: { name: 'Study model', quantity: 12, scale: '1:100', targetDims: '2 inches', notes: 'Inspect before printing.' },
      },
    },
  };
}

function mockPortal({ jobs = [fixtureJob()], modelResponse, transformRpc, getJob, link } = {}) {
  const calls = [];
  const tools = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/mcp')) {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${CONFIG.token}`);
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'tools/call');
      const name = request.params.name;
      tools.push(name);
      let value;
      if (name === 'list_jobs') {
        assert.deepEqual(request.params.arguments, { status: 'preparing', limit: 100 });
        value = { count: jobs.length, jobs: jobs.map(job => ({ id: job.id, status: job.status, version: job.version })) };
      } else if (name === 'get_job') {
        value = getJob ? getJob(request.params.arguments.job) : jobs.find(job => job.id === request.params.arguments.job);
      } else if (name === 'model_download_link') {
        value = link || { job: 'PBL-fixture', file: 'part.stl', url: `${CONFIG.portalUrl}/api/intake?download=eyJ0b2tlbiI.signature`, expiresInDays: 7 };
      } else assert.fail(`Mutation or unsupported tool: ${name}`);
      let envelope = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } };
      if (transformRpc) envelope = transformRpc(envelope, name);
      return Response.json(envelope);
    }
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined, 'MCP bearer is never forwarded to model download');
    return typeof modelResponse === 'function' ? modelResponse() : modelResponse || new Response(MODEL);
  };
  return { fetchImpl, calls, tools };
}

test('Layr config requires HTTPS and a real-shaped access token without URL credentials', () => {
  assert.deepEqual(validateLayrConfig({ ...CONFIG, portalUrl: `${CONFIG.portalUrl}/mcp` }), CONFIG);
  for (const portalUrl of ['http://localhost:9999', 'file:///tmp/portal', 'https://user:secret@example.test', `${CONFIG.portalUrl}/job`, `${CONFIG.portalUrl}/?secret=x`, `${CONFIG.portalUrl}/#token`]) {
    assert.throws(() => validateLayrConfig({ ...CONFIG, portalUrl }), { status: 400 });
  }
  for (const token of ['', 'secret\r\nInjected: x', 'a'.repeat(42), 'a'.repeat(44)]) {
    assert.throws(() => validateLayrConfig({ ...CONFIG, token }), { status: 400 });
  }
});

test('lists paid resin preparation jobs using actual frozen tickets, without mutations', async () => {
  const job = fixtureJob();
  const portal = mockPortal({ jobs: [job] });
  const jobs = await listPreparationJobs(CONFIG, portal);
  assert.deepEqual(jobs, [job]);
  assert.deepEqual(portal.tools, ['list_jobs', 'get_job']);
  const order = buildOrderMetadata(jobs[0], CONFIG.portalUrl);
  assert.equal(order.portalJobId, ID);
  assert.equal(order.portalVersion, 5);
  assert.equal(order.requestedQuantity, 12);
  assert.equal(order.units, 'in');
  assert.equal(order.production.printType, 'resin');
  assert.equal(order.quantity, undefined, 'part counts do not become print-plate quantities');
  assert.match(order.ticketFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(order).includes('private@example.test'));
  assert.ok(!JSON.stringify(order).includes('private-b2-id'));
});

test('unpaid, mismatched-payment, FDM and non-preparation jobs are excluded and cannot download', async () => {
  const variants = [
    job => { job.payment = null; },
    job => { job.ticket = null; },
    job => { job.payment.amountCents = 2149; },
    job => { job.payment.confirmedAt = 'unknown'; },
    job => { job.ticket.specifications.production.printType = 'fdm-standard'; },
    job => { job.status = 'cancelled'; },
    job => { job.status = 'printing'; },
  ];
  for (const mutate of variants) {
    const job = fixtureJob(); mutate(job);
    const portal = mockPortal({ jobs: [job] });
    assert.deepEqual(await listPreparationJobs(CONFIG, portal), []);
    await assert.rejects(downloadModel(CONFIG, job, portal), { status: 409 });
    assert.ok(!portal.tools.includes('model_download_link'));
  }
});

test('malformed MCP envelopes and tool results are rejected without exposing remote text or tokens', async () => {
  const transforms = [
    envelope => ({ ...envelope, id: 'different-request' }),
    envelope => ({ ...envelope, error: { code: -32000, message: CONFIG.token } }),
    envelope => ({ ...envelope, result: { isError: true, content: [{ type: 'text', text: CONFIG.token }] } }),
    envelope => ({ ...envelope, result: { content: [{ type: 'image', data: 'x' }] } }),
    envelope => ({ ...envelope, result: { content: [{ type: 'text', text: 'not-json' }] } }),
    envelope => ({ ...envelope, result: { content: [{ type: 'text', text: 'null' }] } }),
    envelope => ({ ...envelope, result: { content: [{ type: 'text', text: '{"count":99,"jobs":[]}' }] } }),
  ];
  for (const transformRpc of transforms) {
    await assert.rejects(listPreparationJobs(CONFIG, mockPortal({ transformRpc })), error => {
      assert.ok(!error.message.includes(CONFIG.token)); return true;
    });
  }
});

test('invalid ticket model specifications or wrong get_job identity are refused', async () => {
  const variants = [
    job => { job.ticket.specifications.file.name = '../part.stl'; },
    job => { job.ticket.specifications.file.name = 'part.obj'; },
    job => { job.ticket.specifications.file.units = 'cm'; },
    job => { job.ticket.specifications.project.quantity = 0; },
    job => { job.ticket.model.size = MODEL.length + 1; },
    job => { job.ticket.specifications.production = null; },
  ];
  for (const mutate of variants) {
    const job = fixtureJob(); mutate(job);
    await assert.rejects(listPreparationJobs(CONFIG, mockPortal({ jobs: [job] })));
  }
  await assert.rejects(listPreparationJobs(CONFIG, mockPortal({ getJob: () => ({ ...fixtureJob(), id: '27749df7-8282-44de-83bf-30600f802a25' }) })), /different job/);
});

test('downloads private model without bearer token and preserves approved order metadata', async () => {
  const job = fixtureJob();
  const portal = mockPortal();
  const result = await downloadModel(CONFIG, job, portal);
  assert.equal(result.name, 'part.stl');
  assert.deepEqual(result.data, MODEL);
  assert.equal(result.order.requestedQuantity, 12);
  assert.equal(result.order.modelSha256, createHash('sha256').update(MODEL).digest('hex'));
  assert.equal(result.order.ticketFingerprint, buildOrderMetadata(job, CONFIG.portalUrl).ticketFingerprint);
  assert.deepEqual(portal.tools, ['get_job', 'model_download_link']);
  assert.equal(portal.calls.at(-1).options.headers, undefined);
});

test('ticket fingerprint is canonical, changes with approved snapshot, and metadata is detached', () => {
  const job = fixtureJob();
  const first = buildOrderMetadata(job, CONFIG.portalUrl);
  const reordered = structuredClone(job);
  reordered.ticket = Object.fromEntries(Object.entries(reordered.ticket).reverse());
  assert.equal(buildOrderMetadata(reordered, CONFIG.portalUrl).ticketFingerprint, first.ticketFingerprint);
  first.production.printType = 'fdm-standard';
  assert.equal(job.ticket.specifications.production.printType, 'resin');
  reordered.ticket.specifications.project.quantity++;
  assert.notEqual(buildOrderMetadata(reordered, CONFIG.portalUrl).ticketFingerprint, first.ticketFingerprint);
});

test('changed version, cancelled job and changed ticket are refused before issuing a model link', async () => {
  for (const mutate of [job => { job.version++; }, job => { job.status = 'cancelled'; }, job => { job.ticket.specifications.project.quantity++; }]) {
    const current = fixtureJob(); mutate(current);
    const portal = mockPortal({ getJob: () => current });
    await assert.rejects(downloadModel(CONFIG, fixtureJob(), portal), { status: 409 });
    assert.deepEqual(portal.tools, ['get_job']);
  }
});

test('foreign, unrestricted, duplicate-parameter or mismatched file download links are refused', async () => {
  const links = [
    { url: 'https://evil.example/api/intake?download=token.signature' },
    { url: 'http://printbylayr.example/api/intake?download=token.signature' },
    { url: `${CONFIG.portalUrl}/api/operations?download=token.signature` },
    { url: `${CONFIG.portalUrl}/api/intake?download=unsigned` },
    { url: `${CONFIG.portalUrl}/api/intake?download=token.signature&other=1` },
    { url: `${CONFIG.portalUrl}/api/intake?download=token.signature&download=token.signature` },
    { url: `${CONFIG.portalUrl}/api/intake?download=token.signature#fragment` },
    { url: `${CONFIG.portalUrl}/api/intake?download=token.signature`, file: 'other.stl' },
  ];
  for (const link of links) {
    const portal = mockPortal({ link: { file: 'part.stl', ...link } });
    await assert.rejects(downloadModel(CONFIG, fixtureJob(), portal), /model link/);
    assert.equal(portal.calls.length, 2, 'unexpected URL is never fetched');
  }
});

test('100 MiB local limit is explicit before portal calls, and declared oversized responses cancel', async () => {
  const large = fixtureJob();
  large.ticket.specifications.file.sizeBytes = large.ticket.model.size = MAX_MODEL_BYTES + 1;
  let fetched = false;
  await assert.rejects(downloadModel(CONFIG, large, { fetchImpl: async () => { fetched = true; } }), /100 MiB/);
  assert.equal(fetched, false);
  let cancelled = false;
  const portal = mockPortal({ modelResponse: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': String(MAX_MODEL_BYTES + 1) } }) });
  await assert.rejects(downloadModel(CONFIG, fixtureJob(), portal), { status: 413 });
  assert.equal(cancelled, true);
});

test('streamed overflow cancels the model reader; truncated downloads are rejected', async () => {
  let cancelled = false;
  const portal = mockPortal({ modelResponse: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MODEL.length + 1)); },
    cancel() { cancelled = true; },
  })) });
  await assert.rejects(downloadModel(CONFIG, fixtureJob(), portal), { status: 413 });
  assert.equal(cancelled, true);
  await assert.rejects(downloadModel(CONFIG, fixtureJob(), mockPortal({ modelResponse: new Response(MODEL.subarray(1)) })), /size differs/);
});

test('expired access requests reconnect and network failures do not expose secrets', async () => {
  await assert.rejects(listPreparationJobs(CONFIG, { fetchImpl: async () => new Response('secret error', { status: 401 }) }), error => error.status === 401 && /Reconnect/.test(error.message));
  await assert.rejects(listPreparationJobs(CONFIG, { fetchImpl: async () => { throw new Error(CONFIG.token); } }), error => !error.message.includes(CONFIG.token));
});

test('redirect responses are rejected for both MCP and model requests', async () => {
  await assert.rejects(listPreparationJobs(CONFIG, { fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }) }));
  await assert.rejects(downloadModel(CONFIG, fixtureJob(), mockPortal({ modelResponse: new Response(null, { status: 302, headers: { Location: 'https://evil.example' } }) })), /download was rejected/);
});
