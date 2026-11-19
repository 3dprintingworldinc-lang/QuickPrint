'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { SDCPAdapter, normalizeSDCPStatus, CHUNK_BYTES, MAX_FILE_BYTES } = require('../src/adapters/sdcp');

// Synthetic identities and loopback servers only. Never discover a LAN device.
const BOARD = '0123456789abcdef';
const BRAND = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const idle = () => ({ CurrentStatus: [0], PrintInfo: { Status: 0, ErrorNumber: 0, Filename: '', TaskId: '' } });
const active = (name = 'order.goo', task = 'task-new', state = 3) => ({ CurrentStatus: [1], PrintInfo: { Status: state, ErrorNumber: 0, Filename: name, TaskId: task, CurrentLayer: 25, TotalLayer: 100 } });

async function fixture(t, options = {}) {
  const calls = [];
  const uploads = [];
  const sockets = new Set();
  const f = {
    status: idle(),
    attributes: { MachineName: 'Saturn 4 Ultra 16K', FirmwareVersion: 'V1.5.6', ProtocolVersion: 'V3.0.0', MainboardID: BOARD, Resolution: '15120x6230', XYZsize: '218.88x128.88x220', Capabilities: ['FILE_TRANSFER', 'PRINT_CONTROL', 'VIDEO_STREAM'], SupportFileType: ['GOO', 'CTB'] },
    calls, uploads,
    ack(client, message, ack = 0, changes = {}) {
      client.send(JSON.stringify({ Id: BRAND, Topic: `sdcp/response/${BOARD}`, Data: { Cmd: message.Data.Cmd, RequestID: message.Data.RequestID, MainboardID: BOARD, Data: { Ack: ack }, ...changes } }));
    },
    report(client, topic = 'status', changes = {}) {
      client.send(JSON.stringify({ Topic: `sdcp/${topic}/${BOARD}`, MainboardID: BOARD, [topic === 'status' ? 'Status' : 'Attributes']: topic === 'status' ? f.status : f.attributes, ...changes }));
    },
    transferError(code) {
      for (const client of sockets) client.send(JSON.stringify({ Id: BRAND, Topic: `sdcp/error/${BOARD}`, Data: { MainboardID: BOARD, Data: { ErrorCode: code } } }));
    }
  };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    uploads.push(call);
    const result = await options.onUpload?.(call, f) || {};
    if (result.hang) return;
    res.writeHead(result.status || 200, { 'Content-Type': 'application/json', ...result.headers });
    res.end(JSON.stringify(result.body ?? { code: '000000', messages: null, data: {}, success: true }));
  });
  const ws = new WebSocketServer({ server, path: '/websocket' });
  ws.on('connection', client => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('message', async data => {
      if (data.toString() === 'ping') { client.send('pong'); return; }
      const message = JSON.parse(data.toString());
      calls.push(message);
      assert.equal(message.Topic, `sdcp/request/${BOARD}`);
      assert.equal(message.Id, BRAND);
      assert.equal(message.Data.MainboardID, BOARD);
      assert.equal(message.Data.From, 0);
      assert.match(message.Data.RequestID, /^[a-f0-9]{32}$/);
      if (await options.onCommand?.(message, client, f) === false) return;
      f.ack(client, message);
      if (message.Data.Cmd === 0) f.report(client);
      if (message.Data.Cmd === 1) f.report(client, 'attributes');
    });
    if (options.initialReport) f.report(client);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  f.printer = { host: `http://127.0.0.1:${server.address().port}`, mainboardId: BOARD, brandId: BRAND, timeoutMs: options.timeoutMs || 500 };
  t.after(async () => {
    for (const client of sockets) client.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  f.adapter = new SDCPAdapter(f.printer);
  t.after(() => f.adapter.close());
  return f;
}

async function file(t, size = 128, name = 'order.goo') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-sdcp-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.alloc(size, 65));
  return filePath;
}

function multipart(call) {
  const boundary = call.headers['content-type'].match(/boundary=(.+)$/)[1];
  const parts = call.body.toString('latin1').split(`--${boundary}`);
  const values = {};
  for (const part of parts) {
    const match = part.match(/^\r\nContent-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:Content-Type: [^\r]+\r\n)?\r\n([\s\S]*)\r\n$/);
    if (match) values[match[1]] = match[2] ? { filename: match[2], body: Buffer.from(match[3], 'latin1') } : match[3];
  }
  return values;
}

test('SDCP reports fresh status and original firmware geometry without inferring completion from idle', async t => {
  const f = await fixture(t);
  f.status = active('Case.goo', 'actual-task');
  assert.deepEqual(await f.adapter.status(), { state: 'printing', observedAt: f.adapter.reports.status.observedAt, machineStatus: [1], printState: 3, currentFile: 'Case.goo', remoteId: 'actual-task', progress: 25, currentLayer: 25, totalLayers: 100 });
  const attrs = await f.adapter.attributes();
  assert.equal(attrs.XYZsize, '218.88x128.88x220');
  assert.equal(attrs.Resolution, '15120x6230');
  assert.deepEqual(attrs.SupportFileType, ['GOO', 'CTB']);
  f.status = idle();
  assert.equal((await f.adapter.status()).outcome, undefined);
  const requests = f.calls.map(call => call.Data.RequestID);
  assert.equal(new Set(requests).size, requests.length);
});

test('SDCP explicit terminal evidence requires task ID and file; active top-level status takes precedence', () => {
  const finished = { CurrentStatus: [0], PrintInfo: { Status: 9, Filename: 'order.goo', TaskId: 'task-a', CurrentLayer: 100, TotalLayer: 100, ErrorNumber: 0 } };
  assert.equal(normalizeSDCPStatus(finished).outcome, 'completed');
  assert.equal(normalizeSDCPStatus({ ...finished, PrintInfo: { ...finished.PrintInfo, TaskId: '' } }).outcome, undefined);
  assert.equal(normalizeSDCPStatus({ ...finished, CurrentStatus: [1] }).outcome, undefined);
  assert.equal(normalizeSDCPStatus({ CurrentStatus: [0], PrintInfo: { ...finished.PrintInfo, Status: 8 } }).outcome, 'cancelled');
  assert.equal(normalizeSDCPStatus(active('order.goo', 'task-a', 6)).state, 'paused');
  assert.throws(() => normalizeSDCPStatus({ CurrentStatus: 'idle' }), /invalid machine status/);
});

test('SDCP ignores mismatched board, brand, command and request acknowledgements', async t => {
  const f = await fixture(t, { onCommand(message, client, f) {
    f.ack(client, message, 7, { MainboardID: 'ffffffffffffffff' });
    f.ack(client, message, 7, { Cmd: message.Data.Cmd + 1 });
    f.ack(client, message, 7, { RequestID: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    client.send(JSON.stringify({ Id: 'other', Topic: `sdcp/response/${BOARD}`, Data: { ...message.Data, Data: { Ack: 7 } } }));
    f.report(client, 'status', { MainboardID: 'ffffffffffffffff', Status: active('wrong.goo', 'wrong') });
    return true;
  } });
  assert.equal((await f.adapter.status()).state, 'idle');
  assert.equal(f.calls.length, 1);
});

test('SDCP requires a fresh report as well as an ack and never substitutes cached status', async t => {
  const f = await fixture(t, { timeoutMs: 100, initialReport: true, onCommand(message, client, f) { f.ack(client, message); return false; } });
  await assert.rejects(f.adapter.status(), { code: 'SDCP_TELEMETRY_TIMEOUT' });
  assert.equal(f.calls.length, 1);
});

test('SDCP rejects explicit start failure and never retries the command', async t => {
  const f = await fixture(t, { onCommand(message, client, f) { if (message.Data.Cmd === 128) { f.ack(client, message, 5); return false; } } });
  await assert.rejects(f.adapter.start({ remotePath: 'order.goo' }), { code: 'SDCP_COMMAND_REJECTED', ack: 5 });
  assert.equal(f.calls.filter(call => call.Data.Cmd === 128).length, 1);
});

test('SDCP start requires a new matching-file task and returns its printer task ID', async t => {
  const f = await fixture(t, { onCommand(message, client, f) {
    if (message.Data.Cmd !== 128) return;
    assert.deepEqual(message.Data.Data, { Filename: 'order.goo', StartLayer: 0 });
    f.status = active('other.goo', 'other-task'); f.report(client);
    f.status = active('order.goo', 'previous-task'); f.report(client);
    f.status = active('order.goo', 'new-device-task');
    f.ack(client, message); f.report(client); return false;
  } });
  f.status = { CurrentStatus: [0], PrintInfo: { Status: 9, ErrorNumber: 0, Filename: 'order.goo', TaskId: 'previous-task' } };
  assert.deepEqual(await f.adapter.start({ remotePath: 'order.goo' }), { acknowledged: true, remoteId: 'new-device-task' });
  assert.equal(f.calls.filter(call => call.Data.Cmd === 128).length, 1);
});

test('SDCP ack-only or lost start is uncertain and is never retried', async t => {
  for (const drop of [false, true]) {
    const f = await fixture(t, { timeoutMs: 100, onCommand(message, client, f) { if (message.Data.Cmd === 128) { if (!drop) f.ack(client, message); return false; } } });
    await assert.rejects(f.adapter.start({ remotePath: 'order.goo' }), failure => failure.uncertain === true && ['SDCP_START_UNCERTAIN', 'SDCP_COMMAND_UNCERTAIN'].includes(failure.code));
    assert.equal(f.calls.filter(call => call.Data.Cmd === 128).length, 1);
  }
});

test('SDCP will not upload or start over an active print', async t => {
  const f = await fixture(t);
  f.status = active('operator.goo', 'operator-task');
  await assert.rejects(f.adapter.start({ remotePath: 'order.goo' }), { code: 'SDCP_PRINTER_BUSY' });
  await assert.rejects(f.adapter.upload({ filePath: await file(t), fileName: 'order.goo' }), { code: 'SDCP_PRINTER_BUSY' });
  assert.equal(f.uploads.length, 0);
  assert.equal(f.calls.some(call => call.Data.Cmd === 128), false);
});

test('SDCP uploads bounded 1 MiB multipart packets with a whole-file MD5 and one transfer UUID', async t => {
  const f = await fixture(t);
  const size = CHUNK_BYTES * 2 + 17;
  const filePath = await file(t, size);
  const result = await f.adapter.upload({ filePath, fileName: 'order.goo' });
  assert.equal(result.remotePath, 'order.goo');
  assert.equal(result.sizeBytes, size);
  assert.equal(result.md5, createHash('md5').update(Buffer.alloc(size, 65)).digest('hex'));
  assert.equal(f.uploads.length, 3);
  const chunks = f.uploads.map((call, index) => {
    assert.equal(call.method, 'POST'); assert.equal(call.url, '/uploadFile/upload');
    assert.equal(Number(call.headers['content-length']), call.body.length);
    const fields = multipart(call);
    assert.equal(fields.Check, '1'); assert.equal(fields['S-File-MD5'], result.md5);
    assert.equal(fields.Uuid, result.transferId); assert.equal(fields.TotalSize, String(size));
    assert.equal(fields.Offset, String(index * CHUNK_BYTES));
    assert.equal(fields.File.filename, 'order.goo'); assert.ok(fields.File.body.length <= CHUNK_BYTES);
    return fields.File.body;
  });
  assert.deepEqual(Buffer.concat(chunks), await fs.readFile(filePath));
  assert.equal(f.calls.some(call => call.Data.Cmd === 128 || call.Data.Cmd === 255), false, 'upload never starts or terminates a print/transfer');
});

test('SDCP packet rejection and redirect stop transfer without retrying or following redirects', async t => {
  for (const redirect of [false, true]) {
    const f = await fixture(t, { onUpload(call, f) { if (f.uploads.length === 2) return redirect ? { status: 307, headers: { Location: '/untrusted-target' } } : { body: { code: '111111', success: false, messages: [{ field: 'common_field', message: -2 }] } }; } });
    await assert.rejects(f.adapter.upload({ filePath: await file(t, CHUNK_BYTES * 2 + 1), fileName: 'order.goo' }), { code: redirect ? 'PRINTER_REDIRECT_REFUSED' : 'SDCP_UPLOAD_REJECTED' });
    assert.equal(f.uploads.length, 2);
    assert.equal(f.calls.some(call => call.Data.Cmd >= 128), false);
  }
});

test('SDCP interrupted or timed-out upload stops without a command retry or print start', async t => {
  for (const interrupted of [false, true]) {
    const f = await fixture(t, { async onUpload(call, f) {
      if (!interrupted) return { hang: true };
      f.transferError(1);
      await new Promise(resolve => setTimeout(resolve, 15));
      return {};
    } });
    f.adapter.printer.uploadTimeoutMs = 100;
    await assert.rejects(f.adapter.upload({ filePath: await file(t, CHUNK_BYTES + 1), fileName: 'order.goo' }), { code: interrupted ? 'SDCP_TRANSFER_REJECTED' : 'PRINTER_TIMEOUT' });
    assert.equal(f.uploads.length, 1);
    assert.equal(f.calls.some(call => call.Data.Cmd >= 128), false);
  }
});

test('SDCP socket loss after a start send is uncertain and never automatically reconnected or resent', async t => {
  const f = await fixture(t, { onCommand(message, client) { if (message.Data.Cmd === 128) { client.terminate(); return false; } } });
  await assert.rejects(f.adapter.start({ remotePath: 'order.goo' }), failure => failure.uncertain === true);
  assert.equal(f.calls.filter(call => call.Data.Cmd === 128).length, 1);
});

test('SDCP malformed acknowledgement is not success for a mutating command', async t => {
  const f = await fixture(t, { onCommand(message, client, f) { if (message.Data.Cmd === 129) { f.ack(client, message, '0'); return false; } } });
  f.status = active();
  await assert.rejects(f.adapter.pause(), { code: 'SDCP_COMMAND_UNCERTAIN', uncertain: true });
  assert.equal(f.calls.filter(call => call.Data.Cmd === 129).length, 1);
});

test('SDCP rejects unsafe names, unsupported capabilities/formats and files above 512 MiB', async t => {
  const f = await fixture(t);
  for (const name of ['../x.goo', 'bad"name.goo', 'bad\r\n.goo', 'part.gcode', 'part.goo/path']) {
    await assert.rejects(f.adapter.upload({ filePath: 'unused', fileName: name }));
  }
  assert.equal(f.calls.length, 0);
  const huge = await file(t, 1);
  await fs.truncate(huge, MAX_FILE_BYTES + 1);
  await assert.rejects(f.adapter.upload({ filePath: huge, fileName: 'huge.goo' }), { code: 'SDCP_FILE_SIZE_INVALID' });
  assert.equal(f.calls.length, 0);
  f.attributes.Capabilities = ['PRINT_CONTROL'];
  await assert.rejects(f.adapter.upload({ filePath: await file(t), fileName: 'order.goo' }), { code: 'SDCP_CAPABILITY_UNSUPPORTED' });
  f.attributes.SupportFileType = ['CTB'];
  await assert.rejects(f.adapter.start({ remotePath: 'order.goo' }), { code: 'SDCP_FORMAT_UNSUPPORTED' });
  assert.equal(f.uploads.length, 0);
});

test('SDCP pause, resume and stop use the documented commands with explicit ack0', async t => {
  const f = await fixture(t);
  f.status = active(); assert.deepEqual(await f.adapter.pause(), { acknowledged: true });
  f.status = active('order.goo', 'task-new', 6); assert.deepEqual(await f.adapter.resume(), { acknowledged: true });
  assert.deepEqual(await f.adapter.cancel(), { acknowledged: true });
  assert.deepEqual(f.calls.filter(call => call.Data.Cmd >= 128).map(call => ({ cmd: call.Data.Cmd, data: call.Data.Data })), [{ cmd: 129, data: {} }, { cmd: 131, data: {} }, { cmd: 130, data: {} }]);
});

test('SDCP control timeout is uncertain; missing print identity prevents any mutation', async t => {
  const f = await fixture(t, { timeoutMs: 100, onCommand(message) { if (message.Data.Cmd === 129) return false; } });
  f.status = active();
  await assert.rejects(f.adapter.pause(), { code: 'SDCP_COMMAND_UNCERTAIN', uncertain: true });
  assert.equal(f.calls.filter(call => call.Data.Cmd === 129).length, 1);
  f.status = active('order.goo', '');
  await assert.rejects(f.adapter.cancel(), { code: 'SDCP_PRINT_IDENTITY_UNKNOWN' });
  assert.equal(f.calls.some(call => call.Data.Cmd === 130), false);
  await f.adapter.close();
  await assert.rejects(f.adapter.status(), { code: 'SDCP_CLOSED' });
});

test('SDCP requires explicit device IDs and rejects credentials, TLS guesses and base paths', async () => {
  for (const printer of [{ host: '127.0.0.1' }, { host: 'https://127.0.0.1' }, { host: 'http://user:password@127.0.0.1' }, { host: 'http://127.0.0.1/base' }]) {
    const adapter = new SDCPAdapter({ mainboardId: BOARD, brandId: BRAND, ...printer, ...(printer.host === '127.0.0.1' ? { mainboardId: '' } : {}) });
    await assert.rejects(adapter.status());
    await adapter.close();
  }
});
