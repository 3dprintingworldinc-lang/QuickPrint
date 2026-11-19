'use strict';

// Wire contract: CBDtech SDCP v3, status/attributes, Cmd 0/1/128-131 and
// the mainboard HTTP upload interface. Never retries a mutating request.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { adapterError, endpoint, request, safeFileName } = require('./http');

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const capabilities = Object.freeze({ upload: true, start: true, pause: true, resume: true, cancel: true, formats: ['goo', 'ctb'], discovery: false });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f]/.test(value);
const error = (message, status = 502, code = 'SDCP_RESPONSE_INVALID') => adapterError(message, status, code);

function filename(value) {
  const name = safeFileName(value);
  // Do not silently rename an artifact or admit quoted multipart parameters.
  if (name !== value || !/\.(goo|ctb)$/i.test(name)) throw error('SDCP requires an ASCII .goo or .ctb filename without directory separators.', 400, 'SDCP_FILE_NAME_INVALID');
  return name;
}

function normalizeSDCPStatus(status, observedAt = new Date().toISOString()) {
  if (!status || !Array.isArray(status.CurrentStatus) || !status.CurrentStatus.length || status.CurrentStatus.some(n => !Number.isInteger(n) || n < 0 || n > 4)) {
    throw error('SDCP returned invalid machine status.');
  }
  const info = status.PrintInfo;
  if (!info || typeof info !== 'object' || Array.isArray(info) || !Number.isInteger(info.Status) || info.Status < 0 || info.Status > 10 || !Number.isInteger(info.ErrorNumber) || info.ErrorNumber < 0) throw error('SDCP returned invalid print status.');
  const printing = status.CurrentStatus.includes(1);
  const substate = Number.isInteger(info.Status) ? info.Status : undefined;
  let state = printing ? (substate === 6 ? 'paused' : 'printing') : status.CurrentStatus.length === 1 && status.CurrentStatus[0] === 0 ? 'idle' : 'unknown';
  if (Number.isInteger(info.ErrorNumber) && info.ErrorNumber > 0) state = 'error';
  const result = { state, observedAt, machineStatus: [...status.CurrentStatus] };
  if (substate !== undefined) result.printState = substate;
  if (identity(info.Filename)) result.currentFile = info.Filename;
  if (identity(info.TaskId)) result.remoteId = info.TaskId;
  if (finite(info.CurrentLayer) && finite(info.TotalLayer) && info.TotalLayer > 0) {
    result.progress = Math.min(100, Math.max(0, info.CurrentLayer / info.TotalLayer * 100));
    result.currentLayer = info.CurrentLayer;
    result.totalLayers = info.TotalLayer;
  }
  // The sub-status persists after a run. Only expose a terminal outcome with
  // both printer identities; the service must still match it to its run.
  if (['idle', 'error'].includes(state) && result.remoteId && result.currentFile) {
    if (state === 'error') result.outcome = 'failed';
    else if (substate === 9) result.outcome = 'completed';
    else if (substate === 8) result.outcome = 'cancelled';
  }
  if (Number.isInteger(info.ErrorNumber) && info.ErrorNumber > 0) result.message = `Printer reports SDCP print error ${info.ErrorNumber}. Inspect the printer.`;
  else if (state === 'unknown') result.message = 'Printer is transferring a file, testing, or reporting an unsupported state.';
  return result;
}

function multipartChunk(chunk, name, fields) {
  const boundary = 'quickprint-sdcp-' + randomBytes(18).toString('hex');
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="File"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(chunk, Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } };
}

class SDCPAdapter {
  constructor(printer) {
    this.printer = { ...printer };
    this.capabilities = capabilities;
    this.timeout = Math.min(30000, Math.max(100, Number(printer.timeoutMs) || 10000));
    this.client = null;
    this.connecting = null;
    this.closed = false;
    this.pending = new Map();
    this.events = new EventEmitter();
    this.sequence = 0;
    this.reports = {};
    this.mutating = false;
  }

  _configuration() {
    if (!/^[a-fA-F0-9]{16}$/.test(String(this.printer.mainboardId || ''))) throw error('Enter the 16-character SDCP mainboard ID from this printer discovery record.', 400, 'SDCP_MAINBOARD_ID_REQUIRED');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(this.printer.brandId || ''))) throw error('Enter the SDCP discovery Id (brand identifier).', 400, 'SDCP_BRAND_ID_REQUIRED');
    const url = endpoint(this.printer);
    if (url.protocol !== 'http:' || !['', '/'].includes(url.pathname)) throw error('SDCP v3 requires a plain HTTP LAN address without a base path.', 400, 'SDCP_ADDRESS_INVALID');
    if (!url.port && !this.printer.port) url.port = '3030';
    const ws = new URL(url.href);
    ws.protocol = 'ws:';
    ws.pathname = '/websocket';
    this.httpPrinter = { ...this.printer, host: url.origin, port: Number(url.port) || 80 };
    return ws.href;
  }

  async _connect() {
    if (this.closed) throw error('SDCP connection is closed.', 409, 'SDCP_CLOSED');
    if (this.client?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    const url = this._configuration();
    const client = new WebSocket(url, { handshakeTimeout: this.timeout, maxPayload: MAX_MESSAGE_BYTES, followRedirects: false, perMessageDeflate: false });
    this.client = client;
    this.connecting = new Promise((resolve, reject) => {
      let opened = false;
      let heartbeat;
      const timer = setTimeout(() => { reject(error('SDCP WebSocket connection timed out.', 504, 'SDCP_TIMEOUT')); client.terminate(); }, this.timeout);
      client.once('open', () => {
        if (this.closed || this.client !== client) { clearTimeout(timer); reject(error('SDCP connection was closed.', 409, 'SDCP_CLOSED')); client.terminate(); return; }
        opened = true;
        clearTimeout(timer);
        heartbeat = setInterval(() => { if (client.readyState === WebSocket.OPEN) client.send('ping', () => {}); }, 20000);
        heartbeat.unref();
        this.heartbeat = heartbeat;
        resolve();
      });
      client.on('message', (data, binary) => { if (!binary && this.client === client) this._message(data); });
      client.on('error', () => {
        clearTimeout(timer);
        if (!opened) reject(error('Cannot reach the configured SDCP printer.', 502, 'SDCP_CONNECTION_FAILED'));
        if (this.client === client) this._fault(error('SDCP connection failed. Check the printer before retrying a command.', 502, 'SDCP_CONNECTION_LOST'));
      });
      client.once('close', () => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        if (this.heartbeat === heartbeat) this.heartbeat = null;
        if (!opened) reject(error('SDCP connection closed before opening.', 502, 'SDCP_CONNECTION_FAILED'));
        if (this.client === client) {
          this._fault(error('SDCP connection closed. Check the printer before retrying a command.', 502, 'SDCP_CONNECTION_LOST'));
          this.client = null;
        }
      });
    });
    try { await this.connecting; } finally { this.connecting = null; }
  }

  _fault(failure) {
    for (const pending of [...this.pending.values()]) pending.finish(pending.mutating ? Object.assign(error('SDCP command result is uncertain. Inspect the printer; do not automatically retry.', 504, 'SDCP_COMMAND_UNCERTAIN'), { uncertain: true }) : failure);
    this.events.emit('fault', failure);
  }

  _message(data) {
    if (data.length > MAX_MESSAGE_BYTES || data.toString() === 'pong') return;
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (!message || typeof message !== 'object' || (message.Id !== undefined && message.Id !== this.printer.brandId)) return;
    const board = this.printer.mainboardId;
    if (message.Topic === `sdcp/response/${board}`) {
      const envelope = message.Data;
      if (message.Id !== this.printer.brandId || !envelope || envelope.MainboardID !== board) return;
      const pending = this.pending.get(envelope.RequestID);
      if (!pending || envelope.Cmd !== pending.cmd) return;
      const ack = envelope.Data?.Ack;
      if (!Number.isInteger(ack)) pending.finish(pending.mutating ? Object.assign(error('SDCP returned an invalid command acknowledgement. Inspect the printer before retrying.', 504, 'SDCP_COMMAND_UNCERTAIN'), { uncertain: true }) : error('SDCP response did not contain a numeric acknowledgement.'));
      else if (ack !== 0) pending.finish(Object.assign(error(`Printer rejected SDCP command ${pending.cmd} (Ack ${ack}).`, 409, 'SDCP_COMMAND_REJECTED'), { ack, cmd: pending.cmd }));
      else pending.finish(null, envelope.Data);
      return;
    }
    if (message.MainboardID === board) {
      for (const [topic, key] of [['status', 'Status'], ['attributes', 'Attributes']]) {
        if (message.Topic !== `sdcp/${topic}/${board}` || !message[key] || typeof message[key] !== 'object') continue;
        if (topic === 'attributes' && message[key].MainboardID !== board) return;
        const report = { data: message[key], sequence: ++this.sequence, observedAt: new Date().toISOString() };
        this.reports[topic] = report;
        this.events.emit(topic, report);
        return;
      }
    }
    // The documented transfer-error notification carries no transfer UUID.
    // Fail an active upload conservatively; do not associate it with a run.
    if (message.Topic === `sdcp/error/${board}` && message.Data?.MainboardID === board && Number.isInteger(message.Data?.Data?.ErrorCode)) {
      this.events.emit('transferError', error(`Printer reported SDCP transfer error ${message.Data.Data.ErrorCode}.`, 502, 'SDCP_TRANSFER_REJECTED'));
    }
  }

  async _command(cmd, data = {}, mutating = false) {
    await this._connect();
    const requestId = randomUUID().replace(/-/g, '');
    const payload = { Id: this.printer.brandId, Data: { Cmd: cmd, Data: data, RequestID: requestId, MainboardID: this.printer.mainboardId, TimeStamp: Math.floor(Date.now() / 1000), From: 0 }, Topic: `sdcp/request/${this.printer.mainboardId}` };
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (failure, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pending.delete(requestId);
        if (failure) reject(failure); else resolve(result);
      };
      const timer = setTimeout(() => finish(mutating ? Object.assign(error('SDCP command acknowledgement timed out. Inspect the printer; do not automatically retry.', 504, 'SDCP_COMMAND_UNCERTAIN'), { uncertain: true }) : error('SDCP command acknowledgement timed out.', 504, 'SDCP_TIMEOUT')), this.timeout);
      this.pending.set(requestId, { cmd, mutating, finish });
      this.client.send(JSON.stringify(payload), failure => {
        if (failure) finish(mutating ? Object.assign(error('SDCP command send failed with an uncertain result. Inspect the printer.', 504, 'SDCP_COMMAND_UNCERTAIN'), { uncertain: true }) : error('Cannot send the SDCP request.', 502, 'SDCP_CONNECTION_LOST'));
      });
    });
  }

  _waitForReport(topic, after, predicate = () => true) {
    let finish;
    const promise = new Promise((resolve, reject) => {
      const listener = report => {
        if (report.sequence <= after) return;
        try { if (predicate(report)) finish(null, report); } catch (failure) { finish(failure); }
      };
      const fault = failure => finish(failure);
      const timer = setTimeout(() => finish(error('SDCP did not report fresh printer telemetry.', 504, 'SDCP_TELEMETRY_TIMEOUT')), this.timeout);
      let finished = false;
      finish = (failure, report) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.events.off(topic, listener);
        this.events.off('fault', fault);
        if (failure) reject(failure); else resolve(report);
      };
      this.events.on(topic, listener);
      this.events.on('fault', fault);
    });
    return { promise, cancel: () => finish(null) };
  }

  async _refresh(topic, cmd) {
    await this._connect();
    const waiter = this._waitForReport(topic, this.sequence);
    try {
      const [, report] = await Promise.all([this._command(cmd), waiter.promise]);
      return report;
    } finally { waiter.cancel(); }
  }

  async status() {
    const report = await this._refresh('status', 0);
    return normalizeSDCPStatus(report.data, report.observedAt);
  }

  async attributes() {
    const report = await this._refresh('attributes', 1);
    if (report.data.ProtocolVersion !== 'V3.0.0' || !Array.isArray(report.data.Capabilities) || !Array.isArray(report.data.SupportFileType)) throw error('Printer did not report SDCP v3 capabilities and file formats.');
    return { ...report.data, observedAt: report.observedAt };
  }

  async _requireCapability(capability, name) {
    const attributes = await this.attributes();
    if (!attributes.Capabilities.includes(capability)) throw error(`Printer does not advertise SDCP ${capability}.`, 409, 'SDCP_CAPABILITY_UNSUPPORTED');
    if (name && !attributes.SupportFileType.some(type => typeof type === 'string' && type.toLowerCase() === path.extname(name).slice(1).toLowerCase())) throw error('Printer does not advertise support for this resin file format.', 409, 'SDCP_FORMAT_UNSUPPORTED');
    return attributes;
  }

  async _mutate(operation) {
    if (this.mutating) throw error('Another SDCP transfer or print control is in progress.', 409, 'SDCP_BUSY');
    this.mutating = true;
    try { return await operation(); } finally { this.mutating = false; }
  }

  async upload({ filePath, fileName }) {
    const name = filename(fileName || path.basename(filePath));
    return this._mutate(async () => {
      const handle = await fs.promises.open(filePath, 'r');
      let transferFailure;
      const onTransferError = failure => { transferFailure = failure; };
      try {
        const initial = await handle.stat();
        if (!initial.isFile() || initial.size <= 0 || initial.size > MAX_FILE_BYTES) throw error('SDCP upload requires a nonempty file no larger than 512 MiB.', 400, 'SDCP_FILE_SIZE_INVALID');
        await this._requireCapability('FILE_TRANSFER', name);
        if ((await this.status()).state !== 'idle') throw error('Printer must be idle before an SDCP upload.', 409, 'SDCP_PRINTER_BUSY');
        const digest = createHash('md5');
        for await (const chunk of handle.createReadStream({ start: 0, end: initial.size - 1, autoClose: false })) digest.update(chunk);
        const md5 = digest.digest('hex');
        const stable = stat => stat.size === initial.size && stat.mtimeMs === initial.mtimeMs && stat.ctimeMs === initial.ctimeMs;
        if (!stable(await handle.stat())) throw error('Print artifact changed before transfer.', 409, 'SDCP_ARTIFACT_CHANGED');
        const uuid = randomUUID().replace(/-/g, '');
        const deadline = Date.now() + Math.min(120000, Math.max(100, Number(this.printer.uploadTimeoutMs) || 120000));
        const sentDigest = createHash('md5');
        this.events.on('transferError', onTransferError);
        this.events.on('fault', onTransferError);
        for (let offset = 0; offset < initial.size; offset += CHUNK_BYTES) {
          if (this.closed) throw error('SDCP connection was closed during upload.', 409, 'SDCP_CLOSED');
          if (transferFailure) throw transferFailure;
          if (Date.now() >= deadline) throw error('SDCP transfer deadline expired. Inspect the partial transfer before retrying.', 504, 'SDCP_UPLOAD_TIMEOUT');
          const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, initial.size - offset));
          let read = 0;
          while (read < chunk.length) {
            const result = await handle.read(chunk, read, chunk.length - read, offset + read);
            if (!result.bytesRead) throw error('Print artifact was truncated during transfer.', 409, 'SDCP_ARTIFACT_CHANGED');
            read += result.bytesRead;
          }
          sentDigest.update(chunk);
          const multipart = multipartChunk(chunk, name, { 'S-File-MD5': md5, Check: '1', Offset: offset, Uuid: uuid, TotalSize: initial.size });
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw error('SDCP transfer deadline expired. Inspect the partial transfer before retrying.', 504, 'SDCP_UPLOAD_TIMEOUT');
          const response = await request({ ...this.httpPrinter, timeoutMs: remaining }, { path: '/uploadFile/upload', method: 'POST', ...multipart });
          if (response.body?.success !== true || response.body?.code !== '000000') throw error('Printer did not accept the SDCP upload packet. Inspect the partial transfer before retrying.', 502, 'SDCP_UPLOAD_REJECTED');
          if (transferFailure) throw transferFailure;
        }
        if (sentDigest.digest('hex') !== md5 || !stable(await handle.stat())) throw error('Print artifact changed during transfer. Do not start the uploaded file.', 409, 'SDCP_ARTIFACT_CHANGED');
        return { remotePath: name, md5, sizeBytes: initial.size, transferId: uuid };
      } finally {
        this.events.off('transferError', onTransferError);
        this.events.off('fault', onTransferError);
        await handle.close();
      }
    });
  }

  async start({ remotePath }) {
    const name = filename(remotePath);
    return this._mutate(async () => {
      await this._requireCapability('PRINT_CONTROL', name);
      const before = await this.status();
      if (before.state !== 'idle') throw error('Printer must be idle before SDCP start.', 409, 'SDCP_PRINTER_BUSY');
      const waiter = this._waitForReport('status', this.sequence, report => {
        const status = normalizeSDCPStatus(report.data, report.observedAt);
        return ['printing', 'paused'].includes(status.state) && status.remoteId && status.remoteId !== before.remoteId && status.currentFile === name;
      });
      try {
        const [, report] = await Promise.all([this._command(128, { Filename: name, StartLayer: 0 }, true), waiter.promise]);
        return { acknowledged: true, remoteId: report.data.PrintInfo.TaskId };
      } catch (failure) {
        if (failure.code === 'SDCP_TELEMETRY_TIMEOUT' || failure.code === 'SDCP_CONNECTION_LOST') throw Object.assign(error('SDCP start result is uncertain. Acknowledgement alone does not identify a new print; inspect the printer before retrying.', 504, 'SDCP_START_UNCERTAIN'), { uncertain: true });
        throw failure;
      } finally { waiter.cancel(); }
    });
  }

  async _control(cmd, allowed) {
    return this._mutate(async () => {
      await this._requireCapability('PRINT_CONTROL');
      const status = await this.status();
      if (!allowed.includes(status.state) || !status.remoteId || !status.currentFile) throw error('Fresh telemetry does not identify an active print for this control.', 409, 'SDCP_PRINT_IDENTITY_UNKNOWN');
      await this._command(cmd, {}, true);
      return { acknowledged: true };
    });
  }

  async pause() { return this._control(129, ['printing']); }
  async resume() { return this._control(131, ['paused']); }
  async cancel() { return this._control(130, ['printing', 'paused']); }

  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    this._fault(error('SDCP connection was closed.', 409, 'SDCP_CLOSED'));
    const client = this.client;
    this.client = null;
    if (client && client.readyState !== WebSocket.CLOSED) client.terminate();
  }
}

module.exports = { SDCPAdapter, normalizeSDCPStatus, MAX_FILE_BYTES, CHUNK_BYTES };
