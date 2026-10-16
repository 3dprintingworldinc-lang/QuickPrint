'use strict';

const path = require('node:path');
const { request, multipartFile, safeFileName } = require('./http');

function protocolError(message) {
  return Object.assign(new Error(message), { status: 502, code: 'PRINTER_RESPONSE_INVALID' });
}

function remoteFilePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') ||
      value.split('/').some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f]/.test(value)) {
    throw Object.assign(new Error('The OctoPrint file path is invalid.'), { status: 400 });
  }
  return value.split('/').map(encodeURIComponent).join('/');
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function temperatureReading(value) {
  if (!value || (!finite(value.actual) && !finite(value.target))) return undefined;
  return {
    ...(finite(value.actual) ? { actual: value.actual } : {}),
    ...(finite(value.target) ? { target: value.target } : {})
  };
}

function stateFrom(job, printer) {
  const state = typeof job.state === 'string' ? job.state.toLowerCase() : '';
  const flags = printer?.state?.flags || {};
  if (flags.error || state.includes('error')) return 'error';
  if (flags.closedOrError || state === 'offline' || state.startsWith('closed')) return 'offline';
  if (flags.paused || state === 'paused') return 'paused';
  if (flags.printing || ['printing', 'starting', 'finishing', 'pausing', 'cancelling'].includes(state)) return 'printing';
  if (flags.ready || flags.operational || state === 'operational') return 'idle';
  return 'unknown';
}

class OctoPrintAdapter {
  constructor(printer) {
    this.printer = printer;
    this.capabilities = Object.freeze({
      upload: true, start: true, pause: true, resume: true, cancel: true,
      formats: ['gcode', 'gco', 'g'], discovery: false
    });
  }

  async _request(options) {
    return request(this.printer, {
      ...options,
      timeoutMs: this.printer.timeoutMs ?? options.timeoutMs,
      headers: {
        ...(this.printer.apiKey ? { 'X-Api-Key': this.printer.apiKey } : {}),
        ...options.headers
      }
    });
  }

  async status() {
    // OctoPrint returns 409 for /api/printer while the serial connection is closed.
    // /api/job still reports the disconnected state and selected local file.
    const [jobResponse, printerResponse] = await Promise.all([
      this._request({ path: '/api/job' }),
      this._request({ path: '/api/printer' }).catch(error => {
        if (error.status === 409) return { body: null };
        throw error;
      })
    ]);
    const job = jobResponse.body;
    const printer = printerResponse.body;
    if (!job || typeof job !== 'object' || typeof job.state !== 'string') {
      throw protocolError('OctoPrint returned an invalid job status.');
    }
    const snapshot = {
      state: stateFrom(job, printer),
      printState: job.state,
      observedAt: new Date().toISOString()
    };
    if (finite(job.progress?.completion)) snapshot.progress = Math.min(100, Math.max(0, job.progress.completion));
    const file = job.job?.file;
    if (typeof file?.path === 'string' && file.path) snapshot.currentFile = file.path;
    else if (typeof file?.name === 'string' && file.name) snapshot.currentFile = file.name;
    if (typeof printer?.state?.text === 'string') snapshot.message = printer.state.text;
    const nozzle = temperatureReading(printer?.temperature?.tool0);
    const bed = temperatureReading(printer?.temperature?.bed);
    if (nozzle || bed) snapshot.temperature = { ...(nozzle ? { nozzle } : {}), ...(bed ? { bed } : {}) };
    // REST snapshots do not establish whether an idle print finished or was cancelled.
    // Completion must be reconciled by an operator rather than inferred from 100%.
    return snapshot;
  }

  async upload({ filePath, fileName }) {
    const multipart = await multipartFile(filePath, {
      fileName: safeFileName(fileName || path.basename(filePath)),
      fields: { select: 'false', print: 'false' }
    });
    const response = await this._request({
      path: '/api/files/local', method: 'POST', timeoutMs: 120000, ...multipart
    });
    const remotePath = response.body?.files?.local?.path;
    if (typeof remotePath !== 'string' || !remotePath) {
      throw protocolError('OctoPrint did not return the uploaded file path.');
    }
    remoteFilePath(remotePath);
    return { remotePath };
  }

  async start({ remotePath }) {
    await this._request({
      path: `/api/files/local/${remoteFilePath(remotePath)}`,
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'select', print: true }), expectJson: false
    });
    return { acknowledged: true, remoteId: remotePath };
  }

  async _jobCommand(command, action) {
    await this._request({
      path: '/api/job', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, ...(action ? { action } : {}) }), expectJson: false
    });
    return { acknowledged: true };
  }

  async pause() { return this._jobCommand('pause', 'pause'); }
  async resume() { return this._jobCommand('pause', 'resume'); }
  async cancel() { return this._jobCommand('cancel'); }
}

module.exports = { OctoPrintAdapter };
