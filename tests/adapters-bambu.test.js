'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const mqttPacket = require('mqtt-packet');
const { BambuAdapter, normalizeBambuStatus, buildStartPayload } = require('../src/adapters/bambu');
const { tlsOptions } = require('../src/adapters/tls');

let temporary, key, cert, fingerprint;
test.before(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-adapter-tls-'));
  const keyPath = path.join(temporary, 'key.pem');
  const certPath = path.join(temporary, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
  const der = Buffer.from(cert.toString().replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
  fingerprint = createHash('sha256').update(der).digest('hex');
});
test.after(async () => fs.rm(temporary, { recursive: true, force: true }));

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function broker(t, onPublish) {
  const packets = [];
  const sockets = new Set();
  const server = tls.createServer({ key, cert }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    const parser = mqttPacket.parser();
    socket.on('data', data => parser.parse(data));
    const send = packet => socket.write(mqttPacket.generate(packet));
    parser.on('error', () => socket.destroy());
    parser.on('packet', packet => {
      packets.push(packet);
      if (packet.cmd === 'connect') send({ cmd: 'connack', sessionPresent: false, returnCode: 0 });
      if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: [1] });
      if (packet.cmd === 'publish') {
        if (packet.qos === 1) send({ cmd: 'puback', messageId: packet.messageId });
        onPublish(JSON.parse(packet.payload.toString()), report => send({ cmd: 'publish', qos: 0, retain: false, topic: 'device/TESTSERIAL/report', payload: JSON.stringify({ print: report }) }));
      }
      if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    });
  });
  server.on('tlsClientError', () => {});
  const port = await listen(server);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { port, packets };
}
const config = port => ({ host: '127.0.0.1', port, serial: 'TESTSERIAL', accessCode: 'test-only-code', caCertificate: cert.toString(), model: 'P1S', timeoutMs: 500 });

test('Bambu MQTT uses authenticated QoS1 request/report topics and source telemetry', async t => {
  const mock = await broker(t, (payload, report) => {
    assert.equal(payload.pushing.command, 'pushall');
    report({ gcode_state: 'RUNNING', mc_percent: 37, gcode_file: 'unique-run.gcode.3mf', subtask_id: '1234', nozzle_temper: 210, nozzle_target_temper: 215, bed_temper: 60 });
  });
  const adapter = new BambuAdapter(config(mock.port));
  t.after(() => adapter.close());
  const status = await adapter.status();
  assert.equal(status.state, 'printing'); assert.equal(status.progress, 37);
  assert.equal(status.currentFile, 'unique-run.gcode.3mf'); assert.equal(status.remoteId, '1234');
  assert.equal(status.temperature.nozzle.actual, 210);
  assert.equal(status.outcome, undefined);
  const connect = mock.packets.find(packet => packet.cmd === 'connect');
  assert.equal(connect.username, 'bblp'); assert.equal(connect.clean, true);
  const publish = mock.packets.find(packet => packet.cmd === 'publish');
  assert.equal(publish.topic, 'device/TESTSERIAL/request'); assert.equal(publish.qos, 1); assert.equal(publish.retain, false);
});

test('Bambu print start has single-plate project schema and waits for device acknowledgment', async t => {
  let received;
  const mock = await broker(t, (payload, report) => { received = payload.print; report({ command: received.command, sequence_id: received.sequence_id, result: 'success' }); });
  const adapter = new BambuAdapter(config(mock.port)); t.after(() => adapter.close());
  const result = await adapter.start({ remotePath: 'job-1-run-2.gcode.3mf', jobId: 'job-1' });
  assert.equal(result.acknowledged, true); assert.equal(result.remoteId, received.subtask_id);
  assert.equal(result.remoteId, adapter.deriveRemoteId('job-1'));
  assert.equal(result.remoteId, new BambuAdapter(config(mock.port)).deriveRemoteId('job-1'));
  assert.notEqual(result.remoteId, adapter.deriveRemoteId('job-2'));
  assert.equal(received.command, 'project_file'); assert.equal(received.param, 'Metadata/plate_1.gcode');
  assert.equal(received.url, 'ftp://job-1-run-2.gcode.3mf'); assert.equal(received.file, 'job-1-run-2.gcode.3mf');
  assert.equal(received.use_ams, false); assert.equal(typeof received.bed_leveling, 'boolean');
  assert.ok(Number(received.subtask_id) > 0 && Number(received.subtask_id) < 2147483647);
});

test('Bambu PUBACK alone cannot acknowledge a print; command is never retried', async t => {
  const mock = await broker(t, () => {});
  const adapter = new BambuAdapter({ ...config(mock.port), timeoutMs: 150 }); t.after(() => adapter.close());
  await assert.rejects(adapter.start({ remotePath: 'run.gcode.3mf', jobId: 'test-persisted-run' }), error => error.code === 'BAMBU_COMMAND_UNCONFIRMED' && error.ambiguous === true);
  assert.equal(mock.packets.filter(packet => packet.cmd === 'publish').length, 1);
});

test('Bambu propagates explicit rejection and control commands use printer acknowledgments', async t => {
  const mock = await broker(t, (payload, report) => report({ command: payload.print.command, sequence_id: payload.print.sequence_id, result: payload.print.command === 'project_file' ? 'fail' : 'success' }));
  const adapter = new BambuAdapter(config(mock.port)); t.after(() => adapter.close());
  await assert.rejects(adapter.start({ remotePath: 'run.gcode.3mf', jobId: 'test-persisted-run' }), { code: 'BAMBU_START_REJECTED' });
  for (const method of ['pause', 'resume', 'cancel']) assert.equal((await adapter[method]()).acknowledged, true);
  assert.deepEqual(mock.packets.filter(packet => packet.cmd === 'publish').map(packet => JSON.parse(packet.payload).print.command), ['project_file', 'pause', 'resume', 'stop']);
});

test('Bambu telemetry distinguishes explicit finish from idle and preserves failed outcome', () => {
  assert.equal(normalizeBambuStatus({ gcode_state: 'IDLE', mc_percent: 100 }).outcome, undefined);
  assert.equal(normalizeBambuStatus({ gcode_state: 'FINISH', subtask_id: 42 }).outcome, 'completed');
  assert.equal(normalizeBambuStatus({ gcode_state: 'FAILED' }).outcome, 'failed');
  assert.equal(normalizeBambuStatus({ gcode_state: 'PAUSE' }).state, 'paused');
  assert.equal(normalizeBambuStatus({ gcode_state: 'RUNNING', gcode_file: 'Metadata/plate_1.gcode', subtask_name: 'unique-run' }).currentFile, 'unique-run');
  assert.throws(() => buildStartPayload('../bad.gcode.3mf', { sequenceId: '1', remoteId: '2' }));
});

test('Bambu requires explicit TLS trust and rejects unsupported dual-nozzle routing', async () => {
  const adapter = new BambuAdapter({ ...config(8883), caCertificate: '' });
  await assert.rejects(adapter.status(), { code: 'PRINTER_TLS_TRUST_REQUIRED' });
  const dual = new BambuAdapter({ ...config(8883), model: 'H2D' });
  await assert.rejects(dual.start({ remotePath: 'run.gcode.3mf', jobId: 'test-persisted-run' }), { code: 'BAMBU_MODEL_UNSUPPORTED' });
  for (const model of ['', 'A1', 'P2S', 'H2S']) {
    const unsupported = new BambuAdapter({ ...config(8883), model });
    await assert.rejects(unsupported.start({ remotePath: 'run.gcode.3mf', jobId: 'test-persisted-run' }), { code: 'BAMBU_MODEL_REQUIRED' });
  }
});

test('concurrent Bambu telemetry queries share one authenticated connection', async t => {
  const mock = await broker(t, (_payload, report) => setTimeout(() => report({ gcode_state: 'IDLE', mc_percent: 0 }), 10));
  const adapter = new BambuAdapter(config(mock.port)); t.after(() => adapter.close());
  const statuses = await Promise.all([adapter.status(), adapter.status(), adapter.status()]);
  assert.ok(statuses.every(status => status.state === 'idle'));
  assert.equal(mock.packets.filter(packet => packet.cmd === 'connect').length, 1);
  assert.equal(mock.packets.filter(packet => packet.cmd === 'subscribe').length, 1);
});

test('Bambu ignores another command sequence even when its device result is successful', async t => {
  const mock = await broker(t, (payload, report) => report({ command: 'project_file', sequence_id: String(Number(payload.print.sequence_id) + 1), result: 'success' }));
  const adapter = new BambuAdapter({ ...config(mock.port), timeoutMs: 150 }); t.after(() => adapter.close());
  await assert.rejects(adapter.start({ remotePath: 'run.gcode.3mf', jobId: 'test-persisted-run' }), { code: 'BAMBU_COMMAND_UNCONFIRMED' });
});

test('explicit fingerprint validates self-signed device before credentials; mismatch sends no MQTT data', async t => {
  const mock = await broker(t, (_payload, report) => report({ gcode_state: 'IDLE', mc_percent: 0 }));
  const wrong = new BambuAdapter({ ...config(mock.port), caCertificate: '', tlsFingerprint: '00'.repeat(32) });
  await assert.rejects(wrong.status(), { code: 'PRINTER_TLS_PIN_MISMATCH' });
  assert.equal(mock.packets.length, 0);
  const pinned = new BambuAdapter({ ...config(mock.port), caCertificate: '', tlsFingerprint: fingerprint });
  t.after(() => pinned.close());
  assert.equal((await pinned.status()).state, 'idle');
  const options = await tlsOptions({ host: '127.0.0.1', tlsFingerprint: fingerprint }, mock.port);
  assert.equal(options.rejectUnauthorized, true); assert.ok(options.ca);
});

test('Bambu upload uses implicit FTPS, encrypted data, and verifies remote SIZE', async t => {
  const commands = [];
  const sockets = new Set();
  let transferred = Buffer.alloc(0), controlSocket, dataServer;
  const server = tls.createServer({ key, cert }, socket => {
    controlSocket = socket; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.write('220 Test printer ready\r\n');
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const offset = buffer.indexOf('\r\n'); const line = buffer.slice(0, offset); buffer = buffer.slice(offset + 2);
        const [verb] = line.split(' '); commands.push(verb === 'PASS' ? 'PASS [redacted]' : line);
        if (verb === 'USER') socket.write('331 Password required\r\n');
        else if (verb === 'PASS') socket.write('230 Logged in\r\n');
        else if (verb === 'FEAT') socket.write('211 End\r\n');
        else if (verb === 'EPSV') {
          dataServer = tls.createServer({ key, cert }, data => {
            sockets.add(data); data.on('close', () => sockets.delete(data)); data.on('error', () => {});
            data.on('data', bytes => { transferred = Buffer.concat([transferred, bytes]); });
            data.on('end', () => { data.end(); controlSocket.write('226 Transfer complete\r\n'); });
          });
          dataServer.on('tlsClientError', () => {});
          const dataPort = await listen(dataServer);
          socket.write(`229 Entering Extended Passive Mode (|||${dataPort}|)\r\n`);
        } else if (verb === 'STOR') socket.write('150 Send data\r\n');
        else if (verb === 'SIZE') socket.write(`213 ${transferred.length}\r\n`);
        else if (verb === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('200 OK\r\n');
      }
    });
  });
  server.on('tlsClientError', () => {});
  const ftpPort = await listen(server);
  t.after(async () => { for (const socket of sockets) socket.destroy(); if (dataServer) await new Promise(resolve => dataServer.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  const filePath = path.join(temporary, 'artifact.gcode.3mf');
  const contents = Buffer.from('test-only artifact bytes'); await fs.writeFile(filePath, contents);
  const adapter = new BambuAdapter({ ...config(8883), ftpPort, timeoutMs: 2000 });
  const result = await adapter.upload({ filePath, fileName: 'job-run.gcode.3mf' });
  assert.deepEqual(transferred, contents); assert.equal(result.size, contents.length);
  assert.equal(result.remotePath, 'job-run.gcode.3mf');
  assert.ok(commands.includes('USER bblp')); assert.ok(commands.includes('PROT P'));
  assert.ok(commands.includes('STOR job-run.gcode.3mf')); assert.ok(commands.includes('SIZE job-run.gcode.3mf'));
});
