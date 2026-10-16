'use strict';

// Protocol references: PS AM snapshot, backend/app/services/bambu_mqtt.py
// start_print (3711), stop_print (3948), pause_print/resume_print (4697), and
// bambu_ftp.py ImplicitFTP_TLS. This is an independent JS implementation of
// those wire contracts, not a copy of its Python implementation. In particular,
// QuickPrint retains TLS verification and waits for device-level start evidence.
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { randomInt, createHash } = require('node:crypto');
const mqtt = require('mqtt');
const ftp = require('basic-ftp');
const { tlsOptions } = require('./tls');
const { adapterError, safeFileName } = require('./http');

const capabilities = Object.freeze({ upload: true, start: true, pause: true, resume: true, cancel: true, formats: ['gcode.3mf'], discovery: false });
const ACTIVE = new Set(['PREPARE', 'RUNNING', 'SLICING', 'PAUSE']);
const finite = value => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : undefined;

function normalizeBambuStatus(print, observedAt = new Date().toISOString()) {
  const raw = String(print.gcode_state || '').toUpperCase();
  const state = raw === 'PAUSE' ? 'paused' : ACTIVE.has(raw) ? 'printing' : ['IDLE', 'FINISH'].includes(raw) ? 'idle' : raw === 'FAILED' ? 'error' : 'unknown';
  const progress = finite(print.mc_percent);
  const currentFile = print.gcode_file && !/^Metadata\//i.test(print.gcode_file) ? print.gcode_file : print.subtask_name || print.gcode_file || undefined;
  const result = { state, printState: raw, currentFile, observedAt };
  if (progress !== undefined) result.progress = Math.min(100, Math.max(0, progress));
  if (print.subtask_id != null) result.remoteId = String(print.subtask_id);
  if (raw === 'FINISH') result.outcome = 'completed';
  // Firmware FAILED does not reliably distinguish user cancellation from error.
  if (raw === 'FAILED') { result.outcome = 'failed'; result.message = 'Printer reports the run failed or was stopped. Review the result.'; }
  if (finite(print.print_error) > 0) result.message = `Printer reports error ${print.print_error}. Check the printer display.`;
  const nozzle = { actual: finite(print.nozzle_temper), target: finite(print.nozzle_target_temper) };
  const bed = { actual: finite(print.bed_temper), target: finite(print.bed_target_temper) };
  if (nozzle.actual !== undefined || bed.actual !== undefined) result.temperature = { nozzle, bed };
  return result;
}

function buildStartPayload(remotePath, { sequenceId, remoteId }) {
  const file = safeFileName(remotePath);
  if (!/\.gcode\.3mf$/i.test(file)) throw adapterError('Bambu dispatch requires a prepared single-plate .gcode.3mf artifact.', 400, 'BAMBU_FORMAT_REQUIRED');
  return { print: {
    sequence_id: sequenceId, command: 'project_file', param: 'Metadata/plate_1.gcode',
    url: `ftp://${file}`, file, md5: '', bed_type: 'auto',
    timelapse: false, bed_leveling: true, auto_bed_leveling: 1,
    flow_cali: false, vibration_cali: true, layer_inspect: false,
    use_ams: false, cfg: '0', extrude_cali_flag: 0, extrude_cali_manual_mode: 0,
    nozzle_offset_cali: 0, subtask_name: file.replace(/\.gcode\.3mf$/i, ''),
    profile_id: '0', project_id: remoteId, subtask_id: remoteId, task_id: remoteId,
  } };
}

class BambuAdapter {
  constructor(printer) {
    this.printer = { ...printer };
    this.capabilities = capabilities;
    this.timeout = Math.min(30000, Math.max(100, Number(printer.timeoutMs) || 10000));
    this.client = null;
    this.connecting = null;
    this.events = new EventEmitter();
    this.print = {};
    this.observedAt = null;
    this.closed = false;
  }

  _validate() {
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(String(this.printer.serial || ''))) throw adapterError('Enter the Bambu printer serial number.', 400, 'BAMBU_SERIAL_REQUIRED');
    if (!this.printer.accessCode) throw adapterError('Enter the printer LAN access code and enable LAN/Developer mode.', 400, 'BAMBU_ACCESS_CODE_REQUIRED');
    if (!this.printer.host || /[\s/@?#]/.test(this.printer.host) || this.printer.host.includes('://')) throw adapterError('Bambu host must be an IP address or hostname without a URL scheme.', 400, 'INVALID_PRINTER_HOST');
  }

  async _connect() {
    if (this.closed) throw adapterError('Printer connection is closed.', 409);
    if (this.client?.connected) return;
    if (this.connecting) return this.connecting;
    this._validate();
    this.connecting = this._connectOnce();
    try { await this.connecting; } finally { this.connecting = null; }
  }

  async _connectOnce() {
    const port = Number(this.printer.port) || 8883;
    const trust = await tlsOptions(this.printer, port, { requireExplicitTrust: true });
    if (this.closed) throw adapterError('Printer connection is closed.', 409);
    const client = mqtt.connect({ protocol: 'mqtts', host: this.printer.host, port,
      username: 'bblp', password: this.printer.accessCode,
      clientId: `quickprint_${randomInt(1, 2147483647)}`, protocolVersion: 4,
      clean: true, reconnectPeriod: 0, resubscribe: false, queueQoSZero: false,
      connectTimeout: this.timeout, ...trust });
    this.client = client;
    client.on('message', (topic, buffer) => {
      if (topic !== `device/${this.printer.serial}/report` || buffer.length > 2 * 1024 * 1024) return;
      let report;
      try { report = JSON.parse(buffer.toString('utf8')); } catch { return; }
      if (!report.print || typeof report.print !== 'object') return;
      if (report.print.gcode_state || report.print.mc_percent != null || report.print.nozzle_temper != null) {
        this.print = { ...this.print, ...report.print };
        this.observedAt = new Date().toISOString();
      }
      this.events.emit('report', report.print);
    });
    client.on('error', () => this.events.emit('connectionFailure'));
    client.on('close', () => this.events.emit('connectionFailure'));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(adapterError('Bambu connection timed out. Check LAN/Developer mode, serial number, access code, and certificate.', 504, 'BAMBU_TIMEOUT')), this.timeout);
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        client.removeListener('error', fail); client.removeListener('close', fail);
        if (error) { client.end(true); reject(error); } else resolve();
      };
      const fail = () => finish(adapterError('Could not establish the authenticated Bambu MQTT connection. Check LAN/Developer mode and certificate trust.', 502, 'BAMBU_CONNECTION_FAILED'));
      client.once('error', fail); client.once('close', fail);
      client.once('connect', () => client.subscribe(`device/${this.printer.serial}/report`, { qos: 1 }, (error, granted) => {
        if (error || !granted?.length || granted.some(item => item.qos === 128)) finish(adapterError('Bambu report subscription was rejected; check serial number and access code.', 502));
        else finish();
      }));
    });
  }

  async _exchange(payload, predicate, { ambiguous = false } = {}) {
    await this._connect();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        this.events.removeListener('report', report);
        this.events.removeListener('connectionFailure', failed);
        if (error) { if (ambiguous) error.ambiguous = true; reject(error); } else resolve(value);
      };
      const timer = setTimeout(() => finish(adapterError(ambiguous ? 'The printer did not confirm the command. Check its actual state before retrying; it may have received it.' : 'No printer telemetry arrived. Check the serial number and LAN/Developer mode.', 504, ambiguous ? 'BAMBU_COMMAND_UNCONFIRMED' : 'BAMBU_TELEMETRY_TIMEOUT')), this.timeout);
      const report = value => {
        try { const result = predicate(value); if (result) finish(null, result); }
        catch (error) { finish(error); }
      };
      const failed = () => finish(adapterError('Bambu connection ended before confirmation.', 502, 'BAMBU_CONNECTION_LOST'));
      this.events.on('report', report); this.events.once('connectionFailure', failed);
      this.client.publish(`device/${this.printer.serial}/request`, JSON.stringify(payload), { qos: 1, retain: false }, error => {
        if (error) finish(adapterError('Bambu command delivery failed.', 502, 'BAMBU_PUBLISH_FAILED'));
        // A broker PUBACK acknowledges transport, not a physical print start.
      });
    });
  }

  async status() {
    await this._exchange({ pushing: { command: 'pushall', sequence_id: String(randomInt(1, 2147483647)) } }, value => value.gcode_state ? true : false);
    return normalizeBambuStatus(this.print, this.observedAt);
  }

  async upload({ filePath, fileName }) {
    this._validate();
    const name = safeFileName(fileName);
    if (!/\.gcode\.3mf$/i.test(name)) throw adapterError('Upload a prepared Bambu .gcode.3mf artifact.', 400);
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw adapterError('Print artifact is not a file.', 400);
    const port = Number(this.printer.ftpPort) || 990;
    const secureOptions = await tlsOptions(this.printer, port, { requireExplicitTrust: true });
    // Explicit host also makes passive TLS data connections verify this device.
    secureOptions.host = this.printer.host;
    const client = new ftp.Client(this.timeout);
    client.ftp.verbose = false;
    let timer;
    try {
      const transfer = async () => {
        await client.access({ host: this.printer.host, port, user: 'bblp', password: this.printer.accessCode, secure: 'implicit', secureOptions });
        await client.uploadFrom(filePath, name);
        const size = await client.size(name);
        if (size !== stat.size) throw adapterError('Printer file size differs after upload. Do not start this artifact.', 502, 'BAMBU_UPLOAD_SIZE_MISMATCH');
        return { remotePath: name, size };
      };
      return await Promise.race([transfer(), new Promise((_, reject) => {
        timer = setTimeout(() => { client.close(); reject(adapterError('Bambu file upload timed out.', 504, 'BAMBU_UPLOAD_TIMEOUT')); }, Math.min(Number(this.printer.uploadTimeoutMs) || 180000, 300000));
      })]);
    } catch (error) {
      if (error.code?.startsWith('BAMBU_')) throw error;
      throw adapterError('Bambu encrypted FTP upload failed. Check SD storage, LAN mode, access code, certificate, and firmware support for encrypted data transfers.', 502, 'BAMBU_UPLOAD_FAILED');
    } finally { clearTimeout(timer); client.close(); }
  }

  deriveRemoteId(jobId) {
    if (typeof jobId !== 'string' || !jobId || jobId.length > 256) throw adapterError('A persisted run identifier is required before Bambu dispatch.', 400, 'BAMBU_RUN_ID_REQUIRED');
    // Bambu's firmware identity fields are limited to signed int32; the durable
    // core UUID is mapped deterministically so lost acknowledgments remain
    // attributable to the original intent after a restart.
    return String(createHash('sha256').update(jobId).digest().readUInt32BE(0) % 2147483646 + 1);
  }

  async start({ remotePath, jobId }) {
    const model = String(this.printer.model || '').trim().toUpperCase();
    if (/H2D|H2C|X2D|DUAL/.test(model)) throw adapterError('This Bambu model requires explicit dual-nozzle routing, which this adapter does not yet support.', 409, 'BAMBU_MODEL_UNSUPPORTED');
    if (!['X1', 'X1C', 'X1E', 'P1P', 'P1S'].includes(model)) throw adapterError('Select a supported Bambu model before dispatch: X1, X1C, X1E, P1P, or P1S. Other model routing and FTP variants are not supported in this release.', 409, 'BAMBU_MODEL_REQUIRED');
    const remoteId = this.deriveRemoteId(jobId);
    const sequenceId = String(randomInt(1, 2147483647));
    const payload = buildStartPayload(remotePath, { sequenceId, remoteId });
    await this._exchange(payload, report => {
      if (report.command === 'project_file' && String(report.sequence_id) === sequenceId) {
        const result = String(report.result || '').toLowerCase();
        if (['fail', 'failed', 'error'].includes(result)) throw adapterError('Printer rejected the print command. Review its display, artifact/profile, and spool selection.', 409, 'BAMBU_START_REJECTED');
        if (['success', 'ok'].includes(result)) return true;
      }
      return String(report.subtask_id) === remoteId && ACTIVE.has(String(report.gcode_state).toUpperCase());
    }, { ambiguous: true });
    return { acknowledged: true, remoteId };
  }

  async _control(command, states) {
    const sequence = String(randomInt(1, 2147483647));
    await this._exchange({ print: { command, sequence_id: sequence } }, report => {
      if (report.command === command && String(report.sequence_id) === sequence) {
        const result = String(report.result || '').toLowerCase();
        if (['fail', 'failed', 'error'].includes(result)) throw adapterError('Printer rejected the control command.', 409);
        if (['success', 'ok'].includes(result)) return true;
      }
      return states.includes(String(report.gcode_state).toUpperCase());
    }, { ambiguous: true });
    return { acknowledged: true };
  }
  pause() { return this._control('pause', ['PAUSE']); }
  resume() { return this._control('resume', ['RUNNING']); }
  cancel() { return this._control('stop', ['FAILED', 'IDLE']); }
  async close() { this.closed = true; if (this.client) this.client.end(true); this.events.emit('connectionFailure'); }
}

module.exports = { BambuAdapter, normalizeBambuStatus, buildStartPayload, capabilities };
