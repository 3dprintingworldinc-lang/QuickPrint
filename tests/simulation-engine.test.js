'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SimulationEngine, validateScenario, createPreset, presetCatalog } = require('../src/simulation/engine');

function printer(id, changes = {}) {
  return { id, name: id, zone: 'PLA', position: { x: 2, z: 2 }, materials: ['PLA'], buildVolume: { x: 250, y: 250, z: 250 }, clearing: { mode: 'automatic', cooldownMinutes: 0, cycleMinutes: 1 }, ...changes };
}
function job(id, changes = {}) { return { id, name: id, material: 'PLA', durationMinutes: 10, quantity: 1, ...changes }; }
function scenario(changes = {}) {
  return { schemaVersion: 1, name: 'Test farm', seed: 123, room: { width: 20, depth: 20 }, printers: [printer('p1')], clearers: [], jobs: [job('j1')], routing: { strategy: 'balanced', queueOrder: 'fifo', rules: [] }, ...changes };
}

test('presets are independent validated farm configurations', () => {
  assert.deepEqual(presetCatalog.map(item => item.id), ['starter', 'mixed', 'automated']);
  for (const preset of presetCatalog) {
    const value = createPreset(preset.id);
    assert.deepEqual(validateScenario(value), value);
    assert.ok(value.printers.length >= 3);
    const engine = new SimulationEngine(value);
    assert.ok(engine.advance(120).metrics.completedCopies > 0);
  }
  const first = createPreset('starter');
  first.printers[0].name = 'Changed';
  assert.notEqual(createPreset('starter').printers[0].name, 'Changed');
  assert.throws(() => createPreset('unknown'), /Unknown/);
});

test('routing rejects every hard incompatibility and explains first matching rule', () => {
  const engine = new SimulationEngine(scenario({
    printers: [printer('material', { materials: ['ABS'] }), printer('nozzle', { nozzle: 0.6 }), printer('volume', { buildVolume: { x: 20, y: 20, z: 20 } }), printer('zone', { zone: 'Other' }), printer('valid')],
    jobs: [job('j1', { zone: 'PLA', tag: 'urgent', priority: 5 })],
    routing: { strategy: 'balanced', rules: [{ id: 'first', name: 'First', tag: 'urgent', targetZone: 'PLA' }, { id: 'second', name: 'Second', tag: 'urgent', targetZone: 'Other' }] }
  }));
  const preview = engine.preview('j1');
  assert.equal(preview.selectedPrinterId, 'valid');
  assert.match(preview.candidates[0].reasons.join(' '), /Material/);
  assert.match(preview.candidates[1].reasons.join(' '), /nozzle/);
  assert.match(preview.candidates[2].reasons.join(' '), /build volume/);
  assert.match(preview.candidates[3].reasons.join(' '), /Rule First/);
  assert.doesNotMatch(preview.candidates.flatMap(candidate => candidate.reasons).join(' '), /Rule Second/);
  engine.advance(1);
  assert.equal(engine.snapshot().printers.find(item => item.id === 'valid').state, 'printing');
});

test('balanced, fastest and round robin make different repeat assignment decisions', () => {
  const printers = [printer('slow'), printer('fast', { speedMultiplier: 2 })];
  const jobs = [job('first', { durationMinutes: 2 }), job('second', { arrivalMinutes: 10, durationMinutes: 2 }), job('third', { arrivalMinutes: 20, durationMinutes: 2 })];
  const choices = {};
  for (const strategy of ['balanced', 'fastest', 'round_robin']) {
    const engine = new SimulationEngine(scenario({ printers, jobs, routing: { strategy } }));
    choices[strategy] = engine.advance(30).events.filter(event => event.type === 'print_started').map(event => event.printerId);
  }
  assert.deepEqual(choices.balanced, ['slow', 'fast', 'fast']);
  assert.deepEqual(choices.fastest, ['fast', 'fast', 'fast']);
  assert.deepEqual(choices.round_robin, ['slow', 'fast', 'slow']);
});

test('queue ordering respects FIFO, priority and due dates without blocking compatible later work', () => {
  const jobs = [job('first', { priority: 1, dueMinutes: 90 }), job('urgent', { priority: 10, dueMinutes: 60 }), job('due', { priority: 1, dueMinutes: 10 })];
  for (const [queueOrder, expected] of [['fifo', 'first'], ['priority', 'urgent'], ['due_date', 'due']]) {
    const engine = new SimulationEngine(scenario({ jobs, routing: { queueOrder } }));
    assert.equal(engine.advance(0).printers[0].currentJobId, expected);
  }
  const engine = new SimulationEngine(scenario({ jobs: [job('impossible', { material: 'ABS', priority: 100 }), job('possible')], routing: { queueOrder: 'priority' } }));
  const snapshot = engine.advance(0);
  assert.equal(snapshot.printers[0].currentJobId, 'possible');
  assert.match(snapshot.jobs[0].routingReason, /No printer/);
});

test('quantity and future arrivals are routed without starting before arrival', () => {
  const engine = new SimulationEngine(scenario({ jobs: [job('later', { quantity: 3, arrivalMinutes: 5, durationMinutes: 2 })] }));
  assert.equal(engine.advance(4).printers[0].state, 'idle');
  assert.equal(engine.snapshot().jobs[0].state, 'scheduled');
  assert.equal(engine.advance(1).printers[0].state, 'printing');
  const complete = engine.advance(20);
  assert.equal(complete.metrics.completedCopies, 3);
  assert.equal(complete.jobs[0].queuedCopies, 0);
  assert.equal(complete.jobs[0].state, 'completed');
  assert.deepEqual(complete.events.filter(event => event.type === 'print_started').map(event => event.timeMinutes), [5, 8, 11]);
});

test('printing cannot restart before cooldown and automatic bed clearing finish', () => {
  const engine = new SimulationEngine(scenario({ printers: [printer('p1', { clearing: { mode: 'automatic', cooldownMinutes: 3, cycleMinutes: 2 } })], jobs: [job('j1', { quantity: 2, durationMinutes: 5 })] }));
  assert.equal(engine.advance(5).printers[0].state, 'cooling');
  assert.equal(engine.advance(2).printers[0].state, 'cooling');
  assert.equal(engine.advance(1).printers[0].state, 'clearing');
  assert.equal(engine.advance(1).printers[0].currentCopy, 1);
  const result = engine.advance(1);
  assert.equal(result.printers[0].state, 'printing');
  assert.equal(result.printers[0].currentCopy, 2);
  assert.equal(result.metrics.printMinutes, 5);
  assert.equal(result.metrics.coolingMinutes, 3);
  assert.equal(result.metrics.clearingMinutes, 2);
  assert.equal(result.metrics.utilizationPercent, 50);
});

test('manual clearing blocks indefinitely and operator acknowledgement releases one bed', () => {
  const engine = new SimulationEngine(scenario({ printers: [printer('p1', { clearing: { mode: 'manual', cooldownMinutes: 2, cycleMinutes: 1 } })], jobs: [job('j1', { quantity: 2, durationMinutes: 3 })] }));
  const blocked = engine.advance(100);
  assert.equal(blocked.metrics.completedCopies, 1);
  assert.equal(blocked.printers[0].state, 'blocked');
  assert.equal(blocked.printers[0].blockedReason, 'manual_clear_required');
  assert.equal(blocked.metrics.clearWaitMinutes, 95);
  const resumed = engine.inject({ type: 'manual_clear', printerId: 'p1' });
  assert.equal(resumed.printers[0].currentCopy, 2);
  assert.equal(resumed.printers[0].state, 'printing');
  assert.throws(() => engine.inject({ type: 'manual_clear', printerId: 'p1' }), /requires/);
});

test('shared robot serializes simultaneous clear requests and reports the bottleneck', () => {
  const clearing = { mode: 'robot', resourceId: 'r1', cooldownMinutes: 0, cycleMinutes: 4 };
  const engine = new SimulationEngine(scenario({ printers: [printer('p1', { clearing }), printer('p2', { clearing })], clearers: [{ id: 'r1', position: { x: 5, z: 5 } }], jobs: [job('j1', { quantity: 4, durationMinutes: 2 })] }));
  const waiting = engine.advance(2);
  assert.equal(waiting.printers[0].state, 'clearing');
  assert.equal(waiting.printers[1].state, 'waiting_clear');
  assert.equal(waiting.clearers[0].printerId, 'p1');
  const transferred = engine.advance(4);
  assert.equal(transferred.clearers[0].printerId, 'p2');
  assert.equal(transferred.printers[0].state, 'printing');
  assert.equal(transferred.metrics.clearWaitMinutes, 4);
  assert.equal(transferred.clearers[0].busyMinutes, 4);
  const final = engine.advance(30);
  assert.equal(final.metrics.completedCopies, 4);
  assert.equal(final.clearers[0].busyMinutes, 16);
  assert.equal(final.printers.every(item => item.state === 'idle'), true);
});

test('seeded outcomes and event timelines are identical across advance chunk sizes and restore', () => {
  const value = scenario({ printers: [printer('p1', { failureRate: 0.4 }), printer('p2', { failureRate: 0.4 })], jobs: [job('j1', { quantity: 20, durationMinutes: 0.75 })] });
  const one = new SimulationEngine(value);
  const many = new SimulationEngine(value);
  one.advance(10);
  for (let index = 0; index < 40; index += 1) many.advance(0.25);
  assert.deepEqual(many.serialize(), one.serialize());
  assert.ok(one.snapshot().metrics.failedCopies > 0);
  const restored = SimulationEngine.restore(JSON.parse(JSON.stringify(one.serialize())));
  assert.deepEqual(restored.serialize(), one.serialize());
  for (const engine of [one, restored]) {
    for (const item of engine.snapshot().printers) if (item.state === 'blocked') engine.inject({ type: 'manual_clear', printerId: item.id });
    engine.advance(10);
  }
  assert.deepEqual(restored.serialize(), one.serialize());
});

test('save and restore preserve paused printing, cooling, clearing and robot wait phases', () => {
  for (const mode of ['automatic', 'robot', 'manual']) {
    const clearing = { mode, resourceId: mode === 'robot' ? 'r1' : null, cooldownMinutes: 2, cycleMinutes: 4 };
    const engine = new SimulationEngine(scenario({ printers: [printer('p1', { clearing }), printer('p2', { clearing })], clearers: mode === 'robot' ? [{ id: 'r1', position: { x: 4, z: 4 } }] : [], jobs: [job('j1', { quantity: 4, durationMinutes: 5 })] }));
    for (const duration of [1, 4, 2, 3]) {
      engine.advance(duration);
      const restored = SimulationEngine.restore(engine.serialize());
      assert.deepEqual(restored.snapshot(), engine.snapshot());
      assert.deepEqual(restored.advance(0), engine.snapshot());
    }
  }
});

test('fault injection fails active copies once and never silently reuses an occupied bed', () => {
  const engine = new SimulationEngine(scenario({ jobs: [job('j1', { quantity: 2 })] }));
  engine.advance(1);
  assert.equal(engine.inject({ type: 'offline', printerId: 'p1' }).metrics.failedCopies, 1);
  assert.equal(engine.advance(50).printers[0].state, 'offline');
  assert.equal(engine.inject({ type: 'online', printerId: 'p1' }).printers[0].state, 'blocked');
  engine.inject({ type: 'manual_clear', printerId: 'p1' });
  assert.equal(engine.snapshot().printers[0].currentCopy, 2);
  engine.inject({ type: 'print_failure', printerId: 'p1' });
  assert.equal(engine.snapshot().jobs[0].state, 'failed');
  assert.equal(engine.snapshot().jobs[0].failedCopies, 2);
  assert.throws(() => engine.inject({ type: 'print_failure', printerId: 'p1' }), /active print/);
  assert.throws(() => engine.inject({ type: 'online', printerId: 'p1' }), /offline/);
});

test('clearing failure releases shared resource while retaining blocked occupied bed', () => {
  const clearing = { mode: 'robot', resourceId: 'r1', cooldownMinutes: 0, cycleMinutes: 4, failureRate: 1 };
  const engine = new SimulationEngine(scenario({ printers: [printer('p1', { clearing }), printer('p2', { clearing })], clearers: [{ id: 'r1', position: { x: 4, z: 4 } }], jobs: [job('j1', { quantity: 3, durationMinutes: 1 })] }));
  engine.advance(1);
  const failed = engine.inject({ type: 'clear_failure', printerId: 'p1' });
  assert.equal(failed.printers[0].state, 'blocked');
  assert.equal(failed.printers[0].bedDirty, true);
  assert.equal(failed.clearers[0].printerId, 'p2');
  const stochastic = engine.advance(4);
  assert.equal(stochastic.printers[1].state, 'blocked');
  assert.equal(stochastic.clearers[0].state, 'idle');
  assert.equal(stochastic.metrics.failedCopies, 0, 'A failed clearing cycle does not invalidate the completed print.');
});

test('progress, metrics and snapshots are independent from mutable caller data', () => {
  const input = scenario();
  const engine = new SimulationEngine(input);
  input.printers[0].materials.push('ABS');
  const result = engine.advance(2.5);
  assert.equal(result.printers[0].progress, 25);
  assert.equal(result.metrics.utilizationPercent, 100);
  result.printers[0].state = 'offline';
  result.scenario.name = 'Edited';
  assert.equal(engine.snapshot().printers[0].state, 'printing');
  assert.notEqual(engine.snapshot().scenario.name, 'Edited');
  assert.deepEqual(engine.snapshot().printers[0].materials, ['PLA']);
});

test('scenario validation rejects unsafe limits, unknown resources, bad IDs and out-of-room positions', () => {
  const mutations = [
    value => { value.printers[0].position.x = -1; },
    value => { value.printers[0].position.z = 20; },
    value => { value.printers[0].speedMultiplier = NaN; },
    value => { value.printers[0].nozzle = Infinity; },
    value => { value.printers[0].id = '../printer'; },
    value => { value.printers.push(clone(value.printers[0])); },
    value => { value.printers[0].clearing = { mode: 'robot', resourceId: 'missing' }; },
    value => { value.jobs[0].quantity = 1001; },
    value => { value.jobs[0].quantity = '2'; },
    value => { value.jobs[0].durationMinutes = 0; },
    value => { value.routing.strategy = 'eval(code)'; },
    value => { value.printers[0].materials = []; },
    value => { value.room.width = 1; },
    value => { value.seed = 1.25; }
  ];
  for (const mutate of mutations) {
    const input = scenario();
    mutate(input);
    assert.throws(() => validateScenario(input), error => error.status === 400);
  }
  const engine = new SimulationEngine(scenario());
  for (const duration of [-1, Infinity, NaN, 10081, '1']) assert.throws(() => engine.advance(duration));
  assert.throws(() => engine.inject({ type: 'execute', printerId: 'p1' }));
  assert.throws(() => engine.preview('unknown'));
});

test('restore rejects inconsistent counters, phases, IDs, resources and malformed event records', () => {
  const engine = new SimulationEngine(scenario());
  engine.advance(1);
  const valid = engine.serialize();
  const mutations = [
    value => { value.timeMinutes = NaN; },
    value => { value.randomState = -1; },
    value => { value.printers[0].state = 'imaginary'; },
    value => { value.printers[0].phaseEndMinutes = 0; },
    value => { value.printers[0].currentJobId = 'missing'; },
    value => { value.printers[0].bedDirty = false; },
    value => { value.printers[0].clearResourceId = 'missing'; },
    value => { value.jobs[0].startedCopies = 0; },
    value => { value.jobs[0].completedCopies = 1; },
    value => { value.events[0].timeMinutes = 100; },
    value => { value.events[0].id = 'e999999'; },
    value => { value.printers = []; }
  ];
  for (const mutate of mutations) {
    const value = clone(valid);
    mutate(value);
    assert.throws(() => SimulationEngine.restore(value), error => error.status === 400);
  }
});

test('empty farm and bounded event history advance without per-second loops', () => {
  const empty = new SimulationEngine(scenario({ printers: [], jobs: [] }));
  assert.equal(empty.advance(10080).metrics.utilizationPercent, 0);
  const engine = new SimulationEngine(scenario({ jobs: [job('j1', { durationMinutes: 0.01, quantity: 1000 })], printers: [printer('p1', { clearing: { mode: 'automatic', cooldownMinutes: 0, cycleMinutes: 0.01 } })] }));
  const result = engine.advance(10080);
  assert.equal(result.metrics.completedCopies, 1000);
  assert.equal(result.events.length, 1000);
  assert.deepEqual(SimulationEngine.restore(engine.serialize()).snapshot(), result);
});

function clone(value) { return structuredClone(value); }
