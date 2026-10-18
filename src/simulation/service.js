'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { atomicWrite } = require('../core/store');
const { SimulationEngine, createPreset, presetCatalog } = require('./engine');

function failure(message, status = 400, code = 'SIMULATION_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

// Deliberately owns no production-service or printer-adapter reference.
class SimulationService {
  constructor({ dataDir, now = () => performance.now(), autoTick = true } = {}) {
    this.filePath = path.join(dataDir, 'simulation', 'state.json');
    this.now = now;
    this.autoTick = autoTick;
    this.running = false;
    this.speed = 60;
    this.queue = Promise.resolve();
    this.closed = false;
    this.suspended = false;
    this.lastTick = this.now();
    this.lastSaved = this.lastTick;
  }

  async init() {
    try {
      let saved;
      try {
        const stat = await fs.stat(this.filePath);
        if (stat.size > 4 * 1024 * 1024) throw new Error('Simulation checkpoint is too large.');
        saved = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved !== undefined) {
        if (!saved || typeof saved !== 'object' || saved.version !== 1 || !saved.engine || !Number.isFinite(saved.speed) || saved.speed < 1 || saved.speed > 3600) throw new Error('Unsupported simulation checkpoint.');
        this.engine = SimulationEngine.restore(saved.engine);
        this.speed = saved.speed;
      } else {
        this.engine = new SimulationEngine(createPreset('mixed'));
        await this.persist();
      }
      // Simulated time never advances while QuickPrint is closed.
      this.running = false;
      this.lastTick = this.now();
      if (this.autoTick) {
        this.timer = setInterval(() => {
          if (!this.running || this.tickPending || this.closed || this.suspended) return;
          this.tickPending = true;
          this.tick().catch(error => {
            this.running = false;
            this.runtimeError = error.message || 'The simulation could not advance.';
          }).finally(() => { this.tickPending = false; });
        }, 250);
        this.timer.unref();
      }
    } catch (error) {
      this.initializationError = failure('The saved simulation could not be loaded. Preserve its state.json and restore a verified simulation backup. Production data has not been changed.', 503, 'SIMULATION_STATE_UNAVAILABLE');
      this.engine = null;
    }
    return this;
  }

  ready() {
    if (this.initializationError) throw this.initializationError;
    if (!this.engine) throw failure('The simulation is not ready.', 503);
    if (this.closed) throw failure('The simulation is shutting down.', 503);
  }

  snapshot() {
    this.ready();
    return { ...this.engine.snapshot(), mode: 'simulation', running: this.running,
      speed: this.speed, presets: presetCatalog, error: this.runtimeError || null };
  }

  enqueue(operation) {
    if (this.closed) return Promise.reject(failure('The simulation is shutting down.', 503));
    const result = this.queue.then(() => {
      this.ready();
      if (this.suspended) throw failure('Simulation is paused for a workspace backup.', 503);
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  advanceClock() {
    const current = this.now();
    if (this.running) {
      // Long machine sleeps pause time rather than attempting hours of catch-up.
      const elapsed = Math.max(0, Math.min(5000, current - this.lastTick));
      if (elapsed) this.engine.advance(elapsed / 60000 * this.speed);
    }
    this.lastTick = current;
  }

  async persist(engine = this.engine) {
    try {
      await atomicWrite(this.filePath, JSON.stringify({ version: 1, speed: this.speed,
        engine: engine.serialize(), updatedAt: new Date().toISOString() }));
    } catch (error) {
      this.running = false;
      this.runtimeError = 'Could not save simulation progress. Check available storage.';
      throw error;
    }
    this.lastSaved = this.now();
  }

  tick() {
    return this.enqueue(async () => {
      this.advanceClock();
      if (this.now() - this.lastSaved >= 2000) await this.persist();
    });
  }

  replaceScenario(scenario) {
    return this.enqueue(async () => {
      if (this.running) throw failure('Pause the simulation before editing its scenario.', 409);
      const next = new SimulationEngine(scenario);
      await this.persist(next);
      this.engine = next;
      this.runtimeError = null;
      this.lastTick = this.now();
      return this.snapshot();
    });
  }

  loadPreset(name) { return this.replaceScenario(createPreset(name)); }

  control(body = {}) {
    return this.enqueue(async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('A simulation control object is required.');
      if (!['play', 'pause', 'step', 'reset'].includes(body.action)) throw failure('Choose play, pause, step or reset.');
      if (body.speed !== undefined && (!Number.isFinite(body.speed) || body.speed < 1 || body.speed > 3600)) throw failure('Simulation speed must be from 1× to 3600×.');
      if (['step', 'reset'].includes(body.action) && this.running) throw failure('Pause before stepping or resetting the simulation.', 409);
      const minutes = body.minutes ?? 5;
      if (body.action === 'step' && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)) throw failure('A step must advance more than zero and at most 1440 simulated minutes.');
      this.advanceClock();
      if (body.speed !== undefined) this.speed = body.speed;
      if (body.action === 'play') { this.engine.advance(0); this.running = true; }
      if (body.action === 'pause') this.running = false;
      if (body.action === 'step') this.engine.advance(minutes);
      if (body.action === 'reset') this.engine = new SimulationEngine(this.engine.snapshot().scenario);
      this.runtimeError = null;
      this.lastTick = this.now();
      try { await this.persist(); }
      catch (error) { this.running = false; this.runtimeError = 'Could not save simulation progress. Check available storage.'; throw error; }
      return this.snapshot();
    });
  }

  fault(body) {
    return this.enqueue(async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('A simulation fault object is required.');
      this.advanceClock();
      this.engine.inject(body);
      await this.persist();
      return this.snapshot();
    });
  }

  preview(jobId) { this.ready(); return this.engine.preview(jobId); }

  async freeze() {
    await this.queue;
    if (!this.engine || this.closed) return { wasRunning: false };
    this.advanceClock();
    const wasRunning = this.running;
    this.running = false;
    this.suspended = true;
    try { await this.persist(); }
    catch (error) { this.suspended = false; this.runtimeError = 'The simulation backup checkpoint could not be saved.'; throw error; }
    return { wasRunning };
  }

  resume(token) {
    this.suspended = false;
    if (this.closed || !this.engine) return;
    this.running = Boolean(token?.wasRunning);
    this.lastTick = this.now();
  }

  async close() {
    if (this.closed) return;
    clearInterval(this.timer);
    this.closed = true;
    await this.queue;
    if (!this.engine) return;
    this.advanceClock();
    this.running = false;
    await this.persist();
  }
}

module.exports = { SimulationService };
