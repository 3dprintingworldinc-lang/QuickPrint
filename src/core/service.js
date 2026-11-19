'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { StateStore, atomicWrite, publicValue, clone, error, SECRET_FIELDS } = require('./store');

const FILE_EXTENSIONS = new Set(['.stl', '.step', '.stp', '.obj', '.3mf', '.gcode', '.gco']);
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ACTIVE = new Set(['dispatching', 'printing', 'paused']);
const OUTCOMES = new Set(['completed', 'failed', 'cancelled', 'not_started']);
const RESIN_ANALYSIS_CHECKS = ['--islands', '--resin-traps', '--suction-cups', '--touching-bounds', '--print-height', '--empty-layers'];
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fresh = (timestamp, maximum = 30000) => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) && Date.now() - Date.parse(timestamp) <= maximum && Date.parse(timestamp) - Date.now() <= 5000;

function resinTarget(job, ticket) {
  const source = ticket?.production?.target;
  const original = job.order.requestedQuantity;
  if (source === undefined) return { id: job.order.portalJobId, kind: 'order', cycle: 0, requiredParts: original, authorizedAt: job.createdAt, qcOperationId: null };
  if (!source || Object.keys(source).some(key => !['id', 'kind', 'cycle', 'requiredParts', 'authorizedAt', 'qcOperationId'].includes(key)) || !UUID.test(source.id || '') || !['order', 'replacement'].includes(source.kind) || !Number.isSafeInteger(source.cycle) || source.cycle < 0 ||
      !Number.isSafeInteger(source.requiredParts) || source.requiredParts < 0 || source.requiredParts > original || !Number.isFinite(Date.parse(source.authorizedAt)) ||
      (source.kind === 'order' && (source.id !== job.order.portalJobId || source.cycle !== 0 || source.requiredParts !== original || source.qcOperationId !== null)) ||
      (source.kind === 'replacement' && (source.cycle < 1 || source.qcOperationId !== source.id))) throw error(409, 'The portal production target is invalid or exceeds the approved order.', 'RESIN_TARGET_INVALID');
  return clone(source);
}
const targetFields = target => ({ targetId: target.id, targetKind: target.kind, targetCycle: target.cycle, targetParts: target.requiredParts });
const sameTarget = (left, right) => ['id', 'kind', 'cycle', 'requiredParts', 'qcOperationId'].every(key => left[key] === right[key]) && Date.parse(left.authorizedAt) === Date.parse(right.authorizedAt);

function text(value, maximum = 500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum);
}

function integer(value, fallback, minimum = 1, maximum = 100000) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw error(400, `Enter a whole number between ${minimum} and ${maximum}.`, 'INVALID_NUMBER');
  }
  return parsed;
}

function fileName(value) {
  const basename = path.posix.basename(text(value, 1000).replaceAll('\\', '/'));
  let cleaned = basename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') throw error(400, 'A valid file name is required.', 'INVALID_FILENAME');
  const extension = /\.gcode\.3mf$/i.test(cleaned) ? cleaned.slice(-10) : path.extname(cleaned);
  const stem = [...cleaned.slice(0, extension ? -extension.length : undefined)];
  while (Buffer.byteLength(stem.join('') + extension) > 180 && stem.length) stem.pop();
  cleaned = (stem.join('') || 'model') + extension;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function configurationFingerprint(printer) {
  return digest(JSON.stringify({
    id: printer.id, type: printer.type, host: printer.host, port: printer.port,
    serial: printer.serial, model: printer.model, mainboardId: printer.mainboardId, brandId: printer.brandId, capabilities: printer.capabilities, slicer: printer.slicer,
  }));
}

function basename(value) {
  return String(value || '').replaceAll('\\', '/').split('/').pop();
}

function slicerConfiguration(config, previous = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw error(400, 'Slicer settings must be an object.');
  const next = clone(previous);
  for (const key of ['executable', 'kind']) if (config[key] !== undefined) next[key] = text(config[key], 4000);
  for (const key of ['profilePaths', 'extraArgs']) {
    if (config[key] !== undefined) {
      if (!Array.isArray(config[key]) || config[key].some((item) => typeof item !== 'string')) throw error(400, `${key} must be a list of strings.`);
      next[key] = config[key].map((item) => text(item, 4000));
    }
  }
  if (config.timeoutMs !== undefined) next.timeoutMs = integer(config.timeoutMs, 600000, 1000, 3600000);
  return next;
}

function resinEngineConfiguration(config, previous = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw error(400, 'Resin engine settings must be an object.', 'RESIN_ENGINE_CONFIGURATION');
  const next = { ...previous };
  if (config.dispatchEnabled !== undefined) {
    if (typeof config.dispatchEnabled !== 'boolean') throw error(400, 'Resin dispatch must be explicitly enabled or disabled.', 'RESIN_DISPATCH_CONFIGURATION');
    next.dispatchEnabled = config.dispatchEnabled;
  }
  for (const key of ['prusaExecutable', 'uvtoolsExecutable', 'profilePath', 'freecadExecutable', 'cadAuditPath']) {
    if (config[key] === undefined) continue;
    if (typeof config[key] !== 'string' || /[\0\r\n]/.test(config[key]) || config[key].length > 4000 || (config[key].trim() && !path.isAbsolute(config[key].trim()))) throw error(400, 'Resin engine files must use absolute local paths.', 'RESIN_ENGINE_CONFIGURATION');
    next[key] = config[key].trim();
  }
  for (const [key, fallback, minimum, maximum] of [['cadLinearDeflectionMm', 0.005, 0.0001, 0.1], ['cadAngularDeflectionRad', 0.1, 0.01, 0.5]]) {
    const value = config[key] === undefined ? (next[key] ?? fallback) : config[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw error(400, 'CAD tessellation tolerances are outside the supported bounds.', 'RESIN_CAD_CONFIGURATION');
    next[key] = value;
  }
  if (config.slots !== undefined) {
    if (!Array.isArray(config.slots) || config.slots.length > 32) throw error(400, 'Configure at most 32 resin profile slots.', 'RESIN_PROFILE_SLOTS_INVALID');
    const ids = new Set();
    next.slots = config.slots.map(slot => {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot) || Object.keys(slot).some(key => !['id', 'name', 'profilePath'].includes(key)) ||
          typeof slot.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(slot.id) || ids.has(slot.id) ||
          typeof slot.name !== 'string' || !slot.name.trim() || slot.name.length > 100 || /[\u0000-\u001f\u007f]/.test(slot.name) ||
          typeof slot.profilePath !== 'string' || !slot.profilePath.trim() || slot.profilePath.length > 4000 || /[\0\r\n]/.test(slot.profilePath) || !path.isAbsolute(slot.profilePath.trim())) throw error(400, 'Each resin slot needs a unique ID, name and absolute profile JSON path.', 'RESIN_PROFILE_SLOTS_INVALID');
      ids.add(slot.id);
      return { id: slot.id, name: slot.name.trim(), profilePath: slot.profilePath.trim() };
    });
  }
  if (config.timeoutMs !== undefined) next.timeoutMs = integer(config.timeoutMs, 900000, 1000, 3600000);
  return next;
}

class QuickPrintService extends EventEmitter {
  constructor({ dataDir, adapters, slicer, satellite, resinEngine, resinCad, cadRuntime, seal, unseal } = {}) {
    super();
    if (!dataDir) throw error(500, 'A QuickPrint data directory is required.');
    this.dataDir = path.resolve(dataDir);
    this.adapters = adapters;
    this.slicer = slicer;
    this.satellite = satellite;
    this.resinEngine = resinEngine;
    this.resinCad = resinCad;
    this.cadRuntime = cadRuntime;
    this.store = new StateStore({ dataDir: this.dataDir, seal, unseal });
    this._transaction = Promise.resolve();
    this._locks = new Map();
    this._adapterCache = new Map();
    this._operations = new Set();
    this._preparations = new Map();
    this._pendingPreparations = new Set();
    this._resinPermitIssuers = new WeakMap();
    this._resinDispatchPermits = new Map();
    this._closing = false;
    this._ready = false;
  }

  async init() {
    if (this._ready) return this;
    this.state = await this.store.init() || {
      schemaVersion: 1, jobs: [], printers: [], connectors: [], submissions: {}, events: [],
      settings: {
        siteName: 'QuickPrint',
        slicer: { executable: '', kind: 'orca', profilePaths: [], extraArgs: [] },
        resinEngine: { prusaExecutable: '', uvtoolsExecutable: '', profilePath: '', freecadExecutable: '', cadAuditPath: '', cadLinearDeflectionMm: 0.005, cadAngularDeflectionRad: 0.1, slots: [], timeoutMs: 900000, dispatchEnabled: false },
        intake: { enabled: false, port: 9732, token: crypto.randomBytes(32).toString('base64url') },
        pollIntervalMs: 10000,
      },
    };
    try {
      this.state.settings.resinEngine ||= {};
      if (this.state.settings.resinEngine.dispatchEnabled !== true) this.state.settings.resinEngine.dispatchEnabled = false;
      for (const job of this.state.jobs) {
        job.runs ||= [];
        job.history ||= [];
        if (job.status === 'preparing') {
          this._transition(job, 'review', 'Preparation was interrupted. Prepare this file again.');
          job.error = 'Preparation was interrupted before a validated artifact was saved.';
        } else if (ACTIVE.has(job.status)) {
          const run = this._currentRun(job);
          if (job.status === 'dispatching' && (run?.phase === 'uploading' || (job.technology === 'resin' && run?.phase === 'uploaded'))) {
            run.phase = 'resolved'; run.outcome = 'not_started'; run.resolvedAt = this._now();
            job.currentRunId = null;
            this._transition(job, job.technology === 'resin' ? 'review' : 'ready', 'File upload was interrupted before any start command. A new confirmed dispatch is required.');
          } else {
            if (run) run.phase = 'result_unknown';
            this._transition(job, 'needs_attention', 'QuickPrint restarted during a print operation. Reconcile the printer before another start.');
            job.error = 'The previous print result is unknown. Check the printer; QuickPrint will not restart it automatically.';
          }
        }
        this._quantities(job);
      }
      for (const printer of this.state.printers) {
        printer.status = { state: 'unknown', message: 'Status has not been refreshed in this session.', observedAt: null };
      }
      await this.store.save(this.state);
      this._ready = true;
      return this;
    } catch (failure) {
      await this.store.close();
      throw failure;
    }
  }

  _now() { return new Date().toISOString(); }

  _assertReady() {
    if (!this._ready || this._closing) throw error(503, 'QuickPrint is not ready.', 'NOT_READY');
  }

  _job(id) {
    const job = this.state.jobs.find((item) => item.id === id);
    if (!job) throw error(404, 'Job not found.', 'JOB_NOT_FOUND');
    return job;
  }

  _printer(id) {
    const printer = this.state.printers.find((item) => item.id === id);
    if (!printer) throw error(404, 'Printer not found.', 'PRINTER_NOT_FOUND');
    return printer;
  }

  _currentRun(job) { return job.runs?.find((run) => run.id === job.currentRunId) || null; }

  _quantities(job) {
    job.completedQuantity = job.runs.filter((run) => run.outcome === 'completed').length;
    job.acceptedQuantity = job.runs.reduce((sum, run) => sum + (run.acceptedQuantity || 0), 0);
    job.remainingQuantity = Math.max(0, job.quantity - job.acceptedQuantity);
    job.pendingAcceptanceQuantity = job.runs.filter((run) => run.outcome === 'completed' && !run.resolvedAt).length;
    if (job.technology === 'resin') {
      const production = job.resinProduction || {};
      const target = production.target || resinTarget(job);
      const completed = job.runs.filter(run => run.technology === 'resin' && run.resolvedAt && Number.isSafeInteger(run.printedParts));
      const localPrintedParts = completed.reduce((sum, run) => sum + ((run.targetId || job.order.portalJobId) === target.id ? run.printedParts : 0), 0);
      const lifetimeLocalPrintedParts = completed.reduce((sum, run) => sum + run.printedParts, 0);
      const baselinePrintedParts = Number.isSafeInteger(production.baselinePrintedParts) ? production.baselinePrintedParts : 0;
      const requestedParts = target.requiredParts;
      const printedParts = baselinePrintedParts + localPrintedParts;
      job.resinProduction = { ...production, target, originalRequestedParts: job.order.requestedQuantity, requestedParts, localPrintedParts, lifetimeLocalPrintedParts, printedParts, remainingParts: Math.max(0, requestedParts - printedParts) };
    }
  }

  _transition(job, status, message, extra = {}) {
    const now = this._now();
    const previous = job.status;
    job.status = status;
    job.updatedAt = now;
    job.history.push({ at: now, from: previous || null, to: status, message: this._safeMessage(message), ...extra });
  }

  _safeMessage(value) {
    // Redact before truncating: otherwise a long secret can be cut into a
    // prefix that no longer matches its saved value.
    let message = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    const redact = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, item] of Object.entries(node)) {
        if (SECRET_FIELDS.has(key) && typeof item === 'string' && item.length > 0) message = message.split(item).join('[redacted]');
        else if (item && typeof item === 'object') redact(item);
      }
    };
    if (this.state) { redact(this.state.printers); redact(this.state.settings); redact(this.state.connectors); }
    return message.replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
      .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[redacted]')
      .replace(/\b(password|api[_-]?key|access[_-]?code|token)(\s*[:=]\s*)[^\s,;&]+/gi, '$1$2[redacted]').slice(0, 2000);
  }

  _event({ level = 'info', type = 'operation', message, jobId, printerId }) {
    const event = { id: crypto.randomUUID(), at: this._now(), level, type, message: this._safeMessage(message) };
    if (jobId) event.jobId = jobId;
    if (printerId) event.printerId = printerId;
    this.state.events.unshift(event);
    this.state.events.length = Math.min(this.state.events.length, 500);
    return event;
  }

  _mutate(operation) {
    const task = this._transaction.then(async () => {
      const previous = clone(this.state);
      try {
        const result = await operation();
        await this.store.save(this.state);
        // Return a copy; callers cannot mutate authoritative state.
        const copy = result === undefined ? undefined : clone(result);
        queueMicrotask(() => { try { this.emit('change'); } catch { /* UI listeners must not roll back durable state. */ } });
        return copy;
      } catch (failure) {
        this.state = previous;
        throw failure;
      }
    });
    this._transaction = task.catch(() => {});
    return task;
  }

  _withLocks(keys, operation) {
    this._assertReady();
    const ordered = [...new Set(keys)].sort();
    const waitFor = ordered.map((key) => this._locks.get(key) || Promise.resolve());
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    for (const key of ordered) this._locks.set(key, gate);
    const task = Promise.all(waitFor).then(() => {
      this._assertReady();
      return operation();
    }).finally(() => {
      release();
      for (const key of ordered) if (this._locks.get(key) === gate) this._locks.delete(key);
    });
    this._operations.add(task);
    task.then(() => this._operations.delete(task), () => this._operations.delete(task));
    return task;
  }

  snapshot() {
    this._assertReady();
    return publicValue(clone({
      jobs: this.state.jobs, printers: this.state.printers, settings: this.state.settings,
      events: this.state.events, connectors: this.state.connectors,
    }));
  }

  getJob(id) { this._assertReady(); return publicValue(clone(this._job(id))); }
  getPrinter(id) { this._assertReady(); return publicValue(clone(this._printer(id))); }
  getSettings({ secrets = false } = {}) { this._assertReady(); return secrets ? clone(this.state.settings) : publicValue(clone(this.state.settings)); }
  getConnectors({ secrets = false } = {}) { this._assertReady(); return secrets ? clone(this.state.connectors) : publicValue(clone(this.state.connectors)); }

  async submit({ source = 'manual', sourceId, name, customer, quantity = 1, notes, files, order } = {}) {
    this._assertReady();
    if (order !== undefined) {
      if (!order || order.production?.printType !== 'resin' || !/^[a-f0-9]{64}$/.test(order.ticketFingerprint || '')
        || !Number.isSafeInteger(order.requestedQuantity) || order.requestedQuantity < 1 || order.requestedQuantity > 500
        || !['mm', 'in', 'm'].includes(order.units) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(order.portalJobId || '')
        || !Number.isSafeInteger(order.portalVersion) || order.portalVersion < 1
        || !Array.isArray(files) || files.length !== 1 || Number(quantity) !== 1 || files[0].quantity && files[0].quantity !== 1) {
        throw error(400, 'A Layr resin import requires a verified ticket, specifications and one model file. Requested parts are tracked separately from print runs.', 'INVALID_PRODUCTION_TICKET');
      }
      let portal;
      try { portal = new URL(order.portalUrl); } catch { throw error(400, 'The production ticket needs its portal origin.', 'INVALID_PRODUCTION_TICKET'); }
      if (portal.protocol !== 'https:' || portal.origin !== order.portalUrl || source !== `layr:${portal.origin}` || sourceId !== `${order.portalJobId}:${order.ticketFingerprint}`) throw error(400, 'The production ticket and submission identity must match.', 'INVALID_PRODUCTION_TICKET');
      if (!Buffer.isBuffer(files[0].data) || !/\.(stl|obj|step|stp)$/i.test(files[0].name) || digest(files[0].data) !== order.modelSha256) throw error(400, 'The imported model must match its production ticket receipt.', 'MODEL_RECEIPT_MISMATCH');
      order = clone(order);
    }
    if (typeof source !== 'string' || source.length > 200 || (sourceId !== undefined && (typeof sourceId !== 'string' || sourceId.length > 1000))) {
      throw error(400, 'Source identity must be a string: source up to 200 characters, sourceId up to 1000.', 'SOURCE_IDENTITY');
    }
    source = text(source, 200) || 'manual';
    sourceId = text(sourceId, 1000) || crypto.randomUUID();
    const identity = digest(JSON.stringify([source, sourceId]));
    return this._withLocks([`submission:${identity}`], async () => {
      const existing = this.state.submissions[identity];
      if (existing) return { jobs: existing.jobIds.map((id) => this.getJob(id)), duplicate: true };
      if (!Array.isArray(files) || files.length < 1 || files.length > 50) throw error(400, 'Submit between 1 and 50 files.', 'FILES_REQUIRED');
      const defaultQuantity = integer(quantity, 1);
      const validated = files.map((file) => {
        const filename = fileName(file.name);
        if (!FILE_EXTENSIONS.has(path.extname(filename).toLowerCase())) throw error(400, `${filename}: unsupported file type. Use STEP, STP, STL, OBJ, 3MF, G-code, or GCO.`, 'FILE_TYPE');
        if (!Buffer.isBuffer(file.data) || !file.data.length || file.data.length > MAX_FILE_BYTES) throw error(400, `${filename}: each file must contain data and be at most 100 MiB.`, 'FILE_SIZE');
        return { name: filename, data: file.data, quantity: integer(file.quantity, defaultQuantity) };
      });
      const submissionId = crypto.randomUUID();
      const createdPaths = [];
      try {
        return await this._mutate(async () => {
          const jobs = [];
          for (const file of validated) {
            const id = crypto.randomUUID();
            const jobDir = path.join(this.dataDir, 'jobs', id);
            createdPaths.push(jobDir);
            const inputPath = path.join(jobDir, 'original', file.name);
            await atomicWrite(inputPath, file.data);
            const now = this._now();
            const job = {
              id, submissionId, name: text(name, 200) || file.name, fileName: file.name,
              source, sourceId, customer: text(customer, 500), notes: text(notes, 5000),
              quantity: file.quantity, completedQuantity: 0, acceptedQuantity: 0, remainingQuantity: file.quantity,
              pendingAcceptanceQuantity: 0, status: 'review', createdAt: now, updatedAt: now,
              inputPath, sha256: digest(file.data), bytes: file.data.length, runs: [], currentRunId: null,
              ...(order ? { order, technology: 'resin' } : {}),
              history: [{ at: now, from: null, to: 'review', message: 'File received. Select a compatible printer and prepare it for review.' }],
            };
            jobs.push(job);
          }
          this.state.jobs.push(...jobs);
          this.state.submissions[identity] = { source, sourceId, submissionId, jobIds: jobs.map((job) => job.id), createdAt: this._now() };
          this._event({ type: 'submission', message: `Received ${jobs.length} file(s) from ${source}.` });
          return { jobs: publicValue(jobs), duplicate: false };
        });
      } catch (failure) {
        for (const directory of createdPaths) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        throw failure;
      }
    });
  }

  async savePrinter(config = {}) {
    this._assertReady();
    const id = config.id || crypto.randomUUID();
    return this._withLocks([`printer:${id}`], async () => {
      const previous = this.state.printers.find((item) => item.id === id);
      if (config.id && !previous) throw error(404, 'Printer not found.', 'PRINTER_NOT_FOUND');
      if (previous && this.state.jobs.some((job) => job.printerId === id && (ACTIVE.has(job.status) || this._currentRun(job)))) {
        throw error(409, 'Resolve this printer’s active or uncertain run before editing its connection.', 'PRINTER_BUSY');
      }
      const printer = { ...(previous || {}), id };
      for (const key of ['name', 'type', 'host', 'model', 'serial', 'mainboardId', 'brandId', 'caCertificate', 'tlsFingerprint']) {
        if (config[key] !== undefined) printer[key] = text(config[key], key === 'caCertificate' ? 65536 : 1000);
      }
      for (const key of ['apiKey', 'password', 'accessCode']) {
        if (typeof config[key] === 'string' && config[key].trim()) printer[key] = config[key];
      }
      if (!printer.name || !printer.type || !printer.host) throw error(400, 'Printer name, type, and host are required.', 'PRINTER_FIELDS');
      if (/\r|\n|@/.test(printer.host)) throw error(400, 'Use a printer hostname or address without embedded credentials.', 'PRINTER_HOST');
      if (config.port !== undefined) printer.port = config.port === '' || config.port === null ? undefined : integer(config.port, undefined, 1, 65535);
      if (config.capabilities !== undefined) {
        if (!config.capabilities || typeof config.capabilities !== 'object' || Array.isArray(config.capabilities)) throw error(400, 'Printer capabilities must be an object.');
        printer.capabilities = clone(config.capabilities);
      }
      if (config.slicer === null) delete printer.slicer;
      else if (config.slicer !== undefined) printer.slicer = slicerConfiguration(config.slicer, previous?.slicer);
      printer.createdAt ||= this._now();
      printer.updatedAt = this._now();
      printer.status = { state: 'unknown', message: 'Test the connection to read printer status.', observedAt: null };
      const result = await this._mutate(() => {
        const index = this.state.printers.findIndex((item) => item.id === id);
        if (index < 0) this.state.printers.push(printer); else this.state.printers[index] = printer;
        for (const job of this.state.jobs) {
          if (job.printerId === id && job.status === 'ready' && job.artifact?.printerFingerprint !== configurationFingerprint(printer)) {
            this._transition(job, 'review', 'Printer configuration changed. Prepare the file for this printer again.');
            delete job.artifact;
          }
        }
        this._event({ type: 'printer', printerId: id, message: `${previous ? 'Updated' : 'Added'} printer ${printer.name}.` });
        return publicValue(printer);
      });
      await this._closeAdapter(id);
      return result;
    });
  }

  async removePrinter(id) {
    return this._withLocks([`printer:${id}`], async () => {
      const result = await this._mutate(() => {
        this._printer(id);
        if (this.state.jobs.some((job) => job.printerId === id && (ACTIVE.has(job.status) || this._currentRun(job)))) throw error(409, 'Resolve this printer’s active or uncertain run before removing it.', 'PRINTER_BUSY');
        this.state.printers = this.state.printers.filter((item) => item.id !== id);
        for (const job of this.state.jobs) {
          if (job.printerId === id && !['completed', 'cancelled'].includes(job.status)) {
            this._transition(job, 'review', 'The assigned printer was removed. Select and prepare for another printer.');
            job.printerId = null;
            delete job.artifact;
          }
        }
        this._event({ type: 'printer', printerId: id, message: 'Removed printer configuration.' });
        return { removed: true, id };
      });
      await this._closeAdapter(id);
      return result;
    });
  }

  async _adapter(printer) {
    let cached = this._adapterCache.get(printer.id);
    if (cached) return cached;
    const registry = this.adapters || require('../adapters');
    const factory = typeof registry === 'function' ? registry : registry.createAdapter;
    if (typeof factory !== 'function') throw error(500, 'Printer adapter registry is unavailable.', 'ADAPTER_REGISTRY');
    cached = await factory(clone(printer));
    if (!cached || typeof cached.status !== 'function') throw error(400, 'This printer adapter cannot report status.', 'ADAPTER_INVALID');
    this._adapterCache.set(printer.id, cached);
    return cached;
  }

  async _closeAdapter(id) {
    const adapter = this._adapterCache.get(id);
    this._adapterCache.delete(id);
    try { await adapter?.close?.(); } catch { /* A disconnected adapter must not prevent shutdown. */ }
  }

  _status(status, requireFresh = false) {
    const states = new Set(['idle', 'printing', 'paused', 'offline', 'error', 'unknown']);
    if (!status || !states.has(status.state)) throw error(502, 'The printer returned an unrecognized status.', 'PRINTER_STATUS');
    if (requireFresh && !fresh(status.observedAt)) throw error(409, 'The printer did not return fresh observed telemetry.', 'PRINTER_STATUS_STALE');
    const observedAt = Number.isFinite(Date.parse(status.observedAt)) ? new Date(status.observedAt).toISOString() : this._now();
    const normalized = { state: status.state, observedAt };
    if (Number.isFinite(Number(status.progress))) normalized.progress = Math.max(0, Math.min(100, Number(status.progress)));
    if (status.currentFile) normalized.currentFile = text(status.currentFile, 1000);
    if (status.remoteId !== undefined && status.remoteId !== null) normalized.remoteId = text(status.remoteId, 500);
    if (status.message) normalized.message = this._safeMessage(status.message);
    if (OUTCOMES.has(status.outcome) && status.outcome !== 'not_started') normalized.outcome = status.outcome;
    if (status.temperature && typeof status.temperature === 'object') normalized.temperature = clone(status.temperature);
    return normalized;
  }

  async testPrinter(id) {
    return this._withLocks([`printer:${id}`], async () => {
      let status;
      try {
        const adapter = await this._adapter(this._printer(id));
        status = this._status(await adapter.status(), this._printer(id).type === 'sdcp');
      } catch (failure) {
        status = { state: 'offline', observedAt: this._now(), message: this._safeMessage(failure.message || 'Printer connection failed.') };
      }
      return this._mutate(() => {
        this._printer(id).status = status;
        this._reconcileTelemetry(id, status);
        return status;
      });
    });
  }

  async refreshPrinters() {
    this._assertReady();
    const ids = this.state.printers.map((printer) => printer.id);
    await Promise.all(ids.map((id) => this.testPrinter(id).catch((failure) => {
      if (failure.status !== 404) throw failure;
    })));
    return this.snapshot().printers;
  }

  _matchesRun(status, run) {
    const type = run.printerType || this.state.printers.find(printer => printer.id === run.printerId)?.type;
    if (type === 'sdcp') return Boolean(status.remoteId && run.remoteId && status.remoteId === run.remoteId && status.currentFile && run.remotePath && basename(status.currentFile) === basename(run.remotePath));
    if (status.remoteId && run.remoteId) return status.remoteId === run.remoteId;
    if (!status.currentFile || !run.remotePath) return false;
    return basename(status.currentFile) === basename(run.remotePath);
  }

  _reconcileTelemetry(printerId, status) {
    for (const job of this.state.jobs) {
      const run = this._currentRun(job);
      if (job.printerId !== printerId || !run || run.resolvedAt || run.outcome) continue;
      const matches = this._matchesRun(status, run);
      if (matches && run.technology === 'resin' && fresh(status.observedAt) && status.outcome && ['idle', 'error'].includes(status.state)) run.terminalEvidence = { remoteId: status.remoteId, currentFile: status.currentFile, observedAt: status.observedAt, outcome: status.outcome };
      if (matches && ['printing', 'paused'].includes(status.state)) {
        run.observedPrintingAt = this._now();
        run.phase = 'observed';
        const next = status.state === 'paused' ? 'paused' : 'printing';
        if (job.status !== next) this._transition(job, next, 'Printer telemetry confirms this run.');
        job.progress = status.progress;
        delete job.error;
      } else if (matches && status.outcome && (run.technology !== 'resin' || run.terminalEvidence)) {
        run.outcome = status.outcome;
        run.phase = 'awaiting_review';
        run.finishedAt = this._now();
        this._quantities(job);
        this._transition(job, 'needs_attention', status.outcome === 'completed'
          ? 'Printer reports a completed run. Inspect the result and record accepted quantity.'
          : `Printer reports this run ${status.outcome}. Reconcile it before another start.`);
        job.error = status.outcome === 'completed' ? 'Awaiting operator sign-off.' : `Print ${status.outcome}; operator review required.`;
      } else if (['offline', 'error', 'unknown'].includes(status.state)
        || (status.state === 'idle' && (run.observedPrintingAt
          || Date.now() - Date.parse(run.startRequestedAt) > 30000))
        || (['printing', 'paused'].includes(status.state) && status.currentFile && !matches)) {
        if (job.status !== 'needs_attention') {
          this._transition(job, 'needs_attention', 'Printer status cannot establish the result of this run. Inspect and reconcile it.');
        }
        job.error = 'Print result or identity is uncertain. No automatic restart or completion credit was applied.';
      }
    }
  }

  async _queueResinPreparation(id, keys, operation) {
    this._assertReady();
    const job = this._job(id);
    if (this._preparations.has(id) || ACTIVE.has(job.status) || this._currentRun(job)) throw error(409, 'This job already has an active or queued preparation.', 'JOB_BUSY');
    const controller = new AbortController();
    this._preparations.set(id, controller);
    this._pendingPreparations.add(id);
    try {
      return await this._withLocks(keys, () => {
        controller.signal.throwIfAborted();
        this._pendingPreparations.delete(id);
        return operation(controller);
      });
    } finally {
      if (this._preparations.get(id) === controller) {
        this._preparations.delete(id);
        this._pendingPreparations.delete(id);
      }
    }
  }

  async preprocessResinJob(id, { evaluate = true, fix, hollowThicknessMm } = {}) {
    return this._queueResinPreparation(id, [`job:${id}`, 'satellite:preprocess', 'resin:engine'], async controller => {
      const job = this._job(id);
      if (job.technology !== 'resin') throw error(409, 'Select an imported resin production ticket.', 'RESIN_TICKET_REQUIRED');
      if (job.status !== 'review' || this._currentRun(job)) throw error(409, 'This ticket must be in review before probing preprocessing.', 'JOB_BUSY');
      if (job.order.units !== 'mm') throw error(409, 'Convert and validate model units before SatelLite preprocessing. This probe accepts millimetres.', 'RESIN_UNIT_CONVERSION_REQUIRED');
      try {
        await this._mutate(() => {
          controller.signal.throwIfAborted();
          const current = this._job(id);
          delete current.resinPreparation;
          delete current.error;
          this._transition(current, 'preparing', 'Probing SatelLite model preprocessing; no print file will be generated.');
        });
        const source = await fs.readFile(job.inputPath);
        if (digest(source) !== job.sha256) throw error(409, 'The original model changed. Import it again.', 'ORIGINAL_CHANGED');
        const implementation = this.satellite || require('../slicing/satellite');
        const outputDir = path.join(this.dataDir, 'jobs', id, 'resin-preprocessing');
        controller.signal.throwIfAborted();
        const result = await implementation.preprocess({ inputPath: job.inputPath, outputDir, evaluate, fix, hollowThicknessMm, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!result || !Array.isArray(result.files) || !result.files.length || result.files.length > 100 || !result.files.some(file => ['model', 'report'].includes(file?.kind))) throw error(502, 'SatelLite returned no captured model or report.', 'SATELLITE_NO_OUTPUT');
        if (result.sourceSha256 !== job.sha256 || digest(await fs.readFile(job.inputPath)) !== job.sha256) throw error(409, 'Preprocessing source integrity could not be verified.', 'ORIGINAL_CHANGED');
        for (const file of result.files) {
          const relative = typeof file?.filePath === 'string' ? path.relative(outputDir, file.filePath) : '..';
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw error(502, 'SatelLite output is outside its work directory.', 'INVALID_SATELLITE_OUTPUT');
          const stat = await fs.lstat(file.filePath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || stat.size > MAX_FILE_BYTES || digest(await fs.readFile(file.filePath)) !== file.sha256) throw error(502, 'SatelLite captured output integrity could not be verified.', 'INVALID_SATELLITE_OUTPUT');
        }
        return await this._mutate(() => {
          controller.signal.throwIfAborted();
          const current = this._job(id);
          current.resinPreparation = { ...result, status: 'captured_unqualified', printReady: false, finishedAt: this._now() };
          delete current.error;
          this._transition(current, 'review', 'Captured SatelLite output for inspection. Resin slicing and printer qualification remain pending.');
          return publicValue(current);
        });
      } catch (failure) {
        const cause = controller.signal.aborted ? controller.signal.reason : failure;
        await this._mutate(() => {
          const current = this._job(id);
          delete current.resinPreparation;
          current.error = this._safeMessage(cause?.message || 'SatelLite preprocessing failed.');
          this._transition(current, controller.signal.reason?.code === 'PREPARATION_CANCELLED' ? 'cancelled' : 'review', current.error);
        });
        throw this._publicError(cause);
      }
    });
  }

  async prepareResinCadJob(id, request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => key !== 'confirmedEmbeddedUnits') || request.confirmedEmbeddedUnits !== true) throw error(400, 'Confirm that STEP intrinsic units are converted to millimetres; ticket units will not be applied again.', 'RESIN_CAD_REVIEW_REQUIRED');
    return this._queueResinPreparation(id, [`job:${id}`, 'resin:engine'], async controller => {
      const job = this._job(id);
      if (job.technology !== 'resin' || !job.order?.ticketFingerprint || !/\.(step|stp)$/i.test(job.fileName)) throw error(409, 'Select an imported resin STEP/STP ticket for CAD conversion.', 'RESIN_CAD_SOURCE_REQUIRED');
      if (['pending', 'approved'].includes(job.resinProduction?.plan?.approvalState)) throw error(409, 'Resolve the pending or committed preparation approval before converting CAD again.', 'RESIN_APPROVAL_LOCKED');
      if (!['review', 'cancelled'].includes(job.status) || this._currentRun(job)) throw error(409, 'This resin ticket must be in review before CAD conversion.', 'JOB_BUSY');
      const settings = resinEngineConfiguration(this.state.settings.resinEngine || {});
      if (!settings.freecadExecutable || !settings.cadAuditPath) throw error(400, 'Configure FreeCAD and the isolated CAD audit runtime in Settings.', 'RESIN_CAD_CONFIGURATION');
      try {
        const source = await this._readResinGeometrySource(job);
        await this._mutate(() => {
          controller.signal.throwIfAborted();
          const current = this._job(id); delete current.resinCad; delete current.resinSlice; delete current.error;
          this._invalidateResinPermits(id);
          this._transition(current, 'preparing', 'Auditing STEP transfer and tessellating every solid in millimetres; the original CAD file is preserved.');
        });
        const outputDir = path.join(this.dataDir, 'jobs', id, 'resin-cad');
        await fs.mkdir(outputDir, { recursive: true }); await this._resinCadDirectory(job);
        const implementation = this.resinCad || require('../slicing/resin-cad');
        controller.signal.throwIfAborted();
        const record = await implementation.prepareResinCad({ inputPath: job.inputPath, outputDir, freecadExecutable: settings.freecadExecutable, cadAuditPath: settings.cadAuditPath, timeoutMs: settings.timeoutMs, linearDeflectionMm: settings.cadLinearDeflectionMm, angularDeflectionRad: settings.cadAngularDeflectionRad, signal: controller.signal });
        controller.signal.throwIfAborted();
        await this._resinCadDirectory(job);
        await require('../slicing/resin-cad').verifyResinCadGeometry(record, { source, directory: outputDir });
        await this._readResinGeometrySource(job);
        return await this._mutate(() => {
          controller.signal.throwIfAborted();
          const current = this._job(id);
          current.resinCad = { ...record, operatorReview: { embeddedUnits: true, ticketUnits: current.order.units, coordinateUnits: 'mm', reviewedAt: this._now() } };
          delete current.error;
          this._transition(current, 'review', 'STEP transfer and all solid meshes validated. Review the millimetre geometry and choose a resin slicing profile.');
          return publicValue(current);
        });
      } catch (failure) {
        const cause = controller.signal.aborted ? controller.signal.reason : failure;
        await this._mutate(() => {
          const current = this._job(id); delete current.resinCad; delete current.resinSlice;
          current.error = this._safeMessage(cause?.message || 'CAD preparation failed.');
          this._transition(current, controller.signal.reason?.code === 'PREPARATION_CANCELLED' ? 'cancelled' : 'review', current.error);
        });
        throw this._publicError(cause);
      }
    });
  }

  async _resinCadDirectory(job) {
    const directory = path.join(this.dataDir, 'jobs', job.id, 'resin-cad');
    let current = this.dataDir;
    const rootInfo = await fs.lstat(current);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw error(409, 'CAD evidence root cannot use symbolic links.', 'RESIN_CAD_CHANGED');
    for (const segment of path.relative(this.dataDir, directory).split(path.sep)) {
      current = path.join(current, segment);
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw error(409, 'CAD evidence directories cannot use symbolic links.', 'RESIN_CAD_CHANGED');
    }
    if (path.relative(await fs.realpath(this.dataDir), await fs.realpath(directory)) !== path.relative(this.dataDir, directory)) throw error(409, 'CAD evidence resolves outside its managed job directory.', 'RESIN_CAD_CHANGED');
    return directory;
  }

  async _resinSliceFile(job, result = job.resinSlice) {
    if (!result || result.format !== 'goo' || typeof result.filePath !== 'string' || !path.isAbsolute(result.filePath) || !/^[a-f0-9]{64}$/.test(result.sha256 || '')) throw error(409, 'No captured resin slice is available.', 'RESIN_SLICE_UNAVAILABLE');
    const directory = path.join(this.dataDir, 'jobs', job.id, 'resin-slicing');
    const relative = path.relative(directory, result.filePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw error(502, 'Resin output is outside its job work directory.', 'INVALID_RESIN_OUTPUT');
    const stat = await fs.lstat(result.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 512 * 1024 * 1024 || stat.size !== result.bytes) throw error(502, 'Resin output size or file type is invalid.', 'INVALID_RESIN_OUTPUT');
    const realRelative = path.relative(await fs.realpath(directory), await fs.realpath(result.filePath));
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw error(502, 'Resin output resolves outside its job work directory.', 'INVALID_RESIN_OUTPUT');
    const bytes = await fs.readFile(result.filePath);
    if (digest(bytes) !== result.sha256) throw error(409, 'The captured resin file changed. Slice this ticket again.', 'RESIN_ARTIFACT_CHANGED');
    return bytes;
  }

  async sliceResinJob(id, request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['confirmedRequirements', 'confirmedOriginalSize', 'confirmedSizing', 'sizing', 'profileSlotId', 'expectedGeometrySha256'].includes(key))) throw error(400, 'Resin slicing accepts reviewed sizing, confirmations, a reviewed CAD geometry hash and a configured slot ID only; local paths come from Settings.', 'INVALID_RESIN_SLICE_REQUEST');
    if (request.expectedGeometrySha256 !== undefined && (typeof request.expectedGeometrySha256 !== 'string' || !SHA256.test(request.expectedGeometrySha256))) throw error(400, 'The reviewed CAD geometry hash must be a SHA-256 value.', 'INVALID_RESIN_SLICE_REQUEST');
    let sizing;
    try { sizing = request.sizing === undefined ? { mode: 'original' } : structuredClone(request.sizing); } catch { throw error(400, 'Use an explicit numeric sizing plan.', 'RESIN_SIZING_INVALID'); }
    const originalSize = sizing?.mode === 'original';
    if (request.confirmedRequirements !== true || (originalSize ? request.confirmedOriginalSize !== true && request.confirmedSizing !== true : request.confirmedSizing !== true)) throw error(400, 'Confirm the ticket requirements, selected profile and explicit sizing plan before slicing.', 'RESIN_REVIEW_REQUIRED');
    return this._queueResinPreparation(id, [`job:${id}`, 'resin:engine'], async controller => {
      const job = this._job(id);
      if (job.technology !== 'resin' || !job.order?.ticketFingerprint) throw error(409, 'Select an imported resin production ticket.', 'RESIN_TICKET_REQUIRED');
      if (['pending', 'approved'].includes(job.resinProduction?.plan?.approvalState)) throw error(409, 'Preparation approval is pending or committed. Resolve that approval before replacing its artifact.', 'RESIN_APPROVAL_LOCKED');
      if (!['review', 'cancelled'].includes(job.status) || this._currentRun(job)) throw error(409, 'This resin ticket must be in review before slicing.', 'JOB_BUSY');
      const settings = resinEngineConfiguration(this.state.settings.resinEngine || {});
      const slots = settings.slots || [];
      let slot;
      if (slots.length) {
        slot = request.profileSlotId === undefined && slots.length === 1 ? slots[0] : slots.find(item => item.id === request.profileSlotId);
        if (!slot) throw error(400, 'Choose a configured resin profile slot for this ticket.', 'RESIN_PROFILE_SLOT_REQUIRED');
        settings.profilePath = slot.profilePath;
      } else if (request.profileSlotId !== undefined) throw error(400, 'The selected resin profile slot no longer exists. Review the current Settings.', 'RESIN_PROFILE_SLOT_REQUIRED');
      if (!['prusaExecutable', 'uvtoolsExecutable', 'profilePath'].every(key => settings[key])) throw error(400, 'Configure the resin engine executable and profile paths in Settings.', 'RESIN_ENGINE_CONFIGURATION');
      try {
        await this._mutate(() => {
          controller.signal.throwIfAborted();
          const current = this._job(id); delete current.resinSlice; delete current.error;
          this._transition(current, 'preparing', 'Slicing the resin model with the reviewed local profile; no printer command is sent.');
        });
        const expectedGeometry = await this._expectedResinGeometry(job, sizing);
        if (/\.(step|stp)$/i.test(job.fileName) && request.expectedGeometrySha256 !== job.resinCad?.sha256) throw error(409, 'The CAD geometry changed or has not been reviewed. Refresh its measurements and confirm sizing again.', 'RESIN_CAD_REVIEW_STALE');
        const module = require('../slicing/resin-engine');
        const loaded = await module.loadProfile(settings.profilePath);
        const outputDir = path.join(this.dataDir, 'jobs', id, 'resin-slicing');
        const implementation = this.resinEngine || module;
        controller.signal.throwIfAborted();
        const result = await implementation.prepareResin({ ...settings, inputPath: expectedGeometry.inputPath, outputDir, unitScale: expectedGeometry.unitScale, sizing: expectedGeometry.sizingPlan.requestedSizing, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!result || !result.analysis || !Number.isSafeInteger(result.analysis.count) || result.analysis.count < 0 || result.analysis.passed !== (result.analysis.count === 0) || !Array.isArray(result.analysis.issues) || result.analysis.issues.length !== result.analysis.count || result.analysis.issues.some(issue => typeof issue !== 'string') || !Array.isArray(result.analysis.checks) || result.analysis.checks.length !== RESIN_ANALYSIS_CHECKS.length || RESIN_ANALYSIS_CHECKS.some(check => !result.analysis.checks.includes(check)) || result.sourceSha256 !== expectedGeometry.engineSourceSha256 || result.profileSha256 !== loaded.profileSha256 || result.printerId !== loaded.profile.printerId || result.printerModel !== loaded.profile.printerModel || result.material !== loaded.profile.material || !result.tool || !/^[a-f0-9]{64}$/.test(result.tool.executableSha256 || '')) throw error(502, 'Resin slicing returned incomplete or mismatched evidence.', 'INVALID_RESIN_OUTPUT');
        const inputGeometry = await this._verifyResinInputGeometry(job, result, expectedGeometry);
        const bytes = await this._resinSliceFile(job, result);
        const inspection = require('../slicing/goo').inspectGoo(bytes, { limits: { maxFileBytes: 512 * 1024 * 1024 }, expected: { ...loaded.profile.expected, machineZMm: Number(loaded.ini.max_print_height), machineName: loaded.profile.printerModel, exposureTimeSeconds: loaded.profile.uvtoolsProperties.ExposureTime, bottomExposureTimeSeconds: loaded.profile.uvtoolsProperties.BottomExposureTime, bottomLayerCount: loaded.profile.uvtoolsProperties.BottomLayerCount } });
        module.assertTargetProperties(inspection, loaded.profile.uvtoolsProperties);
        if (inspection.perLayerSettings) throw error(502, 'Per-layer resin parameters require separate qualification.', 'RESIN_PER_LAYER_PROFILE_UNSUPPORTED');
        await this._readResinGeometrySource(job);
        if (expectedGeometry.cadPreparation) {
          const checked = await this._expectedResinGeometry(job, sizing);
          if (!require('node:util').isDeepStrictEqual(checked.cadPreparation, expectedGeometry.cadPreparation)) throw error(409, 'CAD preparation changed during resin slicing.', 'RESIN_CAD_CHANGED');
        }
        controller.signal.throwIfAborted();
        return await this._mutate(() => {
          controller.signal.throwIfAborted();
          const current = this._job(id);
          const cad = expectedGeometry.cadPreparation;
          current.resinSlice = { ...result, sourceSha256: job.sha256, ...(cad ? { meshSourceSha256: expectedGeometry.engineSourceSha256, cadPreparation: cad, rawSliceTool: result.tool, tool: this._resinCadSliceTool(result.tool, cad) } : {}), sizingPlan: expectedGeometry.sizingPlan, inputGeometry, inspection, status: result.analysis.passed ? 'sliced_pending_qualification' : 'analysis_failed', printReady: false, printerCompatible: false, operatorReview: { confirmedRequirements: true, confirmedOriginalSize: originalSize, confirmedSizing: true, sizing: expectedGeometry.sizingPlan.requestedSizing, ...(slot ? { profileSlotId: slot.id, profileSlotName: slot.name } : {}), unitScale: expectedGeometry.unitScale, units: cad ? 'mm' : current.order.units, ...(cad ? { embeddedUnits: true, ticketUnits: current.order.units } : {}), ticketFingerprint: current.order.ticketFingerprint, reviewedAt: this._now() }, finishedAt: this._now() };
          if (result.analysis.passed) delete current.error;
          else current.error = `${result.analysis.count} resin print issue(s) require review. Inspect the captured file and change the model or profile before retrying.`;
          this._transition(current, 'review', result.analysis.passed ? 'Resin slice captured. Printer/material qualification is still required.' : current.error);
          return publicValue(current);
        });
      } catch (failure) {
        const cause = controller.signal.aborted ? controller.signal.reason : failure;
        await this._mutate(() => {
          const current = this._job(id); delete current.resinSlice;
          current.error = this._safeMessage(cause?.message || 'Resin slicing failed.');
          this._transition(current, controller.signal.reason?.code === 'PREPARATION_CANCELLED' ? 'cancelled' : 'review', current.error);
        });
        throw this._publicError(cause);
      }
    });
  }

  async _readResinGeometrySource(job) {
    if (job.technology !== 'resin' || !job.order?.ticketFingerprint) throw error(409, 'Select an imported resin production ticket.', 'RESIN_TICKET_REQUIRED');
    const stat = await fs.lstat(job.inputPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 100 * 1024 * 1024) throw error(409, 'The original model size or file type changed. Import it again.', 'ORIGINAL_CHANGED');
    const file = await fs.open(job.inputPath, 'r');
    try {
      const pinned = await file.stat();
      if (!pinned.isFile() || pinned.size !== stat.size || pinned.size < 1 || pinned.size > 100 * 1024 * 1024) throw error(409, 'The original model size or file type changed. Import it again.', 'ORIGINAL_CHANGED');
      const source = Buffer.alloc(pinned.size); let offset = 0;
      while (offset < source.length) { const read = await file.read(source, offset, source.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      if (offset !== source.length || (await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || digest(source) !== job.sha256) throw error(409, 'The original model changed. Import it again.', 'ORIGINAL_CHANGED');
      return source;
    } finally { await file.close(); }
  }

  async _expectedResinGeometry(job, sizing) {
    const input = await this._resinGeometryInput(job);
    const prepared = require('../slicing/resin-geometry').prepareResinGeometry(input.source, { format: input.format, units: input.units, sizing });
    // Do not retain the potentially 100 MiB normalized Buffer during providers.
    return { sizingPlan: prepared.plan, inputPath: input.inputPath, unitScale: input.unitScale, engineSourceSha256: input.engineSourceSha256, ...(input.cadPreparation ? { cadPreparation: input.cadPreparation } : {}), inputGeometry: { sha256: prepared.transformedSha256, bytes: prepared.stl.length, bounds: prepared.transformedBounds } };
  }

  async _resinGeometryInput(job) {
    const source = await this._readResinGeometrySource(job), format = path.extname(job.fileName).slice(1).toLowerCase();
    if (!['step', 'stp'].includes(format)) {
      const unitScale = { mm: 1, in: 25.4, m: 1000 }[job.order.units];
      if (!unitScale) throw error(400, 'Resolve the model units before slicing.', 'RESIN_MODEL_UNITS');
      return { source, format, inputPath: job.inputPath, units: job.order.units, unitScale, engineSourceSha256: job.sha256 };
    }
    if (!job.resinCad || job.resinCad.operatorReview?.embeddedUnits !== true) throw error(409, 'Audit and convert this STEP model before measuring or slicing its geometry.', 'RESIN_CAD_REQUIRED');
    const directory = await this._resinCadDirectory(job);
    await require('../slicing/resin-cad').verifyResinCadGeometry(job.resinCad, { source, directory });
    const record = job.resinCad;
    const mesh = await this._readResinGeometrySource({ ...job, inputPath: record.filePath, sha256: record.sha256 });
    return { source: mesh, format: 'stl', inputPath: record.filePath, units: 'mm', unitScale: 1, engineSourceSha256: record.sha256,
      cadPreparation: { sourceSha256: job.sha256, meshSha256: record.sha256, reportSha256: record.reportSha256, auditReportSha256: record.auditReportSha256, cadToolSha256: record.tool.executableSha256, tolerance: clone(record.tolerance), originMm: clone(record.originMm) } };
  }

  _resinCadSliceTool(rawTool, cad) {
    if (!SHA256.test(rawTool?.executableSha256 || '') || !SHA256.test(cad?.cadToolSha256 || '')) throw error(409, 'CAD and slicing provider fingerprints are required.', 'RESIN_CAD_CHANGED');
    return { ...rawTool, executableSha256: digest(JSON.stringify({ engineSha256: rawTool.executableSha256, cadToolSha256: cad.cadToolSha256, tolerance: cad.tolerance })) };
  }

  async inspectResinGeometry(id) {
    return this._withLocks([`job:${id}`], async () => {
      const job = this._job(id), input = await this._resinGeometryInput(job);
      const measured = require('../slicing/resin-geometry').measureResinGeometry(input.source, { format: input.format, units: input.units });
      return input.cadPreparation ? Object.freeze({ ...measured, sourceSha256: job.sha256, geometrySha256: input.engineSourceSha256, embeddedUnits: true, ticketUnits: job.order.units, cadPreparation: input.cadPreparation }) : measured;
    });
  }

  async _verifyResinInputGeometry(job, result, expected) {
    const descriptor = result.inputGeometry, anticipated = expected.inputGeometry;
    const same = require('node:util').isDeepStrictEqual;
    if (result.sizingPlan?.sizingSha256 !== expected.sizingPlan.sizingSha256 || !same(result.sizingPlan, expected.sizingPlan) || !descriptor || typeof descriptor.filePath !== 'string' || descriptor.filePath.length > 4000 || /[\0\r\n]/.test(descriptor.filePath) || !path.isAbsolute(descriptor.filePath) || descriptor.sha256 !== anticipated.sha256 || descriptor.bytes !== anticipated.bytes || !same(descriptor.bounds, anticipated.bounds)) throw error(502, 'The engine did not return the independently verified sizing plan and normalized input.', 'INVALID_RESIN_GEOMETRY');
    const directory = path.join(this.dataDir, 'jobs', job.id, 'resin-slicing');
    const relative = path.relative(directory, descriptor.filePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.extname(descriptor.filePath).toLowerCase() !== '.stl') throw error(502, 'Normalized resin input is outside its job work directory.', 'INVALID_RESIN_GEOMETRY');
    const fromData = path.relative(this.dataDir, descriptor.filePath);
    let component = this.dataDir;
    for (const name of fromData.split(path.sep)) {
      component = path.join(component, name);
      const stat = await fs.lstat(component);
      if (stat.isSymbolicLink()) throw error(502, 'Normalized resin input cannot use symbolic links.', 'INVALID_RESIN_GEOMETRY');
    }
    const actualRelative = path.relative(await fs.realpath(directory), await fs.realpath(descriptor.filePath));
    if (!actualRelative || actualRelative === '..' || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) throw error(502, 'Normalized resin input resolves outside its job work directory.', 'INVALID_RESIN_GEOMETRY');
    const file = await fs.open(descriptor.filePath, 'r');
    let bytes;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 100 * 1024 * 1024 || stat.size !== anticipated.bytes) throw error(502, 'Normalized resin input size or file type changed.', 'INVALID_RESIN_GEOMETRY');
      bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      if (offset !== bytes.length || (await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || digest(bytes) !== anticipated.sha256) throw error(409, 'The normalized resin input changed after sizing.', 'RESIN_INPUT_GEOMETRY_CHANGED');
    } finally { await file.close(); }
    const measured = require('../slicing/resin-geometry').measureResinGeometry(bytes, { format: 'stl', units: 'mm' });
    if (measured.triangleCount !== expected.sizingPlan.triangleCount || !same(measured.sourceBounds, anticipated.bounds)) throw error(409, 'The normalized resin input does not match the reviewed bounds.', 'RESIN_INPUT_GEOMETRY_CHANGED');
    return { filePath: descriptor.filePath, sha256: anticipated.sha256, bytes: anticipated.bytes, bounds: measured.sourceBounds };
  }

  async _verifyResinSizingEvidence(job, slice) {
    const isCad = /\.(step|stp)$/i.test(job.fileName);
    if (!slice.sizingPlan) {
      if (isCad) throw error(409, 'STEP resin slices require source-bound CAD and sizing evidence.', 'RESIN_CAD_REQUIRED');
      if (slice.operatorReview?.confirmedOriginalSize !== true || (slice.operatorReview.sizing && slice.operatorReview.sizing.mode !== 'original')) throw error(409, 'Legacy resin slices require original-size review; resized slices need geometry evidence.', 'RESIN_SIZING_UNQUALIFIED');
      return;
    }
    if (slice.operatorReview?.confirmedSizing !== true) throw error(409, 'Confirm the exact geometry sizing plan before production.', 'RESIN_SIZING_UNQUALIFIED');
    const expected = await this._expectedResinGeometry(job, slice.operatorReview.sizing);
    if (isCad && (slice.sourceSha256 !== job.sha256 || slice.meshSourceSha256 !== expected.engineSourceSha256 || slice.operatorReview.embeddedUnits !== true || slice.operatorReview.units !== 'mm' || slice.operatorReview.unitScale !== 1 || !require('node:util').isDeepStrictEqual(slice.cadPreparation, expected.cadPreparation) || !require('node:util').isDeepStrictEqual(slice.tool, this._resinCadSliceTool(slice.rawSliceTool, expected.cadPreparation)))) throw error(409, 'CAD source, conversion, slicing provider or reviewed units changed.', 'RESIN_CAD_CHANGED');
    if (!isCad && (slice.cadPreparation || slice.meshSourceSha256 || slice.rawSliceTool)) throw error(409, 'Mesh-only slices cannot carry unrelated CAD evidence.', 'RESIN_CAD_CHANGED');
    await this._verifyResinInputGeometry(job, slice, expected);
  }

  async getResinSliceDownload(id) {
    return this._withLocks([`job:${id}`], async () => {
      const job = this._job(id);
      if (job.technology !== 'resin') throw error(409, 'Select a resin ticket.', 'RESIN_TICKET_REQUIRED');
      await this._resinSliceFile(job);
      if (job.resinSlice.sizingPlan || /\.(step|stp)$/i.test(job.fileName)) await this._verifyResinSizingEvidence(job, job.resinSlice);
      if (digest(await fs.readFile(job.inputPath)) !== job.sha256) throw error(409, 'The original model changed. Slice this ticket again.', 'ORIGINAL_CHANGED');
      return { filePath: job.resinSlice.filePath, fileName: 'prepared-unqualified.goo', sha256: job.resinSlice.sha256, bytes: job.resinSlice.bytes };
    });
  }

  createResinPermitIssuer({ reauthorize } = {}) {
    this._assertReady();
    if (typeof reauthorize !== 'function') throw error(400, 'A trusted pre-start authorization reader is required.', 'RESIN_AUTHORITY_REQUIRED');
    const issuer = Object.freeze({});
    this._resinPermitIssuers.set(issuer, { reauthorize });
    return issuer;
  }

  _resinIssuer(issuer) {
    const authority = this._resinPermitIssuers.get(issuer);
    if (!authority) throw error(403, 'Only the connected production authority can authorize a resin run.', 'RESIN_AUTHORITY_REQUIRED');
    return authority;
  }

  _invalidateResinPermits(id) {
    for (const [key, permit] of this._resinDispatchPermits) if (permit.id === id) this._resinDispatchPermits.delete(key);
  }

  async inspectResinPrinter(printerId) {
    return this._withLocks([`printer:${printerId}`], async () => {
      const printer = this._printer(printerId);
      const adapter = await this._adapter(printer);
      if (printer.type !== 'sdcp' || typeof adapter.attributes !== 'function') throw error(409, 'Select an SDCP resin printer with readable identity attributes.', 'RESIN_PRINTER_REQUIRED');
      const attributes = await adapter.attributes();
      const { canonicalSDCPDevice, fingerprintSDCPDevice } = require('../adapters/sdcp-identity');
      return { deviceFingerprint: fingerprintSDCPDevice(printer, attributes), device: canonicalSDCPDevice(printer, attributes), printerFingerprint: configurationFingerprint(printer) };
    });
  }

  async _resinDispatchBindings(job, receipt, deviceFingerprint) {
    const slice = job.resinSlice;
    if (job.technology !== 'resin' || !job.order || !SHA256.test(job.order.ticketFingerprint || '') || !slice || slice.format !== 'goo' || slice.modelCopiesPerRun !== 1 || slice.inspection?.validatedLayerData !== true || slice.operatorReview?.confirmedRequirements !== true || (slice.sizingPlan ? slice.operatorReview.confirmedSizing !== true : slice.operatorReview.confirmedOriginalSize !== true) || slice.operatorReview.ticketFingerprint !== job.order.ticketFingerprint || slice.analysis?.passed !== true || slice.analysis.count !== 0 || !Array.isArray(slice.analysis.issues) || slice.analysis.issues.length !== 0 || !Array.isArray(slice.analysis.checks) || RESIN_ANALYSIS_CHECKS.some(check => !slice.analysis.checks.includes(check)) || !SHA256.test(slice.tool?.executableSha256 || '')) throw error(409, 'A validated, issue-free, single-source-instance resin slice is required.', 'RESIN_SLICE_UNQUALIFIED');
    if (!SHA256.test(deviceFingerprint || '') || !receipt || receipt.kind !== 'slice' || !UUID.test(receipt.id || '') || receipt.jobId !== job.order.portalJobId || receipt.ticketFingerprint !== job.order.ticketFingerprint || receipt.sourceSha256 !== job.sha256 || receipt.profileSha256 !== slice.profileSha256 || receipt.tool?.executableSha256 !== slice.tool.executableSha256 || receipt.printerId !== slice.printerId || receipt.printerModel !== slice.printerModel || receipt.material !== slice.material || receipt.artifact?.sha256 !== slice.sha256 || receipt.artifact?.sizeBytes !== slice.bytes || receipt.artifact?.format !== 'goo' || receipt.partsPerRun !== 1 || receipt.deviceFingerprint !== deviceFingerprint || receipt.printReady !== false) throw error(409, 'The portal receipt does not identify this exact slice, profile, one-unit plan and printer.', 'RESIN_RECEIPT_MISMATCH');
    if (slice.sourceSha256 !== job.sha256 || job.order.modelSha256 !== job.sha256 || digest(await fs.readFile(job.inputPath)) !== job.sha256) throw error(409, 'The original model changed after resin preparation.', 'ORIGINAL_CHANGED');
    if (slice.sizingPlan || /\.(step|stp)$/i.test(job.fileName)) await this._verifyResinSizingEvidence(job, slice);
    else if (slice.operatorReview.sizing && slice.operatorReview.sizing.mode !== 'original') throw error(409, 'Legacy resin slices require original-size review; resized slices need geometry evidence.', 'RESIN_SIZING_UNQUALIFIED');
    const bytes = await this._resinSliceFile(job);
    const settings = this.state.settings.resinEngine || {};
    const slotId = slice.operatorReview?.profileSlotId;
    const profilePath = slotId ? settings.slots?.find(slot => slot.id === slotId)?.profilePath : settings.profilePath;
    if (!profilePath) throw error(409, 'The reviewed resin profile is no longer configured.', 'RESIN_PROFILE_CHANGED');
    const module = require('../slicing/resin-engine');
    const loaded = await module.loadProfile(profilePath);
    if (loaded.profileSha256 !== slice.profileSha256 || loaded.profile.printerId !== slice.printerId || loaded.profile.printerModel !== slice.printerModel || loaded.profile.material !== slice.material) throw error(409, 'The resin profile changed after this slice was captured.', 'RESIN_PROFILE_CHANGED');
    const inspection = require('../slicing/goo').inspectGoo(bytes, { limits: { maxFileBytes: 512 * 1024 * 1024 }, expected: { ...loaded.profile.expected, machineZMm: Number(loaded.ini.max_print_height), machineName: loaded.profile.printerModel, exposureTimeSeconds: loaded.profile.uvtoolsProperties.ExposureTime, bottomExposureTimeSeconds: loaded.profile.uvtoolsProperties.BottomExposureTime, bottomLayerCount: loaded.profile.uvtoolsProperties.BottomLayerCount } });
    module.assertTargetProperties(inspection, loaded.profile.uvtoolsProperties);
    if (inspection.perLayerSettings || inspection.sha256 !== slice.sha256) throw error(409, 'The resin artifact does not match its reviewed global profile.', 'RESIN_SLICE_UNQUALIFIED');
    return { receiptId: receipt.id, sourceSha256: job.sha256, artifactSha256: slice.sha256, profileSha256: slice.profileSha256, engineSha256: slice.tool.executableSha256, printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material, format: 'goo', deviceFingerprint, partsPerRun: 1 };
  }

  async adoptResinPreparationTarget(issuer, id, { ticket, confirmedTarget, observedAt } = {}) {
    this._resinIssuer(issuer);
    if (confirmedTarget !== true) throw error(400, 'Confirm the current studio-authorized replacement target before reopening preparation.', 'RESIN_TARGET_REVIEW_REQUIRED');
    return this._withLocks([`job:${id}`], async () => {
      const job = this._job(id);
      if (job.technology !== 'resin' || !job.order?.ticketFingerprint) throw error(409, 'Select an imported resin production ticket.', 'RESIN_TICKET_REQUIRED');
      if (!['review', 'cancelled'].includes(job.status) || this._currentRun(job)) throw error(409, 'Resolve the active or uncertain run before adopting a replacement target.', 'JOB_BUSY');
      if (!fresh(observedAt)) throw error(409, 'Refresh the studio production target before adopting it.', 'RESIN_AUTHORIZATION_STALE');
      if (!ticket?.production?.target || ticket.id !== job.order.portalJobId || ticket.ticketFingerprint !== job.order.ticketFingerprint ||
          !Number.isSafeInteger(ticket.version) || ticket.version < 1 || ticket.ticket?.specifications?.project?.quantity !== job.order.requestedQuantity || ticket.ticket?.specifications?.production?.printType !== 'resin') throw error(409, 'The current production target does not belong to this frozen resin ticket.', 'RESIN_TARGET_INVALID');
      const target = resinTarget(job, ticket), previousTarget = job.resinProduction?.target || resinTarget(job);
      if (ticket.status !== (target.requiredParts > 0 ? 'preparing' : 'post_processing') || ticket.production.approvedReceiptId || ticket.production.approvedTargetId || ticket.production.run?.status === 'printing') throw error(409, 'Adopt an unapproved, stopped studio replacement target in preparation or finishing.', 'RESIN_TARGET_INVALID');
      if (target.id === previousTarget.id) {
        if (!sameTarget(target, previousTarget)) throw error(409, 'The immutable production target details changed under the same identity.', 'RESIN_TARGET_MISMATCH');
        // A delayed repeat must not clear the current target's newer approval.
        return publicValue(clone(job));
      }
      if (target.kind !== 'replacement' || target.cycle <= previousTarget.cycle) throw error(409, 'A replacement target requires a newer studio-authorized QC cycle.', 'RESIN_TARGET_INVALID');
      if ((job.resinProduction?.targetHistory || []).some(item => item.target?.id === target.id) || job.runs.some(run => run.targetId === target.id)) throw error(409, 'An earlier production target identity cannot be reused.', 'RESIN_TARGET_MISMATCH');
      return this._mutate(() => {
        const current = this._job(id);
        this._quantities(current);
        const production = current.resinProduction;
        production.targetHistory ||= [];
        production.targetHistory.push({ target: clone(previousTarget), printedParts: production.printedParts, localPrintedParts: production.localPrintedParts, baselinePrintedParts: production.baselinePrintedParts || 0 });
        delete production.baselinePrintedParts;
        delete production.authorization;
        delete production.portalProgress;
        delete production.plan;
        production.target = target;
        production.targetVerified = true;
        this._quantities(current);
        this._invalidateResinPermits(id);
        this._transition(current, 'review', 'Adopted the studio replacement target. Source, captured slice and prior production remain available; preparation can now be revised.');
        return publicValue(current);
      });
    });
  }

  async reviewResinProductionPlan(issuer, id, { receipt, deviceFingerprint, confirmedWholeModel, ticket } = {}) {
    this._resinIssuer(issuer);
    if (confirmedWholeModel !== true) throw error(400, 'Confirm that the entire imported source model represents one ordered production unit.', 'RESIN_UNIT_PLAN_REQUIRED');
    return this._withLocks([`job:${id}`], async () => {
      const job = this._job(id);
      if (!['review', 'cancelled'].includes(job.status) || this._currentRun(job)) throw error(409, 'Resolve this job before reviewing its production plan.', 'JOB_BUSY');
      const bindings = await this._resinDispatchBindings(job, receipt, deviceFingerprint);
      const target = resinTarget(job, ticket), previousTarget = job.resinProduction?.target || resinTarget(job);
      if (ticket && (ticket.id !== job.order.portalJobId || ticket.ticketFingerprint !== job.order.ticketFingerprint || ticket.ticket?.specifications?.project?.quantity !== job.order.requestedQuantity || ticket.status !== 'preparing')) throw error(409, 'Review a current preparing ticket before changing its production plan.', 'RESIN_TARGET_INVALID');
      const changedTarget = target.id !== previousTarget.id;
      if (!changedTarget && job.resinProduction?.targetVerified && (!ticket?.production?.target || !sameTarget(target, previousTarget))) throw error(409, 'The immutable production target details changed under the same identity.', 'RESIN_TARGET_MISMATCH');
      if (changedTarget && (!ticket || target.kind !== 'replacement' || target.cycle <= previousTarget.cycle)) throw error(409, 'A new replacement target requires an explicit studio-authorized QC cycle.', 'RESIN_TARGET_INVALID');
      if (changedTarget && ((job.resinProduction?.targetHistory || []).some(item => item.target?.id === target.id) || job.runs.some(run => run.targetId === target.id))) throw error(409, 'An earlier production target identity cannot be reused.', 'RESIN_TARGET_MISMATCH');
      if (target.requiredParts < 1) throw error(409, 'This correction target authorizes finishing work without another physical print.', 'RESIN_TARGET_COMPLETE');
      const previousPlan = job.resinProduction?.plan;
      if (!changedTarget && ['pending', 'approved'].includes(previousPlan?.approvalState) && Object.entries(bindings).some(([key, value]) => previousPlan[key] !== value)) throw error(409, 'Resolve the current preparation approval before replacing its production plan.', 'RESIN_APPROVAL_LOCKED');
      return this._mutate(() => {
        const current = this._job(id);
        current.resinProduction ||= {};
        if (changedTarget) {
          current.resinProduction.targetHistory ||= [];
          current.resinProduction.targetHistory.push({ target: clone(previousTarget), printedParts: current.resinProduction.printedParts || 0 });
          delete current.resinProduction.baselinePrintedParts;
          delete current.resinProduction.authorization;
        }
        current.resinProduction.target = target;
        current.resinProduction.targetVerified = Boolean(ticket?.production?.target);
        this._quantities(current);
        current.resinProduction.plan = { ...(changedTarget ? {} : previousPlan), ...bindings, ...targetFields(target), confirmedWholeModel: true, reviewedAt: this._now() };
        this._invalidateResinPermits(id);
        this._transition(current, 'review', 'One source instance represents one ordered unit. Authoritative qualification and per-run printer readiness are still required.');
        return publicValue(current);
      });
    });
  }

  async withResinPreparationEvidence(issuer, id, { receipt, deviceFingerprint, operationId, expectedVersion } = {}, operation) {
    this._resinIssuer(issuer);
    if (typeof operation !== 'function') throw error(400, 'A trusted preparation approval operation is required.', 'RESIN_APPROVAL_OPERATION_REQUIRED');
    return this._withLocks([`job:${id}`], async () => {
      const job = this._job(id);
      if (job.status !== 'review' || this._currentRun(job)) throw error(409, 'Resolve this job before sending preparation approval.', 'JOB_BUSY');
      const bindings = await this._resinDispatchBindings(job, receipt, deviceFingerprint);
      const plan = job.resinProduction?.plan;
      if (!plan || plan.confirmedWholeModel !== true || Object.entries(bindings).some(([key, value]) => plan[key] !== value)) throw error(409, 'The preparation evidence no longer matches the reviewed production plan.', 'RESIN_APPROVAL_PLAN_MISMATCH');
      if (plan.approvalState === 'approved') throw error(409, 'This preparation approval is already committed. Replay its saved operation instead of issuing another approval.', 'RESIN_APPROVAL_LOCKED');
      if (plan.approvalState === 'pending' && plan.approvalOperationId && plan.approvalOperationId !== operationId) throw error(409, 'A pending approval belongs to another saved operation.', 'RESIN_APPROVAL_LOCKED');
      if (plan.withdrawalVersion && (!Number.isSafeInteger(expectedVersion) || expectedVersion < plan.withdrawalVersion)) throw error(409, 'Refresh the reopened preparation before sending another approval.', 'RESIN_AUTHORIZATION_STALE');
      if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || (plan.approvalState === 'pending' && plan.approvalExpectedVersion && plan.approvalExpectedVersion !== expectedVersion))) throw error(409, 'The approval operation must retain its expected portal version.', 'RESIN_APPROVAL_PLAN_MISMATCH');
      await this._mutate(() => {
        const current = this._job(id);
        current.resinProduction.plan.approvalState = 'pending';
        if (operationId !== undefined) {
          if (!UUID.test(operationId)) throw error(409, 'Preparation approval requires its saved operation identity.', 'RESIN_APPROVAL_OPERATION_REQUIRED');
          current.resinProduction.plan.approvalOperationId = operationId;
        }
        if (expectedVersion !== undefined) current.resinProduction.plan.approvalExpectedVersion = expectedVersion;
        current.resinProduction.plan.approvalRequestedAt = this._now();
      });
      // Keep the job lock until both RPC and local acknowledgement persist.
      // Any error after invocation leaves the durable pending state intact;
      // the same remote operation must be replayed, never assumed unsent.
      const result = await operation();
      const ticket = result?.ticket;
      if (!ticket || ticket.id !== job.order.portalJobId || ticket.ticketFingerprint !== job.order.ticketFingerprint || ticket.status !== 'queued' || !Number.isSafeInteger(ticket.version) || ticket.version < 1 || ticket.production?.approvedReceiptId !== bindings.receiptId || ticket.ticket?.specifications?.project?.quantity !== job.order.requestedQuantity) throw error(409, 'The portal did not confirm this exact queued preparation approval. Replay its saved operation.', 'RESIN_APPROVAL_UNCONFIRMED');
      if (resinTarget(job, ticket).id !== plan.targetId || (ticket.production?.target && (ticket.production.approvedTargetId !== plan.targetId || (job.resinProduction.targetVerified && !sameTarget(resinTarget(job, ticket), job.resinProduction.target))))) throw error(409, 'The portal approval refers to another production target.', 'RESIN_TARGET_MISMATCH');
      await this._mutate(() => {
        const current = this._job(id);
        current.resinProduction.plan.approvalState = 'approved';
        current.resinProduction.plan.approvedAt = this._now();
        current.resinProduction.plan.approvalVersion = ticket.version;
      });
      return result;
    });
  }

  async releaseResinPreparationApproval(issuer, id, { receiptId, operationId } = {}) {
    this._resinIssuer(issuer);
    return this._withLocks([`job:${id}`], () => this._mutate(() => {
      const job = this._job(id), plan = job.resinProduction?.plan;
      if (!UUID.test(receiptId || '') || !plan || plan.receiptId !== receiptId || this._currentRun(job)) throw error(409, 'The dismissed operation does not match this pending preparation approval.', 'RESIN_APPROVAL_PLAN_MISMATCH');
      if (plan.approvalOperationId && operationId !== plan.approvalOperationId) throw error(409, 'This dismissal refers to an older preparation generation.', 'RESIN_APPROVAL_PLAN_MISMATCH');
      if (plan.approvalState === 'approved') throw error(409, 'A confirmed portal approval cannot be released as an unsent operation.', 'RESIN_APPROVAL_RELEASE_FORBIDDEN');
      this._invalidateResinPermits(id);
      delete plan.approvalState;
      delete plan.approvalRequestedAt;
      delete plan.approvedAt;
      delete plan.approvalVersion;
      delete plan.approvalExpectedVersion;
      delete plan.approvalOperationId;
      plan.approvalReleasedAt = this._now();
      return publicValue(job);
    }));
  }

  async applyResinPreparationWithdrawal(issuer, id, { ticket, receiptId, operationId, withdrawalVersion } = {}) {
    this._resinIssuer(issuer);
    return this._withLocks([`job:${id}`], () => this._mutate(() => {
      const job = this._job(id), plan = job.resinProduction?.plan;
      if (!plan || !UUID.test(operationId || '') || plan.receiptId !== receiptId || this._currentRun(job) || ticket?.id !== job.order.portalJobId || ticket.ticketFingerprint !== job.order.ticketFingerprint ||
          ticket.status !== 'preparing' || !Number.isSafeInteger(ticket.version) || ticket.production?.approvedReceiptId || ticket.production?.approvedTargetId || ticket.production?.run?.status === 'printing' || resinTarget(job, ticket).id !== plan.targetId ||
          (job.resinProduction.targetVerified && (!ticket.production?.target || !sameTarget(resinTarget(job, ticket), job.resinProduction.target)))) throw error(409, 'The portal did not confirm withdrawal of this stopped preparation target.', 'RESIN_WITHDRAWAL_UNCONFIRMED');
      if (plan.withdrawalOperationId === operationId) return publicValue(job);
      const confirmedVersion = withdrawalVersion ?? ticket.version;
      if (!Number.isSafeInteger(confirmedVersion) || confirmedVersion > ticket.version || confirmedVersion <= Math.max(plan.approvalVersion || 0, plan.approvalExpectedVersion || 0, plan.withdrawalVersion || 0)) throw error(409, 'An older withdrawal cannot clear a newer preparation approval.', 'RESIN_WITHDRAWAL_STALE');
      this._invalidateResinPermits(id);
      plan.approvalState = 'withdrawn'; plan.withdrawalOperationId = operationId; plan.withdrawalVersion = confirmedVersion; plan.withdrawnAt = this._now();
      delete plan.approvalRequestedAt; delete plan.approvedAt; delete plan.approvalVersion; delete plan.approvalOperationId; delete plan.approvalExpectedVersion;
      delete job.resinProduction.authorization;
      this._transition(job, 'review', 'Portal preparation withdrawn. The original ticket and production history are preserved.');
      return publicValue(job);
    }));
  }

  _validateResinAuthorization(job, bindings, proof, previous) {
    const { authorization, receipt, ticket } = proof || {};
    const progress = ticket?.production?.progress;
    const target = resinTarget(job, ticket);
    if (job.resinProduction?.targetVerified && (!ticket?.production?.target || !sameTarget(target, job.resinProduction.target))) throw error(409, 'The fresh proof changed immutable production target details.', 'RESIN_TARGET_MISMATCH');
    const checked = Date.parse(authorization?.checkedAt);
    const expires = Date.parse(authorization?.expiresAt);
    if (!authorization || authorization.qualified !== true || !fresh(authorization.checkedAt) || !Number.isFinite(expires) || expires <= Date.now() || expires - checked > 35000 || expires <= checked || !SHA256.test(authorization.qualificationFingerprint || '') || !ticket || ticket.id !== job.order.portalJobId || ticket.ticketFingerprint !== job.order.ticketFingerprint || ticket.status !== 'queued' || !Number.isSafeInteger(ticket.version) || ticket.version < 1 || ticket.production?.approvedReceiptId !== bindings.receiptId || ticket.ticket?.specifications?.project?.quantity !== job.order.requestedQuantity || ticket.ticket?.specifications?.production?.printType !== 'resin' || !progress || progress.requestedParts !== target.requiredParts || !Number.isSafeInteger(progress.printedParts) || progress.printedParts < 0 || !Number.isSafeInteger(progress.remainingParts) || progress.remainingParts < 1 || progress.printedParts + progress.remainingParts !== progress.requestedParts) throw error(409, 'The portal did not provide current qualified authorization for a queued resin unit.', 'RESIN_AUTHORIZATION_REQUIRED');
    const expected = { jobVersion: ticket.version, ticketFingerprint: job.order.ticketFingerprint, receiptId: bindings.receiptId, sourceSha256: bindings.sourceSha256, artifactSha256: bindings.artifactSha256, profileSha256: bindings.profileSha256, engineSha256: bindings.engineSha256, deviceFingerprint: bindings.deviceFingerprint, printerId: bindings.printerId, printerModel: bindings.printerModel, material: bindings.material, format: bindings.format, partsPerRun: 1, plannedParts: 1, remainingParts: progress.remainingParts };
    if (ticket.production?.target || authorization.targetId !== undefined) Object.assign(expected, targetFields(target));
    if (ticket.production?.target && ticket.production.approvedTargetId !== target.id) throw error(409, 'The approved receipt belongs to another production target.', 'RESIN_TARGET_MISMATCH');
    if (Object.entries(expected).some(([key, value]) => authorization[key] !== value) || !receipt || receipt.id !== bindings.receiptId) throw error(409, 'The fresh authorization does not match this production plan.', 'RESIN_AUTHORIZATION_MISMATCH');
    if (previous && (authorization.qualificationFingerprint !== previous.qualificationFingerprint || authorization.jobVersion !== previous.jobVersion || (previous.targetId && previous.targetId !== target.id))) throw error(409, 'Production qualification, target or portal version changed before start.', 'RESIN_AUTHORIZATION_CHANGED');
    return { authorization: { ...clone(authorization), ...targetFields(target) }, progress: clone(progress), target };
  }

  async issueResinDispatchPermit(issuer, id, { printerId, authorization, receipt, ticket, deviceFingerprint, observedAt } = {}) {
    this._resinIssuer(issuer);
    return this._withLocks([`job:${id}`, `printer:${printerId}`], async () => {
      if (this.state.settings.resinEngine?.dispatchEnabled !== true) throw error(409, 'Qualified resin dispatch is disabled in local Settings.', 'RESIN_DISPATCH_DISABLED');
      const job = this._job(id), printer = this._printer(printerId);
      if (job.status !== 'review' || this._currentRun(job) || printer.type !== 'sdcp') throw error(409, 'The resin ticket and SDCP printer are not available for a new run.', 'JOB_NOT_READY');
      if (!fresh(observedAt)) throw error(409, 'Refresh production authorization before requesting a start permit.', 'RESIN_AUTHORIZATION_STALE');
      const bindings = await this._resinDispatchBindings(job, receipt, deviceFingerprint);
      if (bindings.printerId !== printer.id) throw error(409, 'The qualified slice is bound to a different local printer. Bind the profile to this printer and prepare it again.', 'RESIN_PRINTER_BINDING_MISMATCH');
      const plan = job.resinProduction?.plan;
      if (!plan || plan.confirmedWholeModel !== true || Object.entries(bindings).some(([key, value]) => plan[key] !== value)) throw error(409, 'Review the exact single-unit production plan before authorizing a run.', 'RESIN_UNIT_PLAN_REQUIRED');
      const checked = this._validateResinAuthorization(job, bindings, { authorization, receipt, ticket });
      if (ticket.version <= (plan.withdrawalVersion || 0) || ticket.version < (plan.approvalVersion || 0)) throw error(409, 'Refresh production authorization after the latest preparation change.', 'RESIN_AUTHORIZATION_STALE');
      if ((plan.targetId || job.order.portalJobId) !== checked.target.id || (job.resinProduction?.target?.id || job.order.portalJobId) !== checked.target.id) throw error(409, 'Review this exact current production target before another run.', 'RESIN_TARGET_MISMATCH');
      const adapter = await this._adapter(printer);
      if (typeof adapter.attributes !== 'function') throw error(409, 'The printer cannot provide qualified SDCP identity.', 'RESIN_PRINTER_REQUIRED');
      const actual = require('../adapters/sdcp-identity').fingerprintSDCPDevice(printer, await adapter.attributes());
      if (actual !== deviceFingerprint) throw error(409, 'The actual SDCP printer identity differs from the qualified device.', 'RESIN_DEVICE_MISMATCH');
      const quantityView = clone(job);
      this._quantities(quantityView);
      const local = quantityView.resinProduction;
      const baseline = local.baselinePrintedParts ?? checked.progress.printedParts - local.localPrintedParts;
      if (!Number.isSafeInteger(baseline) || baseline < 0 || baseline + local.localPrintedParts !== checked.progress.printedParts) throw error(409, 'The portal has not confirmed the local printed-unit progress.', 'RESIN_PORTAL_PROGRESS_UNCONFIRMED');
      await this._mutate(() => {
        const current = this._job(id);
        current.resinProduction.baselinePrintedParts = baseline;
        current.resinProduction.target = checked.target;
        current.resinProduction.targetVerified = Boolean(ticket.production?.target);
        current.resinProduction.plan.approvalState = 'approved';
        current.resinProduction.plan.approvalVersion = Math.max(current.resinProduction.plan.approvalVersion || 0, ticket.version);
        current.resinProduction.portalProgress = checked.progress;
        current.resinProduction.authorization = { ...checked.authorization, observedAt };
        this._quantities(current);
      });
      for (const [key, value] of this._resinDispatchPermits) if (value.expires <= Date.now()) this._resinDispatchPermits.delete(key);
      if (this._resinDispatchPermits.size >= 100) throw error(429, 'Too many unconsumed resin permits. Wait for them to expire.', 'RESIN_PERMIT_LIMIT');
      const permitId = crypto.randomUUID(), expires = Math.min(Date.now() + 30000, Date.parse(authorization.expiresAt));
      this._resinDispatchPermits.set(permitId, { id, printerId, issuer, receipt: clone(receipt), authorization: checked.authorization, target: checked.target, bindings, printerFingerprint: configurationFingerprint(printer), expires });
      return { permitId, expiresAt: new Date(expires).toISOString(), jobId: id, printerId };
    });
  }

  async dispatchQualifiedResinJob(id, { permitId, confirmedReady } = {}) {
    if (confirmedReady !== true) throw error(400, 'Explicitly confirm physical printer readiness for this individual run.', 'CONFIRMATION_REQUIRED');
    const initial = this._resinDispatchPermits.get(permitId);
    if (!initial || initial.id !== id) throw error(409, 'A fresh one-use production permit is required.', 'RESIN_PERMIT_REQUIRED');
    return this._withLocks([`job:${id}`, `printer:${initial.printerId}`], async () => {
      const permit = this._resinDispatchPermits.get(permitId);
      this._resinDispatchPermits.delete(permitId);
      if (!permit || permit.id !== id || permit.expires <= Date.now()) throw error(409, 'The one-use resin permit expired or was consumed.', 'RESIN_PERMIT_EXPIRED');
      const authority = this._resinIssuer(permit.issuer);
      const job = this._job(id), printer = this._printer(permit.printerId);
      if (!sameTarget(job.resinProduction?.target || resinTarget(job), permit.target) || (job.resinProduction?.plan?.targetId || job.order.portalJobId) !== permit.target.id ||
          Object.entries(targetFields(permit.target)).some(([key, value]) => job.resinProduction?.plan?.[key] !== undefined && job.resinProduction.plan[key] !== value)) throw error(409, 'The production target changed after this permit was issued.', 'RESIN_TARGET_MISMATCH');
      if (this.state.settings.resinEngine?.dispatchEnabled !== true) throw error(409, 'Qualified resin dispatch is disabled.', 'RESIN_DISPATCH_DISABLED');
      if (job.resinProduction?.plan?.approvalState !== 'approved') throw error(409, 'The local preparation has been withdrawn or is no longer approved.', 'RESIN_APPROVAL_LOCKED');
      if (job.status !== 'review' || this._currentRun(job) || this.state.jobs.some(other => other.id !== id && other.printerId === printer.id && this._currentRun(other))) throw error(409, 'Resolve this printer’s active or uncertain job before starting another unit.', 'PRINTER_BUSY');
      if (configurationFingerprint(printer) !== permit.printerFingerprint) throw error(409, 'Printer configuration changed after authorization.', 'PRINTER_MISMATCH');
      const bindings = await this._resinDispatchBindings(job, permit.receipt, permit.bindings.deviceFingerprint);
      if (JSON.stringify(bindings) !== JSON.stringify(permit.bindings)) throw error(409, 'The approved production artifact changed.', 'RESIN_RECEIPT_MISMATCH');
      const adapter = await this._adapter(printer);
      const identity = require('../adapters/sdcp-identity');
      const inspectDevice = async () => {
        const attributes = await adapter.attributes();
        if (identity.fingerprintSDCPDevice(printer, attributes) !== permit.bindings.deviceFingerprint || !attributes.Capabilities?.includes('PRINT_CONTROL') || !attributes.Capabilities?.includes('FILE_TRANSFER') || !attributes.SupportFileType?.some(format => String(format).toLowerCase() === 'goo')) throw error(409, 'Printer identity, firmware or GOO capabilities changed.', 'RESIN_DEVICE_MISMATCH');
        const status = this._status(await adapter.status(), true);
        if (status.state !== 'idle' || !fresh(status.observedAt)) throw error(409, 'The printer must report fresh idle telemetry.', 'PRINTER_NOT_READY');
      };
      if (adapter.capabilities?.upload !== true || adapter.capabilities?.start !== true || typeof adapter.attributes !== 'function') throw error(409, 'The SDCP adapter cannot upload and start qualified resin files.', 'CAPABILITY_UNSUPPORTED');
      await inspectDevice();
      if (permit.expires <= Date.now()) throw error(409, 'Refresh the resin permit before transfer.', 'RESIN_PERMIT_EXPIRED');
      const runId = crypto.randomUUID(), remoteName = `qp-${id.slice(0, 8)}-${runId.slice(0, 8)}-prepared.goo`;
      await this._mutate(() => {
        const current = this._job(id);
        current.printerId = printer.id;
        current.runs.push({ id: runId, technology: 'resin', ...targetFields(permit.target), printerId: printer.id, printerType: 'sdcp', printerFingerprint: permit.printerFingerprint, phase: 'uploading', createdAt: this._now(), artifactSha256: bindings.artifactSha256, profileSha256: bindings.profileSha256, sourceSha256: bindings.sourceSha256, engineSha256: bindings.engineSha256, receiptId: bindings.receiptId, deviceFingerprint: bindings.deviceFingerprint, qualificationFingerprint: permit.authorization.qualificationFingerprint, plannedParts: 1, fileName: remoteName });
        current.currentRunId = runId;
        delete current.error;
        this._transition(current, 'dispatching', 'Qualified one-unit dispatch intent saved before transfer.', { runId });
      });
      let startRequested = false;
      try {
        const upload = await adapter.upload({ filePath: job.resinSlice.filePath, fileName: remoteName });
        if (!upload?.remotePath || basename(upload.remotePath) !== remoteName) throw error(502, 'Upload did not return this run’s exact remote filename.', 'UPLOAD_IDENTITY');
        await this._mutate(() => { const run = this._currentRun(this._job(id)); run.remotePath = upload.remotePath; run.phase = 'uploaded'; });
        const context = { jobId: id, ...targetFields(permit.target), portalJobId: job.order.portalJobId, portalUrl: job.order.portalUrl, printerId: printer.id, receiptId: bindings.receiptId, runId, deviceFingerprint: bindings.deviceFingerprint, artifactSha256: bindings.artifactSha256, profileSha256: bindings.profileSha256, sourceSha256: bindings.sourceSha256, engineSha256: bindings.engineSha256, plannedParts: 1, authorization: clone(permit.authorization) };
        const proof = await authority.reauthorize(clone(context));
        await this._resinDispatchBindings(job, proof?.receipt, bindings.deviceFingerprint);
        const refreshed = this._validateResinAuthorization(job, bindings, proof, permit.authorization);
        await inspectDevice();
        this._assertReady();
        if (this.state.settings.resinEngine?.dispatchEnabled !== true || configurationFingerprint(this._printer(printer.id)) !== permit.printerFingerprint || !fresh(refreshed.authorization.checkedAt) || Date.parse(refreshed.authorization.expiresAt) <= Date.now()) throw error(409, 'Production authorization or local dispatch readiness changed before start.', 'RESIN_AUTHORIZATION_CHANGED');
        await this._mutate(() => {
          const run = this._currentRun(this._job(id));
          run.phase = 'starting'; run.startRequestedAt = this._now(); run.authorization = refreshed.authorization;
        });
        this._assertReady();
        if (this.state.settings.resinEngine?.dispatchEnabled !== true || !fresh(refreshed.authorization.checkedAt) || Date.parse(refreshed.authorization.expiresAt) <= Date.now()) throw error(409, 'Production authorization expired or dispatch was disabled while saving the start intent.', 'RESIN_AUTHORIZATION_CHANGED');
        startRequested = true;
        const started = await adapter.start({ remotePath: upload.remotePath, jobId: runId });
        const requestedAt = this._currentRun(this._job(id)).startRequestedAt;
        if (started?.acknowledged !== true || typeof started.remoteId !== 'string' || !started.remoteId || started.currentFile !== remoteName || !fresh(started.observedAt) || Date.parse(started.observedAt) < Date.parse(requestedAt)) throw error(502, 'The printer did not identify a fresh new task for this exact file. Inspect the printer.', 'RESIN_START_UNCERTAIN');
        return await this._mutate(() => {
          const current = this._job(id), run = this._currentRun(current);
          run.remoteId = started.remoteId; run.phase = 'observed'; run.startedAt = this._now(); run.observedPrintingAt = started.observedAt;
          run.startEvidence = { remoteId: started.remoteId, currentFile: started.currentFile, observedAt: started.observedAt };
          this._transition(current, 'printing', 'SDCP identified this qualified one-unit print. No production or QC credit has been applied.', { runId });
          return publicValue(current);
        });
      } catch (failure) {
        await this._mutate(() => {
          const current = this._job(id), run = this._currentRun(current);
          current.error = this._safeMessage(failure.message);
          if (startRequested) { run.phase = 'result_unknown'; this._transition(current, 'needs_attention', 'Start result is uncertain. Do not retry until this run is reconciled.', { runId }); }
          else { run.phase = 'resolved'; run.outcome = 'not_started'; run.printedParts = 0; run.resolvedAt = this._now(); current.currentRunId = null; this._quantities(current); this._transition(current, 'review', 'Transfer or renewed qualification failed before any print start.', { runId }); }
        });
        throw this._publicError(failure);
      }
    });
  }

  async reconcileResinRun(id, { runId, outcome, printedParts = 0, notes = '' } = {}) {
    if (!OUTCOMES.has(outcome) || !Number.isInteger(printedParts) || printedParts < 0 || printedParts > 1 || (outcome !== 'completed' && printedParts !== 0)) throw error(400, 'Record zero or one printed unit; only a completed run can contribute production.', 'RESIN_RECONCILIATION_INVALID');
    const printerId = this._job(id).printerId;
    return this._withLocks([`job:${id}`, `printer:${printerId}`], async () => {
      const existingJob = this._job(id);
      if (existingJob.technology !== 'resin') throw error(409, 'Select a resin production run.', 'RESIN_TICKET_REQUIRED');
      const existingRun = existingJob.runs.find(item => item.id === runId && item.technology === 'resin');
      if (!existingRun) throw error(409, 'Choose the exact resin run to reconcile.', 'STALE_RECONCILIATION');
      if (!existingRun.resolvedAt && printedParts === 0) {
        try {
          const adapter = await this._adapter(this._printer(printerId));
          const status = this._status(await adapter.status(), true);
          if (['printing', 'paused'].includes(status.state)) throw error(409, 'The printer still reports an active run. Confirm it has stopped before releasing this run.', 'RESIN_RUN_ACTIVE');
        } catch (failure) { if (failure.code === 'RESIN_RUN_ACTIVE') throw failure; }
      }
      return this._mutate(() => {
      const job = this._job(id);
      if (job.technology !== 'resin') throw error(409, 'Select a resin production run.', 'RESIN_TICKET_REQUIRED');
      const run = job.runs.find(item => item.id === runId && item.technology === 'resin');
      if (!run) throw error(409, 'Choose the exact resin run to reconcile.', 'STALE_RECONCILIATION');
      if (run.resolvedAt) {
        if (run.reconciliation?.outcome === outcome && run.reconciliation.printedParts === printedParts) return publicValue(job);
        throw error(409, 'This resin run already has a different reconciliation.', 'STALE_RECONCILIATION');
      }
      if (job.currentRunId !== runId || job.status !== 'needs_attention') throw error(409, 'Wait for a terminal result or reconcile an uncertain run after inspection.', 'RUN_NOT_REVIEWABLE');
      if (printedParts > 0 && (outcome !== 'completed' || run.terminalEvidence?.outcome !== 'completed' || !run.startEvidence || !this._matchesRun(run.terminalEvidence, run))) throw error(409, 'Positive production requires the service’s identified start and completed terminal evidence.', 'RESIN_TERMINAL_EVIDENCE_REQUIRED');
      this._quantities(job);
      if (job.resinProduction.printedParts + printedParts > job.resinProduction.requestedParts) throw error(409, 'Printed units exceed the ordered production quantity.', 'QUANTITY_EXCEEDED');
      const reviewedAt = this._now();
      run.outcome = outcome; run.printedParts = printedParts; run.resolvedAt = reviewedAt; run.phase = 'resolved';
      run.reconciliation = { outcome, printedParts, reviewedAt, notes: text(notes, 5000) };
      this._invalidateResinPermits(id);
      if (printedParts === 0 && job.resinProduction?.plan) {
        delete job.resinProduction.plan.approvalState;
        delete job.resinProduction.plan.approvalRequestedAt;
        delete job.resinProduction.plan.approvedAt;
        delete job.resinProduction.plan.approvalVersion;
      }
      job.currentRunId = null;
      delete job.error; delete job.progress;
      this._quantities(job);
      this._transition(job, 'review', 'Resin run reviewed. Portal production confirmation, further units and QC remain separate.', { runId });
      return publicValue(job);
      });
    });
  }

  _resinProfileSlot(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw error(400, 'Choose a valid resin profile slot.', 'RESIN_PROFILE_SLOT_INVALID');
    const slot = this.state.settings.resinEngine?.slots?.find(item => item.id === id);
    if (!slot) throw error(404, 'Resin profile slot not found. Save the slot in Settings first.', 'RESIN_PROFILE_SLOT_NOT_FOUND');
    return clone(slot);
  }

  async getResinProfileSlot(id) {
    return this._withLocks([`resin:profile:${id}`], async () => {
      const slot = this._resinProfileSlot(id);
      const loaded = await require('../slicing/resin-engine').loadProfile(slot.profilePath);
      if (JSON.stringify(this._resinProfileSlot(id)) !== JSON.stringify(slot)) throw error(409, 'This resin profile slot changed while loading. Refresh it before editing.', 'RESIN_PROFILE_SLOT_CHANGED');
      return { slot, profile: require('../slicing/resin-profiles').profileView(loaded), profileSha256: loaded.profileSha256 };
    });
  }

  async customizeResinProfileSlot(id, patch) {
    return this._withLocks([`resin:profile:${id}`], async () => {
      const slot = this._resinProfileSlot(id);
      const { loadProfile } = require('../slicing/resin-engine');
      const { customizeProfile, profileView } = require('../slicing/resin-profiles');
      const loaded = await loadProfile(slot.profilePath);
      let customization = patch;
      if (patch && typeof patch === 'object' && !Array.isArray(patch) && Object.hasOwn(patch, 'expectedProfileSha256')) {
        const { expectedProfileSha256, ...edits } = patch;
        if (typeof expectedProfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProfileSha256) || expectedProfileSha256 !== loaded.profileSha256) throw error(409, 'This resin profile changed since the editor loaded. Reload it before saving.', 'RESIN_PROFILE_SOURCE_CHANGED');
        customization = edits;
      }
      const customized = customizeProfile(loaded, customization);
      const selectedPrinterId = customization && Object.hasOwn(customization, 'printerId') ? customization.printerId : null;
      const validatePrinterBinding = () => {
        if (!selectedPrinterId) return;
        const selected = this.state.printers.find(item => item.id === selectedPrinterId);
        if (!selected || selected.type !== 'sdcp') throw error(409, 'Choose an existing configured SDCP printer for this resin profile.', 'RESIN_PROFILE_PRINTER_INVALID');
      };
      validatePrinterBinding();
      const managedRoot = path.resolve(this.dataDir, 'profiles', 'resin');
      await fs.mkdir(managedRoot, { recursive: true, mode: 0o700 });
      const rootRelative = path.relative(await fs.realpath(this.dataDir), await fs.realpath(managedRoot));
      if (!rootRelative || rootRelative === '..' || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) throw error(409, 'Managed resin profiles must remain inside this workspace.', 'RESIN_PROFILE_PATH_INVALID');
      const directory = await fs.mkdtemp(path.join(managedRoot, 'profile-'));
      let saved = false;
      try {
        const profilePath = path.join(directory, 'profile.json');
        await fs.writeFile(path.join(directory, 'preset.ini'), customized.preset, { flag: 'wx', mode: 0o600 });
        await fs.writeFile(profilePath, JSON.stringify(customized.profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        // Validate the actual files that will be selected, not only the patch.
        const snapshot = await loadProfile(profilePath);
        if ((await loadProfile(slot.profilePath)).profileSha256 !== loaded.profileSha256) throw error(409, 'The source resin profile changed while editing. Reload it and retry.', 'RESIN_PROFILE_SOURCE_CHANGED');
        const result = await this._mutate(() => {
          this._assertReady();
          validatePrinterBinding();
          let current;
          try { current = this._resinProfileSlot(id); }
          catch { throw error(409, 'This resin profile slot was removed while editing. Refresh Settings.', 'RESIN_PROFILE_SLOT_CHANGED'); }
          if (JSON.stringify(current) !== JSON.stringify(slot)) throw error(409, 'This resin profile slot changed while editing. Reload it and retry.', 'RESIN_PROFILE_SLOT_CHANGED');
          // Read current settings here so unrelated concurrent edits survive.
          const selected = { ...current, profilePath };
          this.state.settings.resinEngine.slots = this.state.settings.resinEngine.slots.map(item => item.id === id ? selected : item);
          this._event({ type: 'settings', message: `Customized resin profile slot ${selected.name}; existing artifacts retain their recorded profile hashes.` });
          return { slot: selected, profile: profileView(snapshot), profileSha256: snapshot.profileSha256 };
        });
        saved = true;
        return result;
      } finally {
        if (!saved) {
          // Only remove the uniquely created managed directory, never a source
          // profile or a path supplied by an API request.
          const relative = path.relative(managedRoot, path.resolve(directory));
          if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) await fs.rm(directory, { recursive: true, force: true });
        }
      }
    });
  }

  async prepareJob(id, printerId) {
    return this._withLocks([`job:${id}`, `printer:${printerId}`], async () => {
      const job = this._job(id);
      if (job.technology === 'resin' || job.order?.production?.printType === 'resin') throw error(409, 'Use Slice resin model with a reviewed resin engine profile for this ticket. Generic printer preparation is unavailable for resin.', 'RESIN_SLICING_UNAVAILABLE');
      const printer = this._printer(printerId);
      if (ACTIVE.has(job.status) || this._currentRun(job)) throw error(409, 'Resolve the current print run before preparing another artifact.', 'JOB_BUSY');
      if (job.acceptedQuantity >= job.quantity) throw error(409, 'This order already has its requested accepted quantity.', 'JOB_COMPLETE');
      const input = clone(job);
      const boundPrinter = clone(printer);
      const settings = clone(this.state.settings);
      const controller = new AbortController();
      this._preparations.set(id, controller);
      try {
        await this._mutate(() => {
          const current = this._job(id);
          current.printerId = printerId;
          delete current.error;
          delete current.artifact;
          this._transition(current, 'preparing', 'Preparing and validating an artifact for the selected printer.');
        });
        controller.signal.throwIfAborted();
        const source = await fs.readFile(input.inputPath);
        if (digest(source) !== input.sha256) throw error(409, 'The original file changed on disk. Import it as a new submission.', 'ORIGINAL_CHANGED');
        const implementation = this.slicer || require('../slicing');
        const prepare = typeof implementation === 'function' ? implementation : implementation.prepare;
        if (typeof prepare !== 'function') throw error(500, 'Preparation service is unavailable.', 'SLICER_UNAVAILABLE');
        const outputDir = path.join(this.dataDir, 'jobs', id, 'artifacts', crypto.randomUUID());
        await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
        controller.signal.throwIfAborted();
        const artifact = await prepare({ inputPath: input.inputPath, outputDir, printer: boundPrinter, settings, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!artifact || typeof artifact.filePath !== 'string' || !artifact.format) throw error(500, 'Preparation returned no validated artifact.', 'ARTIFACT_MISSING');
        const filePath = path.resolve(artifact.filePath);
        const relative = path.relative(outputDir, filePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw error(500, 'Preparation output is outside the job artifact folder.', 'ARTIFACT_PATH');
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size === 0) throw error(500, 'Preparation output is empty.', 'ARTIFACT_EMPTY');
        const hash = digest(await fs.readFile(filePath));
        if (artifact.sha256 && artifact.sha256 !== hash) throw error(409, 'The prepared artifact failed its integrity check.', 'ARTIFACT_INTEGRITY');
        return await this._mutate(() => {
          controller.signal.throwIfAborted();
          const current = this._job(id);
          current.artifact = {
            ...clone(artifact), filePath, fileName: fileName(artifact.fileName || path.basename(filePath)), sha256: hash,
            printerId, printerFingerprint: configurationFingerprint(boundPrinter), preparedAt: this._now(),
          };
          delete current.error;
          this._transition(current, 'ready', 'Artifact validated. Review the printer and explicitly confirm each physical start.');
          return publicValue(current);
        });
      } catch (failure) {
        const cause = controller.signal.aborted ? controller.signal.reason : failure;
        const cancelled = cause?.code === 'PREPARATION_CANCELLED';
        await this._mutate(() => {
          const current = this._job(id);
          delete current.artifact;
          if (cancelled) {
            delete current.error;
            this._transition(current, 'cancelled', 'Preparation cancelled. No printer command was sent.');
          } else {
            current.error = this._safeMessage(cause?.message || 'Preparation failed.');
            this._transition(current, 'review', `Preparation stopped: ${current.error}`);
          }
        });
        throw this._publicError(cause);
      } finally {
        if (this._preparations.get(id) === controller) this._preparations.delete(id);
      }
    });
  }

  _publicError(failure) {
    return error(failure.status || 502, this._safeMessage(failure.message || 'The operation failed.'), failure.code || 'OPERATION_FAILED');
  }

  async dispatchJob(id, printerId, { confirmed = false } = {}) {
    if (confirmed !== true) throw error(400, 'Confirm the physical printer is ready before starting a print.', 'CONFIRMATION_REQUIRED');
    return this._withLocks([`job:${id}`, `printer:${printerId}`], async () => {
      const job = this._job(id);
      if (job.technology === 'resin') throw error(409, 'Resin printer dispatch has not been qualified.', 'RESIN_DISPATCH_UNAVAILABLE');
      const printer = this._printer(printerId);
      if (job.status !== 'ready' || this._currentRun(job) || job.acceptedQuantity >= job.quantity) throw error(409, 'The job is not ready for another confirmed run.', 'JOB_NOT_READY');
      if (!job.artifact || job.printerId !== printerId || job.artifact.printerFingerprint !== configurationFingerprint(printer)) throw error(409, 'Prepare the file for this printer before dispatch.', 'PRINTER_MISMATCH');
      if (this.state.jobs.some((other) => other.id !== id && other.printerId === printerId && this._currentRun(other))) throw error(409, 'Resolve this printer’s other active or uncertain job first.', 'PRINTER_BUSY');
      const artifact = clone(job.artifact);
      if (digest(await fs.readFile(artifact.filePath)) !== artifact.sha256) throw error(409, 'The prepared artifact changed. Prepare it again.', 'ARTIFACT_CHANGED');
      const adapter = await this._adapter(printer);
      if (adapter.capabilities?.upload !== true || adapter.capabilities?.start !== true) throw error(409, 'This adapter does not support uploading and starting prints.', 'CAPABILITY_UNSUPPORTED');
      if (Array.isArray(adapter.capabilities.formats) && adapter.capabilities.formats.length) {
        const normalize = (format) => String(format).toLowerCase().replace(/^\./, '');
        const format = normalize(artifact.format);
        const allowed = adapter.capabilities.formats.map(normalize);
        if (!allowed.includes(format) && !(format === 'gcode.3mf' && allowed.includes('3mf'))) {
          throw error(409, 'This prepared artifact format is not supported by the printer adapter.', 'ARTIFACT_FORMAT');
        }
      }
      const status = this._status(await adapter.status(), printer.type === 'sdcp');
      await this._mutate(() => { this._printer(printerId).status = status; });
      if (status.state !== 'idle' || Math.abs(Date.now() - Date.parse(status.observedAt)) > 30000) throw error(409, 'The printer must report a fresh idle state before dispatch.', 'PRINTER_NOT_READY');
      const runId = crypto.randomUUID();
      const remoteName = `qp-${id.slice(0, 8)}-${runId.slice(0, 8)}-${fileName(artifact.fileName)}`;
      await this._mutate(() => {
        const current = this._job(id);
        current.runs.push({ id: runId, printerId, printerType: printer.type, phase: 'uploading', createdAt: this._now(), artifactSha256: artifact.sha256, fileName: remoteName });
        current.currentRunId = runId;
        delete current.error;
        this._transition(current, 'dispatching', 'Dispatch intent saved; uploading one file-copy.', { runId });
      });
      let upload;
      try {
        upload = await adapter.upload({ filePath: artifact.filePath, fileName: remoteName });
        if (!upload?.remotePath) throw error(502, 'Printer upload returned no remote file identity.', 'UPLOAD_IDENTITY');
      } catch (failure) {
        await this._mutate(() => {
          const current = this._job(id);
          const run = this._currentRun(current);
          run.phase = 'resolved'; run.outcome = 'not_started'; run.resolvedAt = this._now();
          current.currentRunId = null;
          current.error = this._safeMessage(failure.message);
          this._transition(current, 'ready', `Upload failed before any start command: ${current.error}`);
        });
        throw this._publicError(failure);
      }
      // This durable checkpoint MUST precede start(). On crash, it becomes an
      // operator/reconciliation hold, never an automatic retry.
      await this._mutate(() => {
        const run = this._currentRun(this._job(id));
        run.remotePath = text(upload.remotePath, 2000);
        run.remoteId = text(typeof adapter.deriveRemoteId === 'function' ? adapter.deriveRemoteId(runId) : runId, 500);
        run.phase = 'starting';
        run.startRequestedAt = this._now();
      });
      try {
        const started = await adapter.start({ remotePath: upload.remotePath, jobId: runId });
        if (started?.acknowledged !== true) throw error(502, 'The printer did not acknowledge the start. Check the printer before resolving this run.', 'START_UNKNOWN');
        return await this._mutate(() => {
          const current = this._job(id);
          const run = this._currentRun(current);
          run.phase = 'acknowledged'; run.startedAt = this._now();
          if (started.remoteId) run.remoteId = text(started.remoteId, 500);
          this._transition(current, 'printing', 'Printer acknowledged the start. Awaiting identified telemetry and a final result.', { runId });
          this._event({ type: 'dispatch', jobId: id, printerId, message: 'One file-copy start acknowledged.' });
          return publicValue(current);
        });
      } catch (failure) {
        await this._mutate(() => {
          const current = this._job(id);
          const run = this._currentRun(current);
          run.phase = 'result_unknown';
          current.error = this._safeMessage(failure.message);
          this._transition(current, 'needs_attention', 'Start result is uncertain. Do not retry until the printer has been checked and this run reconciled.', { runId });
        });
        throw this._publicError(failure);
      }
    });
  }

  async controlJob(id, action) {
    this._assertReady();
    if (!['pause', 'resume', 'cancel'].includes(action)) throw error(400, 'Choose pause, resume, or cancel.', 'CONTROL_ACTION');
    const printerId = this._job(id).printerId;
    const preparation = action === 'cancel' ? this._preparations.get(id) : null;
    if (preparation) preparation.abort(error(409, 'Preparation cancelled by the operator.', 'PREPARATION_CANCELLED'));
    if (preparation && this._pendingPreparations.has(id)) {
      // Pending resin work owns a queue gate but has not entered the engine.
      // Persist cancellation now; its aborted callback will consume that gate
      // only after its predecessors finish, preserving lock ordering.
      return this._mutate(() => {
        const job = this._job(id);
        if (this._currentRun(job) || ACTIVE.has(job.status)) throw error(409, 'An active printer run must be controlled separately.', 'JOB_BUSY');
        delete job.resinPreparation; delete job.resinSlice; delete job.error;
        if (job.status !== 'cancelled') this._transition(job, 'cancelled', 'Queued resin preparation cancelled; the engine was not started.');
        return publicValue(job);
      });
    }
    return this._withLocks([`job:${id}`, `printer:${printerId}`], async () => {
      const job = this._job(id);
      const run = this._currentRun(job);
      if (!run) {
        if (preparation && job.status === 'cancelled') return publicValue(clone(job));
        if (action !== 'cancel' || ['completed', 'cancelled'].includes(job.status)) throw error(409, 'This job has no controllable print run.', 'NO_ACTIVE_RUN');
        return this._mutate(() => {
          const current = this._job(id);
          this._transition(current, 'cancelled', 'Outstanding job cancelled; no printer command was sent.');
          return publicValue(current);
        });
      }
      const adapter = await this._adapter(this._printer(printerId));
      if (adapter.capabilities?.[action] !== true || typeof adapter[action] !== 'function') throw error(409, `This printer does not support ${action}.`, 'CAPABILITY_UNSUPPORTED');
      const status = this._status(await adapter.status(), run.printerType === 'sdcp');
      if (Math.abs(Date.now() - Date.parse(status.observedAt)) > 30000) throw error(409, 'Refresh printer telemetry before sending controls.', 'PRINTER_STATUS_STALE');
      if (!this._matchesRun(status, run)) throw error(409, 'Printer telemetry does not identify this job. Use the printer controls directly, then reconcile in QuickPrint.', 'PRINT_IDENTITY_UNKNOWN');
      if (action === 'pause' && status.state !== 'printing') throw error(409, 'Only a printing job can be paused.');
      if (action === 'resume' && status.state !== 'paused') throw error(409, 'Only a paused job can be resumed.');
      if (action === 'cancel' && !['printing', 'paused'].includes(status.state)) throw error(409, 'The printer does not report an active run to cancel.');
      await this._mutate(() => {
        this._currentRun(this._job(id)).controlIntent = { action, at: this._now() };
      });
      try {
        await adapter[action]();
        return await this._mutate(() => {
          const current = this._job(id);
          if (action === 'cancel') {
            this._transition(current, 'needs_attention', 'Cancel command sent. Confirm the printer has stopped and reconcile the result.');
            current.error = 'Cancellation requires printer confirmation and operator reconciliation.';
          } else {
            this._transition(current, action === 'pause' ? 'paused' : 'printing', `${action === 'pause' ? 'Pause' : 'Resume'} command sent; awaiting telemetry.`);
          }
          return publicValue(current);
        });
      } catch (failure) {
        await this._mutate(() => {
          const current = this._job(id);
          current.error = this._safeMessage(failure.message);
          this._transition(current, 'needs_attention', `${action} command result is uncertain. Inspect the printer.`);
        });
        throw this._publicError(failure);
      }
    });
  }

  async reconcileJob(id, { outcome, acceptedQuantity = 0, notes = '', runId } = {}) {
    this._assertReady();
    if (this._job(id).technology === 'resin') throw error(409, 'Use resin run reconciliation; file-copy acceptance cannot grant resin production or QC credit.', 'RESIN_RECONCILIATION_REQUIRED');
    if (!OUTCOMES.has(outcome)) throw error(400, 'Choose completed, failed, cancelled, or not_started.', 'RECONCILIATION_OUTCOME');
    const accepted = integer(acceptedQuantity, 0, 0, 1);
    if (outcome !== 'completed' && accepted !== 0) throw error(400, 'Only a completed run can contribute an accepted file-copy.', 'RECONCILIATION_QUANTITY');
    const printerId = this._job(id).printerId;
    return this._withLocks([`job:${id}`, `printer:${printerId}`], () => this._mutate(() => {
      const job = this._job(id);
      const run = this._currentRun(job);
      if (runId && runId !== job.currentRunId) {
        const resolved = job.runs.find((item) => item.id === runId);
        if (resolved?.resolvedAt && resolved.outcome === outcome && resolved.acceptedQuantity === accepted) return publicValue(job);
        throw error(409, 'This reconciliation refers to a different print run. Refresh the job.', 'STALE_RECONCILIATION');
      }
      if (!run) {
        const last = job.runs.at(-1);
        if (last?.resolvedAt && last.outcome === outcome && last.acceptedQuantity === accepted) return publicValue(job);
        throw error(409, 'There is no unresolved run to reconcile.', 'NO_UNRESOLVED_RUN');
      }
      if (job.status !== 'needs_attention') throw error(409, 'Refresh the printer and wait for the run to need review before recording its outcome.', 'RUN_NOT_REVIEWABLE');
      if (job.acceptedQuantity + accepted > job.quantity) throw error(409, 'Accepted quantity would exceed the requested file-copy quantity.', 'QUANTITY_EXCEEDED');
      run.outcome = outcome;
      run.acceptedQuantity = accepted;
      run.notes = text(notes, 5000);
      run.resolvedAt = this._now();
      run.phase = 'resolved';
      job.currentRunId = null;
      delete job.error;
      delete job.progress;
      this._quantities(job);
      const next = job.remainingQuantity === 0 ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'ready';
      this._transition(job, next, `Operator reconciled run as ${outcome}; ${accepted} accepted file-copy. ${job.remainingQuantity} still required.`, { runId: run.id });
      this._event({ type: 'reconciliation', jobId: id, printerId, message: `Run reconciled as ${outcome}; accepted ${accepted}.` });
      return publicValue(job);
    }));
  }

  async setupResinCadRuntime(request = {}) {
    this._assertReady();
    if (!request || typeof request !== 'object' || Array.isArray(request) || ![Object.prototype, null].includes(Object.getPrototypeOf(request)) || Reflect.ownKeys(request).length) throw error(400, 'Managed CAD runtime setup accepts an empty request only.', 'RESIN_CAD_RUNTIME_REQUEST_INVALID');
    return this._withLocks(['resin:runtime', 'resin:engine'], async () => {
      const controller = new AbortController(), key = 'cad-runtime';
      this._preparations.set(key, controller);
      try {
        const distributionVersion = '8.0.1.1.0';
        const outputDir = path.join(this.dataDir, '.providers', 'cad-transfer', distributionVersion);
        const cadAuditPath = path.join(outputDir, 'site-packages');
        const managedDirectory = async (candidate, create = false) => {
          const relative = path.relative(this.dataDir, candidate);
          if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw error(409, 'CAD runtime setup must remain inside its managed data directory.', 'RESIN_CAD_RUNTIME_PATH_INVALID');
          let component = this.dataDir;
          for (const name of relative.split(path.sep)) {
            controller.signal.throwIfAborted();
            component = path.join(component, name);
            let stat;
            try { stat = await fs.lstat(component); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
            if (!stat) {
              if (!create) return false;
              try { await fs.mkdir(component); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
              stat = await fs.lstat(component);
            }
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw error(409, 'CAD runtime managed directories cannot be files or symbolic links.', 'RESIN_CAD_RUNTIME_PATH_INVALID');
          }
          const actual = path.relative(await fs.realpath(this.dataDir), await fs.realpath(candidate));
          if (actual === '..' || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) throw error(409, 'CAD runtime path resolves outside the managed data directory.', 'RESIN_CAD_RUNTIME_PATH_INVALID');
          return true;
        };
        // The final target stays absent for the installer's atomic staging and
        // rename. Existing targets are inspected, never removed or overwritten.
        await managedDirectory(path.dirname(outputDir), true);
        await managedDirectory(outputDir);
        controller.signal.throwIfAborted();
        const implementation = this.cadRuntime || require('../slicing/resin-cad-runtime');
        if (typeof implementation.provisionResinCadRuntime !== 'function') throw error(500, 'The CAD runtime provisioner is unavailable.', 'RESIN_CAD_RUNTIME_CONFIGURATION');
        const result = await implementation.provisionResinCadRuntime({ outputDir, signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!result || typeof result.cadAuditPath !== 'string' || !path.isAbsolute(result.cadAuditPath) || path.relative(outputDir, result.cadAuditPath) !== 'site-packages' || result.distributionVersion !== distributionVersion || typeof result.reused !== 'boolean' || !await managedDirectory(cadAuditPath)) throw error(502, 'The CAD runtime provisioner did not return its exact managed installation.', 'RESIN_CAD_RUNTIME_RESULT_INVALID');
        controller.signal.throwIfAborted();
        return await this._mutate(() => {
          controller.signal.throwIfAborted();
          this.state.settings.resinEngine ||= {};
          this.state.settings.resinEngine.cadAuditPath = cadAuditPath;
          this._event({ type: 'settings', message: 'Configured the managed STEP transfer audit runtime.' });
          return { cadAuditPath, distributionVersion, reused: result.reused };
        });
      } catch (failure) {
        throw this._publicError(controller.signal.aborted ? controller.signal.reason : failure);
      } finally {
        if (this._preparations.get(key) === controller) this._preparations.delete(key);
      }
    });
  }

  async updateSettings(patch = {}) {
    this._assertReady();
    return this._mutate(() => {
      const next = clone(this.state.settings);
      if (patch.siteName !== undefined) next.siteName = text(patch.siteName, 200) || 'QuickPrint';
      if (patch.pollIntervalMs !== undefined) next.pollIntervalMs = integer(patch.pollIntervalMs, 10000, 1000, 3600000);
      if (patch.slicer !== undefined) {
        next.slicer = slicerConfiguration(patch.slicer, next.slicer);
      }
      if (patch.resinEngine !== undefined) next.resinEngine = resinEngineConfiguration(patch.resinEngine, next.resinEngine);
      if (patch.intake !== undefined) {
        if (!patch.intake || typeof patch.intake !== 'object' || Array.isArray(patch.intake)) throw error(400, 'Intake settings must be an object.');
        if (patch.intake.enabled !== undefined) next.intake.enabled = patch.intake.enabled === true;
        if (patch.intake.port !== undefined) next.intake.port = integer(patch.intake.port, 9732, 1024, 65535);
        if (typeof patch.intake.token === 'string' && patch.intake.token.trim()) {
          if (patch.intake.token.length < 24) throw error(400, 'Use an intake token with at least 24 characters.');
          next.intake.token = patch.intake.token;
        }
      }
      this.state.settings = next;
      this._event({ type: 'settings', message: 'Updated site settings.' });
      return publicValue(next);
    });
  }

  async saveConnector(config = {}) {
    this._assertReady();
    return this._mutate(() => {
      const id = config.id || crypto.randomUUID();
      const previous = this.state.connectors.find((item) => item.id === id);
      if (config.id && !previous) throw error(404, 'Input connector not found.', 'CONNECTOR_NOT_FOUND');
      if (!['folder', 'email', 'layr'].includes(config.type || previous?.type)) throw error(400, 'Connector type must be folder, email or layr.', 'CONNECTOR_TYPE');
      if (previous && config.type && config.type !== previous.type) throw error(409, 'A connector’s type cannot change. Create another connector.', 'CONNECTOR_TYPE_IMMUTABLE');
      const next = { ...(previous || {}), id, type: config.type || previous.type };
      for (const key of ['name', 'path', 'host', 'username', 'mailbox', 'portalUrl', 'clientId', 'expiresAt', 'apiMode']) if (config[key] !== undefined) next[key] = text(config[key], 4000);
      if (typeof config.password === 'string' && config.password.trim()) next.password = config.password;
      for (const key of ['token', 'refreshToken']) if (typeof config[key] === 'string' && config[key].trim()) next[key] = config[key];
      if (next.type === 'layr' && next.apiMode === 'production') {
        delete next.refreshToken; delete next.expiresAt; delete next.clientId;
      }
      if (next.type === 'layr') {
        require('../connectors/validation').validateConnector(next);
        next.portalUrl = new URL(next.portalUrl).origin;
      }
      for (const key of ['enabled', 'secure', 'autoSyncPreparation']) if (config[key] !== undefined) next[key] = config[key] === true;
      for (const key of ['port', 'settleMs', 'pollIntervalMs']) if (config[key] !== undefined) next[key] = integer(config[key], undefined, key === 'settleMs' ? 0 : 1, key === 'port' ? 65535 : 86400000);
      if (config.defaults !== undefined) {
        if (!config.defaults || typeof config.defaults !== 'object' || Array.isArray(config.defaults)) throw error(400, 'Connector defaults must be an object.');
        next.defaults = { quantity: integer(config.defaults.quantity, 1), customer: text(config.defaults.customer, 500), notes: text(config.defaults.notes, 5000) };
      }
      if (config.state !== undefined) {
        if (!config.state || typeof config.state !== 'object' || Array.isArray(config.state)) throw error(400, 'Connector state must be an object.');
        next.state = clone(config.state);
      }
      next.createdAt ||= this._now();
      next.updatedAt = this._now();
      const index = this.state.connectors.findIndex((item) => item.id === id);
      if (index < 0) this.state.connectors.push(next); else this.state.connectors[index] = next;
      return publicValue(next);
    });
  }

  async removeConnector(id) {
    this._assertReady();
    return this._mutate(() => {
      if (!this.state.connectors.some((item) => item.id === id)) throw error(404, 'Input connector not found.', 'CONNECTOR_NOT_FOUND');
      this.state.connectors = this.state.connectors.filter((item) => item.id !== id);
      return { removed: true, id };
    });
  }

  async recordEvent(event) {
    this._assertReady();
    return this._mutate(() => this._event(event));
  }

  async waitForIdle() {
    // The caller must stop admitting new work (HTTP writes, connectors, polls)
    // before using this barrier for a consistent backup.
    do {
      await Promise.allSettled([...this._operations]);
      await this._transaction;
    } while (this._operations.size);
  }

  cancelPreparationsForShutdown() {
    for (const controller of this._preparations.values()) {
      controller.abort(error(503, 'Preparation stopped because QuickPrint is closing. Prepare this file again after restart.', 'PREPARATION_SHUTDOWN'));
    }
  }

  async close() {
    if (this._closing) return this._closePromise;
    this._closing = true;
    this._resinDispatchPermits.clear();
    this.cancelPreparationsForShutdown();
    this._closePromise = (async () => {
      await this.waitForIdle();
      await Promise.allSettled([...this._adapterCache.keys()].map((id) => this._closeAdapter(id)));
      await this.store.close();
      this._ready = false;
    })();
    return this._closePromise;
  }
}

module.exports = { QuickPrintService };
