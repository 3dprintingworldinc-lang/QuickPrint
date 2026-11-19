'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { QuickPrintService } = require('../src/core/service');
const { startServer } = require('../src/server');
const { ConnectorManager } = require('../src/connectors');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t, { http = false, provision } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-cad-runtime-service-'));
  const calls = [];
  const runtime = { async provisionResinCadRuntime(input) {
    calls.push(input);
    if (provision) return provision(input, calls.length);
    const cadAuditPath = path.join(input.outputDir, 'site-packages'), reused = await fs.stat(cadAuditPath).then(() => true, () => false);
    if (!reused) { await fs.mkdir(cadAuditPath, { recursive: true }); await fs.writeFile(path.join(cadAuditPath, 'owned-fixture.pyd'), 'No native code or download is used in this service fixture.'); }
    return { cadAuditPath, distributionVersion: '8.0.1.1.0', reused };
  } };
  const app = http ? await startServer({ dataDir, cadRuntime: runtime }) : null;
  const service = app?.service || new QuickPrintService({ dataDir, cadRuntime: runtime });
  if (!app) await service.init();
  await service.updateSettings({ siteName: 'Saved before setup', resinEngine: { prusaExecutable: path.join(dataDir, 'prusa.exe'), freecadExecutable: path.join(dataDir, 'FreeCADCmd.exe'), profilePath: path.join(dataDir, 'profile.json'), cadAuditPath: path.join(dataDir, 'previous-runtime', 'site-packages'), dispatchEnabled: false } });
  t.after(async () => { await (app ? app.close() : service.close()); await fs.rm(dataDir, { recursive: true, force: true }); });
  const outputDir = path.join(dataDir, '.providers', 'cad-transfer', '8.0.1.1.0');
  return { dataDir, outputDir, runtime, calls, service, app };
}
async function installed(input, reused = false) {
  const cadAuditPath = path.join(input.outputDir, 'site-packages'); await fs.mkdir(cadAuditPath, { recursive: true });
  return { cadAuditPath, distributionVersion: '8.0.1.1.0', reused };
}

test('setup provisions only its hidden managed target and changes only the saved CAD runtime setting', async t => {
  const f = await fixture(t), before = f.service.getSettings();
  const result = await f.service.setupResinCadRuntime();
  assert.deepEqual(result, { cadAuditPath: path.join(f.outputDir, 'site-packages'), distributionVersion: '8.0.1.1.0', reused: false });
  assert.equal(f.calls.length, 1); assert.deepEqual(Object.keys(f.calls[0]).sort(), ['outputDir','signal']); assert.equal(f.calls[0].outputDir, f.outputDir); assert.ok(f.calls[0].signal instanceof AbortSignal);
  const expected = structuredClone(before); expected.resinEngine.cadAuditPath = result.cadAuditPath;
  assert.deepEqual(f.service.getSettings(), expected); assert.equal(f.service.getSettings().resinEngine.dispatchEnabled, false);
  const reused = await f.service.setupResinCadRuntime({}); assert.equal(reused.reused, true); assert.equal(reused.cadAuditPath, result.cadAuditPath);
  assert.equal(f.calls.length, 2); assert.equal(f.service._preparations.size, 0);
});

test('setup rejects caller paths, URLs and nonempty or nonplain bodies before provisioning or creating provider directories', async t => {
  const f = await fixture(t);
  const hidden = {}; Object.defineProperty(hidden, 'url', { value: 'https://invalid.example/payload' });
  for (const body of [null, [], 'install', false, new Date(), Object.create({ inherited: true }), { outputDir: f.dataDir }, { url: 'https://invalid.example/payload' }, { offlineDir: f.dataDir }, hidden, { [Symbol('payload')]: true }]) {
    await assert.rejects(f.service.setupResinCadRuntime(body), { code: 'RESIN_CAD_RUNTIME_REQUEST_INVALID' });
  }
  assert.equal(f.calls.length, 0); await assert.rejects(fs.stat(path.join(f.dataDir, '.providers')), { code: 'ENOENT' });
});

test('concurrent settings edits survive an installation and dispatch/freecad configuration is not implicitly enabled', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { provision: async input => { entered.resolve(); await release.promise; return installed(input); } });
  const setup = f.service.setupResinCadRuntime(); await entered.promise;
  const freecadExecutable = path.join(f.dataDir, 'new-configured', 'FreeCADCmd.exe');
  await f.service.updateSettings({ siteName: 'Saved during installation', pollIntervalMs: 17000, resinEngine: { freecadExecutable, timeoutMs: 123000 } });
  release.resolve(); const result = await setup, settings = f.service.getSettings();
  assert.equal(settings.siteName, 'Saved during installation'); assert.equal(settings.pollIntervalMs, 17000); assert.equal(settings.resinEngine.freecadExecutable, freecadExecutable); assert.equal(settings.resinEngine.timeoutMs, 123000);
  assert.equal(settings.resinEngine.cadAuditPath, result.cadAuditPath); assert.equal(settings.resinEngine.dispatchEnabled, false);
});

test('checksum or provisioning failure leaves previous settings untouched', async t => {
  const f = await fixture(t, { provision: async () => { throw Object.assign(new Error('Pinned download checksum mismatch'), { code: 'CAD_RUNTIME_CHECKSUM' }); } }), before = f.service.getSettings();
  await assert.rejects(f.service.setupResinCadRuntime(), { code: 'CAD_RUNTIME_CHECKSUM' });
  assert.deepEqual(f.service.getSettings(), before); assert.equal(f.service._preparations.size, 0);
});

test('invalid returned installation identity cannot rebind the configured runtime', async t => {
  for (const change of [
    (result, f) => { result.cadAuditPath = path.join(f.dataDir, 'external-runtime', 'site-packages'); },
    result => { result.cadAuditPath = 'site-packages'; }, result => { result.distributionVersion = 'other'; }, result => { result.reused = 'yes'; },
  ]) {
    const f = await fixture(t, { provision: async input => { const result = await installed(input); change(result, f); return result; } }), before = f.service.getSettings();
    await assert.rejects(f.service.setupResinCadRuntime(), { code: 'RESIN_CAD_RUNTIME_RESULT_INVALID' }); assert.deepEqual(f.service.getSettings(), before);
  }
});

test('managed parent files or directory junctions are rejected before the installer can follow them', async t => {
  for (const level of [0,1,2]) {
    const f = await fixture(t), components = ['.providers','cad-transfer','8.0.1.1.0'];
    const link = path.join(f.dataDir, ...components.slice(0, level + 1)), external = path.join(f.dataDir, 'external-target');
    await fs.mkdir(path.dirname(link), { recursive: true }); await fs.mkdir(external);
    await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
    const before = f.service.getSettings();
    await assert.rejects(f.service.setupResinCadRuntime(), { code: 'RESIN_CAD_RUNTIME_PATH_INVALID' }); assert.equal(f.calls.length, 0); assert.deepEqual(f.service.getSettings(), before);
  }
  const f = await fixture(t); await fs.writeFile(path.join(f.dataDir, '.providers'), 'file blocks managed directory');
  await assert.rejects(f.service.setupResinCadRuntime(), { code: 'RESIN_CAD_RUNTIME_PATH_INVALID' }); assert.equal(f.calls.length, 0);
});

test('installer-time parent replacement and a linked returned site are rejected before updating settings', async t => {
  for (const kind of ['parent', 'site']) {
    const f = await fixture(t, { provision: async input => {
      const result = await installed(input), external = path.join(f.dataDir, 'external-installed');
      const target = kind === 'parent' ? path.dirname(input.outputDir) : result.cadAuditPath;
      await fs.rename(target, external); await fs.symlink(external, target, process.platform === 'win32' ? 'junction' : 'dir');
      return result;
    } }), before = f.service.getSettings();
    await assert.rejects(f.service.setupResinCadRuntime(), { code: 'RESIN_CAD_RUNTIME_PATH_INVALID' }); assert.deepEqual(f.service.getSettings(), before);
  }
});

test('runtime requests serialize and wait behind the shared resin engine lock', async t => {
  const entered = deferred(), release = deferred(); let active = 0, maximum = 0;
  const f = await fixture(t, { provision: async (input, number) => { active++; maximum = Math.max(maximum, active); if (number === 1) { entered.resolve(); await release.promise; } const result = await installed(input, number > 1); active--; return result; } });
  const engineEntered = deferred(), releaseEngine = deferred();
  const engine = f.service._withLocks(['resin:engine'], async () => { engineEntered.resolve(); await releaseEngine.promise; }); await engineEntered.promise;
  const first = f.service.setupResinCadRuntime(), second = f.service.setupResinCadRuntime();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
  releaseEngine.resolve(); await engine; await entered.promise; assert.equal(f.calls.length, 1);
  release.resolve(); const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.reused), [false,true]); assert.equal(maximum, 1); assert.equal(f.service._preparations.size, 0);
});

test('shutdown aborts the tracked installer and waits for cleanup without saving a late runtime path', async t => {
  const entered = deferred(), aborted = deferred(), cleanup = deferred();
  const f = await fixture(t, { provision: async input => {
    entered.resolve();
    try { await new Promise((_, reject) => input.signal.addEventListener('abort', () => { aborted.resolve(); reject(Object.assign(new Error('Native abort'), { code: 'ABORT_ERR' })); }, { once: true })); }
    finally { await cleanup.promise; }
  } }), before = f.service.getSettings();
  const setup = f.service.setupResinCadRuntime(); await entered.promise;
  const rejected = assert.rejects(setup, { code: 'PREPARATION_SHUTDOWN' });
  let closed = false; const closing = f.service.close().then(() => { closed = true; }); await aborted.promise;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  cleanup.resolve(); await rejected; await closing;
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.settings.resinEngine, before.resinEngine); assert.equal(saved.settings.siteName, before.siteName); assert.equal(f.service._preparations.size, 0);
});

test('failure to save settings keeps the old path and a retry can reuse the already installed managed files', async t => {
  const f = await fixture(t), before = f.service.getSettings();
  t.mock.method(f.service.store, 'save', async () => { throw Object.assign(new Error('Fixture disk failure'), { code: 'FIXTURE_DISK_FAILURE' }); });
  await assert.rejects(f.service.setupResinCadRuntime(), { code: 'FIXTURE_DISK_FAILURE' }); t.mock.restoreAll();
  assert.deepEqual(f.service.getSettings(), before);
  const retry = await f.service.setupResinCadRuntime(); assert.equal(retry.reused, true); assert.equal(f.service.getSettings().resinEngine.cadAuditPath, retry.cadAuditPath);
});

test('consistent workspace backup waits for runtime setup and excludes managed binary payloads', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { http: true, provision: async input => { entered.resolve(); await release.promise; const result = await installed(input); await fs.writeFile(path.join(result.cadAuditPath, 'binary.pyd'), 'Owned simulated binary'); return result; } });
  assert.equal(f.service.cadRuntime, f.runtime, 'server must forward the injected provisioner before this test can invoke setup');
  const setup = f.service.setupResinCadRuntime(); await entered.promise;
  const idleEntered = deferred(), waitForIdle = f.service.waitForIdle.bind(f.service);
  t.mock.method(f.service, 'waitForIdle', () => { idleEntered.resolve(); return waitForIdle(); });
  const headers = { Authorization: `Bearer ${f.app.token}` };
  let finished = false; const backup = fetch(f.app.url + '/api/backup', { headers }).then(response => { finished = true; return response; });
  await idleEntered.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  const blocked = await fetch(f.app.url + '/api/settings', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(blocked.status, 503);
  release.resolve(); const result = await setup, response = await backup; assert.equal(response.status, 200);
  const archive = new AdmZip(Buffer.from(await response.arrayBuffer()));
  assert.ok(!archive.getEntries().some(entry => entry.entryName.startsWith('.providers/')));
  assert.equal(JSON.parse(archive.readAsText('state.json')).settings.resinEngine.cadAuditPath, result.cadAuditPath);
  t.mock.restoreAll();
});

test('server shutdown immediately aborts HTTP runtime setup while backup drains cleanup with the service still alive', { timeout: 10000 }, async t => {
  const entered = deferred(), cleanup = deferred(); let aborted = false;
  const f = await fixture(t, { http: true, provision: async input => {
    entered.resolve();
    try { await new Promise((_, reject) => input.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('Fixture native abort'), { code: 'ABORT_ERR' })); }, { once: true })); }
    finally { await cleanup.promise; }
  } });
  const before = f.service.getSettings(), headers = { Authorization: `Bearer ${f.app.token}` };
  const setupResponse = fetch(f.app.url + '/api/resin/cad/runtime', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' }).then(async response => { await response.arrayBuffer(); return response.status; }, () => null).catch(() => null);
  await entered.promise;
  const idleEntered = deferred(), waitForIdle = f.service.waitForIdle.bind(f.service);
  t.mock.method(f.service, 'waitForIdle', () => { idleEntered.resolve(); return waitForIdle(); });
  let restarts = 0; const start = ConnectorManager.prototype.start;
  t.mock.method(ConnectorManager.prototype, 'start', function (...args) { restarts++; return start.apply(this, args); });
  let backupFinished = false;
  const backupResponse = fetch(f.app.url + '/api/backup', { headers }).then(async response => { await response.arrayBuffer(); return response.status; }, () => null).catch(() => null).finally(() => { backupFinished = true; });
  await idleEntered.promise;
  let closed = false; const closing = f.app.close().then(() => { closed = true; });
  try {
    assert.equal(aborted, true, 'shutdown cancellation must happen synchronously before waiting for the backup');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false); assert.equal(backupFinished, false);
    assert.deepEqual(f.service.getSettings(), before, 'the service remains readable while installer and backup cleanup finish');
    const blocked = await fetch(f.app.url + '/api/state', { headers }); assert.equal(blocked.status, 503);
  } finally {
    // Also drains an intentionally broken implementation without hanging the
    // regression's teardown: this does not mark the service closed.
    f.service.cancelPreparationsForShutdown(); cleanup.resolve();
  }
  await closing; const [setupStatus, backupStatus] = await Promise.all([setupResponse, backupResponse]);
  assert.ok(setupStatus === 503 || setupStatus === null); assert.ok(backupStatus === 200 || backupStatus === null);
  assert.equal(restarts, 0); assert.equal(f.app.server.listening, false);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(saved.settings.resinEngine, before.resinEngine);
  await assert.rejects(fs.stat(path.join(f.dataDir, 'service.lock')), { code: 'ENOENT' });
  t.mock.restoreAll();
});
