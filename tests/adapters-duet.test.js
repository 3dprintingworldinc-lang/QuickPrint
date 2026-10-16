'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DuetAdapter } = require('../src/adapters/duet');

async function mockDuet(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = {
      method: req.method, url: new URL(req.url, 'http://localhost'),
      headers: req.headers, body: Buffer.concat(chunks)
    };
    calls.push(call);
    const reply = await handler(call) || {};
    res.writeHead(reply.status || 200, { 'Content-Type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, host: `http://127.0.0.1:${server.address().port}` };
}

const session = () => ({ body: { err: 0, sessionTimeout: 8000, sessionKey: 123456, boardType: 'duet3mb6hc100' } });

test('Duet modern object model reports actual progress, current file and mapped heater temperatures', async t => {
  let machineState = 'processing';
  const mock = await mockDuet(t, call => {
    if (call.url.pathname === '/rr_connect') return session();
    const result = {
      state: { status: machineState, currentTool: 7 },
      job: { file: { fileName: '0:/gcodes/job-123.gcode', size: 2000 }, filePosition: 500, lastFileName: 'old.gcode' },
      heat: { bedHeaters: [0], heaters: [{ current: 60, active: 60, state: 'active' }, { current: 205, active: 210, state: 'active' }] },
      tools: [{ number: 7, heaters: [1] }]
    }[call.url.searchParams.get('key')];
    return { body: { result } };
  });
  const adapter = new DuetAdapter({ host: mock.host, password: 'mock & password' });
  const status = await adapter.status();
  assert.equal(status.state, 'printing');
  assert.equal(status.progress, 25);
  assert.equal(status.currentFile, '0:/gcodes/job-123.gcode');
  assert.deepEqual(status.temperature, { nozzle: { actual: 205, target: 210 }, bed: { actual: 60, target: 60 } });
  assert.ok(Number.isFinite(Date.parse(status.observedAt)));
  assert.equal(mock.calls[0].url.pathname, '/rr_connect');
  assert.equal(mock.calls[0].url.searchParams.get('password'), 'mock & password');
  assert.equal(mock.calls[0].url.searchParams.get('sessionKey'), 'yes');
  assert.deepEqual(mock.calls.slice(1).map(call => call.url.searchParams.get('key')), ['state', 'job', 'heat', 'tools']);
  assert.ok(mock.calls.slice(1).every(call => call.headers['x-session-key'] === '123456' && !call.url.searchParams.has('password')));
  machineState = 'idle';
  const idle = await adapter.status();
  assert.equal(idle.state, 'idle');
  assert.equal(idle.outcome, undefined, 'idle does not prove a completed print');
  assert.equal(mock.calls.filter(call => call.url.pathname === '/rr_connect').length, 1);
});

test('Duet handles legacy unknown-request HTTP 500 and interprets fractionPrinted as percent', async t => {
  let printing = true;
  const mock = await mockDuet(t, call => {
    if (call.url.pathname === '/rr_connect') return { body: { err: 0, sessionTimeout: 8000 } };
    if (call.url.pathname === '/rr_model') return { status: 500 };
    if (call.url.pathname === '/rr_fileinfo') return { body: { err: 0, fileName: '/gcodes/job-123.gcode', size: 4000 } };
    if (call.url.searchParams.get('type') === '2') return { body: { status: 'P', tools: [{ number: 4, heaters: [2] }] } };
    return { body: {
      status: printing ? 'P' : 'I', currentTool: 4, fractionPrinted: printing ? 52.5 : 100,
      temps: {
        bed: { current: 59, active: 60, state: 2 }, current: [59, 30, 200], state: [2, 0, 2],
        tools: { active: [[205]], standby: [[150]] }
      }
    } };
  });
  const adapter = new DuetAdapter({ host: mock.host });
  const status = await adapter.status();
  assert.equal(status.state, 'printing');
  assert.equal(status.progress, 52.5);
  assert.equal(status.currentFile, '0:/gcodes/job-123.gcode');
  assert.deepEqual(status.temperature, { nozzle: { actual: 200, target: 205 }, bed: { actual: 59, target: 60 } });
  assert.equal(mock.calls[0].url.searchParams.get('password'), '', 'no guessed default password');
  assert.equal(mock.calls[0].url.searchParams.has('password'), true);
  printing = false;
  const idle = await adapter.status();
  assert.equal(idle.state, 'idle');
  assert.equal(idle.outcome, undefined);
  assert.equal(idle.currentFile, undefined);
  assert.equal(mock.calls.filter(call => call.url.pathname === '/rr_model').length, 1);
  assert.equal(mock.calls.filter(call => call.url.pathname === '/rr_fileinfo').length, 1);
});

test('Duet raw file upload and quoted G-code controls use standalone HTTP schemas', async t => {
  const mock = await mockDuet(t, call => {
    if (call.url.pathname === '/rr_connect') return session();
    if (call.url.pathname === '/rr_gcode') return { body: { buff: 0 } };
    return { body: { err: 0 } };
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-duet-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'fixture.gcode');
  const bytes = Buffer.from('; local mock fixture\nG28\n');
  await fs.writeFile(filePath, bytes);
  const adapter = new DuetAdapter({ host: mock.host });
  const uploaded = await adapter.upload({ filePath, fileName: 'job 123.gcode' });
  assert.deepEqual(uploaded, { remotePath: '0:/gcodes/job 123.gcode' });
  const upload = mock.calls[1];
  assert.equal(upload.url.pathname, '/rr_upload');
  assert.equal(upload.url.searchParams.get('name'), uploaded.remotePath);
  assert.equal(upload.method, 'POST');
  assert.equal(upload.headers['content-type'], 'application/octet-stream');
  assert.equal(Number(upload.headers['content-length']), bytes.length);
  assert.deepEqual(upload.body, bytes);
  assert.deepEqual(await adapter.start(uploaded), { acknowledged: true, remoteId: uploaded.remotePath });
  await adapter.pause();
  await adapter.resume();
  await adapter.cancel();
  assert.deepEqual(mock.calls.slice(2).map(call => call.url.searchParams.get('gcode')), [
    'M32 "0:/gcodes/job 123.gcode"', 'M25', 'M24', 'M0'
  ]);
  assert.ok(mock.calls.slice(2).every(call => call.method === 'GET' && call.url.pathname === '/rr_gcode'));
  await adapter.close();
  assert.equal(mock.calls.at(-1).url.pathname, '/rr_disconnect');
  assert.equal(mock.calls.at(-1).headers['x-session-key'], '123456');
});

test('Duet rejects firmware upload errors and G-code rejection instead of acknowledging', async t => {
  let command = { err: 1 };
  const mock = await mockDuet(t, call => call.url.pathname === '/rr_connect' ? session() : { body: command });
  const adapter = new DuetAdapter({ host: mock.host });
  await assert.rejects(adapter.start({ remotePath: '0:/gcodes/job.gcode' }), { code: 'RRF_COMMAND_REJECTED' });
  command = { err: 0 };
  await assert.rejects(adapter.resume(), { code: 'RRF_COMMAND_REJECTED' });
  command = { buff: -1 };
  await assert.rejects(adapter.pause(), { code: 'RRF_COMMAND_REJECTED' });
  assert.equal(mock.calls.filter(call => call.url.pathname === '/rr_gcode').length, 3);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-duet-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'fixture.gcode');
  await fs.writeFile(filePath, 'G28\n');
  command = { err: 1 };
  await assert.rejects(adapter.upload({ filePath }), { code: 'RRF_COMMAND_REJECTED' });
  assert.equal(mock.calls.filter(call => call.url.pathname === '/rr_upload').length, 1);
});

test('Duet authentication errors do not create a usable session or send commands', async t => {
  const mock = await mockDuet(t, () => ({ body: { err: 1 } }));
  const adapter = new DuetAdapter({ host: mock.host, password: 'configured-test-password' });
  await assert.rejects(adapter.start({ remotePath: '0:/gcodes/job.gcode' }), { status: 401, code: 'RRF_AUTH_FAILED' });
  await assert.rejects(adapter.pause(), { status: 401, code: 'RRF_AUTH_FAILED' });
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls.every(call => call.url.pathname === '/rr_connect'));
});

test('Duet does not fall back on object-model authentication or memory failures', async t => {
  let status = 503;
  const mock = await mockDuet(t, call => call.url.pathname === '/rr_connect' ? session() : { status });
  const adapter = new DuetAdapter({ host: mock.host });
  await assert.rejects(adapter.status(), { status: 503 });
  status = 401;
  await assert.rejects(adapter.status(), { status: 401 });
  assert.ok(!mock.calls.some(call => call.url.pathname === '/rr_status'));
});

test('Duet serializes operations and never retries an ambiguous command timeout', async t => {
  const commands = [];
  const mock = await mockDuet(t, async call => {
    if (call.url.pathname === '/rr_connect') return session();
    const command = call.url.searchParams.get('gcode');
    commands.push(command);
    if (command === 'M25') await new Promise(resolve => setTimeout(resolve, 150));
    return { body: { buff: 200 } };
  });
  const adapter = new DuetAdapter({ host: mock.host, timeoutMs: 100 });
  const paused = adapter.pause();
  const resumed = adapter.resume();
  await assert.rejects(paused, { status: 504, code: 'PRINTER_TIMEOUT' });
  assert.deepEqual(await resumed, { acknowledged: true });
  assert.deepEqual(commands, ['M25', 'M24']);
  assert.equal(mock.calls.filter(call => call.url.pathname === '/rr_connect').length, 2);
});

test('Duet rejects command-injection filenames before contacting the printer', async t => {
  const mock = await mockDuet(t, () => session());
  const adapter = new DuetAdapter({ host: mock.host });
  for (const remotePath of [
    '0:/gcodes/../config.g', '0:/gcodes/a"\nM112', '0:/gcodes/a;M112',
    '0:/sys/config.g', '0:/gcodes/subdirectory/file.gcode', 'http://example.invalid/a'
  ]) await assert.rejects(adapter.start({ remotePath }), { status: 400 });
  assert.equal(mock.calls.length, 0);
});

test('Duet refuses login redirects without forwarding its password or establishing a session', async t => {
  const destination = await mockDuet(t, () => session());
  const mock = await mockDuet(t, () => ({ status: 307, headers: { Location: `${destination.host}/rr_connect` } }));
  const adapter = new DuetAdapter({ host: mock.host, password: 'local-test-secret' });
  await assert.rejects(adapter.status(), { code: 'PRINTER_REDIRECT_REFUSED' });
  assert.equal(mock.calls.length, 1);
  assert.equal(destination.calls.length, 0);
});

test('Duet legacy file-info races omit the file marker and never infer terminal outcomes', async t => {
  const mock = await mockDuet(t, call => {
    if (call.url.pathname === '/rr_connect') return session();
    if (call.url.pathname === '/rr_model') return { status: 404 };
    if (call.url.pathname === '/rr_fileinfo') return { body: { err: 1 } };
    return { body: { status: 'P', currentTool: -1 } };
  });
  const status = await new DuetAdapter({ host: mock.host }).status();
  assert.equal(status.state, 'printing');
  assert.equal(status.currentFile, undefined);
  assert.equal(status.progress, undefined);
  assert.equal(status.outcome, undefined);
});
