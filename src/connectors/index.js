'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { validateConnector } = require('./validation');
const { pollFolder } = require('./folder');
const { pollEmail } = require('./email');

function locationKey(config) {
  return createHash('sha256').update(JSON.stringify(config.type === 'folder'
    ? [config.type, path.resolve(config.path)]
    : [config.type, config.host.toLowerCase(), config.port ?? (config.secure === false ? 143 : 993), config.username, config.mailbox || 'INBOX'])).digest('hex');
}

function safeError(error, type) {
  if (error.status === 400) return 'A file could not be accepted. Check supported format, quantity and file size.';
  if (['EAUTH', 'AUTHENTICATIONFAILED', 'AUTHENTICATION_FAILED'].includes(error.code) || error.authenticationFailed || error.serverResponseCode === 'AUTHENTICATIONFAILED') return 'Mailbox authentication failed. Check the username and app password.';
  if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code)) return 'Mailbox TLS certificate verification failed. Correct the mail server certificate or configure trusted system certificates.';
  if (error.code === 'ENOENT') return 'The watched folder is unavailable. Check its path and network-drive connection.';
  if (['EACCES', 'EPERM'].includes(error.code)) return 'QuickPrint does not have permission to read the folder or save its checkpoint.';
  if (error.code === 'ENOTDIR') return 'The watched path must be a folder.';
  if (error.code === 'UIDVALIDITY') return 'The mailbox did not provide a stable message identity. Import paused.';
  if (error.code === 'MAIL_PARSE') return 'An email could not be parsed. Import will retry without advancing its checkpoint.';
  if (error.code === 'ATTACHMENT_COUNT') return 'An email contains more than 50 print attachments. Split it into smaller messages and move the original out of this mailbox to resume import.';
  return type === 'email' ? 'Email import failed. Check the mailbox connection and configuration; QuickPrint will retry.' : 'Folder import failed. Check file availability and storage permissions; QuickPrint will retry.';
}

class ConnectorManager {
  constructor({ service, imapFactory, parseMail, now = Date.now, tickMs = 1000 } = {}) {
    if (!service?.dataDir) throw new Error('ConnectorManager requires a service with a dataDir.');
    this.service = service;
    this.imapFactory = imapFactory || (options => new (require('imapflow').ImapFlow)(options));
    this.parseMail = parseMail || ((source, options) => require('mailparser').simpleParser(source, options));
    this.now = now;
    this.tickMs = tickMs;
    this.stateFile = path.join(service.dataDir, 'connectors', 'checkpoints.json');
    this.checkpoints = { version: 1, connectors: {} };
    this.configs = new Map();
    this.runtime = new Map();
    this.inFlight = new Map();
    this.clients = new Set();
    this.writeQueue = Promise.resolve();
    this.stopping = false;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    try {
      const state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
      if (state.version !== 1 || !state.connectors || typeof state.connectors !== 'object' || Array.isArray(state.connectors)) throw new Error('Invalid connector checkpoint schema.');
      this.checkpoints = state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Connector checkpoints could not be read. Restore the checkpoint file before restarting imports.');
    }
    this.stopping = false;
    this.started = true;
    await this.reload();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  async reload() {
    const configs = await this.service.getConnectors({ secrets: true });
    this.configs = new Map((configs || []).map(config => [config.id, config]));
    for (const config of this.configs.values()) {
      const previous = this.runtime.get(config.id);
      const runtime = previous || { id: config.id, type: config.type, importedCount: 0, lastCheckedAt: null, lastImportedAt: null, failures: 0 };
      runtime.enabled = config.enabled !== false;
      runtime.type = config.type;
      runtime.state = runtime.enabled ? 'idle' : 'disabled';
      runtime.nextPollAt = this.now();
      runtime.error = null;
      try { validateConnector(config); } catch (error) { runtime.error = error.message; runtime.state = 'error'; runtime.invalid = true; }
      if (!runtime.error) runtime.invalid = false;
      this.runtime.set(config.id, runtime);
    }
    for (const id of this.runtime.keys()) if (!this.configs.has(id)) this.runtime.delete(id);
    return this.status();
  }

  tick() {
    if (this.stopping) return;
    for (const [id, runtime] of this.runtime) {
      if (runtime.enabled && !runtime.invalid && runtime.nextPollAt <= this.now() && !this.inFlight.has(id)) this.pollNow(id).catch(() => {});
    }
  }

  status() {
    return [...this.runtime.values()].map(({ failures, invalid, ...safe }) => ({ ...safe, nextPollAt: safe.nextPollAt ? new Date(safe.nextPollAt).toISOString() : null }));
  }

  async pollNow(id) {
    if (this.stopping || !this.started) throw Object.assign(new Error('Input connectors are stopped.'), { status: 409 });
    if (this.inFlight.has(id)) return this.inFlight.get(id);
    const config = this.configs.get(id);
    if (!config) throw Object.assign(new Error('Input connector not found.'), { status: 404 });
    if (config.enabled === false) throw Object.assign(new Error('Enable this connector before importing files.'), { status: 409 });
    validateConnector(config);
    const operation = this.poll(config);
    this.inFlight.set(id, operation);
    try { return await operation; } finally { this.inFlight.delete(id); }
  }

  async poll(config) {
    const runtime = this.runtime.get(config.id);
    runtime.state = 'polling';
    runtime.lastCheckedAt = new Date(this.now()).toISOString();
    const location = locationKey(config);
    let checkpoint = this.checkpoints.connectors[config.id];
    if (!checkpoint || checkpoint.location !== location) checkpoint = this.checkpoints.connectors[config.id] = { type: config.type, location };
    try {
      await (config.type === 'folder' ? pollFolder(this, config, checkpoint) : pollEmail(this, config, checkpoint));
      runtime.state = 'idle';
      runtime.error = null;
      runtime.failures = 0;
      runtime.nextPollAt = this.now() + (config.type === 'email' ? (config.pollIntervalMs ?? 60000) : 1000);
    } catch (error) {
      runtime.state = 'error';
      const message = safeError(error, config.type);
      runtime.failures++;
      runtime.nextPollAt = this.now() + Math.min(300000, 5000 * 2 ** Math.min(runtime.failures - 1, 6));
      const changed = runtime.error !== message;
      runtime.error = message;
      if (changed) {
        // A storage failure can also prevent diagnostics from being persisted.
        // Keep the visible retry status even if the event log is unavailable.
        try { await this.event(config, 'error', 'connector.import_failed', message); } catch { /* Retry preserves pending input. */ }
      }
    }
    return this.status().find(item => item.id === config.id);
  }

  imported(id, count) {
    const runtime = this.runtime.get(id);
    if (runtime) { runtime.importedCount += count; runtime.lastImportedAt = new Date(this.now()).toISOString(); }
  }

  async event(config, level, type, message) {
    await this.service.recordEvent({ level, type, message: `${config.name || config.type} input: ${message}` });
  }

  persist() {
    const contents = JSON.stringify(this.checkpoints, null, 2);
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, contents, { mode: 0o600 });
        await fs.rename(temporary, this.stateFile);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
    return this.writeQueue;
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const client of this.clients) { try { client.close(); } catch { /* Already closed. */ } }
    await Promise.allSettled([...this.inFlight.values()]);
    await this.writeQueue;
    this.started = false;
  }
}

module.exports = { ConnectorManager, validateConnector };
