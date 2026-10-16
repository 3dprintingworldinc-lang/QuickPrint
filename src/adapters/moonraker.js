'use strict';

const path = require('node:path');
const { request, multipartFile, safeFileName } = require('./http');

const STATES = new Map([
  ['standby', 'idle'], ['printing', 'printing'], ['paused', 'paused'],
  ['complete', 'idle'], ['cancelled', 'idle'], ['error', 'error']
]);
const OUTCOMES = new Map([['complete', 'completed'], ['cancelled', 'cancelled'], ['error', 'failed']]);

function protocolError(message) {
  return Object.assign(new Error(message), { status: 502, code: 'PRINTER_RESPONSE_INVALID' });
}

function validRemotePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') ||
      value.split('/').some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f]/.test(value)) {
    throw Object.assign(new Error('The Moonraker file path is invalid.'), { status: 400 });
  }
  return value;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function temperatureReading(value) {
  if (!value || (!finite(value.temperature) && !finite(value.target))) return undefined;
  return {
    ...(finite(value.temperature) ? { actual: value.temperature } : {}),
    ...(finite(value.target) ? { target: value.target } : {})
  };
}

class MoonrakerAdapter {
  constructor(printer) {
    this.printer = printer;
    this.capabilities = Object.freeze({
      upload: true, start: true, pause: true, resume: true, cancel: true,
      formats: ['gcode'], discovery: false
    });
  }

  async _request(options) {
    const response = await request(this.printer, {
      ...options,
      timeoutMs: this.printer.timeoutMs ?? options.timeoutMs,
      headers: {
        ...(this.printer.apiKey ? { 'X-Api-Key': this.printer.apiKey } : {}),
        ...options.headers
      }
    });
    // Moonraker wraps successful HTTP results; an error envelope is never an acknowledgement.
    if (!response.body || typeof response.body !== 'object' || response.body.error ||
        !Object.prototype.hasOwnProperty.call(response.body, 'result')) {
      throw protocolError('Moonraker did not return a successful API result.');
    }
    return response.body.result;
  }

  async status() {
    const result = await this._request({
      path: '/printer/objects/query?print_stats&virtual_sdcard&webhooks&extruder=temperature,target&heater_bed=temperature,target'
    });
    const status = result?.status;
    if (!status || typeof status !== 'object') throw protocolError('Moonraker returned an invalid printer status.');
    const printState = status.print_stats?.state;
    const hostState = status.webhooks?.state;
    let state = STATES.get(printState) || 'unknown';
    if (hostState === 'shutdown' || hostState === 'error') state = 'error';
    else if (hostState === 'disconnected' || hostState === 'startup') state = 'offline';
    const snapshot = { state, observedAt: new Date().toISOString() };
    if (typeof printState === 'string') snapshot.printState = printState;
    if (finite(status.virtual_sdcard?.progress)) snapshot.progress = Math.min(100, Math.max(0, status.virtual_sdcard.progress * 100));
    if (typeof status.print_stats?.filename === 'string' && status.print_stats.filename) snapshot.currentFile = status.print_stats.filename;
    const outcome = OUTCOMES.get(printState);
    if (outcome) snapshot.outcome = outcome;
    const message = state === 'offline' || hostState === 'shutdown' || hostState === 'error'
      ? status.webhooks?.state_message
      : status.print_stats?.message;
    if (typeof message === 'string' && message) snapshot.message = message;
    const nozzle = temperatureReading(status.extruder);
    const bed = temperatureReading(status.heater_bed);
    if (nozzle || bed) snapshot.temperature = { ...(nozzle ? { nozzle } : {}), ...(bed ? { bed } : {}) };
    return snapshot;
  }

  async upload({ filePath, fileName }) {
    const multipart = await multipartFile(filePath, {
      fileName: safeFileName(fileName || path.basename(filePath)),
      fields: { root: 'gcodes', print: 'false' }
    });
    const result = await this._request({ path: '/server/files/upload', method: 'POST', timeoutMs: 120000, ...multipart });
    const item = result?.item;
    if (!item || typeof item.path !== 'string' || !item.path || (item.root && item.root !== 'gcodes')) {
      throw protocolError('Moonraker did not return the uploaded G-code path.');
    }
    return { remotePath: validRemotePath(item.path) };
  }

  async _command(endpoint) {
    const result = await this._request({ path: endpoint, method: 'POST' });
    if (result !== 'ok') throw protocolError('Moonraker did not acknowledge the printer command.');
    return { acknowledged: true };
  }

  async start({ remotePath }) {
    validRemotePath(remotePath);
    await this._command(`/printer/print/start?filename=${encodeURIComponent(remotePath)}`);
    return { acknowledged: true, remoteId: remotePath };
  }

  async pause() { return this._command('/printer/print/pause'); }
  async resume() { return this._command('/printer/print/resume'); }
  async cancel() { return this._command('/printer/print/cancel'); }
}

module.exports = { MoonrakerAdapter };
