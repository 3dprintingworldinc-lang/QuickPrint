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
    serial: printer.serial, model: printer.model, capabilities: printer.capabilities, slicer: printer.slicer,
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

class QuickPrintService extends EventEmitter {
  constructor({ dataDir, adapters, slicer, seal, unseal } = {}) {
    super();
    if (!dataDir) throw error(500, 'A QuickPrint data directory is required.');
    this.dataDir = path.resolve(dataDir);
    this.adapters = adapters;
    this.slicer = slicer;
    this.store = new StateStore({ dataDir: this.dataDir, seal, unseal });
    this._transaction = Promise.resolve();
    this._locks = new Map();
    this._adapterCache = new Map();
    this._operations = new Set();
    this._preparations = new Map();
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
        intake: { enabled: false, port: 9732, token: crypto.randomBytes(32).toString('base64url') },
        pollIntervalMs: 10000,
      },
    };
    try {
      for (const job of this.state.jobs) {
        job.runs ||= [];
        job.history ||= [];
        if (job.status === 'preparing') {
          this._transition(job, 'review', 'Preparation was interrupted. Prepare this file again.');
          job.error = 'Preparation was interrupted before a validated artifact was saved.';
        } else if (ACTIVE.has(job.status)) {
          const run = this._currentRun(job);
          if (job.status === 'dispatching' && run?.phase === 'uploading') {
            run.phase = 'resolved'; run.outcome = 'not_started'; run.resolvedAt = this._now();
            job.currentRunId = null;
            this._transition(job, 'ready', 'File upload was interrupted before any start command. A new confirmed dispatch is required.');
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

  async submit({ source = 'manual', sourceId, name, customer, quantity = 1, notes, files } = {}) {
    this._assertReady();
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
      for (const key of ['name', 'type', 'host', 'model', 'serial', 'caCertificate', 'tlsFingerprint']) {
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

  _status(status) {
    const states = new Set(['idle', 'printing', 'paused', 'offline', 'error', 'unknown']);
    if (!status || !states.has(status.state)) throw error(502, 'The printer returned an unrecognized status.', 'PRINTER_STATUS');
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
        status = this._status(await adapter.status());
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
    if (status.remoteId && run.remoteId) return status.remoteId === run.remoteId;
    if (!status.currentFile || !run.remotePath) return false;
    return basename(status.currentFile) === basename(run.remotePath);
  }

  _reconcileTelemetry(printerId, status) {
    for (const job of this.state.jobs) {
      const run = this._currentRun(job);
      if (job.printerId !== printerId || !run || run.resolvedAt || run.outcome) continue;
      const matches = this._matchesRun(status, run);
      if (matches && ['printing', 'paused'].includes(status.state)) {
        run.observedPrintingAt = this._now();
        run.phase = 'observed';
        const next = status.state === 'paused' ? 'paused' : 'printing';
        if (job.status !== next) this._transition(job, next, 'Printer telemetry confirms this run.');
        job.progress = status.progress;
        delete job.error;
      } else if (matches && status.outcome) {
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

  async prepareJob(id, printerId) {
    return this._withLocks([`job:${id}`, `printer:${printerId}`], async () => {
      const job = this._job(id);
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
      const status = this._status(await adapter.status());
      await this._mutate(() => { this._printer(printerId).status = status; });
      if (status.state !== 'idle' || Math.abs(Date.now() - Date.parse(status.observedAt)) > 30000) throw error(409, 'The printer must report a fresh idle state before dispatch.', 'PRINTER_NOT_READY');
      const runId = crypto.randomUUID();
      const remoteName = `qp-${id.slice(0, 8)}-${runId.slice(0, 8)}-${fileName(artifact.fileName)}`;
      await this._mutate(() => {
        const current = this._job(id);
        current.runs.push({ id: runId, printerId, phase: 'uploading', createdAt: this._now(), artifactSha256: artifact.sha256, fileName: remoteName });
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
      const status = this._status(await adapter.status());
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

  async updateSettings(patch = {}) {
    this._assertReady();
    return this._mutate(() => {
      const next = clone(this.state.settings);
      if (patch.siteName !== undefined) next.siteName = text(patch.siteName, 200) || 'QuickPrint';
      if (patch.pollIntervalMs !== undefined) next.pollIntervalMs = integer(patch.pollIntervalMs, 10000, 1000, 3600000);
      if (patch.slicer !== undefined) {
        next.slicer = slicerConfiguration(patch.slicer, next.slicer);
      }
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
      if (!['folder', 'email'].includes(config.type || previous?.type)) throw error(400, 'Connector type must be folder or email.', 'CONNECTOR_TYPE');
      if (previous && config.type && config.type !== previous.type) throw error(409, 'A connector’s type cannot change. Create another connector.', 'CONNECTOR_TYPE_IMMUTABLE');
      const next = { ...(previous || {}), id, type: config.type || previous.type };
      for (const key of ['name', 'path', 'host', 'username', 'mailbox']) if (config[key] !== undefined) next[key] = text(config[key], 4000);
      if (typeof config.password === 'string' && config.password.trim()) next.password = config.password;
      for (const key of ['enabled', 'secure']) if (config[key] !== undefined) next[key] = config[key] === true;
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

  async close() {
    if (this._closing) return this._closePromise;
    this._closing = true;
    for (const controller of this._preparations.values()) {
      controller.abort(error(503, 'Preparation stopped because QuickPrint is closing. Prepare this file again after restart.', 'PREPARATION_SHUTDOWN'));
    }
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
