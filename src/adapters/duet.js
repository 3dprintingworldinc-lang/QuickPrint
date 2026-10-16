'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { request, safeFileName, adapterError } = require('./http');

// Standalone RepRapFirmware HTTP API, not the Duet Software Framework SBC API.
// Protocol: https://github.com/Duet3D/RepRapFirmware/wiki/HTTP-requests
const MODERN_STATES = new Map([
  ['idle', 'idle'], ['processing', 'printing'], ['paused', 'paused'],
  ['pausing', 'printing'], ['resuming', 'printing'], ['cancelling', 'printing'],
  ['halted', 'error'], ['off', 'offline']
]);
const LEGACY_STATES = new Map([
  ['I', 'idle'], ['P', 'printing'], ['S', 'paused'], ['D', 'printing'],
  ['R', 'printing'], ['A', 'printing'], ['H', 'error'], ['O', 'offline']
]);

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }

function ensureObject(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw adapterError(`RepRapFirmware returned an invalid ${operation} response.`, 502, 'RRF_RESPONSE_INVALID');
  }
  return value;
}

function ensureSuccess(value, operation) {
  ensureObject(value, operation);
  if (value.err !== 0) {
    throw adapterError(`RepRapFirmware did not accept the ${operation}.`, 502, 'RRF_COMMAND_REJECTED');
  }
  return value;
}

function remotePath(value) {
  const prefix = '0:/gcodes/';
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw adapterError('Duet print files must be uploaded to 0:/gcodes/.', 400, 'INVALID_FILE_NAME');
  }
  const name = value.slice(prefix.length);
  if (!name || safeFileName(name) !== name) {
    throw adapterError('The Duet print filename is invalid.', 400, 'INVALID_FILE_NAME');
  }
  return value;
}

function reportedPath(value) {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.startsWith('/gcodes/')) return `0:${value}`;
  if (value.startsWith('gcodes/')) return `0:/${value}`;
  if (!value.includes('/') && !value.includes('\\')) return `0:/gcodes/${value}`;
  return value;
}

function reading(heater) {
  if (!heater || !finite(heater.current) || heater.current <= -273) return undefined;
  const target = heater.state === 'off' || heater.state === 0 ? 0
    : heater.state === 'standby' || heater.state === 1 ? heater.standby : heater.active;
  return { actual: heater.current, ...(finite(target) ? { target } : {}) };
}

function attachTemperatures(snapshot, nozzle, bed) {
  if (nozzle || bed) snapshot.temperature = { ...(nozzle ? { nozzle } : {}), ...(bed ? { bed } : {}) };
}

class DuetAdapter {
  constructor(printer) {
    this.printer = printer;
    this.capabilities = Object.freeze({
      upload: true, start: true, pause: true, resume: true, cancel: true,
      formats: ['gcode', 'gco', 'g'], discovery: false
    });
    this._tail = Promise.resolve();
    this._sessionKey = undefined;
    this._sessionExpires = 0;
    this._sessionTimeout = 0;
    this._statusApi = undefined;
    this._closed = false;
  }

  _serialize(operation) {
    const pending = this._tail.then(operation);
    this._tail = pending.catch(() => {});
    return pending;
  }

  async _call(options) {
    try {
      const response = await request(this.printer, {
        ...options,
        headers: { ...(this._sessionKey ? { 'X-Session-Key': this._sessionKey } : {}), ...options.headers }
      });
      this._sessionExpires = Date.now() + this._sessionTimeout;
      return response.body;
    } catch (error) {
      this._sessionExpires = 0;
      // Never replay a command after an expired session, network loss, or timeout.
      throw error;
    }
  }

  async _connect() {
    if (Date.now() < this._sessionExpires) return;
    this._sessionKey = undefined;
    this._sessionTimeout = 0;
    this._sessionExpires = 0;
    const password = String(this.printer.password ?? '');
    const body = ensureObject(await this._call({
      path: `/rr_connect?password=${encodeURIComponent(password)}&sessionKey=yes`
    }), 'connection');
    if (body.err === 1) throw adapterError('RepRapFirmware rejected the configured password.', 401, 'RRF_AUTH_FAILED');
    if (body.err === 2) throw adapterError('RepRapFirmware has no free HTTP sessions. Wait for another session to expire.', 429, 'RRF_SESSIONS_FULL');
    ensureSuccess(body, 'connection');
    if (body.sessionKey !== undefined && body.sessionKey !== 0) {
      const key = String(body.sessionKey);
      if (!/^\d+$/.test(key)) throw adapterError('RepRapFirmware returned an invalid session key.', 502, 'RRF_RESPONSE_INVALID');
      this._sessionKey = key;
    }
    // Leave a margin before the firmware's idle timeout. Missing timeout means reconnect next time.
    this._sessionTimeout = finite(body.sessionTimeout) && body.sessionTimeout > 0 ? Math.floor(body.sessionTimeout * 0.8) : 0;
    this._sessionExpires = Date.now() + this._sessionTimeout;
  }

  _operation(operation) {
    return this._serialize(async () => {
      if (this._closed) throw adapterError('The Duet connection is closed.', 409, 'PRINTER_CONNECTION_CLOSED');
      await this._connect();
      return operation();
    });
  }

  async _model(key) {
    const body = ensureObject(await this._call({ path: `/rr_model?key=${key}&flags=d3vn` }), 'object model');
    if (body.err !== undefined || !Object.prototype.hasOwnProperty.call(body, 'result')) {
      throw adapterError('RepRapFirmware returned an invalid object model response.', 502, 'RRF_RESPONSE_INVALID');
    }
    return body.result;
  }

  async _modernStatus(machine) {
    ensureObject(machine, 'machine state');
    if (typeof machine.status !== 'string') throw adapterError('RepRapFirmware omitted its machine state.', 502, 'RRF_RESPONSE_INVALID');
    const job = ensureObject(await this._model('job'), 'job');
    const heat = ensureObject(await this._model('heat'), 'heaters');
    const tools = await this._model('tools');
    const snapshot = {
      state: MODERN_STATES.get(machine.status) || 'unknown',
      printState: machine.status, observedAt: new Date().toISOString()
    };
    const file = reportedPath(job.file?.fileName);
    if (file) snapshot.currentFile = file;
    if (finite(job.filePosition) && finite(job.file?.size) && job.file.size > 0) {
      snapshot.progress = Math.min(100, Math.max(0, 100 * job.filePosition / job.file.size));
    }
    const tool = Array.isArray(tools) ? tools.find(value => value?.number === machine.currentTool) : undefined;
    const nozzle = reading(heat.heaters?.[tool?.heaters?.[0]]);
    const bed = reading(heat.heaters?.[heat.bedHeaters?.[0]]);
    attachTemperatures(snapshot, nozzle, bed);
    // Idle and lastFileName alone cannot distinguish successful, cancelled, or failed prints.
    return snapshot;
  }

  async _legacyStatus() {
    const body = ensureObject(await this._call({ path: '/rr_status?type=3' }), 'status');
    if (body.err !== undefined || typeof body.status !== 'string') throw adapterError('RepRapFirmware returned an invalid legacy status.', 502, 'RRF_RESPONSE_INVALID');
    const snapshot = {
      state: LEGACY_STATES.get(body.status) || 'unknown',
      printState: body.status, observedAt: new Date().toISOString()
    };
    // The legacy API calls this a fraction but its documented units are already 0..100.
    if (finite(body.fractionPrinted)) snapshot.progress = Math.min(100, Math.max(0, body.fractionPrinted));
    if (typeof body.output?.message === 'string') snapshot.message = body.output.message;
    if (snapshot.state === 'printing' || snapshot.state === 'paused') {
      const info = ensureObject(await this._call({ path: '/rr_fileinfo' }), 'active file');
      // A print can end between the status and file-info requests; err:1 means no file is available.
      if (info.err === 0) {
        const file = reportedPath(info.fileName);
        if (file) snapshot.currentFile = file;
      } else if (info.err !== 1) throw adapterError('RepRapFirmware returned invalid active-file information.', 502, 'RRF_RESPONSE_INVALID');
    }
    const bed = reading(body.temps?.bed);
    let nozzle;
    if (Number.isInteger(body.currentTool) && body.currentTool >= 0) {
      // Heater 0 is not necessarily a nozzle: use the firmware's explicit tool/heater mapping.
      const advanced = ensureObject(await this._call({ path: '/rr_status?type=2' }), 'tool configuration');
      if (advanced.err !== undefined) throw adapterError('RepRapFirmware rejected the tool configuration query.', 502, 'RRF_RESPONSE_INVALID');
      const tools = Array.isArray(advanced.tools) ? advanced.tools : [];
      const index = tools.findIndex(tool => tool?.number === body.currentTool);
      const heater = tools[index]?.heaters?.[0];
      if (Number.isInteger(heater)) nozzle = reading({
        current: body.temps?.current?.[heater], state: body.temps?.state?.[heater],
        active: body.temps?.tools?.active?.[index]?.[0], standby: body.temps?.tools?.standby?.[index]?.[0]
      });
    }
    attachTemperatures(snapshot, nozzle, bed);
    return snapshot;
  }

  async status() {
    return this._operation(async () => {
      if (this._statusApi === 'legacy') return this._legacyStatus();
      let machine;
      try { machine = await this._model('state'); }
      catch (error) {
        // RRF 2 reports an unknown request as HTTP 500; other servers use 404.
        // Probe the alternate read-only API. Authentication and resource failures are not detection.
        if (error.status !== 404 && error.status !== 500) throw error;
        this._statusApi = 'legacy';
        return this._legacyStatus();
      }
      this._statusApi = 'model';
      return this._modernStatus(machine);
    });
  }

  async upload({ filePath, fileName }) {
    const name = safeFileName(fileName || path.basename(filePath));
    const remote = `0:/gcodes/${name}`;
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw adapterError('Print artifact is not a file.', 400);
    return this._operation(async () => {
      ensureSuccess(await this._call({
        path: `/rr_upload?name=${encodeURIComponent(remote)}`, method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size },
        body: fs.createReadStream(filePath), timeoutMs: 120000
      }), 'file upload');
      return { remotePath: remote };
    });
  }

  async _gcode(code) {
    if (Buffer.byteLength(code, 'utf8') > 255) throw adapterError('The Duet print command is too long.', 400);
    return this._operation(async () => {
      const body = ensureObject(await this._call({ path: `/rr_gcode?gcode=${encodeURIComponent(code)}` }), 'G-code');
      if ((body.err !== undefined && body.err !== 0) || !Number.isInteger(body.buff) || body.buff < 0) {
        throw adapterError('RepRapFirmware did not accept the printer command into its buffer.', 502, 'RRF_COMMAND_REJECTED');
      }
      return { acknowledged: true };
    });
  }

  async start({ remotePath: remote }) {
    remotePath(remote);
    await this._gcode(`M32 "${remote}"`);
    return { acknowledged: true, remoteId: remote };
  }

  async pause() { return this._gcode('M25'); }
  async resume() { return this._gcode('M24'); }
  async cancel() { return this._gcode('M0'); }

  async close() {
    return this._serialize(async () => {
      if (this._closed) return;
      this._closed = true;
      try {
        // IP-based sessions on old firmware may be shared with another application.
        if (this._sessionKey && Date.now() < this._sessionExpires) {
          ensureSuccess(await this._call({ path: '/rr_disconnect' }), 'disconnect');
        }
      } finally {
        this._sessionKey = undefined;
        this._sessionExpires = 0;
      }
    });
  }
}

module.exports = { DuetAdapter };
