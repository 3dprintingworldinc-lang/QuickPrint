'use strict';

// This module intentionally has no IO or printer-adapter dependencies.
const STATES = ['idle', 'printing', 'cooling', 'waiting_clear', 'clearing', 'blocked', 'offline'];
const CLOCK_KEYS = ['printMinutes', 'coolingMinutes', 'clearingMinutes', 'clearWaitMinutes', 'blockedMinutes', 'idleMinutes', 'offlineMinutes'];
const MAX_TIME = 1e9;
const MAX_EVENTS = 1000;
const clone = value => structuredClone(value);
const round = value => Math.round(value * 1e9) / 1e9;
function fail(message) { const error = new Error(message); error.status = 400; throw error; }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}
function number(value, fallback, min, max, label, integer = false) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) fail(`${label} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  return result;
}
function string(value, fallback, label, limit = 120) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || result.length > limit || /[\u0000-\u001f]/.test(result)) fail(`${label} must be text of at most ${limit} characters.`);
  return result.trim();
}
function id(value, label) {
  const result = string(value, undefined, label, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result)) fail(`${label} must contain letters, numbers, underscores, dots or hyphens.`);
  return result;
}
function bool(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
}
function choice(value, fallback, options, label) {
  const result = value === undefined ? fallback : value;
  if (!options.includes(result)) fail(`${label} must be one of: ${options.join(', ')}.`);
  return result;
}
function list(value, fallback, max, label) {
  const result = value === undefined ? fallback : value;
  if (!Array.isArray(result) || result.length > max) fail(`${label} must be an array with at most ${max} entries.`);
  return result;
}
function unique(items, label) {
  if (new Set(items.map(item => item.id)).size !== items.length) fail(`${label} IDs must be unique.`);
}
function position(value, room, label) {
  object(value, label);
  return { x: number(value.x, undefined, 0.5, room.width - 0.5, `${label}.x`), z: number(value.z, undefined, 0.5, room.depth - 0.5, `${label}.z`) };
}
function volume(value, label) {
  object(value, label);
  return Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, number(value[axis], undefined, 0.1, 5000, `${label}.${axis}`)]));
}

function validateScenario(input) {
  object(input, 'Scenario');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) fail('Unsupported simulation scenario version.');
  const roomInput = object(input.room || { width: 16, depth: 12 }, 'Room');
  const room = { width: number(roomInput.width, 16, 2, 1000, 'Room width'), depth: number(roomInput.depth, 12, 2, 1000, 'Room depth') };
  const clearers = list(input.clearers, [], 32, 'Clearers').map((entry, index) => {
    object(entry, 'Clearer');
    return { id: id(entry.id, 'Clearer ID'), name: string(entry.name, `Robot ${index + 1}`, 'Clearer name'), position: position(entry.position, room, 'Clearer position') };
  });
  unique(clearers, 'Clearer');
  const printers = list(input.printers, [], 100, 'Printers').map((entry, index) => {
    object(entry, 'Printer');
    const clearing = object(entry.clearing || {}, 'Clearing configuration');
    const mode = choice(clearing.mode, 'manual', ['manual', 'automatic', 'robot'], 'Clearing mode');
    const resourceId = clearing.resourceId == null ? null : id(clearing.resourceId, 'Clearing resource ID');
    if (mode === 'robot' && !clearers.some(clearer => clearer.id === resourceId)) fail(`Printer ${entry.id} needs an existing shared clearing resource.`);
    if (mode !== 'robot' && resourceId !== null) fail(`Printer ${entry.id} may only select a clearing resource in robot mode.`);
    const materials = list(entry.materials, ['PLA'], 20, 'Printer materials').map(material => string(material, undefined, 'Material', 40).toUpperCase());
    if (!materials.length || materials.some(material => !material) || new Set(materials).size !== materials.length) fail('Each printer needs unique nonempty materials.');
    return {
      id: id(entry.id, 'Printer ID'), name: string(entry.name, `Printer ${index + 1}`, 'Printer name'), model: string(entry.model, 'Virtual CoreXY', 'Printer model'),
      zone: string(entry.zone, '', 'Printer zone', 40), position: position(entry.position, room, 'Printer position'), rotation: number(entry.rotation, 0, -360, 360, 'Printer rotation'),
      buildVolume: volume(entry.buildVolume || { x: 256, y: 256, z: 256 }, 'Printer build volume'), materials,
      nozzle: number(entry.nozzle, 0.4, 0.1, 5, 'Printer nozzle'), speedMultiplier: number(entry.speedMultiplier, 1, 0.1, 20, 'Printer speed multiplier'),
      enabled: bool(entry.enabled, true, 'Printer enabled'), failureRate: number(entry.failureRate, 0, 0, 1, 'Printer failure rate'),
      clearing: { mode, cooldownMinutes: number(clearing.cooldownMinutes, 2, 0, 1440, 'Cooling duration'), cycleMinutes: number(clearing.cycleMinutes, 1, 0.01, 1440, 'Clearing duration'), resourceId, failureRate: number(clearing.failureRate, 0, 0, 1, 'Clearing failure rate') }
    };
  });
  unique(printers, 'Printer');
  const jobs = list(input.jobs, [], 500, 'Jobs').map((entry, index) => {
    object(entry, 'Job');
    const material = string(entry.material, 'PLA', 'Job material', 40).toUpperCase();
    if (!material) fail('Job material must not be empty.');
    return {
      id: id(entry.id, 'Job ID'), name: string(entry.name, `Job ${index + 1}`, 'Job name'), material, nozzle: number(entry.nozzle, 0.4, 0.1, 5, 'Job nozzle'),
      size: volume(entry.size || { x: 80, y: 60, z: 40 }, 'Job size'), durationMinutes: number(entry.durationMinutes, 20, 0.01, 10080, 'Job duration'),
      quantity: number(entry.quantity, 1, 1, 1000, 'Job quantity', true), priority: number(entry.priority, 1, 0, 100, 'Job priority', true),
      dueMinutes: entry.dueMinutes == null ? null : number(entry.dueMinutes, undefined, 0, MAX_TIME, 'Job due time'), arrivalMinutes: number(entry.arrivalMinutes, 0, 0, MAX_TIME, 'Job arrival time'),
      tag: string(entry.tag, '', 'Job tag', 40), zone: string(entry.zone, '', 'Job zone', 40)
    };
  });
  unique(jobs, 'Job');
  if (jobs.reduce((sum, job) => sum + job.quantity, 0) > 10000) fail('A scenario supports at most 10,000 print copies.');
  const routingInput = object(input.routing || {}, 'Routing');
  const routing = {
    strategy: choice(routingInput.strategy, 'balanced', ['balanced', 'fastest', 'round_robin'], 'Routing strategy'),
    queueOrder: choice(routingInput.queueOrder, 'priority', ['fifo', 'priority', 'due_date'], 'Queue order'),
    rules: list(routingInput.rules, [], 100, 'Routing rules').map((entry, index) => {
      object(entry, 'Routing rule');
      const targetZone = string(entry.targetZone, undefined, 'Rule target zone', 40);
      if (!targetZone) fail('Routing rules need a target zone.');
      return { id: id(entry.id, 'Rule ID'), name: string(entry.name, `Rule ${index + 1}`, 'Rule name'), enabled: bool(entry.enabled, true, 'Rule enabled'), material: string(entry.material, '', 'Rule material', 40).toUpperCase(), tag: string(entry.tag, '', 'Rule tag', 40), minPriority: number(entry.minPriority, 0, 0, 100, 'Rule minimum priority', true), targetZone };
    })
  };
  unique(routing.rules, 'Routing rule');
  return { schemaVersion: 1, name: string(input.name, 'Virtual print farm', 'Scenario name'), seed: number(input.seed, 42, 0, 0xffffffff, 'Random seed', true), room, printers, clearers, jobs, routing };
}

const presetCatalog = Object.freeze([
  { id: 'starter', name: 'Starter farm', description: 'Three PLA printers with manual bed clearing.' },
  { id: 'mixed', name: 'Mixed-material farm', description: 'Material zones, printer capabilities and priority routing.' },
  { id: 'automated', name: 'Automated farm', description: 'Six printers sharing two clearing robots.' }
]);
function createPreset(name = 'starter') {
  if (!presetCatalog.some(preset => preset.id === name)) fail('Unknown simulation preset.');
  const automated = name === 'automated';
  const mixed = name === 'mixed';
  const printers = Array.from({ length: automated ? 6 : mixed ? 4 : 3 }, (_, index) => ({
    id: `p${index + 1}`, name: `Printer ${String(index + 1).padStart(2, '0')}`, model: index === 3 ? 'Large-format CoreXY' : 'Virtual CoreXY',
    zone: mixed && index >= 2 ? 'Engineering' : 'PLA', position: { x: 3 + (index % 3) * 4, z: 3 + Math.floor(index / 3) * 5 }, rotation: 0,
    materials: mixed && index >= 2 ? ['PLA', 'PETG', 'ABS'] : ['PLA', 'PETG'], nozzle: index === 3 && mixed ? 0.6 : 0.4,
    buildVolume: index === 3 ? { x: 350, y: 350, z: 400 } : { x: 256, y: 256, z: 256 }, speedMultiplier: 1 + (index % 3) * 0.2,
    clearing: { mode: automated ? 'robot' : mixed ? 'automatic' : 'manual', cooldownMinutes: 2, cycleMinutes: automated ? 4 : 1, resourceId: automated ? `robot${index < 3 ? 1 : 2}` : null }
  }));
  const jobs = [
    { id: 'brackets', name: 'Customer brackets', material: 'PLA', quantity: 12, durationMinutes: 18, priority: 2, dueMinutes: 120 },
    { id: 'cases', name: 'Sensor cases', material: mixed ? 'PETG' : 'PLA', quantity: 8, durationMinutes: 26, priority: 1, arrivalMinutes: 10, dueMinutes: 240 },
    { id: 'urgent', name: 'Urgent prototype', material: mixed ? 'ABS' : 'PLA', quantity: 2, durationMinutes: 35, priority: 5, arrivalMinutes: 25, dueMinutes: 90, tag: 'urgent' }
  ];
  return validateScenario({ schemaVersion: 1, name: presetCatalog.find(preset => preset.id === name).name, seed: 42, room: { width: 16, depth: 12 }, printers,
    clearers: automated ? [{ id: 'robot1', name: 'North clearing robot', position: { x: 7, z: 4.7 } }, { id: 'robot2', name: 'South clearing robot', position: { x: 7, z: 9.7 } }] : [], jobs,
    routing: { strategy: 'balanced', queueOrder: 'priority', rules: mixed ? [{ id: 'engineering', name: 'Engineering materials', material: 'ABS', targetZone: 'Engineering' }] : [] }
  });
}

class SimulationEngine {
  constructor(scenario) {
    this.scenario = validateScenario(scenario);
    this.timeMinutes = 0;
    this.randomState = this.scenario.seed;
    this.roundRobinIndex = 0;
    this.eventSequence = 0;
    this.events = [];
    this.printers = this.scenario.printers.map(printer => ({ ...clone(printer), state: printer.enabled ? 'idle' : 'offline', currentJobId: null, currentCopy: null, phaseStartedMinutes: null, phaseEndMinutes: null, bedDirty: false, blockedReason: '', clearResourceId: null, waitingSinceMinutes: null, willFail: false, assignedPrintMinutes: 0, completedCopies: 0, failedCopies: 0, ...Object.fromEntries(CLOCK_KEYS.map(key => [key, 0])) }));
    this.jobs = this.scenario.jobs.map(job => ({ ...clone(job), startedCopies: 0, completedCopies: 0, failedCopies: 0 }));
    this.clearers = this.scenario.clearers.map(clearer => ({ ...clone(clearer), state: 'idle', printerId: null, phaseEndMinutes: null, busyMinutes: 0 }));
    this._event('scenario_loaded', `Loaded ${this.scenario.name}.`);
  }

  _event(type, message, printer, job) {
    this.events.push({ id: `e${++this.eventSequence}`, timeMinutes: this.timeMinutes, type, message, ...(printer ? { printerId: printer.id } : {}), ...(job ? { jobId: job.id } : {}) });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  _random() {
    this.randomState = (this.randomState + 0x6d2b79f5) >>> 0;
    let value = this.randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  _phase(printer, state, duration = null) {
    printer.state = state;
    printer.phaseStartedMinutes = duration === null ? null : this.timeMinutes;
    printer.phaseEndMinutes = duration === null ? null : round(this.timeMinutes + duration);
  }

  _release(printer) {
    const resource = this.clearers.find(clearer => clearer.id === printer.clearResourceId);
    if (resource) Object.assign(resource, { state: 'idle', printerId: null, phaseEndMinutes: null });
    printer.clearResourceId = null;
  }

  _block(printer, reason) {
    this._release(printer);
    this._phase(printer, 'blocked');
    printer.blockedReason = reason;
    printer.waitingSinceMinutes = this.timeMinutes;
    printer.bedDirty = true;
    printer.willFail = false;
  }

  _failPrint(printer, reason) {
    const job = this.jobs.find(item => item.id === printer.currentJobId);
    if (!job) fail('Printing state has no assigned job.');
    job.failedCopies += 1;
    printer.failedCopies += 1;
    this._block(printer, reason);
    this._event('print_failed', `${printer.name}: ${job.name} failed; clear the bed before reuse.`, printer, job);
  }

  _clearStart(printer, clearer = null) {
    this._phase(printer, 'clearing', printer.clearing.cycleMinutes);
    printer.waitingSinceMinutes = null;
    printer.willFail = this._random() < printer.clearing.failureRate;
    if (clearer) {
      printer.clearResourceId = clearer.id;
      Object.assign(clearer, { state: 'clearing', printerId: printer.id, phaseEndMinutes: printer.phaseEndMinutes });
    }
    this._event('clearing_started', `${printer.name}: clearing${clearer ? ` with ${clearer.name}` : ''}.`, printer);
  }

  _clearComplete(printer, manual = false) {
    this._release(printer);
    this._phase(printer, 'idle');
    Object.assign(printer, { bedDirty: false, blockedReason: '', currentJobId: null, currentCopy: null, waitingSinceMinutes: null, willFail: false });
    this._event(manual ? 'manual_clear' : 'clearing_completed', `${printer.name}: bed is clear.`, printer);
  }

  _finish(printer) {
    if (printer.state === 'printing') {
      if (printer.willFail) return this._failPrint(printer, 'print_failure');
      const job = this.jobs.find(item => item.id === printer.currentJobId);
      job.completedCopies += 1;
      printer.completedCopies += 1;
      printer.willFail = false;
      this._phase(printer, 'cooling', printer.clearing.cooldownMinutes);
      this._event('print_completed', `${printer.name}: completed ${job.name} copy ${printer.currentCopy}; cooling.`, printer, job);
    } else if (printer.state === 'cooling') {
      if (printer.clearing.mode === 'manual') {
        this._block(printer, 'manual_clear_required');
        this._event('manual_clear_required', `${printer.name}: waiting for an operator to clear the bed.`, printer);
      } else if (printer.clearing.mode === 'automatic') this._clearStart(printer);
      else {
        this._phase(printer, 'waiting_clear');
        printer.waitingSinceMinutes = this.timeMinutes;
        this._event('waiting_clear', `${printer.name}: waiting for a shared clearing robot.`, printer);
      }
    } else if (printer.state === 'clearing') {
      if (printer.willFail) {
        this._block(printer, 'clear_failure');
        this._event('clear_failed', `${printer.name}: clearing failed; operator intervention required.`, printer);
      } else this._clearComplete(printer);
    }
  }

  _rule(job) {
    return this.scenario.routing.rules.find(rule => rule.enabled && (!rule.material || rule.material === job.material) && (!rule.tag || rule.tag === job.tag) && job.priority >= rule.minPriority);
  }

  _candidate(job, printer, checkAvailability = true) {
    const reasons = [];
    const rule = this._rule(job);
    if (!printer.materials.includes(job.material)) reasons.push(`Material ${job.material} is unsupported.`);
    if (Math.abs(printer.nozzle - job.nozzle) > 1e-9) reasons.push(`Requires a ${job.nozzle} mm nozzle.`);
    if (['x', 'y', 'z'].some(axis => job.size[axis] > printer.buildVolume[axis])) reasons.push('Part exceeds build volume in its configured orientation.');
    if (job.zone && job.zone !== printer.zone) reasons.push(`Job requires zone ${job.zone}.`);
    if (rule && rule.targetZone !== printer.zone) reasons.push(`Rule ${rule.name} restricts this job to zone ${rule.targetZone}.`);
    if (checkAvailability) {
      if (printer.state !== 'idle') reasons.push(`Printer is ${printer.state.replace('_', ' ')}${printer.blockedReason ? ` (${printer.blockedReason.replaceAll('_', ' ')})` : ''}.`);
      if (job.arrivalMinutes > this.timeMinutes) reasons.push(`Job arrives at minute ${job.arrivalMinutes}.`);
      if (job.startedCopies >= job.quantity) reasons.push('All requested copies have already been assigned.');
    }
    let score;
    if (this.scenario.routing.strategy === 'fastest') score = job.durationMinutes / printer.speedMultiplier;
    else if (this.scenario.routing.strategy === 'round_robin') score = (this.printers.indexOf(printer) - this.roundRobinIndex + this.printers.length) % this.printers.length;
    else score = printer.assignedPrintMinutes;
    return { printerId: printer.id, eligible: reasons.length === 0, reasons, score: round(score) };
  }

  preview(jobId) {
    const job = this.jobs.find(item => item.id === jobId);
    if (!job) fail('Unknown simulation job.');
    const candidates = this.printers.map(printer => this._candidate(job, printer));
    const selected = candidates.filter(candidate => candidate.eligible).sort((a, b) => a.score - b.score)[0];
    return { jobId, selectedPrinterId: selected?.printerId || null, candidates };
  }

  _queue() {
    const order = this.scenario.routing.queueOrder;
    return this.jobs.filter(job => job.arrivalMinutes <= this.timeMinutes && job.startedCopies < job.quantity).sort((a, b) => {
      if (order === 'priority' && a.priority !== b.priority) return b.priority - a.priority;
      if (order === 'due_date' && a.dueMinutes !== b.dueMinutes) {
        const difference = (a.dueMinutes ?? Infinity) - (b.dueMinutes ?? Infinity);
        if (difference) return difference;
      }
      return a.arrivalMinutes - b.arrivalMinutes || this.jobs.indexOf(a) - this.jobs.indexOf(b);
    });
  }

  _pump() {
    for (let pass = 0; pass < 1000; pass += 1) {
      let changed = false;
      for (const printer of this.printers) {
        if (printer.phaseEndMinutes !== null && printer.phaseEndMinutes <= this.timeMinutes) { this._finish(printer); changed = true; }
      }
      for (const printer of this.printers.filter(item => item.state === 'waiting_clear').sort((a, b) => a.waitingSinceMinutes - b.waitingSinceMinutes)) {
        const clearer = this.clearers.find(item => item.id === printer.clearing.resourceId && item.state === 'idle');
        if (clearer) { this._clearStart(printer, clearer); changed = true; }
      }
      for (const job of this._queue()) {
        if (!this.printers.some(printer => printer.state === 'idle')) break;
        while (job.startedCopies < job.quantity) {
          const selected = this.preview(job.id).selectedPrinterId;
          if (!selected) break;
          const printer = this.printers.find(item => item.id === selected);
          const duration = round(job.durationMinutes / printer.speedMultiplier);
          job.startedCopies += 1;
          Object.assign(printer, { currentJobId: job.id, currentCopy: job.startedCopies, bedDirty: true, blockedReason: '', waitingSinceMinutes: null, assignedPrintMinutes: round(printer.assignedPrintMinutes + duration), willFail: this._random() < printer.failureRate });
          this._phase(printer, 'printing', duration);
          this.roundRobinIndex = (this.printers.indexOf(printer) + 1) % Math.max(1, this.printers.length);
          this._event('print_started', `${printer.name}: started ${job.name} copy ${printer.currentCopy}.`, printer, job);
          changed = true;
        }
      }
      if (!changed) return;
    }
    fail('Simulation exceeded its transition limit.');
  }

  _accrue(delta) {
    const keys = { idle: 'idleMinutes', printing: 'printMinutes', cooling: 'coolingMinutes', waiting_clear: 'clearWaitMinutes', clearing: 'clearingMinutes', blocked: 'blockedMinutes', offline: 'offlineMinutes' };
    for (const printer of this.printers) {
      const key = keys[printer.state];
      printer[key] = round(printer[key] + delta);
      if (printer.state === 'blocked' && printer.bedDirty) printer.clearWaitMinutes = round(printer.clearWaitMinutes + delta);
    }
    for (const clearer of this.clearers) if (clearer.state === 'clearing') clearer.busyMinutes = round(clearer.busyMinutes + delta);
  }

  advance(minutes) {
    number(minutes, undefined, 0, 10080, 'Advance duration');
    const target = round(this.timeMinutes + minutes);
    if (target > MAX_TIME) fail('Simulation clock limit exceeded.');
    this._pump();
    let iterations = 0;
    while (this.timeMinutes < target) {
      if (++iterations > 100000) fail('Simulation exceeded its event limit.');
      let next = target;
      for (const printer of this.printers) if (printer.phaseEndMinutes !== null && printer.phaseEndMinutes > this.timeMinutes) next = Math.min(next, printer.phaseEndMinutes);
      for (const job of this.jobs) if (job.arrivalMinutes > this.timeMinutes && job.startedCopies < job.quantity) next = Math.min(next, job.arrivalMinutes);
      this._accrue(round(next - this.timeMinutes));
      this.timeMinutes = next;
      this._pump();
    }
    return this.snapshot();
  }

  inject(input) {
    object(input, 'Fault');
    const type = choice(input.type, undefined, ['offline', 'online', 'print_failure', 'clear_failure', 'manual_clear'], 'Fault type');
    const printer = this.printers.find(item => item.id === input.printerId);
    if (!printer) fail('Unknown simulation printer.');
    if (type === 'offline') {
      if (printer.state === 'offline') fail('Printer is already offline.');
      if (printer.state === 'printing') this._failPrint(printer, 'offline_during_print');
      this._release(printer);
      this._phase(printer, 'offline');
      printer.willFail = false;
      printer.enabled = false;
      this._event('printer_offline', `${printer.name}: taken offline.`, printer);
    } else if (type === 'online') {
      if (printer.state !== 'offline') fail('Only an offline printer can be brought online.');
      printer.enabled = true;
      if (printer.bedDirty) this._block(printer, 'bed_check_required');
      else this._phase(printer, 'idle');
      this._event('printer_online', `${printer.name}: online${printer.bedDirty ? '; clear the bed before reuse' : ''}.`, printer);
    } else if (type === 'print_failure') {
      if (printer.state !== 'printing') fail('A print failure requires an active print.');
      this._failPrint(printer, 'injected_print_failure');
    } else if (type === 'clear_failure') {
      if (printer.state !== 'clearing') fail('A clearing failure requires an active clearing cycle.');
      this._block(printer, 'injected_clear_failure');
      this._event('clear_failed', `${printer.name}: injected clearing failure.`, printer);
    } else {
      if (!['blocked', 'waiting_clear'].includes(printer.state)) fail('Manual clearing requires a blocked bed or a printer waiting for a clearer.');
      this._clearComplete(printer, true);
    }
    this._pump();
    return this.snapshot();
  }

  _jobSnapshot(job) {
    const activeCopies = this.printers.filter(printer => printer.state === 'printing' && printer.currentJobId === job.id).length;
    const queuedCopies = job.quantity - job.startedCopies;
    const state = activeCopies ? 'printing' : queuedCopies ? (job.arrivalMinutes > this.timeMinutes ? 'scheduled' : 'queued') : job.failedCopies ? (job.completedCopies ? 'partial_failure' : 'failed') : 'completed';
    let routingReason = '';
    if (queuedCopies) {
      const preview = this.preview(job.id);
      if (job.arrivalMinutes > this.timeMinutes) routingReason = `Scheduled to arrive at minute ${job.arrivalMinutes}.`;
      else if (preview.selectedPrinterId) routingReason = `Next eligible printer: ${this.printers.find(printer => printer.id === preview.selectedPrinterId).name}.`;
      else if (!this.printers.some(printer => this._candidate(job, printer, false).eligible)) routingReason = 'No printer satisfies all material, nozzle, volume and routing constraints.';
      else routingReason = 'Compatible printers are busy, offline or waiting for bed clearing.';
    }
    return { ...clone(job), state, queuedCopies, activeCopies, routingReason };
  }

  snapshot() {
    const printers = this.printers.map(printer => ({ ...clone(printer), progress: printer.phaseEndMinutes === null ? 0 : Math.max(0, Math.min(100, round(100 * (this.timeMinutes - printer.phaseStartedMinutes) / (printer.phaseEndMinutes - printer.phaseStartedMinutes || 1)))) }));
    const jobs = this.jobs.map(job => this._jobSnapshot(job));
    const sum = (items, key) => round(items.reduce((total, item) => total + item[key], 0));
    const completedCopies = sum(jobs, 'completedCopies');
    const printMinutes = sum(printers, 'printMinutes');
    const metrics = { elapsedMinutes: this.timeMinutes, completedCopies, failedCopies: sum(jobs, 'failedCopies'), queuedCopies: sum(jobs, 'queuedCopies'), activeCopies: sum(jobs, 'activeCopies'), throughputPerHour: this.timeMinutes ? round(completedCopies * 60 / this.timeMinutes) : 0, utilizationPercent: this.timeMinutes && printers.length ? round(100 * printMinutes / (this.timeMinutes * printers.length)) : 0, printMinutes, clearWaitMinutes: sum(printers, 'clearWaitMinutes'), clearingMinutes: sum(printers, 'clearingMinutes'), coolingMinutes: sum(printers, 'coolingMinutes'), blockedPrinters: printers.filter(printer => printer.state === 'blocked').length, waitingClearers: printers.filter(printer => printer.state === 'waiting_clear').length, availablePrinters: printers.filter(printer => printer.state === 'idle').length, printerCount: printers.length };
    return { scenario: clone(this.scenario), timeMinutes: this.timeMinutes, printers, jobs, clearers: clone(this.clearers), metrics, events: clone(this.events) };
  }

  serialize() {
    return clone({ schemaVersion: 1, scenario: this.scenario, timeMinutes: this.timeMinutes, randomState: this.randomState, roundRobinIndex: this.roundRobinIndex, eventSequence: this.eventSequence, printers: this.printers, jobs: this.jobs, clearers: this.clearers, events: this.events });
  }

  static restore(value) {
    object(value, 'Saved simulation');
    if (value.schemaVersion !== 1) fail('Unsupported saved simulation version.');
    const engine = new SimulationEngine(value.scenario);
    engine.timeMinutes = number(value.timeMinutes, undefined, 0, MAX_TIME, 'Saved clock');
    engine.randomState = number(value.randomState, undefined, 0, 0xffffffff, 'Saved random state', true);
    engine.roundRobinIndex = number(value.roundRobinIndex, undefined, 0, Math.max(0, engine.printers.length - 1), 'Saved routing index', true);
    engine.eventSequence = number(value.eventSequence, undefined, 0, 1e9, 'Saved event sequence', true);
    function matchRuntime(saved, configured, label) {
      list(saved, undefined, configured.length, label);
      if (saved.length !== configured.length || saved.some((item, index) => !item || item.id !== configured[index].id)) fail(`${label} must match scenario IDs and ordering.`);
    }
    matchRuntime(value.jobs, engine.jobs, 'Saved jobs');
    engine.jobs.forEach((job, index) => {
      const saved = object(value.jobs[index], 'Saved job');
      for (const key of ['startedCopies', 'completedCopies', 'failedCopies']) job[key] = number(saved[key], undefined, 0, job.quantity, `Saved ${key}`, true);
      if (job.completedCopies + job.failedCopies > job.startedCopies) fail('Saved job counters are inconsistent.');
      if (job.startedCopies && job.arrivalMinutes > engine.timeMinutes) fail('Saved job starts before its arrival.');
    });
    matchRuntime(value.printers, engine.printers, 'Saved printers');
    engine.printers.forEach((printer, index) => {
      const saved = object(value.printers[index], 'Saved printer');
      printer.state = choice(saved.state, undefined, STATES, 'Saved printer state');
      printer.enabled = bool(saved.enabled, true, 'Saved printer enabled');
      for (const key of CLOCK_KEYS) printer[key] = number(saved[key], undefined, 0, engine.timeMinutes, `Saved ${key}`);
      printer.assignedPrintMinutes = number(saved.assignedPrintMinutes, undefined, 0, MAX_TIME * 10000, 'Saved assigned print time');
      for (const key of ['completedCopies', 'failedCopies']) printer[key] = number(saved[key], undefined, 0, 10000, `Saved printer ${key}`, true);
      printer.bedDirty = bool(saved.bedDirty, false, 'Saved dirty bed');
      printer.willFail = bool(saved.willFail, false, 'Saved failure outcome');
      printer.blockedReason = string(saved.blockedReason, '', 'Saved blocked reason');
      printer.currentJobId = saved.currentJobId == null ? null : id(saved.currentJobId, 'Saved current job');
      const currentJob = engine.jobs.find(job => job.id === printer.currentJobId);
      if (printer.currentJobId && !currentJob) fail('Saved printer references a missing job.');
      printer.currentCopy = saved.currentCopy == null ? null : number(saved.currentCopy, undefined, 1, currentJob?.startedCopies || 0, 'Saved current copy', true);
      if ((printer.currentJobId === null) !== (printer.currentCopy === null)) fail('Saved job and copy must be assigned together.');
      for (const key of ['phaseStartedMinutes', 'phaseEndMinutes', 'waitingSinceMinutes']) printer[key] = saved[key] == null ? null : number(saved[key], undefined, 0, MAX_TIME + 100800, `Saved ${key}`);
      const active = ['printing', 'cooling', 'clearing'].includes(printer.state);
      if (active && (printer.phaseStartedMinutes === null || printer.phaseEndMinutes === null || printer.phaseStartedMinutes > engine.timeMinutes || printer.phaseEndMinutes <= engine.timeMinutes || printer.phaseEndMinutes <= printer.phaseStartedMinutes || !currentJob)) fail('Saved active phase is inconsistent.');
      if (!active && (printer.phaseStartedMinutes !== null || printer.phaseEndMinutes !== null)) fail('Saved inactive printer must not have a scheduled phase.');
      if (printer.waitingSinceMinutes !== null && printer.waitingSinceMinutes > engine.timeMinutes) fail('Saved wait starts in the future.');
      if (printer.state === 'idle' && (printer.bedDirty || currentJob)) fail('Saved idle printer cannot have an occupied bed.');
      if (['printing', 'cooling', 'waiting_clear', 'clearing', 'blocked'].includes(printer.state) && !printer.bedDirty) fail('Saved active printer must have an occupied bed.');
      if ((printer.state === 'offline') === printer.enabled) fail('Saved enabled status disagrees with printer state.');
      if (currentJob && !engine._candidate(currentJob, printer, false).eligible) fail('Saved printer cannot handle its assigned job.');
      if (printer.willFail && !['printing', 'clearing'].includes(printer.state)) fail('Saved failure outcome needs an active print or clearing cycle.');
      const accountedTime = printer.printMinutes + printer.coolingMinutes + printer.clearingMinutes + printer.clearWaitMinutes + printer.idleMinutes + printer.offlineMinutes;
      if (Math.abs(accountedTime - engine.timeMinutes) > Math.max(1e-6, engine.timeMinutes * 1e-12) || printer.blockedMinutes > printer.clearWaitMinutes) fail('Saved printer time accounting is inconsistent.');
      if (printer.state === 'waiting_clear' && (printer.clearing.mode !== 'robot' || printer.waitingSinceMinutes === null)) fail('Saved clearing wait is inconsistent.');
      printer.clearResourceId = saved.clearResourceId == null ? null : id(saved.clearResourceId, 'Saved clearing resource');
      if (printer.clearResourceId && (printer.state !== 'clearing' || printer.clearing.mode !== 'robot' || printer.clearResourceId !== printer.clearing.resourceId)) fail('Saved clearing resource assignment is inconsistent.');
      if (printer.state === 'clearing' && printer.clearing.mode === 'robot' && !printer.clearResourceId) fail('Saved robot clearing phase needs its resource.');
    });
    for (const job of engine.jobs) {
      const assigned = engine.printers.filter(printer => printer.currentJobId === job.id);
      const active = assigned.filter(printer => printer.state === 'printing');
      if (job.startedCopies !== job.completedCopies + job.failedCopies + active.length) fail('Saved print counters do not match active printers.');
      if (new Set(assigned.map(printer => printer.currentCopy)).size !== assigned.length) fail('Saved copies cannot occupy multiple printers.');
    }
    if (engine.printers.reduce((sum, printer) => sum + printer.completedCopies, 0) !== engine.jobs.reduce((sum, job) => sum + job.completedCopies, 0) || engine.printers.reduce((sum, printer) => sum + printer.failedCopies, 0) !== engine.jobs.reduce((sum, job) => sum + job.failedCopies, 0)) fail('Saved job and printer totals disagree.');
    matchRuntime(value.clearers, engine.clearers, 'Saved clearers');
    engine.clearers.forEach((clearer, index) => {
      const saved = object(value.clearers[index], 'Saved clearer');
      clearer.state = choice(saved.state, undefined, ['idle', 'clearing'], 'Saved clearer state');
      clearer.printerId = saved.printerId == null ? null : id(saved.printerId, 'Saved clearer printer');
      clearer.phaseEndMinutes = saved.phaseEndMinutes == null ? null : number(saved.phaseEndMinutes, undefined, engine.timeMinutes, MAX_TIME + 1440, 'Saved clearer end time');
      clearer.busyMinutes = number(saved.busyMinutes, undefined, 0, engine.timeMinutes, 'Saved clearer utilization');
      const assigned = engine.printers.filter(printer => printer.clearResourceId === clearer.id);
      if (clearer.state === 'idle' && (clearer.printerId || clearer.phaseEndMinutes !== null || assigned.length)) fail('Saved idle clearer cannot own a printer.');
      if (clearer.state === 'clearing' && (assigned.length !== 1 || assigned[0].id !== clearer.printerId || assigned[0].phaseEndMinutes !== clearer.phaseEndMinutes)) fail('Saved shared clearer assignment is inconsistent.');
    });
    let lastSequence = Math.max(0, engine.eventSequence - MAX_EVENTS);
    let lastTime = 0;
    engine.events = list(value.events, undefined, MAX_EVENTS, 'Saved events').map(saved => {
      object(saved, 'Saved event');
      const eventId = id(saved.id, 'Saved event ID');
      const sequence = /^e\d+$/.test(eventId) ? Number(eventId.slice(1)) : NaN;
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequence || sequence > engine.eventSequence) fail('Saved event sequence is invalid.');
      lastSequence = sequence;
      const timeMinutes = number(saved.timeMinutes, undefined, lastTime, engine.timeMinutes, 'Saved event time');
      lastTime = timeMinutes;
      const event = { id: eventId, timeMinutes, type: string(saved.type, undefined, 'Saved event type', 64), message: string(saved.message, undefined, 'Saved event message', 500) };
      if (saved.printerId !== undefined) { event.printerId = id(saved.printerId, 'Saved event printer'); if (!engine.printers.some(printer => printer.id === event.printerId)) fail('Saved event printer is missing.'); }
      if (saved.jobId !== undefined) { event.jobId = id(saved.jobId, 'Saved event job'); if (!engine.jobs.some(job => job.id === event.jobId)) fail('Saved event job is missing.'); }
      return event;
    });
    return engine;
  }
}

module.exports = { SimulationEngine, validateScenario, createPreset, presetCatalog };
