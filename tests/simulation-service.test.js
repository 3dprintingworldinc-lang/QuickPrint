'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const AdmZip = require('adm-zip');
const { SimulationService } = require('../src/simulation/service');
const { SimulationEngine, createPreset } = require('../src/simulation/engine');
const { startServer } = require('../src/server');

async function directory(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-simulation-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function server(t, dataDir = null) {
  dataDir ||= await directory(t);
  let adapterCalls = 0;
  const app = await startServer({ dataDir, simulationAutoTick: false, adapters: {
    createAdapter() { adapterCalls++; throw new Error('Simulation must not invoke printer adapters.'); }
  } });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = (route, body, method) => fetch(app.url + route, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { ...app, dataDir, request, adapterCalls: () => adapterCalls };
}

test('virtual clock, speed changes, restart pause and deterministic continuation preserve work', async t => {
  const dataDir = await directory(t);
  let clock = 0;
  const service = await new SimulationService({ dataDir, now: () => clock, autoTick: false }).init();
  await service.loadPreset('automated');
  await service.control({ action: 'play', speed: 120 });
  clock += 1000;
  await service.tick();
  assert.equal(service.snapshot().timeMinutes, 2);
  clock += 500;
  await service.control({ action: 'play', speed: 60 });
  assert.equal(service.snapshot().timeMinutes, 3, 'Speed changes account for elapsed time at the old speed.');
  clock += 1000;
  await service.close();
  const saved = JSON.parse(await fs.readFile(service.filePath, 'utf8'));
  assert.equal(saved.engine.timeMinutes, 4);
  clock += 86400000;
  const restored = await new SimulationService({ dataDir, now: () => clock, autoTick: false }).init();
  t.after(() => restored.close());
  assert.equal(restored.snapshot().running, false);
  assert.equal(restored.snapshot().timeMinutes, 4);
  assert.deepEqual(restored.engine.serialize(), saved.engine);
  const expected = SimulationEngine.restore(saved.engine).advance(30);
  const actual = await restored.control({ action: 'step', minutes: 30 });
  assert.deepEqual(actual.metrics, expected.metrics);
  assert.deepEqual(actual.events, expected.events);
});

test('long computer sleeps do not produce unbounded virtual catch-up', async t => {
  const dataDir = await directory(t);
  let clock = 0;
  const service = await new SimulationService({ dataDir, now: () => clock, autoTick: false }).init();
  t.after(() => service.close());
  await service.control({ action: 'play', speed: 60 });
  clock = 24 * 60 * 60 * 1000;
  await service.tick();
  assert.equal(service.snapshot().timeMinutes, 5);
});

test('backup freezes a durable checkpoint and excludes backup duration on resume', async t => {
  const dataDir = await directory(t);
  let clock = 0;
  const service = await new SimulationService({ dataDir, now: () => clock, autoTick: false }).init();
  t.after(() => service.close());
  await service.control({ action: 'play' });
  clock = 1000;
  const token = await service.freeze();
  assert.equal(service.snapshot().timeMinutes, 1);
  assert.equal(service.snapshot().running, false);
  assert.deepEqual(JSON.parse(await fs.readFile(service.filePath, 'utf8')).engine, service.engine.serialize());
  await assert.rejects(service.control({ action: 'step' }), error => error.status === 503);
  clock = 100000;
  service.resume(token);
  clock += 1000;
  await service.tick();
  assert.equal(service.snapshot().running, true);
  assert.equal(service.snapshot().timeMinutes, 2);
});

test('authenticated simulation API validates edits and cannot change production jobs or printers', async t => {
  const app = await server(t);
  assert.equal((await fetch(app.url + '/api/simulation')).status, 401);
  assert.equal((await fetch(app.url + '/api/simulation/export')).status, 401);
  const initialProduction = app.service.snapshot();
  const initial = await (await app.request('/api/simulation')).json();
  assert.equal(initial.mode, 'simulation');
  assert.equal(initial.running, false);
  assert.equal(initial.presets.length, 3);
  let response = await app.request('/api/simulation/preset', { name: 'automated' });
  assert.equal(response.status, 200);
  const preset = await response.json();
  const beforePreview = app.simulation.engine.serialize();
  assert.equal((await app.request(`/api/simulation/preview/${preset.jobs[0].id}`)).status, 200);
  assert.deepEqual(app.simulation.engine.serialize(), beforePreview, 'Routing explanation must not assign a job.');
  assert.equal((await app.request('/api/simulation/control', { action: 'play', speed: 120 })).status, 200);
  assert.equal((await app.request('/api/simulation/control', { action: 'step' })).status, 409);
  assert.equal((await app.request('/api/simulation/scenario', preset.scenario, 'PUT')).status, 409);
  assert.equal((await app.request('/api/simulation/control', { action: 'pause' })).status, 200);
  response = await app.request('/api/simulation/control', { action: 'step', minutes: 120 });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).metrics.completedCopies > 0);
  assert.deepEqual(app.service.snapshot(), initialProduction);
  assert.equal(app.adapterCalls(), 0);
  const beforeInvalid = app.simulation.engine.serialize();
  for (const body of [null, [], { action: 'execute' }, { action: 'step', minutes: -1 }, { action: 'play', speed: 0 }]) {
    assert.equal((await app.request('/api/simulation/control', body)).status, 400);
  }
  assert.equal((await app.request('/api/simulation/fault', { type: 'execute', printerId: 'none' })).status, 400);
  assert.equal((await app.request('/api/simulation/scenario', { schemaVersion: 99 }, 'PUT')).status, 400);
  assert.deepEqual(app.simulation.engine.serialize(), beforeInvalid);
});

test('scenario export/import, faults and manual clearing keep occupied beds out of dispatch', async t => {
  const app = await server(t);
  const scenario = createPreset('starter');
  scenario.printers = [scenario.printers[0]];
  scenario.jobs = [{ ...scenario.jobs[0], quantity: 2, durationMinutes: 1 }];
  scenario.printers[0].clearing.cooldownMinutes = 0;
  assert.equal((await app.request('/api/simulation/scenario', scenario, 'PUT')).status, 200);
  const exported = await app.request('/api/simulation/export');
  assert.match(exported.headers.get('content-disposition'), /QuickPrint-scenario.json/);
  assert.deepEqual(await exported.json(), app.simulation.snapshot().scenario);
  const response = await app.request('/api/simulation/control', { action: 'step', minutes: 5 });
  const blocked = await response.json();
  assert.equal(blocked.printers[0].state, 'blocked');
  assert.equal(blocked.metrics.completedCopies, 1);
  assert.equal(blocked.metrics.queuedCopies, 1);
  const printerId = scenario.printers[0].id;
  assert.equal((await app.request('/api/simulation/fault', { type: 'manual_clear', printerId })).status, 200);
  const running = app.simulation.snapshot();
  assert.equal(running.printers[0].state, 'printing');
  assert.equal(running.printers[0].currentCopy, 2);
  assert.equal((await app.request('/api/simulation/fault', { type: 'print_failure', printerId })).status, 200);
  const failed = app.simulation.snapshot();
  assert.equal(failed.metrics.failedCopies, 1);
  assert.equal(failed.printers[0].bedDirty, true);
  assert.equal(failed.printers[0].state, 'blocked');
  assert.equal(app.adapterCalls(), 0);
});

test('workspace backup includes a restorable simulation checkpoint and resumes the run', async t => {
  const app = await server(t);
  await app.request('/api/simulation/control', { action: 'step', minutes: 10 });
  await app.request('/api/simulation/control', { action: 'play' });
  const response = await app.request('/api/backup');
  assert.equal(response.status, 200);
  const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
  const saved = JSON.parse(zip.readAsText('simulation/state.json'));
  const restored = SimulationEngine.restore(saved.engine);
  assert.ok(restored.snapshot().timeMinutes >= 10);
  assert.equal(app.simulation.snapshot().running, true);
  assert.equal(app.adapterCalls(), 0);
});

test('corrupt simulation checkpoint is preserved and does not prevent production startup', async t => {
  const dataDir = await directory(t);
  const filename = path.join(dataDir, 'simulation', 'state.json');
  await fs.mkdir(path.dirname(filename));
  await fs.writeFile(filename, '{invalid checkpoint');
  const app = await server(t, dataDir);
  assert.equal((await fetch(app.url + '/api/health')).status, 200);
  assert.equal((await app.request('/api/state')).status, 200);
  const response = await app.request('/api/simulation');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'SIMULATION_STATE_UNAVAILABLE');
  await app.close();
  assert.equal(await fs.readFile(filename, 'utf8'), '{invalid checkpoint');
});

test('falsy JSON checkpoints are preserved rather than silently reset', async t => {
  const dataDir = await directory(t);
  const filename = path.join(dataDir, 'simulation', 'state.json');
  await fs.mkdir(path.dirname(filename));
  for (const value of ['null', 'false', '0', '""']) {
    await fs.writeFile(filename, value);
    const service = await new SimulationService({ dataDir, autoTick: false }).init();
    assert.throws(() => service.snapshot(), error => error.status === 503);
    await service.close();
    assert.equal(await fs.readFile(filename, 'utf8'), value);
  }
});

test('a failed simulator checkpoint cannot skip production shutdown', async t => {
  const app = await server(t);
  let productionClosed = false;
  const closeProduction = app.service.close.bind(app.service);
  app.service.close = async () => { productionClosed = true; await closeProduction(); };
  app.simulation.persist = async () => { throw new Error('Disk full'); };
  await assert.rejects(app.close(), /Disk full/);
  assert.equal(productionClosed, true);
});
