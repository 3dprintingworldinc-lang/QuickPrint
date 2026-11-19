'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { PINNED_WHEELS, LIMITS, provisionResinCadRuntime, inspectResinCadRuntime, inspectWheelArchive } = require('../src/slicing/resin-cad-runtime');

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const wheelDir = path.resolve(process.env.QUICKPRINT_CAD_WHEELS || '.cache/step-probe/ocp');
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-cad-runtime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function zip(records) {
  const archive = new AdmZip();
  records.forEach((record, index) => {
    const original = 'entry-' + index;
    archive.addFile(original, Buffer.from(record.data || 'owned fixture'));
    const entry = archive.getEntry(original);
    entry.entryName = record.name;
    if (record.attributes != null) entry.attr = record.attributes;
  });
  return archive.toBuffer();
}
function centralOffsets(bytes) {
  const end = bytes.length - 22, count = bytes.readUInt16LE(end + 10), result = [];
  let cursor = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    result.push(cursor);
    cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  return result;
}
function response(url, { size, byte = 0, lengthHeader, never = false, onCancel = () => {} } = {}) {
  let remaining = size;
  return {
    ok: true, redirected: false, url,
    headers: new Headers(lengthHeader == null ? {} : { 'content-length': String(lengthHeader) }),
    body: {
      getReader() {
        return {
          async read() {
            if (never) return new Promise(() => {});
            if (!remaining) return { done: true };
            const length = Math.min(1024 * 1024, remaining); remaining -= length;
            return { done: false, value: Buffer.alloc(length, byte) };
          },
          cancel() { onCancel(); return Promise.resolve(); },
        };
      },
    },
  };
}
async function noStages(dir) { assert.deepEqual(await fs.readdir(dir), []); }
async function pinnedCacheAvailable() {
  try { for (const pin of PINNED_WHEELS) if ((await fs.stat(path.join(wheelDir, pin.filename))).size !== pin.size) return false; return true; }
  catch { return false; }
}

test('wheel inspection rejects Windows traversal, device names, alternate streams and wheel installation hooks', () => {
  assert.equal(inspectWheelArchive(zip([{ name: 'OCP/__init__.py' }])).entries[0].name, 'OCP/__init__.py');
  for (const name of ['../escape', '/absolute', 'C:/escape', 'OCP\\escape', 'OCP/file:stream', 'OCP/CON.txt', 'OCP/LpT9', 'OCP/filename.', 'OCP/filename ', 'OCP//file', 'payload.data/scripts/install', 'OCP/__pycache__/cached.pyc', 'surprise.pth']) {
    assert.throws(() => inspectWheelArchive(zip([{ name }])), { code: 'CAD_RUNTIME_INVALID' }, name);
  }
});

test('wheel inspection rejects links, special files, case-fold collisions and file-directory overlap', () => {
  for (const attributes of [(0xa1ff << 16) >>> 0, (0x61ff << 16) >>> 0, 0x400]) {
    assert.throws(() => inspectWheelArchive(zip([{ name: 'OCP/file', attributes }])), /links and special files/);
  }
  for (const names of [['OCP/a.py', 'ocp/A.py'], ['OCP', 'OCP/a.py'], ['OCP/a.py', 'OCP']]) {
    assert.throws(() => inspectWheelArchive(zip(names.map(name => ({ name })))), /overlap/);
  }
});

test('wheel inspection rejects mismatched local headers, hidden entries, encryption and unsupported ZIP layouts before inflation', () => {
  const mutations = [
    bytes => { const c = centralOffsets(bytes)[0]; bytes.writeUInt16LE(1, c + 8); },
    bytes => { const c = centralOffsets(bytes)[0]; bytes.writeUInt16LE(99, c + 10); },
    bytes => { const c = centralOffsets(bytes)[0]; bytes.writeUInt16LE(1, c + 30); },
    bytes => { const c = centralOffsets(bytes)[0], local = bytes.readUInt32LE(c + 42); bytes.writeUInt32LE(0, local + 14); },
    bytes => { const end = bytes.length - 22; bytes.writeUInt16LE(1, end + 4); },
    bytes => { const c = centralOffsets(bytes)[0]; bytes.writeUInt32LE(1, c + 42); },
  ];
  for (const mutate of mutations) { const bytes = zip([{ name: 'OCP/a.py' }]); mutate(bytes); assert.throws(() => inspectWheelArchive(bytes), { code: 'CAD_RUNTIME_INVALID' }); }
  assert.throws(() => inspectWheelArchive(Buffer.concat([zip([{ name: 'OCP/a.py' }]), Buffer.from('hidden')])), /ZIP directory/);
});

test('wheel expanded-byte, entry-count and individual-file bounds apply to metadata before decompression', () => {
  const one = zip([{ name: 'OCP/a.py' }]), c = centralOffsets(one)[0];
  one.writeUInt32LE(LIMITS.entryBytes + 1, c + 24);
  assert.throws(() => inspectWheelArchive(one), /expanded size/);
  const total = zip(Array.from({ length: 5 }, (_, index) => ({ name: 'OCP/' + index })));
  for (const central of centralOffsets(total)) {
    total.writeUInt32LE(LIMITS.entryBytes, central + 24);
    total.writeUInt32LE(LIMITS.entryBytes, total.readUInt32LE(central + 42) + 22);
  }
  assert.throws(() => inspectWheelArchive(total), /expanded size/);
  const tooMany = zip(Array.from({ length: LIMITS.entries + 1 }, (_, index) => ({ name: 'OCP/' + index })));
  assert.throws(() => inspectWheelArchive(tooMany), /ZIP directory/);
});

test('setup requires an explicit destination and refuses to overwrite an unrecognized existing directory', async t => {
  const dir = await temporary(t), outputDir = path.join(dir, 'existing');
  await fs.mkdir(outputDir); await fs.writeFile(path.join(outputDir, 'keep.txt'), 'owned existing content');
  let called = false;
  await assert.rejects(provisionResinCadRuntime({ outputDir, fetchImpl: async () => { called = true; } }), { code: 'CAD_RUNTIME_INVALID' });
  assert.equal(called, false); assert.equal(await fs.readFile(path.join(outputDir, 'keep.txt'), 'utf8'), 'owned existing content');
  await assert.rejects(provisionResinCadRuntime({ outputDir: 'relative' }), /absolute/);
  await assert.rejects(provisionResinCadRuntime({ outputDir: path.parse(dir).root }), /absolute/);
});

test('wrong download checksum cannot create a runtime or leave staging files', async t => {
  const dir = await temporary(t); let calls = 0, cancelled = false;
  await assert.rejects(provisionResinCadRuntime({ outputDir: path.join(dir, 'runtime'), fetchImpl: async (url, options) => {
    calls++; assert.equal(url, PINNED_WHEELS[0].url); assert.equal(new URL(url).hostname, 'files.pythonhosted.org');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    return response(url, { size: PINNED_WHEELS[0].size, lengthHeader: PINNED_WHEELS[0].size, onCancel: () => { cancelled = true; } });
  } }), { code: 'CAD_RUNTIME_CHECKSUM' });
  assert.equal(calls, 1); assert.equal(cancelled, true); await noStages(dir);
});

test('redirects, wrong declared length and oversized streams are refused and cancelled', async t => {
  const dir = await temporary(t);
  for (const kind of ['redirect', 'length', 'overflow', 'emptyChunk']) {
    let cancelled = false;
    await assert.rejects(provisionResinCadRuntime({ outputDir: path.join(dir, 'runtime'), fetchImpl: async url => {
      const result = response(url, { size: PINNED_WHEELS[0].size + 1, onCancel: () => { cancelled = true; } });
      if (kind === 'redirect') { result.redirected = true; result.body.cancel = () => { cancelled = true; }; }
      if (kind === 'length') { result.headers = new Headers({ 'content-length': String(PINNED_WHEELS[0].size + 1) }); result.body.cancel = () => { cancelled = true; }; }
      if (kind === 'emptyChunk') result.body.getReader = () => ({ read: async () => ({ done: false, value: new Uint8Array() }), cancel: () => { cancelled = true; } });
      return result;
    } }), { code: 'CAD_RUNTIME_INVALID' }, kind);
    assert.equal(cancelled, true, kind); await noStages(dir);
  }
});

test('download timeout covers an unresponsive fetch or body, and caller cancellation preserves the reason', async t => {
  const dir = await temporary(t);
  for (const kind of ['fetch', 'body']) {
    const started = Date.now();
    await assert.rejects(provisionResinCadRuntime({ outputDir: path.join(dir, 'runtime'), timeoutMs: 20, fetchImpl: async url => {
      if (kind === 'fetch') return new Promise(() => {});
      const result = response(url, { never: true });
      result.body.getReader = () => ({ read: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
      return result;
    } }), { code: 'CAD_RUNTIME_TIMEOUT' });
    assert.ok(Date.now() - started < 2000); await noStages(dir);
  }
  const controller = new AbortController(), reason = Object.assign(new Error('operator cancelled setup'), { code: 'TEST_CANCEL' });
  await assert.rejects(provisionResinCadRuntime({ outputDir: path.join(dir, 'runtime'), signal: controller.signal, fetchImpl: async () => { controller.abort(reason); return new Promise(() => {}); } }), error => error === reason);
  await noStages(dir);
});

test('a stale destination lock is visible and is never deleted by another setup', async t => {
  const dir = await temporary(t), lock = path.join(dir, '.runtime.quickprint-cad.lock');
  await fs.writeFile(lock, 'another setup');
  await assert.rejects(provisionResinCadRuntime({ outputDir: path.join(dir, 'runtime'), fetchImpl: async () => { throw new Error('must not download'); } }), { code: 'CAD_RUNTIME_BUSY' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'another setup');
});

test('CLI documents interpreter isolation and requires an explicit output directory', () => {
  const cli = path.resolve('scripts/setup-resin-cad.js');
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /CPython 3\.11 Windows x64/); assert.match(help.stdout, /does not run Python, pip/);
  const missing = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /explicit --output-dir/);
});

test('real pinned offline wheels provision a verified reusable runtime; tampering, extra files and forged receipts fail closed', { timeout: 60000 }, async t => {
  if (!await pinnedCacheAvailable()) return t.skip('Exact pinned offline wheels unavailable; set QUICKPRINT_CAD_WHEELS to the verified wheel directory.');
  const dir = await temporary(t), outputDir = path.join(dir, 'runtime');
  const installed = await provisionResinCadRuntime({ outputDir, offlineDir: wheelDir });
  assert.equal(installed.reused, false); assert.equal(installed.binaryManifest.length, 415); assert.equal(installed.distributionVersion, '8.0.1.1.0');
  assert.equal(installed.binaryManifest.reduce((sum, file) => sum + file.bytes, 0), 172722132);
  assert.equal(installed.modulePaths.bindingModule, path.join(installed.cadAuditPath, 'OCP', 'OCP.cp311-win_amd64.pyd'));
  const again = await provisionResinCadRuntime({ outputDir, fetchImpl: async () => { throw new Error('reuse must not download'); } });
  assert.equal(again.reused, true); assert.deepEqual(again.binaryManifest, installed.binaryManifest);
  const receiptBytes = await fs.readFile(installed.receiptPath), original = await fs.readFile(installed.modulePaths.OCP);
  const modified = Buffer.from(original); modified[0] ^= 1; await fs.writeFile(installed.modulePaths.OCP, modified);
  const forged = JSON.parse(receiptBytes), file = forged.installedFiles.find(item => item.name === 'OCP/__init__.py');
  file.sha256 = digest(modified); forged.installedManifestSha256 = digest(JSON.stringify(forged.installedFiles));
  await fs.writeFile(installed.receiptPath, JSON.stringify(forged));
  await assert.rejects(inspectResinCadRuntime(installed.cadAuditPath), { code: 'CAD_RUNTIME_INVALID' });
  await fs.writeFile(installed.receiptPath, receiptBytes);
  await assert.rejects(inspectResinCadRuntime(installed.cadAuditPath), { code: 'CAD_RUNTIME_INVALID' });
  await fs.writeFile(installed.modulePaths.OCP, original);
  const extra = path.join(installed.cadAuditPath, 'OCP', 'surprise.pyc'); await fs.writeFile(extra, 'cached executable code');
  await assert.rejects(inspectResinCadRuntime(installed.cadAuditPath), /unexpected file/); await fs.unlink(extra);
  await fs.unlink(installed.modulePaths.OCP);
  await assert.rejects(inspectResinCadRuntime(installed.cadAuditPath), /files are missing/); await fs.writeFile(installed.modulePaths.OCP, original);
  const ocpDir = path.join(installed.cadAuditPath, 'OCP'), held = path.join(dir, 'held-OCP');
  await fs.rename(ocpDir, held);
  let linked = false;
  try {
    try { await fs.symlink(held, ocpDir, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
    catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; t.diagnostic('Directory-link creation unavailable; archive link rejection is still covered.'); }
    if (linked) await assert.rejects(inspectResinCadRuntime(installed.cadAuditPath), /links are forbidden/);
  } finally { if (linked) await fs.unlink(ocpDir); await fs.rename(held, ocpDir); }
  const verified = await inspectResinCadRuntime(installed.cadAuditPath); assert.deepEqual(verified.binaryManifest, installed.binaryManifest);
  assert.deepEqual((await fs.readdir(outputDir)).sort(), ['quickprint-cad-runtime.json', 'site-packages']);
  assert.equal((await fs.readdir(dir)).length, 1);
});

test('a real pinned download followed by an extraction write failure cleans its staging tree and permits retry', { timeout: 60000 }, async t => {
  if (!await pinnedCacheAvailable()) return t.skip('Exact pinned offline wheels unavailable; set QUICKPRINT_CAD_WHEELS to exercise real extraction recovery.');
  const dir = await temporary(t), outputDir = path.join(dir, 'runtime');
  let calls = 0;
  await assert.rejects(provisionResinCadRuntime({ outputDir, fetchImpl: async url => {
    const pin = PINNED_WHEELS.find(item => item.url === url); assert.ok(pin); calls++;
    if (calls === 2) {
      const stage = (await fs.readdir(dir)).find(name => name.startsWith('.runtime.quickprint-cad-stage-'));
      assert.ok(stage); const site = path.join(dir, stage, 'site-packages');
      await fs.rmdir(site); await fs.writeFile(site, 'simulate destination write failure');
    }
    return new Response(await fs.readFile(path.join(wheelDir, pin.filename)), { headers: { 'content-length': String(pin.size) } });
  } }), error => ['EEXIST', 'ENOTDIR'].includes(error.code));
  assert.equal(calls, 2); await noStages(dir);
  const successful = await provisionResinCadRuntime({ outputDir, offlineDir: wheelDir });
  assert.equal(successful.reused, false); assert.equal(successful.binaryManifest.length, 415);
});
