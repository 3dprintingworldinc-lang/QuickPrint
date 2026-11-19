'use strict';

// This installs wheel payloads into a private directory. It never runs pip,
// Python, wheel hooks, or code from the downloaded distribution.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const DISTRIBUTION_VERSION = '8.0.1.1.0';
const RECEIPT_NAME = 'quickprint-cad-runtime.json';
const INSTALLED_MANIFEST_SHA256 = '1920f7620091d9738e675774018a0a55d22c547975f45a601baaee06c5fb735d';
const LIMITS = Object.freeze({ archiveBytes: 64 * 1024 * 1024, expandedBytes: 512 * 1024 * 1024, entries: 1024, entryBytes: 128 * 1024 * 1024, timeoutMs: 120000, receiptBytes: 1024 * 1024 });
const PINNED_WHEELS = Object.freeze([
  Object.freeze({ package: 'cadquery-ocp-novtk', version: DISTRIBUTION_VERSION,
    filename: 'cadquery_ocp_novtk-8.0.1.1.0-cp311-cp311-win_amd64.whl',
    url: 'https://files.pythonhosted.org/packages/4c/e4/d83068851eebe80128ec819f8dcac7e75b7eef38c3dba721b72ca2c51171/cadquery_ocp_novtk-8.0.1.1.0-cp311-cp311-win_amd64.whl',
    sha256: 'e2010a034a90eea87f4c22b5c4dd018afb1a76eb711045399266f0ad9d23f9a9', size: 47528110 }),
  Object.freeze({ package: 'cadquery-ocp-proxy', version: DISTRIBUTION_VERSION,
    filename: 'cadquery_ocp_proxy-8.0.1.1.0-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/13/5e/29c3d8c4b290dee82387468a33ac06c663518a167963cdb9ff48e6bbd8f9/cadquery_ocp_proxy-8.0.1.1.0-py3-none-any.whl',
    sha256: '98c71bb60cfb651afe179b134ab88580fd75384fce0cc6d633f727002cd18abd', size: 3250 }),
]);

function fail(message, code = 'CAD_RUNTIME_INVALID') {
  return Object.assign(new Error(message), { code });
}
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function sortedManifest(files) { return files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); }
function throwIfAborted(signal) { if (signal?.aborted) throw signal.reason || fail('CAD runtime setup cancelled.', 'ABORT_ERR'); }
async function statOrNull(file) { try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function readBoundedFile(file, maxBytes, signal) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw fail('CAD runtime input exceeds its byte limit.');
    const chunks = []; let bytes = 0;
    for (;;) {
      throwIfAborted(signal);
      const buffer = Buffer.alloc(Math.min(1024 * 1024, maxBytes - bytes + 1));
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) throw fail('CAD runtime input exceeds its byte limit.');
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}

function safeName(name, directory = false) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[^\x20-\x7e]|[\\:]/.test(name) || name.startsWith('/')) throw fail('Unsafe wheel path.');
  const trimmed = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = trimmed.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail('Unsafe wheel path.');
  if (parts.some(part => /\.data$/i.test(part) || part.toLowerCase() === '__pycache__') || /\.(?:pyc|pyo|pth)$/i.test(trimmed)) throw fail('Unsupported wheel layout.');
  return trimmed;
}

function reservePath(names, name, directory) {
  const key = name.toLowerCase();
  if (names.has(key)) throw fail('Wheel contains overlapping paths.');
  const parts = key.split('/');
  for (let i = 1; i < parts.length; i++) if (names.get(parts.slice(0, i).join('/')) === false) throw fail('Wheel file overlaps a directory.');
  if (!directory && [...names.keys()].some(other => other.startsWith(key + '/'))) throw fail('Wheel file overlaps a directory.');
  names.set(key, directory);
}

// Only the ordinary, non-encrypted ZIP format used by the pinned wheels is
// supported. Inspect all paths, sizes and local headers before inflating data.
function inspectWheelArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > LIMITS.archiveBytes) throw fail('Invalid wheel archive size.');
  const end = buffer.length - 22;
  if (buffer.readUInt32LE(end) !== 0x06054b50 || buffer.readUInt16LE(end + 20) !== 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw fail('Unsupported wheel ZIP directory.');
  const count = buffer.readUInt16LE(end + 10);
  const centralBytes = buffer.readUInt32LE(end + 12), centralOffset = buffer.readUInt32LE(end + 16);
  if (!count || count > LIMITS.entries || buffer.readUInt16LE(end + 8) !== count || centralOffset + centralBytes !== end) throw fail('Invalid wheel ZIP directory.');
  const entries = [], names = new Map();
  let cursor = centralOffset, expandedBytes = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw fail('Invalid wheel entry header.');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16), compressedBytes = buffer.readUInt32LE(cursor + 20), bytes = buffer.readUInt32LE(cursor + 24);
    const nameBytes = buffer.readUInt16LE(cursor + 28), extraBytes = buffer.readUInt16LE(cursor + 30), commentBytes = buffer.readUInt16LE(cursor + 32);
    const attributes = buffer.readUInt32LE(cursor + 38), offset = buffer.readUInt32LE(cursor + 42);
    if (buffer.readUInt16LE(cursor + 6) > 20 || (flags & ~0x800) || ![0, 8].includes(method) || extraBytes || commentBytes || buffer.readUInt16LE(cursor + 34) || cursor + 46 + nameBytes > end) throw fail('Unsupported wheel entry encoding.');
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameBytes);
    if ([...rawName].some(byte => byte < 0x20 || byte > 0x7e)) throw fail('Unsafe wheel path encoding.');
    const archiveName = rawName.toString('ascii'), directory = archiveName.endsWith('/');
    const name = safeName(archiveName, directory), type = (attributes >>> 16) & 0xf000;
    if ((type && type !== (directory ? 0x4000 : 0x8000)) || (attributes & 0x400) || (!directory && (attributes & 0x10))) throw fail('Wheel links and special files are forbidden.');
    if (bytes > LIMITS.entryBytes || (expandedBytes += bytes) > LIMITS.expandedBytes || (directory && (bytes || compressedBytes || method)) || (method === 0 && compressedBytes !== bytes)) throw fail('Wheel expanded size exceeds its limit.');
    reservePath(names, name, directory);
    if (offset + 30 > centralOffset || buffer.readUInt32LE(offset) !== 0x04034b50) throw fail('Invalid wheel local header.');
    const localNameBytes = buffer.readUInt16LE(offset + 26), localExtraBytes = buffer.readUInt16LE(offset + 28);
    const dataOffset = offset + 30 + localNameBytes + localExtraBytes;
    if (localExtraBytes || localNameBytes !== nameBytes || dataOffset + compressedBytes > centralOffset || buffer.readUInt16LE(offset + 6) !== flags || buffer.readUInt16LE(offset + 8) !== method || buffer.readUInt32LE(offset + 14) !== crc || buffer.readUInt32LE(offset + 18) !== compressedBytes || buffer.readUInt32LE(offset + 22) !== bytes || !buffer.subarray(offset + 30, dataOffset).equals(rawName)) throw fail('Wheel local and directory headers disagree.');
    entries.push({ name, directory, bytes, compressedBytes, crc, method, offset, dataOffset });
    cursor += 46 + nameBytes;
  }
  if (cursor !== end) throw fail('Invalid wheel directory size.');
  let nextOffset = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset !== nextOffset) throw fail('Wheel data contains overlaps or hidden entries.');
    nextOffset = entry.dataOffset + entry.compressedBytes;
  }
  if (nextOffset !== centralOffset) throw fail('Wheel data contains hidden entries.');
  return { entries, expandedBytes };
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function inflateEntry(buffer, entry) {
  const compressed = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedBytes);
  let data;
  try {
    if (entry.method === 0) data = compressed;
    else {
      const result = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.bytes), info: true });
      if (result.engine.bytesWritten !== compressed.length) throw fail('Wheel compressed stream contains trailing data.');
      data = result.buffer;
    }
  } catch { throw fail('Wheel compressed data is invalid or exceeds its limit.'); }
  if (data.length !== entry.bytes || crc32(data) !== entry.crc) throw fail('Wheel file size or CRC does not match.');
  return data;
}

async function writeNewFile(file, data) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
async function hashFile(file, expectedBytes, signal) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedBytes || stat.size > LIMITS.entryBytes) throw fail('CAD runtime file size has changed.');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (;;) {
      throwIfAborted(signal);
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > expectedBytes) throw fail('CAD runtime file size has changed.');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (bytes !== expectedBytes) throw fail('CAD runtime file size has changed.');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function inspectRuntime(cadAuditPath, { signal } = {}) {
  if (typeof cadAuditPath !== 'string' || !path.isAbsolute(cadAuditPath) || path.basename(cadAuditPath) !== 'site-packages') throw fail('CAD audit path must be an absolute managed site-packages directory.');
  const sitePath = path.resolve(cadAuditPath), root = path.dirname(sitePath);
  for (const dir of [root, sitePath]) {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('CAD runtime directory must not be a link.');
  }
  const receiptPath = path.join(root, RECEIPT_NAME), receiptStat = await fs.lstat(receiptPath);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > LIMITS.receiptBytes) throw fail('Invalid CAD runtime receipt.');
  let receipt;
  try { receipt = JSON.parse((await readBoundedFile(receiptPath, LIMITS.receiptBytes, signal)).toString('utf8')); } catch (error) { throwIfAborted(signal); throw fail('Invalid CAD runtime receipt.'); }
  if (receipt.schemaVersion !== 1 || receipt.distributionVersion !== DISTRIBUTION_VERSION || receipt.platform !== 'cp311-win_amd64' || JSON.stringify(receipt.wheels) !== JSON.stringify(PINNED_WHEELS) || receipt.installedManifestSha256 !== INSTALLED_MANIFEST_SHA256 || !Array.isArray(receipt.installedFiles) || receipt.installedFiles.length !== 415) throw fail('CAD runtime receipt does not match the pinned distribution.');
  const manifest = receipt.installedFiles;
  const names = new Map();
  for (const file of manifest) {
    if (!file || Object.keys(file).sort().join(',') !== 'bytes,name,sha256' || safeName(file.name) !== file.name || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > LIMITS.entryBytes || !/^[a-f0-9]{64}$/.test(file.sha256)) throw fail('Invalid CAD runtime manifest.');
    reservePath(names, file.name, false);
  }
  if (sha256(JSON.stringify(manifest)) !== INSTALLED_MANIFEST_SHA256) throw fail('CAD runtime manifest has changed.');
  const expected = new Map(manifest.map(file => [file.name, file]));
  const expectedDirs = new Set();
  for (const file of manifest) {
    const parts = file.name.split('/');
    for (let i = 1; i < parts.length; i++) expectedDirs.add(parts.slice(0, i).join('/'));
  }
  let entryCount = 0;
  async function visit(dir, relative = '') {
    for (const name of await fs.readdir(dir)) {
      throwIfAborted(signal);
      if (++entryCount > LIMITS.entries) throw fail('CAD runtime contains too many entries.');
      const rel = relative ? relative + '/' + name : name, full = path.join(dir, name), stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw fail('CAD runtime links are forbidden.');
      if (stat.isDirectory()) {
        if (!expectedDirs.has(rel)) throw fail('CAD runtime contains an unexpected directory.');
        await visit(full, rel);
      } else {
        const file = expected.get(rel);
        if (!stat.isFile() || !file || stat.size !== file.bytes || await hashFile(full, file.bytes, signal) !== file.sha256) throw fail('CAD runtime contains a missing, changed or unexpected file.');
        expected.delete(rel);
      }
    }
  }
  await visit(sitePath);
  if (expected.size) throw fail('CAD runtime files are missing.');
  const rootEntries = (await fs.readdir(root)).sort();
  if (rootEntries.join('\n') !== [RECEIPT_NAME, 'site-packages'].sort().join('\n')) throw fail('CAD runtime root contains unexpected files.');
  return {
    distributionVersion: DISTRIBUTION_VERSION,
    binaryManifest: manifest.map(file => ({ ...file })),
    modulePaths: { OCP: path.join(sitePath, 'OCP', '__init__.py'), bindingModule: path.join(sitePath, 'OCP', 'OCP.cp311-win_amd64.pyd') },
  };
}

async function inspectResinCadRuntime(cadAuditPath, options = {}) {
  try { return await inspectRuntime(cadAuditPath, options); }
  catch (error) {
    throwIfAborted(options.signal);
    if (error.code === 'CAD_RUNTIME_INVALID') throw error;
    throw fail('The managed CAD runtime is missing or unreadable; its directory was not changed.');
  }
}

async function wheelBytes(pin, { offlineDir, fetchImpl, signal, timeoutMs }) {
  let data;
  if (offlineDir) {
    const source = path.join(offlineDir, pin.filename), stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pin.size) throw fail('Offline wheel size does not match the pinned download.');
    data = await readBoundedFile(source, pin.size, signal);
    throwIfAborted(signal);
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(fail('CAD runtime download timed out.', 'CAD_RUNTIME_TIMEOUT')), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let response, reader;
    const abort = new Promise((_, reject) => combined.addEventListener('abort', () => reject(combined.reason), { once: true }));
    try {
      throwIfAborted(combined);
      response = await Promise.race([fetchImpl(pin.url, { redirect: 'error', credentials: 'omit', signal: combined }), abort]);
      if (!response?.ok || response.redirected || (response.url && response.url !== pin.url)) throw fail('The pinned wheel download failed.');
      const length = response.headers?.get('content-length');
      if (length != null && (!/^\d+$/.test(length) || Number(length) !== pin.size)) throw fail('Download length does not match the pinned wheel.');
      if (!response.body?.getReader) throw fail('Wheel download does not provide a bounded stream.');
      reader = response.body.getReader();
      // The exact pinned length is known. A single allocation avoids an
      // unbounded chunk-object list when a server sends very small chunks.
      const downloaded = Buffer.allocUnsafe(pin.size); let bytes = 0;
      for (;;) {
        const next = await Promise.race([reader.read(), abort]);
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || !next.value.length || bytes + next.value.length > pin.size) throw fail('Wheel download exceeds its pinned byte limit or contains an invalid chunk.');
        downloaded.set(next.value, bytes);
        bytes += next.value.length;
      }
      data = downloaded.subarray(0, bytes);
    } finally {
      clearTimeout(timeout);
      // Cancellation is best effort: an unresponsive injected/network stream
      // must not extend the overall timeout while cleanup waits for it.
      if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
      else if (response?.body?.cancel) { try { Promise.resolve(response.body.cancel()).catch(() => {}); } catch {} }
    }
  }
  if (data.length !== pin.size || sha256(data) !== pin.sha256) throw fail('Wheel download checksum does not match the pinned distribution.', 'CAD_RUNTIME_CHECKSUM');
  return data;
}

async function provisionResinCadRuntime({ outputDir, offlineDir, fetchImpl = globalThis.fetch, signal, timeoutMs = LIMITS.timeoutMs } = {}) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || path.resolve(outputDir) === path.parse(path.resolve(outputDir)).root) throw fail('An explicit absolute runtime output directory is required.');
  if (offlineDir != null && (typeof offlineDir !== 'string' || !path.isAbsolute(offlineDir))) throw fail('Offline wheel directory must be absolute.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs || (!offlineDir && typeof fetchImpl !== 'function')) throw fail('Invalid CAD runtime download options.');
  const target = path.resolve(outputDir), cadAuditPath = path.join(target, 'site-packages'), receiptPath = path.join(target, RECEIPT_NAME);
  throwIfAborted(signal);
  const result = async reused => ({ cadAuditPath, receiptPath, reused, ...await inspectResinCadRuntime(cadAuditPath, { signal }) });
  if (await statOrNull(target)) return result(true);
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const lockPath = path.join(parent, '.' + path.basename(target) + '.quickprint-cad.lock');
  let lock, stage;
  try {
    try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('Another CAD runtime setup holds this destination.', 'CAD_RUNTIME_BUSY'); throw error; }
    if (await statOrNull(target)) return result(true);
    stage = await fs.mkdtemp(path.join(parent, '.' + path.basename(target) + '.quickprint-cad-stage-'));
    const stageSite = path.join(stage, 'site-packages');
    await fs.mkdir(stageSite, { mode: 0o700 });
    const archives = [], paths = new Map();
    let entryCount = 0, expandedBytes = 0;
    for (const pin of PINNED_WHEELS) {
      throwIfAborted(signal);
      const buffer = await wheelBytes(pin, { offlineDir, fetchImpl, signal, timeoutMs });
      const archive = inspectWheelArchive(buffer);
      entryCount += archive.entries.length; expandedBytes += archive.expandedBytes;
      if (entryCount > LIMITS.entries || expandedBytes > LIMITS.expandedBytes) throw fail('Combined wheels exceed extraction limits.');
      for (const entry of archive.entries) reservePath(paths, entry.name, entry.directory);
      archives.push({ buffer, ...archive });
    }
    const installedFiles = [];
    for (const archive of archives) for (const entry of archive.entries) {
      throwIfAborted(signal);
      if (entry.directory) continue;
      const data = inflateEntry(archive.buffer, entry);
      const destination = path.join(stageSite, ...entry.name.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeNewFile(destination, data);
      installedFiles.push({ name: entry.name, bytes: data.length, sha256: sha256(data) });
    }
    sortedManifest(installedFiles);
    if (sha256(JSON.stringify(installedFiles)) !== INSTALLED_MANIFEST_SHA256) throw fail('Installed wheel payload does not match the pinned manifest.');
    const receipt = { schemaVersion: 1, distributionVersion: DISTRIBUTION_VERSION, platform: 'cp311-win_amd64', wheels: PINNED_WHEELS, installedManifestSha256: INSTALLED_MANIFEST_SHA256, installedFiles };
    await writeNewFile(path.join(stage, RECEIPT_NAME), JSON.stringify(receipt, null, 2) + '\n');
    await inspectResinCadRuntime(stageSite, { signal });
    throwIfAborted(signal);
    if (await statOrNull(target)) throw fail('CAD runtime destination appeared during setup; it was not overwritten.');
    await fs.rename(stage, target);
    stage = null;
    return { cadAuditPath, receiptPath, reused: false, distributionVersion: DISTRIBUTION_VERSION, binaryManifest: installedFiles, modulePaths: { OCP: path.join(cadAuditPath, 'OCP', '__init__.py'), bindingModule: path.join(cadAuditPath, 'OCP', 'OCP.cp311-win_amd64.pyd') } };
  } finally {
    // stage is a unique directory created by this invocation, inside the
    // explicitly chosen target's parent. Never recursively remove the target.
    if (stage && path.dirname(path.resolve(stage)) === parent && path.basename(stage).startsWith('.' + path.basename(target) + '.quickprint-cad-stage-')) await fs.rm(stage, { recursive: true, force: true });
    if (lock) { await lock.close(); await fs.unlink(lockPath); }
  }
}

module.exports = { DISTRIBUTION_VERSION, PINNED_WHEELS, LIMITS, provisionResinCadRuntime, inspectResinCadRuntime, inspectWheelArchive };
