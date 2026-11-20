'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { QuickPrintService } = require('../src/core/service');
const { startServer } = require('../src/server');
const { loadProfile } = require('../src/slicing/resin-engine');
const { customizeProfile } = require('../src/slicing/resin-profiles');
const { CONFIRMED, createProfile, makeSlice, importTicket, deferred } = require('./helpers/resin-slice');

async function fixture(t, { http = false, prepareResin = makeSlice } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-customization-'));
  const originals = path.join(dataDir, 'originals'); await fs.mkdir(originals);
  const settings = await createProfile(originals);
  const slots = [{ id: 'grey', name: 'Grey resin', profilePath: settings.profilePath }, { id: 'tough', name: 'Tough resin', profilePath: settings.profilePath }];
  let app;
  let service;
  if (http) { app = await startServer({ dataDir, resinEngine: { prepareResin } }); service = app.service; }
  else { service = new QuickPrintService({ dataDir, resinEngine: { prepareResin } }); await service.init(); }
  await service.updateSettings({ resinEngine: { ...settings, slots } });
  const originalJson = await fs.readFile(settings.profilePath);
  const originalPresetPath = (await loadProfile(settings.profilePath)).presetPath;
  const originalPreset = await fs.readFile(originalPresetPath);
  t.after(async () => { if (app) await app.close(); else await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir, settings, slots, originalJson, originalPreset, originalPresetPath, app,
    get service() { return service; },
    request(route, options = {}) { return fetch(app.url + route, { ...options, headers: { Authorization: `Bearer ${app.token}`, ...options.headers } }); },
    json(route, body) { return this.request(route, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    async unchangedOriginals() { assert.deepEqual(await fs.readFile(settings.profilePath), originalJson); assert.deepEqual(await fs.readFile(originalPresetPath), originalPreset); },
    async reopen() { await service.close(); service = new QuickPrintService({ dataDir, resinEngine: { prepareResin } }); await service.init(); },
  };
}

function pauseManagedWrite(t, dataDir) {
  const entered = deferred(), release = deferred();
  const writeFile = fs.writeFile;
  let stopped = false;
  t.mock.method(fs, 'writeFile', async function (filename, ...args) {
    if (!stopped && String(filename).startsWith(path.join(dataDir, 'profiles', 'resin') + path.sep) && path.basename(String(filename)) === 'profile.json') {
      stopped = true; entered.resolve(); await release.promise;
    }
    return writeFile.call(this, filename, ...args);
  });
  return { entered: entered.promise, release: release.resolve };
}

test('profile GET returns the editable view and frozen hash without raw INI, credentials or executable paths', async t => {
  const f = await fixture(t);
  const loaded = await loadProfile(f.settings.profilePath);
  const result = await f.service.getResinProfileSlot('grey');
  assert.deepEqual(Object.keys(result).sort(), ['profile', 'profileSha256', 'slot']);
  assert.deepEqual(result.slot, f.slots[0]);
  assert.equal(result.profileSha256, loaded.profileSha256);
  assert.deepEqual(Object.keys(result.profile).sort(), ['expected', 'material', 'orientationCandidates', 'padEnabled', 'printerId', 'printerModel', 'supportsEnabled', 'uvtoolsProperties']);
  assert.equal(result.profile.supportsEnabled, true); assert.equal(result.profile.padEnabled, true);
  assert.equal(result.profile.presetPath, undefined); assert.equal(result.profile.ini, undefined);
  assert.ok(!JSON.stringify(result).includes(f.settings.prusaExecutable));
  result.profile.uvtoolsProperties.ExposureTime = 999;
  assert.equal((await f.service.getResinProfileSlot('grey')).profile.uvtoolsProperties.ExposureTime, 2);
  await f.unchangedOriginals();
});

test('customization creates validated independent snapshots and preserves printer geometry and original files', async t => {
  const f = await fixture(t);
  const before = await f.service.getResinProfileSlot('grey');
  const patch = { material: 'Custom tough resin', layerHeightMm: 0.025, supportsEnabled: false, padEnabled: false,
    uvtoolsProperties: { ExposureTime: 3.2, BottomExposureTime: 25, BottomLayerCount: 2, LightPWM: 220, BottomLightPWM: 230, LiftHeight: 6, LiftSpeed: 110, RetractSpeed: 120, WaitTimeBeforeCure: 0.5, TransitionLayerCount: 2 },
    orientationCandidates: [{ x: 20, y: -10, z: 45 }, { x: 30, y: 0, z: 90 }] };
  const customized = await f.service.customizeResinProfileSlot('grey', patch);
  assert.notEqual(customized.slot.profilePath, before.slot.profilePath);
  const relative = path.relative(path.join(f.dataDir, 'profiles', 'resin'), customized.slot.profilePath);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const loaded = await loadProfile(customized.slot.profilePath);
  assert.equal(customized.profileSha256, loaded.profileSha256); assert.notEqual(customized.profileSha256, before.profileSha256);
  assert.equal(loaded.profile.material, patch.material);
  assert.equal(loaded.profile.printerId, before.profile.printerId); assert.equal(loaded.profile.printerModel, before.profile.printerModel);
  assert.deepEqual(loaded.profile.expected, { ...before.profile.expected, layerHeightMm: 0.025 });
  assert.equal(loaded.ini.layer_height, '0.025'); assert.equal(loaded.ini.initial_layer_height, '0.025');
  assert.equal(loaded.ini.exposure_time, '3.2'); assert.equal(loaded.ini.initial_exposure_time, '25');
  assert.equal(loaded.ini.supports_enable, '0'); assert.equal(loaded.ini.pad_enable, '0'); assert.equal(loaded.ini.hollowing_enable, '0');
  assert.equal(loaded.profile.uvtoolsProperties.MachineName, before.profile.printerModel); assert.equal(loaded.profile.uvtoolsProperties.LayerHeight, 0.025);
  assert.deepEqual(loaded.profile.orientationCandidates, patch.orientationCandidates);
  assert.equal((await f.service.getResinProfileSlot('tough')).profileSha256, before.profileSha256, 'another slot sharing the original file stays unchanged');
  await f.unchangedOriginals();
  await f.reopen();
  assert.equal((await f.service.getResinProfileSlot('grey')).profileSha256, customized.profileSha256);
});

test('customization is a pure transformation before snapshot storage and does not mutate caller values', async t => {
  const f = await fixture(t), loaded = await loadProfile(f.settings.profilePath);
  const initial = structuredClone(loaded.profile), initialPreset = Buffer.from(loaded.preset);
  const patch = { material: 'Editable', uvtoolsProperties: { ExposureTime: 4 }, orientationCandidates: [{ x: 5, y: 6, z: 7 }] };
  const originalPatch = structuredClone(patch);
  const changed = customizeProfile(loaded, patch);
  changed.profile.orientationCandidates[0].x = 99;
  assert.deepEqual(loaded.profile, initial); assert.deepEqual(loaded.preset, initialPreset); assert.deepEqual(patch, originalPatch);
});

test('binding a profile to a configured local SDCP printer changes only its printer ID metadata', async t => {
  const f = await fixture(t);
  const printer = await f.service.savePrinter({ name: 'Bound printer', type: 'sdcp', host: 'printer-fixture.invalid', mainboardId: '0123456789abcdef', brandId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const before = await f.service.getResinProfileSlot('grey');
  const bound = await f.service.customizeResinProfileSlot('grey', { printerId: printer.id, expectedProfileSha256: before.profileSha256 });
  assert.deepEqual(bound.profile, { ...before.profile, printerId: printer.id });
  assert.notEqual(bound.profileSha256, before.profileSha256);
  assert.equal((await loadProfile(bound.slot.profilePath)).profile.printerId, printer.id);
  assert.equal((await f.service.getResinProfileSlot('tough')).profile.printerId, before.profile.printerId);
  assert.equal(f.service.snapshot().jobs.length, 0, 'binding metadata neither creates nor dispatches a job');
  await f.unchangedOriginals();
});

test('missing, non-SDCP and unsafe local printer bindings fail without managed files or slot changes', async t => {
  const f = await fixture(t);
  const other = await f.service.savePrinter({ name: 'Different transport', type: 'moonraker', host: 'printer-fixture.invalid' });
  for (const printerId of [randomUUID(), other.id]) await assert.rejects(f.service.customizeResinProfileSlot('grey', { printerId }), { status: 409, code: 'RESIN_PROFILE_PRINTER_INVALID' });
  for (const printerId of ['', '../printer', 123, null]) await assert.rejects(f.service.customizeResinProfileSlot('grey', { printerId }), { status: 400, code: 'RESIN_PROFILE_CUSTOMIZATION_INVALID' });
  assert.deepEqual(f.service.getSettings().resinEngine.slots, f.slots);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'profiles', 'resin')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
  await f.unchangedOriginals();
});

test('removing the selected local printer during snapshot creation prevents a dangling profile binding', async t => {
  const f = await fixture(t);
  const printer = await f.service.savePrinter({ name: 'Removed target', type: 'sdcp', host: 'printer-fixture.invalid' });
  const paused = pauseManagedWrite(t, f.dataDir);
  const pending = f.service.customizeResinProfileSlot('grey', { printerId: printer.id });
  const rejected = assert.rejects(pending, { status: 409, code: 'RESIN_PROFILE_PRINTER_INVALID' });
  try { await paused.entered; await f.service.removePrinter(printer.id); }
  finally { paused.release(); }
  await rejected;
  assert.deepEqual(f.service.getSettings().resinEngine.slots, f.slots);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'profiles', 'resin')), []);
  await f.unchangedOriginals();
});

test('unsafe types, identities, ranges, geometry changes and arbitrary paths are rejected before storing snapshots', async t => {
  const f = await fixture(t);
  const patches = [null, [], {}, { profilePath: '/untrusted' }, { expected: { resolutionX: 1 } }, { material: '' }, { material: 'x\nsecret' }, { material: 2 },
    { layerHeightMm: '0.05' }, { layerHeightMm: 0 }, { layerHeightMm: Infinity }, { layerHeightMm: NaN }, { layerHeightMm: 11 },
    { supportsEnabled: 'false' }, { padEnabled: 0 }, { uvtoolsProperties: null }, { uvtoolsProperties: [] }, { uvtoolsProperties: {} },
    { uvtoolsProperties: { MachineName: 'Different printer' } }, { uvtoolsProperties: { LayerHeight: 0.1 } }, { uvtoolsProperties: { AccessToken: 'private' } },
    { uvtoolsProperties: { LightPWM: 256 } }, { uvtoolsProperties: { BottomLightPWM: 1.5 } }, { uvtoolsProperties: { BottomLayerCount: 1.5 } }, { uvtoolsProperties: { TransitionLayerCount: 1.5 } },
    { uvtoolsProperties: { ExposureTime: 0 } }, { uvtoolsProperties: { BottomExposureTime: -1 } }, { uvtoolsProperties: { WaitTimeAfterCure: 3601 } },
    { uvtoolsProperties: { LiftHeight: 31 } }, { uvtoolsProperties: { LiftSpeed: 0 } }, { uvtoolsProperties: { RetractSpeed: 0 } },
    { uvtoolsProperties: { LiftHeight2: 1 } }, { uvtoolsProperties: { BottomLiftHeight2: 1, BottomLiftSpeed2: 0 } },
    { orientationCandidates: [] }, { orientationCandidates: [{ x: 0, y: 0 }] }, { orientationCandidates: [{ x: '0', y: 0, z: 0 }] },
    { orientationCandidates: [{ x: 361, y: 0, z: 0 }] }, { orientationCandidates: [{ x: 0, y: 0, z: 0, filePath: '/untrusted' }] },
  ];
  for (const patch of patches) await assert.rejects(f.service.customizeResinProfileSlot('grey', patch), { status: 400, code: 'RESIN_PROFILE_CUSTOMIZATION_INVALID' });
  assert.deepEqual(f.service.getSettings().resinEngine.slots, f.slots);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'profiles', 'resin')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
  await f.unchangedOriginals();
});

test('profile loading itself rejects invalid PWM, counts and nonzero motion with zero speed', async t => {
  const f = await fixture(t);
  const original = JSON.parse(f.originalJson);
  for (const change of [{ LightPWM: 256 }, { BottomLightPWM: 0.5 }, { TransitionLayerCount: 1.5 }, { BottomLayerCount: -1 }, { LiftSpeed: 0 }, { RetractSpeed: 0 }]) {
    await fs.writeFile(f.settings.profilePath, JSON.stringify({ ...original, uvtoolsProperties: { ...original.uvtoolsProperties, ...change } }));
    await assert.rejects(loadProfile(f.settings.profilePath), { code: 'RESIN_PROFILE_INVALID' });
  }
  await fs.writeFile(f.settings.profilePath, f.originalJson);
  const result = await f.service.customizeResinProfileSlot('grey', { uvtoolsProperties: { BottomLiftHeight2: 0, BottomLiftSpeed2: 0, LiftHeight2: 0, LiftSpeed2: 0 } });
  assert.equal(result.profile.uvtoolsProperties.LiftSpeed2, 0, 'an unused second motion stage may have zero speed');
});

test('concurrent edits to one slot compose on serialized snapshots while another slot remains independent', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([
    f.service.customizeResinProfileSlot('grey', { material: 'Serialized resin' }),
    f.service.customizeResinProfileSlot('grey', { uvtoolsProperties: { ExposureTime: 4 } }),
  ]);
  assert.notEqual(first.slot.profilePath, second.slot.profilePath);
  assert.equal(second.profile.material, 'Serialized resin'); assert.equal(second.profile.uvtoolsProperties.ExposureTime, 4);
  assert.equal((await f.service.getResinProfileSlot('grey')).profileSha256, second.profileSha256);
  assert.equal((await f.service.getResinProfileSlot('tough')).profile.material, 'Synthetic fixture');
  assert.equal((await loadProfile(first.slot.profilePath)).profile.uvtoolsProperties.ExposureTime, 2, 'previous managed snapshots remain immutable');
});

for (const change of ['replace', 'remove']) test(`slot ${change} during snapshot writing causes a CAS conflict without losing settings or originals`, async t => {
  const f = await fixture(t), paused = pauseManagedWrite(t, f.dataDir);
  const pending = f.service.customizeResinProfileSlot('grey', { material: 'Must not be committed' });
  const rejected = assert.rejects(pending, { code: 'RESIN_PROFILE_SLOT_CHANGED', status: 409 });
  try {
    await paused.entered;
    await f.service.updateSettings({ siteName: 'Changed concurrently', resinEngine: { slots: change === 'remove' ? [f.slots[1]] : [{ ...f.slots[0], name: 'Renamed concurrently' }, f.slots[1]] } });
  } finally { paused.release(); }
  await rejected;
  assert.equal(f.service.getSettings().siteName, 'Changed concurrently');
  assert.equal(f.service.getSettings().resinEngine.slots.length, change === 'remove' ? 1 : 2);
  if (change === 'replace') assert.equal(f.service.getSettings().resinEngine.slots[0].name, 'Renamed concurrently');
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'profiles', 'resin')), [], 'uncommitted managed snapshot is cleaned up');
  await f.unchangedOriginals();
});

test('source file modification during customization is rejected instead of rebinding the slot to stale input', async t => {
  const f = await fixture(t), paused = pauseManagedWrite(t, f.dataDir);
  const pending = f.service.customizeResinProfileSlot('grey', { material: 'Must not be committed' });
  const rejected = assert.rejects(pending, { code: 'RESIN_PROFILE_SOURCE_CHANGED', status: 409 });
  try {
    await paused.entered;
    const profile = JSON.parse(f.originalJson); profile.material = 'Externally changed';
    await fs.writeFile(f.settings.profilePath, JSON.stringify(profile));
  } finally { paused.release(); }
  await rejected;
  assert.deepEqual(f.service.getSettings().resinEngine.slots, f.slots);
  assert.equal((await f.service.getResinProfileSlot('grey')).profile.material, 'Externally changed');
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'profiles', 'resin')), []);
  assert.deepEqual(await fs.readFile(f.originalPresetPath), f.originalPreset);
});

test('unrelated concurrent settings and slot edits survive successful customization', async t => {
  const f = await fixture(t), paused = pauseManagedWrite(t, f.dataDir);
  const pending = f.service.customizeResinProfileSlot('grey', { material: 'Committed resin' });
  try {
    await paused.entered;
    await f.service.updateSettings({ siteName: 'Keep this site', resinEngine: { timeoutMs: 12345, slots: [f.slots[0], { ...f.slots[1], name: 'Keep other slot' }] } });
  } finally { paused.release(); }
  const result = await pending;
  const settings = f.service.getSettings();
  assert.equal(settings.siteName, 'Keep this site'); assert.equal(settings.resinEngine.timeoutMs, 12345);
  assert.equal(settings.resinEngine.slots[1].name, 'Keep other slot'); assert.equal(settings.resinEngine.slots[0].profilePath, result.slot.profilePath);
});

test('customization preserves completed and inflight slice hashes and never grants print readiness', async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, { prepareResin: async options => { calls++; if (calls === 2) { entered.resolve(); await release.promise; } return makeSlice(options); } });
  const one = await importTicket(f.service), two = await importTicket(f.service);
  const captured = await f.service.sliceResinJob(one.id, { ...CONFIRMED, profileSlotId: 'grey' });
  const pending = f.service.sliceResinJob(two.id, { ...CONFIRMED, profileSlotId: 'grey' });
  await entered.promise;
  let customized;
  try { customized = await f.service.customizeResinProfileSlot('grey', { material: 'For future slices only' }); }
  finally { release.resolve(); }
  const inflight = await pending;
  for (const job of [f.service.getJob(one.id), inflight]) {
    assert.equal(job.resinSlice.profileSha256, captured.resinSlice.profileSha256);
    assert.notEqual(job.resinSlice.profileSha256, customized.profileSha256);
    assert.equal(job.resinSlice.material, 'Synthetic fixture'); assert.equal(job.resinSlice.printReady, false); assert.equal(job.resinSlice.printerCompatible, false);
    assert.equal(job.artifact, undefined); assert.equal(job.runs.length, 0);
    await assert.rejects(f.service.dispatchJob(job.id, 'unused', { confirmed: true }), { code: 'RESIN_DISPATCH_UNAVAILABLE' });
  }
  const next = await importTicket(f.service);
  const future = await f.service.sliceResinJob(next.id, { ...CONFIRMED, profileSlotId: 'grey' });
  assert.equal(future.resinSlice.profileSha256, customized.profileSha256); assert.equal(future.resinSlice.material, 'For future slices only');
});

test('HTTP profile routes require local authentication and return exact backend customization results', async t => {
  const f = await fixture(t, { http: true });
  const route = '/api/resin/profiles/grey';
  assert.equal((await fetch(f.app.url + route)).status, 401);
  assert.equal((await fetch(f.app.url + route, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ material: 'Unauthorized' }) })).status, 401);
  const remoteHost = await new Promise((resolve, reject) => {
    const request = http.request(f.app.url + route, { headers: { Host: 'remote.invalid', Authorization: `Bearer ${f.app.token}` } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end();
  });
  assert.equal(remoteHost, 403);
  const before = await (await f.request(route)).json();
  const response = await f.json(route, { material: 'HTTP customized', uvtoolsProperties: { ExposureTime: 3 } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.profile.material, 'HTTP customized'); assert.equal(result.profile.uvtoolsProperties.ExposureTime, 3);
  assert.notEqual(result.profileSha256, before.profileSha256);
  assert.deepEqual(await (await f.request(route)).json(), result);
  assert.equal((await f.json(route, { profilePath: '/untrusted' })).status, 400);
  assert.equal((await f.request('/api/resin/profiles/missing')).status, 404);
  await f.unchangedOriginals();
});

test('a stale HTTP editor hash cannot overwrite another customization or create an unused snapshot', async t => {
  const f = await fixture(t, { http: true }), route = '/api/resin/profiles/grey';
  const firstEditor = await (await f.request(route)).json();
  const saved = await f.json(route, { expectedProfileSha256: firstEditor.profileSha256, material: 'Newer saved resin' });
  assert.equal(saved.status, 200);
  const newer = await saved.json();
  const directory = path.join(f.dataDir, 'profiles', 'resin');
  const committedSnapshots = await fs.readdir(directory);
  for (const expectedProfileSha256 of [firstEditor.profileSha256, '0'.repeat(64), 'not-a-digest', null, 123]) {
    const stale = await f.json(route, { expectedProfileSha256, material: 'Stale form must not win', uvtoolsProperties: firstEditor.profile.uvtoolsProperties });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).error, 'RESIN_PROFILE_SOURCE_CHANGED');
  }
  assert.deepEqual(await (await f.request(route)).json(), newer);
  assert.deepEqual(await fs.readdir(directory), committedSnapshots);
  const refreshed = await f.json(route, { expectedProfileSha256: newer.profileSha256, material: 'Refreshed editor resin' });
  assert.equal(refreshed.status, 200);
  await f.unchangedOriginals();
});

test('profile customization HTTP writes are blocked during a consistent workspace backup', async t => {
  const f = await fixture(t, { http: true });
  const entered = deferred(), release = deferred(), readdir = fs.readdir;
  let stopped = false;
  t.mock.method(fs, 'readdir', async function (directory, ...args) {
    const result = await readdir.call(this, directory, ...args);
    if (!stopped && String(directory) === f.dataDir) { stopped = true; entered.resolve(); await release.promise; }
    return result;
  });
  const backup = f.request('/api/backup');
  try {
    await entered.promise;
    const blocked = await f.json('/api/resin/profiles/grey', { material: 'Blocked during backup' });
    assert.equal(blocked.status, 503); assert.equal((await blocked.json()).error, 'BACKUP_IN_PROGRESS');
    assert.equal((await f.request('/api/resin/profiles/grey')).status, 200, 'profile reads remain available');
  } finally { release.resolve(); }
  const response = await backup; assert.equal(response.status, 200); await response.arrayBuffer();
  assert.deepEqual(f.service.getSettings().resinEngine.slots, f.slots);
  await f.unchangedOriginals();
});
