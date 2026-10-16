'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SECRET_FIELDS = new Set(['password', 'apiKey', 'accessCode', 'token']);

function clone(value) {
  return structuredClone(value);
}

function error(status, message, code = 'QUICKPRINT_ERROR') {
  const result = new Error(message);
  result.status = status;
  result.code = code;
  return result;
}

function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key)) {
      result[`has${key[0].toUpperCase()}${key.slice(1)}`] = Boolean(item);
    } else {
      result[key] = publicValue(item);
    }
  }
  return result;
}

async function atomicWrite(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    // Directory fsync is not supported on every Windows filesystem.
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(filePath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (failure) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw failure;
  }
}

class StateStore {
  constructor({ dataDir, seal, unseal }) {
    if (Boolean(seal) !== Boolean(unseal)) throw error(500, 'Provide both secret encryption functions.');
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'state.json');
    this.lockPath = path.join(dataDir, 'service.lock');
    this.seal = seal;
    this.unseal = unseal;
    this.nonce = crypto.randomUUID();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await this.acquireLock();
    try {
      if (!this.seal) await this.localEncryption();
      let raw;
      try { raw = await fs.readFile(this.filePath, 'utf8'); } catch (failure) {
        if (failure.code === 'ENOENT') return null;
        throw failure;
      }
      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        throw error(500, 'QuickPrint state is damaged. Preserve the data folder and restore a verified backup; it was not reset.', 'STATE_CORRUPT');
      }
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.jobs) || !Array.isArray(parsed.printers)
        || !Array.isArray(parsed.connectors) || !parsed.settings || !parsed.submissions
        || !Array.isArray(parsed.events)) {
        throw error(500, 'Unsupported or incomplete QuickPrint state. No data was changed.', 'STATE_SCHEMA');
      }
      return await this.transformSecrets(parsed, false);
    } catch (failure) {
      await this.close();
      throw failure;
    }
  }

  async acquireLock() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(this.lockPath, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce: this.nonce })); await handle.sync(); }
        finally { await handle.close(); }
        this.ownsLock = true;
        return;
      } catch (failure) {
        if (failure.code !== 'EEXIST') throw failure;
        let previous;
        try { previous = JSON.parse(await fs.readFile(this.lockPath, 'utf8')); } catch {
          throw error(409, 'The data folder has an unreadable service lock. Confirm no QuickPrint process is running before removing service.lock.', 'STATE_LOCKED');
        }
        if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) {
          throw error(409, 'The data folder service lock needs operator review.', 'STATE_LOCKED');
        }
        try { process.kill(previous.pid, 0); } catch (probe) {
          if (probe.code === 'ESRCH') {
            // Re-read ownership before removing a dead process's lock.
            const current = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
            if (current.nonce === previous.nonce) await fs.unlink(this.lockPath);
            continue;
          }
        }
        throw error(409, 'Another QuickPrint process is using this data folder.', 'STATE_LOCKED');
      }
    }
    throw error(409, 'Could not acquire the QuickPrint data folder lock.', 'STATE_LOCKED');
  }

  async localEncryption() {
    const keyPath = path.join(this.dataDir, 'secret.key');
    let key;
    try { key = await fs.readFile(keyPath); } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
      // Never replace a missing key when encrypted data already exists.
      try {
        const raw = await fs.readFile(this.filePath, 'utf8');
        if (raw.includes('"local-aes-gcm"')) throw error(500, 'The local secret key is missing. Restore secret.key with state.json from the same backup.', 'SECRET_KEY_MISSING');
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      key = crypto.randomBytes(32);
      const handle = await fs.open(keyPath, 'wx', 0o600);
      try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
    }
    if (key.length !== 32) throw error(500, 'The local secret key is invalid.', 'SECRET_KEY_INVALID');
    this.provider = 'local-aes-gcm';
    this.seal = (plain) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    };
    this.unseal = (value) => {
      const data = Buffer.from(value, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    };
  }

  async transformSecrets(value, encrypt) {
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.transformSecrets(item, encrypt)));
    if (!value || typeof value !== 'object') return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_FIELDS.has(key) && item) {
        if (encrypt) {
          const encoded = await this.seal(String(item));
          if (typeof encoded !== 'string') throw error(500, 'Secret encryption must return an encoded string.', 'SECRET_ENCODING');
          result[key] = { protected: true, provider: this.provider || 'injected', value: encoded };
        } else {
          if (!item.protected || typeof item.value !== 'string' || item.provider !== (this.provider || 'injected')) {
            throw error(500, 'Saved credentials use a different protection method. Open this data folder with its original QuickPrint installation.', 'SECRET_PROVIDER');
          }
          try { result[key] = await this.unseal(item.value); } catch {
            throw error(500, 'A saved credential could not be decrypted. Restore its matching key or use the original Windows account.', 'SECRET_DECRYPTION');
          }
          if (typeof result[key] !== 'string') throw error(500, 'Secret decryption returned an invalid value.', 'SECRET_ENCODING');
        }
      } else {
        result[key] = await this.transformSecrets(item, encrypt);
      }
    }
    return result;
  }

  async save(state) {
    const persisted = await this.transformSecrets(state, true);
    await atomicWrite(this.filePath, `${JSON.stringify(persisted, null, 2)}\n`);
  }

  async close() {
    if (!this.ownsLock) return;
    this.ownsLock = false;
    try {
      const lock = JSON.parse(await fs.readFile(this.lockPath, 'utf8'));
      if (lock.nonce === this.nonce) await fs.unlink(this.lockPath);
    } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
}

module.exports = { StateStore, atomicWrite, publicValue, clone, error, SECRET_FIELDS };
