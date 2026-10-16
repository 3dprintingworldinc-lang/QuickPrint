'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OctoPrintAdapter } = require('../src/adapters/octoprint');
const { MoonrakerAdapter } = require('../src/adapters/moonraker');

async function mockPrinter(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    calls.push(call);
    const reply = handler(call) || {};
    res.writeHead(reply.status || 200, { 'Content-Type': 'application/json', ...reply.headers });
    res.end(reply.status === 204 ? undefined : JSON.stringify(reply.body ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { host: `http://127.0.0.1:${server.address().port}`, calls };
}

async function printFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-adapter-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'fixture.gcode');
  await fs.writeFile(filePath, '; test fixture only\nG28\n');
  return filePath;
}

function assertMultipart(call, fields) {
  assert.equal(Number(call.headers['content-length']), call.body.length);
  assert.match(call.headers['content-type'], /^multipart\/form-data; boundary=quickprint-/);
  assert.match(call.body.toString(), /name="file"; filename="run 123.gcode"/);
  assert.match(call.body.toString(), /; test fixture only\nG28\n/);
  for (const [name, value] of Object.entries(fields)) {
    assert.ok(call.body.includes(Buffer.from(`name="${name}"\r\n\r\n${value}\r\n`)), `${name} multipart value`);
  }
}

test('OctoPrint status reports source progress, file marker and temperatures without inferring completion', async t => {
  let operational = false;
  const mock = await mockPrinter(t, call => ({ body: call.url === '/api/job' ? {
    state: operational ? 'Operational' : 'Printing',
    job: { file: { name: 'part.gcode', path: 'orders/run-123.gcode' } },
    progress: { completion: operational ? 100 : 37.5 }
  } : {
    state: { text: operational ? 'Operational' : 'Printing', flags: { printing: !operational, operational: true, ready: operational } },
    temperature: { tool0: { actual: 204.2, target: 205 }, bed: { actual: 59, target: 60 } }
  } }));
  const adapter = new OctoPrintAdapter({ host: mock.host, apiKey: 'mock-octo-key' });
  const status = await adapter.status();
  assert.equal(status.state, 'printing');
  assert.equal(status.progress, 37.5);
  assert.equal(status.currentFile, 'orders/run-123.gcode');
  assert.deepEqual(status.temperature, { nozzle: { actual: 204.2, target: 205 }, bed: { actual: 59, target: 60 } });
  assert.ok(Number.isFinite(Date.parse(status.observedAt)));
  operational = true;
  const idle = await adapter.status();
  assert.equal(idle.state, 'idle');
  assert.equal(idle.progress, 100);
  assert.equal(idle.outcome, undefined, 'REST idle plus 100% is not unique proof of successful printing');
  assert.ok(mock.calls.every(call => call.headers['x-api-key'] === 'mock-octo-key'));
});

test('OctoPrint multipart upload never selects or starts; start and controls use documented commands', async t => {
  const mock = await mockPrinter(t, call => call.url === '/api/files/local' ? {
    status: 201, body: { files: { local: { name: 'run 123.gcode', path: 'orders/run 123.gcode' } }, done: true }
  } : { status: 204 });
  const adapter = new OctoPrintAdapter({ host: mock.host, apiKey: 'mock-octo-key' });
  const uploaded = await adapter.upload({ filePath: await printFile(t), fileName: 'run 123.gcode' });
  assert.deepEqual(uploaded, { remotePath: 'orders/run 123.gcode' });
  assertMultipart(mock.calls[0], { select: 'false', print: 'false' });
  assert.equal(mock.calls[0].method, 'POST');
  assert.deepEqual(await adapter.start(uploaded), { acknowledged: true, remoteId: uploaded.remotePath });
  await adapter.pause();
  await adapter.resume();
  await adapter.cancel();
  assert.equal(mock.calls[1].url, '/api/files/local/orders/run%20123.gcode');
  assert.deepEqual(mock.calls.slice(1).map(call => JSON.parse(call.body)), [
    { command: 'select', print: true },
    { command: 'pause', action: 'pause' },
    { command: 'pause', action: 'resume' },
    { command: 'cancel' }
  ]);
  assert.ok(mock.calls.slice(2).every(call => call.url === '/api/job'));
  assert.ok(mock.calls.every(call => call.method === 'POST' && call.headers['x-api-key'] === 'mock-octo-key'));
});

test('OctoPrint disconnected status handles its documented 409 and does not fabricate progress', async t => {
  const mock = await mockPrinter(t, call => call.url === '/api/printer'
    ? { status: 409, body: { error: 'Printer is not operational' } }
    : { body: { state: 'Offline', job: { file: null }, progress: { completion: null } } });
  const status = await new OctoPrintAdapter({ host: mock.host }).status();
  assert.equal(status.state, 'offline');
  assert.equal(status.progress, undefined);
  assert.equal(status.currentFile, undefined);
});

test('OctoPrint failed starts propagate a rejection with no automatic retry', async t => {
  const mock = await mockPrinter(t, () => ({ status: 409, body: { error: 'Printer is busy' } }));
  await assert.rejects(new OctoPrintAdapter({ host: mock.host }).start({ remotePath: 'run.gcode' }), { status: 409 });
  assert.equal(mock.calls.length, 1);
});

test('Moonraker status maps firmware states and explicit job outcomes', async t => {
  let printState = 'printing';
  let includeProgress = true;
  const mock = await mockPrinter(t, () => ({ body: { result: { status: {
    print_stats: { state: printState, filename: 'orders/run-123.gcode', message: '' },
    webhooks: { state: 'ready' }, virtual_sdcard: includeProgress ? { progress: 0.425 } : {},
    extruder: { temperature: 200.5, target: 200 }, heater_bed: { temperature: 60, target: 60 }
  } } } }));
  const adapter = new MoonrakerAdapter({ host: mock.host, apiKey: 'mock-moon-key' });
  const status = await adapter.status();
  assert.equal(status.state, 'printing');
  assert.equal(status.progress, 42.5);
  assert.equal(status.currentFile, 'orders/run-123.gcode');
  assert.equal(status.outcome, undefined);
  assert.deepEqual(status.temperature, { nozzle: { actual: 200.5, target: 200 }, bed: { actual: 60, target: 60 } });
  const query = new URL(mock.calls[0].url, mock.host);
  for (const object of ['print_stats', 'virtual_sdcard', 'webhooks', 'extruder', 'heater_bed']) assert.ok(query.searchParams.has(object));
  for (const [firmware, state, outcome] of [
    ['paused', 'paused', undefined], ['complete', 'idle', 'completed'],
    ['cancelled', 'idle', 'cancelled'], ['error', 'error', 'failed'], ['standby', 'idle', undefined]
  ]) {
    printState = firmware;
    const next = await adapter.status();
    assert.equal(next.state, state);
    assert.equal(next.outcome, outcome);
  }
  includeProgress = false;
  assert.equal((await adapter.status()).progress, undefined);
  printState = '__proto__';
  const unexpected = await adapter.status();
  assert.equal(unexpected.state, 'unknown');
  assert.equal(unexpected.outcome, undefined);
  assert.ok(mock.calls.every(call => call.headers['x-api-key'] === 'mock-moon-key'));
});

test('Moonraker multipart upload targets gcodes without printing; start and controls use HTTP API', async t => {
  const mock = await mockPrinter(t, call => ({ body: { result: call.url === '/server/files/upload'
    ? { item: { root: 'gcodes', path: 'orders/run 123.gcode' }, print_started: false, print_queued: false }
    : 'ok' } }));
  const adapter = new MoonrakerAdapter({ host: mock.host, apiKey: 'mock-moon-key' });
  const uploaded = await adapter.upload({ filePath: await printFile(t), fileName: 'run 123.gcode' });
  assert.deepEqual(uploaded, { remotePath: 'orders/run 123.gcode' });
  assertMultipart(mock.calls[0], { root: 'gcodes', print: 'false' });
  assert.deepEqual(await adapter.start(uploaded), { acknowledged: true, remoteId: uploaded.remotePath });
  await adapter.pause();
  await adapter.resume();
  await adapter.cancel();
  assert.deepEqual(mock.calls.map(call => call.url), [
    '/server/files/upload', '/printer/print/start?filename=orders%2Frun%20123.gcode',
    '/printer/print/pause', '/printer/print/resume', '/printer/print/cancel'
  ]);
  assert.ok(mock.calls.every(call => call.method === 'POST' && call.headers['x-api-key'] === 'mock-moon-key'));
});

test('Moonraker refuses success responses containing error envelopes or missing command acknowledgements', async t => {
  let body = { error: { code: 400, message: 'Printer is busy' } };
  const mock = await mockPrinter(t, () => ({ body }));
  const adapter = new MoonrakerAdapter({ host: mock.host });
  await assert.rejects(adapter.start({ remotePath: 'run.gcode' }), { code: 'PRINTER_RESPONSE_INVALID' });
  body = { result: null };
  await assert.rejects(adapter.start({ remotePath: 'run.gcode' }), { code: 'PRINTER_RESPONSE_INVALID' });
  assert.equal(mock.calls.length, 2, 'one request per explicit call, with no retries');
});

test('HTTP adapters refuse redirects without sending printer API credentials to another endpoint', async t => {
  const destination = await mockPrinter(t, () => ({ body: { result: 'ok' } }));
  const origin = await mockPrinter(t, () => ({ status: 307, headers: { Location: `${destination.host}/capture` } }));
  for (const Adapter of [OctoPrintAdapter, MoonrakerAdapter]) {
    const adapter = new Adapter({ host: origin.host, apiKey: 'mock-secret-stays-at-origin' });
    await assert.rejects(adapter.start({ remotePath: 'run.gcode' }), { code: 'PRINTER_REDIRECT_REFUSED' });
  }
  assert.equal(origin.calls.length, 2);
  assert.ok(origin.calls.every(call => call.headers['x-api-key'] === 'mock-secret-stays-at-origin'));
  assert.equal(destination.calls.length, 0);
});

test('remote file paths cannot escape the configured endpoint or inject query arguments', async t => {
  const mock = await mockPrinter(t, call => call.url.startsWith('/printer') ? { body: { result: 'ok' } } : { status: 204 });
  for (const Adapter of [OctoPrintAdapter, MoonrakerAdapter]) {
    const adapter = new Adapter({ host: mock.host });
    for (const remotePath of ['../x.gcode', '/tmp/x.gcode', 'https://example.invalid/x', 'a\\x.gcode', 'a\0.gcode']) {
      await assert.rejects(adapter.start({ remotePath }), { status: 400 });
    }
    await adapter.start({ remotePath: 'folder/a?print=false#x.gcode' });
  }
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0].url, '/api/files/local/folder/a%3Fprint%3Dfalse%23x.gcode');
  assert.equal(mock.calls[1].url, '/printer/print/start?filename=folder%2Fa%3Fprint%3Dfalse%23x.gcode');
});
