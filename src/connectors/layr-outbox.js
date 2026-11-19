'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicWrite } = require('../core/store');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const ACTIONS = new Set(['record_preprocessing', 'record_slice', 'approve_preparation', 'start_print', 'finish_print', 'fail_print']);
const STATES = new Set(['pending', 'paused', 'auth_required', 'conflict', 'rejected', 'confirmed', 'dismissed']);
const EXPECTED = { record_preprocessing: 'preparing', record_slice: 'preparing', approve_preparation: 'queued', start_print: 'printing', finish_print: 'post_processing', fail_print: 'preparing' };
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, status = 400, code = 'LAYR_OUTBOX_INVALID') => Object.assign(new Error(message), { status, code });
const fail = (message, status, code) => { throw failure(message, status, code); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fingerprint = value => digest(JSON.stringify(canonical(value)));
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Production outbox evidence contains unsupported fields.');
}
function text(value, maximum = 200) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail('The outbox requires the original HTTPS portal origin.'); }
  if (!text(value, 2000) || url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) fail('The outbox requires the original HTTPS portal origin.');
  return url.origin;
}
function validateCommand(command) {
  keys(command, ['action', 'id', 'version', 'operationId', 'data']);
  if (!ACTIONS.has(command.action) || !UUID.test(command.id || '') || !UUID.test(command.operationId || '') || !Number.isSafeInteger(command.version) || command.version < 1 || !object(command.data)) fail('A saved production action requires valid job, operation and version identities.');
  const data = command.data;
  if (!HASH.test(data.ticketFingerprint || '')) fail('Production evidence requires the approved ticket fingerprint.');
  const fields = {
    record_preprocessing: ['ticketFingerprint', 'sourceSha256', 'tool', 'outputs', 'operations'],
    record_slice: ['ticketFingerprint', 'sourceSha256', 'tool', 'profileSha256', 'printerId', 'printerModel', 'material', 'artifact'],
    approve_preparation: ['ticketFingerprint', 'receiptId'],
    start_print: ['ticketFingerprint', 'receiptId', 'runId', 'artifactSha256', 'printerId', 'remoteId', 'observedAt'],
    finish_print: ['ticketFingerprint', 'runId', 'remoteId', 'observedAt'],
    fail_print: ['ticketFingerprint', 'runId', 'remoteId', 'observedAt'],
  };
  keys(data, fields[command.action]);
  if (['record_preprocessing', 'record_slice'].includes(command.action)) {
    keys(data.tool, ['name', 'version', 'executableSha256']);
    if (!HASH.test(data.sourceSha256 || '') || !text(data.tool.name) || !text(data.tool.version, 80) || !HASH.test(data.tool.executableSha256 || '')) fail('Preparation evidence requires source and tool hashes.');
  }
  if (command.action === 'record_preprocessing') {
    keys(data.operations, ['evaluate', 'fix', 'hollowThicknessMm']);
    if (typeof data.operations.evaluate !== 'boolean' || ![undefined, null, 'simple', 'standard'].includes(data.operations.fix) ||
        (data.operations.hollowThicknessMm != null && (typeof data.operations.hollowThicknessMm !== 'number' || !Number.isFinite(data.operations.hollowThicknessMm) || data.operations.hollowThicknessMm <= 0 || data.operations.hollowThicknessMm > 50)) ||
        (!data.operations.evaluate && !data.operations.fix && data.operations.hollowThicknessMm == null)) fail('Requested preprocessing operations are invalid.');
    if (!Array.isArray(data.outputs) || data.outputs.length < 1 || data.outputs.length > 50) fail('Preparation evidence requires captured model or report outputs.');
    let bytes = 0;
    for (const output of data.outputs) {
      keys(output, ['name', 'sha256', 'sizeBytes', 'kind']);
      if (!text(output.name, 255) || /[\\/]/.test(output.name) || ['.', '..'].includes(output.name) || !HASH.test(output.sha256 || '') ||
          !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes < 1 || !['model', 'report'].includes(output.kind)) fail('Captured output evidence is invalid.');
      bytes += output.sizeBytes;
    }
    if (bytes > 100 * 1024 * 1024) fail('Captured output evidence exceeds 100 MiB.');
  } else if (command.action === 'record_slice') {
    keys(data.artifact, ['sha256', 'sizeBytes', 'format']);
    if (!HASH.test(data.profileSha256 || '') || !text(data.printerId) || !text(data.printerModel) || !text(data.material) || !HASH.test(data.artifact.sha256 || '') ||
        !Number.isSafeInteger(data.artifact.sizeBytes) || data.artifact.sizeBytes < 1 || data.artifact.sizeBytes > 512 * 1024 * 1024 || !text(data.artifact.format, 40)) fail('Slice evidence requires the bound profile, printer, material and artifact hashes.');
  } else if (command.action === 'approve_preparation') {
    if (!UUID.test(data.receiptId || '')) fail('Preparation approval requires a receipt identity.');
  } else {
    if (!UUID.test(data.runId || '') || !text(data.remoteId) || !text(data.observedAt, 40) || !Number.isFinite(Date.parse(data.observedAt))) fail('Printer evidence requires an explicit identified run and observation.');
    if (command.action === 'start_print' && (!UUID.test(data.receiptId || '') || !HASH.test(data.artifactSha256 || '') || !text(data.printerId))) fail('Printer start evidence must identify its approved receipt, printer and artifact.');
  }
  if (Buffer.byteLength(JSON.stringify(command)) > 32768) fail('Production evidence exceeds 32 KiB.', 413);
}
function commandContent(entry, command) {
  const { operationId, ...content } = command;
  return { connectorId: entry.connectorId, portalUrl: entry.portalUrl, ...content };
}
function publicEntry(entry) {
  return structuredClone({
    operationId: entry.operationId, connectorId: entry.connectorId, portalUrl: entry.portalUrl,
    id: entry.id, action: entry.action, version: entry.version, state: entry.state, attempts: entry.attempts,
    createdAt: entry.createdAt, updatedAt: entry.updatedAt, lastAttemptAt: entry.lastAttemptAt,
    nextAttemptAt: entry.nextAttemptAt, error: entry.error,
    ...(entry.confirmation ? { confirmation: entry.confirmation } : {}),
    ...(entry.resolution ? { resolution: entry.resolution } : {}),
  });
}
function confirmation(result, entry, now) {
  const ticket = result?.ticket;
  const command = JSON.parse(entry.bodyJson);
  if (!object(ticket) || ticket.id !== entry.id || ticket.version !== entry.version + 1 || ticket.status !== EXPECTED[entry.action] || ticket.ticketFingerprint !== command.data.ticketFingerprint) fail('The portal response did not confirm the saved production operation.', 502, 'LAYR_OUTBOX_UNCONFIRMED');
  const summary = { version: ticket.version, status: ticket.status, confirmedAt: new Date(now).toISOString() };
  if (['record_preprocessing', 'record_slice'].includes(entry.action)) {
    const receipt = result.receipt;
    if (!object(receipt) || receipt.id !== entry.operationId || receipt.jobId !== entry.id || receipt.ticketFingerprint !== command.data.ticketFingerprint ||
        receipt.sourceSha256 !== command.data.sourceSha256 || typeof receipt.qualified !== 'boolean' || receipt.printReady !== false) fail('The portal response did not confirm the saved preparation receipt.', 502, 'LAYR_OUTBOX_UNCONFIRMED');
    summary.receiptId = receipt.id; summary.qualified = receipt.qualified;
  }
  return summary;
}

class LayrOutbox {
  constructor({ service, dataDir = service?.dataDir, now = Date.now, write = atomicWrite } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof now !== 'function' || typeof write !== 'function') throw new TypeError('LayrOutbox requires an absolute data directory, clock and atomic writer.');
    this.filePath = path.join(dataDir, 'layr-outbox.json');
    this.now = now; this.write = write;
    this.state = { version: 1, operations: [] };
    this.queue = Promise.resolve(); this.ready = false;
  }
  async init() {
    if (this.ready) return this;
    if (!this.initializing) this.initializing = (async () => {
      try {
        const stat = await fs.stat(this.filePath);
        if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error('Invalid outbox file');
        const saved = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
        if (!object(saved) || Object.keys(saved).sort().join(',') !== 'operations,version' || saved.version !== 1 || !Array.isArray(saved.operations) || saved.operations.length > 10000) throw new Error('Invalid outbox schema');
        const ids = new Set(), dedup = new Set();
        for (const entry of saved.operations) {
          keys(entry, ['operationId', 'connectorId', 'portalUrl', 'id', 'action', 'version', 'dedupKeyHash', 'contentFingerprint', 'bodyJson', 'state', 'attempts',
            'createdAt', 'updatedAt', 'lastAttemptAt', 'nextAttemptAt', 'error', 'confirmation', 'resolution']);
          if (!object(entry) || !text(entry.connectorId, 200) || origin(entry.portalUrl) !== entry.portalUrl || !UUID.test(entry.operationId || '') ||
              !HASH.test(entry.dedupKeyHash || '') || !HASH.test(entry.contentFingerprint || '') || !STATES.has(entry.state) ||
              !Number.isSafeInteger(entry.attempts) || entry.attempts < 0 || typeof entry.bodyJson !== 'string' || ids.has(entry.operationId) || dedup.has(entry.dedupKeyHash)) throw new Error('Invalid outbox operation');
          const body = JSON.parse(entry.bodyJson); validateCommand(body);
          if (body.operationId !== entry.operationId || body.id !== entry.id || body.action !== entry.action || body.version !== entry.version ||
              fingerprint(commandContent(entry, body)) !== entry.contentFingerprint) throw new Error('Outbox identity mismatch');
          ids.add(entry.operationId); dedup.add(entry.dedupKeyHash);
          // Persisted public confirmation must also be a narrow, safe summary.
          if (entry.confirmation && (!object(entry.confirmation) || Object.keys(entry.confirmation).some(key => !['version', 'status', 'confirmedAt', 'receiptId', 'qualified'].includes(key)) ||
              entry.confirmation.version !== entry.version + 1 || entry.confirmation.status !== EXPECTED[entry.action])) throw new Error('Invalid confirmation');
          if ((entry.state === 'confirmed') !== Boolean(entry.confirmation)) throw new Error('Missing confirmation');
          if ((entry.state === 'dismissed') !== Boolean(entry.resolution) || (entry.resolution && (!object(entry.resolution) ||
              Object.keys(entry.resolution).sort().join(',') !== 'at,reason' || typeof entry.resolution.reason !== 'string' || !entry.resolution.reason.trim() || entry.resolution.reason.length > 500 ||
              !Number.isFinite(Date.parse(entry.resolution.at))))) throw new Error('Invalid local resolution');
        }
        this.state = saved;
      } catch (error) {
        if (error.code !== 'ENOENT') throw failure('The production outbox could not be read. Preserve the file and restore a verified copy before sending evidence.', 500, 'LAYR_OUTBOX_CORRUPT');
      }
      this.ready = true;
      return this;
    })();
    return this.initializing;
  }
  _serialize(operation) {
    const task = this.queue.catch(() => {}).then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  _clock() {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) fail('The production outbox clock is invalid.', 500);
    return now;
  }
  async _save(next) {
    const json = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(json) > MAX_STATE_BYTES) fail('The production outbox is full. Preserve it for review before queueing more evidence.', 409, 'LAYR_OUTBOX_FULL');
    try { await this.write(this.filePath, json); }
    catch { throw failure('The production outbox could not be saved. No further request was sent.', 500, 'LAYR_OUTBOX_SAVE'); }
    this.state = next;
  }
  async _update(operationId, patch) {
    const next = structuredClone(this.state);
    const entry = next.operations.find(value => value.operationId === operationId);
    if (!entry) fail('Production outbox operation not found.', 404);
    Object.assign(entry, patch, { updatedAt: new Date(this._clock()).toISOString() });
    await this._save(next);
    return entry;
  }
  status() { return this.state.operations.map(publicEntry); }
  get(operationId) { const entry = this.state.operations.find(value => value.operationId === operationId); return entry ? publicEntry(entry) : null; }
  lookup(dedupKey) {
    if (!this.ready) fail('Initialize the production outbox before looking up saved evidence.', 503, 'LAYR_OUTBOX_NOT_READY');
    if (typeof dedupKey !== 'string' || dedupKey.length < 1 || dedupKey.length > 4000) fail('A stable evidence key is required.');
    // Recompute the scoped hash for each stored operation. This supports old
    // outbox files without persisting raw keys or changing any saved body.
    const matches = this.state.operations.filter(entry => entry.dedupKeyHash === fingerprint([entry.connectorId, entry.portalUrl, entry.id, entry.action, dedupKey]));
    if (matches.length > 1) fail('This evidence key matches several production scopes. Use a globally unique evidence key.', 409, 'LAYR_OUTBOX_DEDUP_AMBIGUOUS');
    return matches.length ? publicEntry(matches[0]) : null;
  }
  async enqueue(input, dedupKey) {
    await this.init();
    return this._serialize(async () => {
      keys(input, ['connectorId', 'portalUrl', 'action', 'id', 'version', 'data']);
      if (!text(input.connectorId, 200) || typeof dedupKey !== 'string' || dedupKey.length < 1 || dedupKey.length > 4000) fail('A connector identity and stable evidence key are required.');
      const portalUrl = origin(input.portalUrl);
      const candidate = { action: input.action, id: input.id, version: input.version, operationId: '00000000-0000-4000-8000-000000000000', data: input.data };
      validateCommand(candidate);
      let bodyJson;
      try { bodyJson = JSON.stringify(candidate); } catch { fail('Production evidence must be serializable JSON.'); }
      const command = JSON.parse(bodyJson);
      const contentFingerprint = fingerprint(commandContent({ connectorId: input.connectorId, portalUrl }, command));
      const dedupKeyHash = fingerprint([input.connectorId, portalUrl, input.id, input.action, dedupKey]);
      const existing = this.state.operations.find(entry => entry.dedupKeyHash === dedupKeyHash);
      if (existing) {
        if (existing.contentFingerprint !== contentFingerprint) fail('This evidence key already identifies another saved body or version. Reconcile it or use a new evidence key.', 409, 'LAYR_OUTBOX_DEDUP_CONFLICT');
        return publicEntry(existing);
      }
      if (this.state.operations.length >= 10000) fail('The production outbox is full. Preserve its history for review.', 409, 'LAYR_OUTBOX_FULL');
      const operationId = randomUUID();
      command.operationId = operationId;
      bodyJson = JSON.stringify(command);
      const at = new Date(this._clock()).toISOString();
      const entry = { operationId, connectorId: input.connectorId, portalUrl, id: command.id, action: command.action, version: command.version,
        dedupKeyHash, contentFingerprint, bodyJson, state: 'pending', attempts: 0,
        createdAt: at, updatedAt: at, lastAttemptAt: null, nextAttemptAt: null, error: null };
      const next = structuredClone(this.state); next.operations.push(entry);
      await this._save(next);
      return publicEntry(entry);
    });
  }
  async dismissOperation(operationId, { reason } = {}) {
    await this.init();
    return this._serialize(async () => {
      if (!UUID.test(operationId || '') || typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) fail('Provide an operation UUID and a review reason of at most 500 characters.');
      reason = reason.trim();
      const entry = this.state.operations.find(value => value.operationId === operationId);
      if (!entry) fail('Production outbox operation not found.', 404);
      if (entry.state === 'dismissed') {
        if (entry.resolution.reason !== reason) fail('This operation already has a different local resolution.', 409, 'LAYR_OUTBOX_RESOLUTION_CONFLICT');
        return publicEntry(entry);
      }
      if (!['conflict', 'rejected'].includes(entry.state) && !(entry.state === 'paused' && entry.attempts === 0)) {
        fail('Reconcile this attempted or unresolved operation through exact replay before dismissing it.', 409, 'LAYR_OUTBOX_RECONCILIATION_REQUIRED');
      }
      return publicEntry(await this._update(operationId, { state: 'dismissed', nextAttemptAt: null, error: null, resolution: { reason, at: new Date(this._clock()).toISOString() } }));
    });
  }
  async process(configs, { client = require('./layr-production-client'), signal, beforeSend, getConfigs } = {}) {
    await this.init();
    const values = configs instanceof Map ? [...configs.values()] : configs;
    if (!Array.isArray(values) || typeof client?.postEvidence !== 'function' || (beforeSend !== undefined && typeof beforeSend !== 'function') || (getConfigs !== undefined && typeof getConfigs !== 'function')) throw new TypeError('Provide connector configurations and a production evidence client.');
    return this._serialize(async () => {
      const blocked = new Set();
      for (const saved of [...this.state.operations]) {
        if (signal?.aborted) break;
        const entry = this.state.operations.find(value => value.operationId === saved.operationId);
        if (['confirmed', 'dismissed'].includes(entry.state)) continue;
        const jobKey = JSON.stringify([entry.portalUrl, entry.id]);
        if (blocked.has(jobKey)) continue;
        blocked.add(jobKey);
        if (['conflict', 'rejected'].includes(entry.state)) continue;
        const liveValues = getConfigs ? await getConfigs() : values;
        if (!Array.isArray(liveValues)) throw new TypeError('The connector provider must return configurations.');
        let config = liveValues.find(value => value?.id === entry.connectorId);
        let paused;
        if (!config) paused = 'The saved connector was removed. Restore it to resume this operation.';
        else if (config.enabled === false) paused = 'The production connector is disabled.';
        else if (config.type !== 'layr' || config.apiMode !== 'production') paused = 'The connector is not configured for the scoped production API.';
        else {
          try { if (origin(config.portalUrl) !== entry.portalUrl) paused = 'The connector origin changed. Restore the saved portal before retrying.'; }
          catch { paused = 'The connector portal origin is invalid.'; }
        }
        if (paused) {
          if (entry.state !== 'paused' || entry.error !== paused) await this._update(entry.operationId, { state: 'paused', error: paused });
          continue;
        }
        if (typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.token)) {
          const message = 'The production credential is missing or invalid. Reconnect this input; the saved operation is preserved.';
          if (entry.state !== 'auth_required' || entry.error !== message) await this._update(entry.operationId, { state: 'auth_required', nextAttemptAt: null, error: message });
          continue;
        }
        if (entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) > this._clock()) continue;
        // Never-sent evidence must still match local files. Once an attempt was
        // durable it may already have committed remotely, so exact replay must
        // remain possible even after files change or the local slice is replaced.
        if (beforeSend && entry.attempts === 0) {
          try { await beforeSend(publicEntry(entry), JSON.parse(entry.bodyJson), config, { signal }); }
          catch {
            if (signal?.aborted) break;
            await this._update(entry.operationId, { state: 'paused', nextAttemptAt: null, error: 'Local preparation evidence changed or requires review. Resolve this held operation before sending later evidence.' });
            continue;
          }
        }
        if (signal?.aborted) break;
        if (getConfigs) {
          const latest = await getConfigs();
          if (!Array.isArray(latest)) throw new TypeError('The connector provider must return configurations.');
          const refreshed = latest.find(value => value?.id === entry.connectorId);
          let valid = refreshed && refreshed.enabled !== false && refreshed.type === 'layr' && refreshed.apiMode === 'production';
          try { valid = valid && origin(refreshed.portalUrl) === entry.portalUrl; } catch { valid = false; }
          if (!valid) {
            await this._update(entry.operationId, { state: 'paused', nextAttemptAt: null, error: 'The connector changed before transmission. Restore the saved production connection to resume.' });
            continue;
          }
          if (typeof refreshed.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(refreshed.token)) {
            await this._update(entry.operationId, { state: 'auth_required', nextAttemptAt: null, error: 'The production credential is missing or invalid. Reconnect this input; the saved operation is preserved.' });
            continue;
          }
          config = refreshed;
        }
        const now = this._clock();
        // This durable attempt marker precedes RPC. A crash or failed response
        // leaves the original body and UUID available for exact replay.
        const attempting = await this._update(entry.operationId, { state: 'pending', attempts: entry.attempts + 1, lastAttemptAt: new Date(now).toISOString(),
          nextAttemptAt: new Date(now + 5000).toISOString(), error: null });
        let result, caught;
        try { result = await client.postEvidence(config, JSON.parse(attempting.bodyJson), { signal }); }
        catch (error) { caught = error; }
        if (!caught) {
          try {
            const summary = confirmation(result, attempting, this._clock());
            await this._update(entry.operationId, { state: 'confirmed', nextAttemptAt: null, error: null, confirmation: summary });
            blocked.delete(jobKey);
            continue;
          } catch (error) {
            // If confirmation persistence fails, stop. The saved pending entry
            // must be replayed; no later operation may overtake it.
            if (error.code === 'LAYR_OUTBOX_SAVE' || error.code === 'LAYR_OUTBOX_FULL') throw error;
            caught = error;
          }
        }
        const status = caught?.status;
        const delay = Math.min(300000, 5000 * 2 ** Math.min(attempting.attempts - 1, 6));
        const auth = status === 401 || status === 403 || ['LAYR_AUTH', 'LAYR_RECONNECT'].includes(caught?.code);
        const conflict = status === 409;
        const rejected = !auth && !conflict && Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
        await this._update(entry.operationId, {
          state: conflict ? 'conflict' : auth ? 'auth_required' : rejected ? 'rejected' : 'pending',
          nextAttemptAt: conflict || rejected ? null : new Date(this._clock() + delay).toISOString(),
          error: conflict ? 'The portal ticket or operation conflicts with this saved body. Reconcile it before later evidence.' :
            auth ? 'The production credential was rejected. Reconnect this input; the saved operation is preserved.' :
            rejected ? 'The portal rejected this saved evidence. Review it before continuing.' :
            'The operation was not confirmed. QuickPrint will retry the same saved body and operation id.',
        });
      }
      return this.status();
    });
  }
}

module.exports = { LayrOutbox };
