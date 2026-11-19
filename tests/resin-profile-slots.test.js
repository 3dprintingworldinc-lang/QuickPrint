'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { QuickPrintService } = require('../src/core/service');
const { CONFIRMED, createProfile, makeSlice, importTicket, deferred } = require('./helpers/resin-slice');

async function fixture(t, prepareResin = makeSlice) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-slots-'));
  const first = await createProfile(dataDir);
  const secondDirectory = path.join(dataDir, 'second'); await fs.mkdir(secondDirectory);
  const second = await createProfile(secondDirectory);
  const profile = JSON.parse(await fs.readFile(second.profilePath)); profile.material = 'Second resin'; profile.printerId = 'fixture-printer-2';
  await fs.writeFile(second.profilePath, JSON.stringify(profile));
  const slots = [{ id: 'grey-50', name: 'Grey · 50 µm', profilePath: first.profilePath }, { id: 'tough-50', name: 'Tough · 50 µm', profilePath: second.profilePath }];
  let service = new QuickPrintService({ dataDir, resinEngine: { prepareResin } }); await service.init();
  await service.updateSettings({ resinEngine: { ...first, slots } });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, slots, get service() { return service; }, async reopen() { await service.close(); service = new QuickPrintService({ dataDir, resinEngine: { prepareResin } }); await service.init(); } };
}

test('each resin ticket selects its own named slot and preserves the selected profile identity across restart', async t => {
  const calls = []; const f = await fixture(t, options => { calls.push(options.profilePath); return makeSlice(options); });
  const one = await importTicket(f.service), two = await importTicket(f.service);
  const first = await f.service.sliceResinJob(one.id, { ...CONFIRMED, profileSlotId: 'grey-50' });
  const second = await f.service.sliceResinJob(two.id, { ...CONFIRMED, profileSlotId: 'tough-50' });
  assert.deepEqual(calls, f.slots.map(slot => slot.profilePath));
  assert.equal(first.resinSlice.operatorReview.profileSlotId, 'grey-50'); assert.equal(first.resinSlice.operatorReview.profileSlotName, 'Grey · 50 µm');
  assert.equal(second.resinSlice.material, 'Second resin'); assert.equal(second.resinSlice.printerId, 'fixture-printer-2');
  assert.notEqual(first.resinSlice.profileSha256, second.resinSlice.profileSha256);
  assert.equal(second.resinSlice.printReady, false); assert.equal(second.artifact, undefined);
  await f.reopen(); assert.deepEqual(f.service.getSettings().resinEngine.slots, f.slots);
  assert.equal(f.service.getJob(two.id).resinSlice.operatorReview.profileSlotId, 'tough-50');
});

test('multiple slots require a configured identity and never silently fall back to the legacy path', async t => {
  let calls = 0; const f = await fixture(t, options => { calls++; return makeSlice(options); }); const job = await importTicket(f.service);
  for (const profileSlotId of [undefined, '', 'deleted-slot', { profilePath: f.slots[0].profilePath }]) await assert.rejects(f.service.sliceResinJob(job.id, { ...CONFIRMED, profileSlotId }), { code: 'RESIN_PROFILE_SLOT_REQUIRED' });
  assert.equal(calls, 0); assert.equal(f.service.getJob(job.id).status, 'review');
  await f.service.updateSettings({ resinEngine: { slots: [f.slots[1]] } });
  const result = await f.service.sliceResinJob(job.id, CONFIRMED); assert.equal(result.resinSlice.operatorReview.profileSlotId, 'tough-50');
  await f.service.updateSettings({ resinEngine: { slots: [] } });
  await assert.rejects(f.service.sliceResinJob(job.id, { ...CONFIRMED, profileSlotId: 'tough-50' }), { code: 'RESIN_PROFILE_SLOT_REQUIRED' });
  assert.equal((await f.service.sliceResinJob(job.id, CONFIRMED)).resinSlice.operatorReview.profileSlotId, undefined);
});

test('malformed or duplicate slot settings are rejected atomically', async t => {
  const f = await fixture(t), valid = f.slots[0];
  for (const slots of [null, {}, Array.from({ length: 33 }, (_, n) => ({ ...valid, id: `slot-${n}` })), [valid, valid], [{ ...valid, id: '../outside' }], [{ ...valid, name: '' }], [{ ...valid, profilePath: 'relative.json' }], [{ ...valid, profilePath: `${valid.profilePath}\n` }], [{ ...valid, executable: 'untrusted' }]]) {
    await assert.rejects(f.service.updateSettings({ resinEngine: { slots } }), { code: 'RESIN_PROFILE_SLOTS_INVALID' });
    assert.deepEqual(f.service.getSettings().resinEngine.slots, f.slots);
  }
});

test('editing slots during preparation cannot change the profile selected for the current slice', async t => {
  const entered = deferred(), release = deferred(); const f = await fixture(t, async options => { entered.resolve(); await release.promise; return makeSlice(options); });
  const job = await importTicket(f.service); const pending = f.service.sliceResinJob(job.id, { ...CONFIRMED, profileSlotId: 'tough-50' }); await entered.promise;
  await f.service.updateSettings({ resinEngine: { slots: [{ ...f.slots[1], name: 'Changed name', profilePath: f.slots[0].profilePath }] } });
  release.resolve(); const result = await pending;
  assert.equal(result.resinSlice.operatorReview.profileSlotName, 'Tough · 50 µm'); assert.equal(result.resinSlice.material, 'Second resin');
});
