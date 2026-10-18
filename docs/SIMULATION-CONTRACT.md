# Simulation implementation contract

The simulator is a separate virtual workspace. It never imports printer adapters,
opens printer connections, or creates/modifies production jobs. Its state is saved
under `dataDir/simulation/`. Runtime estimates are scenario inputs, not slicer or
physics predictions.

## Scenario (version 1)

```js
{
  schemaVersion: 1, name: 'Mixed-material farm', seed: 42,
  room: { width: 16, depth: 12 }, // meters; x/z scene coordinates
  printers: [{
    id: 'p1', name: 'Printer 01', model: 'CoreXY', zone: 'PLA',
    position: { x: 3, z: 3 }, rotation: 0,
    buildVolume: { x: 256, y: 256, z: 256 }, // millimeters
    materials: ['PLA', 'PETG'], nozzle: 0.4, speedMultiplier: 1,
    enabled: true, failureRate: 0, // probability 0..1 per print
    clearing: { mode: 'automatic', cooldownMinutes: 2, cycleMinutes: 1,
      resourceId: null, failureRate: 0 }
  }],
  clearers: [{ id: 'robot1', name: 'Clearing robot', position: { x: 8, z: 5 } }],
  jobs: [{
    id: 'j1', name: 'Bracket', material: 'PLA', nozzle: 0.4,
    size: { x: 80, y: 60, z: 40 }, durationMinutes: 20, quantity: 3,
    priority: 1, dueMinutes: 120, arrivalMinutes: 0, tag: '', zone: ''
  }],
  routing: { strategy: 'balanced', queueOrder: 'priority',
    rules: [{ id: 'r1', name: 'PLA zone', enabled: true,
      material: 'PLA', tag: '', minPriority: 0, targetZone: 'PLA' }] }
}
```

Strategies: `balanced`, `fastest`, `round_robin`. Queue order: `fifo`,
`priority`, `due_date`. The first matching enabled rule restricts jobs to its
target zone. Job zone, material, nozzle and build volume remain hard constraints.
Clearing modes: `manual`, `automatic`, `robot`. A robot is one shared resource,
so only one printer can use it at once. Printing, cooling, waiting for a clearer,
clearing and a blocked/uncleared bed all prevent another print from starting.

## Engine (CommonJS, no IO)

`src/simulation/engine.js` exports `SimulationEngine`, `validateScenario`,
`createPreset(name)` and `presetCatalog`. Presets: `starter`, `mixed`, `automated`.

- `new SimulationEngine(scenario)` validates/copies configuration.
- `snapshot()` returns `{ scenario, timeMinutes, printers, jobs, clearers,
  metrics, events }`; runtime arrays include configuration fields and state.
- `advance(minutes)` progresses a deterministic, seeded simulation.
- `preview(jobId)` returns `{ jobId, selectedPrinterId, candidates }`, where each
  candidate has `{ printerId, eligible, reasons, score }`.
- `inject({ type, printerId })` accepts `offline`, `online`, `print_failure`,
  `clear_failure`, `manual_clear` and validates the current state.
- `serialize()` returns JSON-safe state; `SimulationEngine.restore(value)`
  validates and restores it without operating any hardware.

Concrete printer runtime states and metric names are documented by the engine
author here before UI integration. The snapshot includes progress (0..100),
current job ID and phase end time where relevant. Events have stable IDs, simulated
time, type, message and optional job/printer IDs. Bound arrays and advance work.

### Concrete runtime schema

Each printer merges its scenario configuration with:

```js
{
  state: 'idle', // idle | printing | cooling | waiting_clear | clearing | blocked | offline
  progress: 0, // 0..100 through the current printing, cooling or clearing phase
  currentJobId: null, currentCopy: null,
  phaseStartedMinutes: null, phaseEndMinutes: null,
  bedDirty: false, blockedReason: '', clearResourceId: null,
  waitingSinceMinutes: null,
  completedCopies: 0, failedCopies: 0,
  printMinutes: 0, coolingMinutes: 0, clearingMinutes: 0,
  clearWaitMinutes: 0, blockedMinutes: 0, idleMinutes: 0, offlineMinutes: 0,
  assignedPrintMinutes: 0, willFail: false
}
```

`currentJobId` remains assigned during cooling and clearing so the scene can show
the finished part. `manual_clear` is an immediate operator acknowledgement that the
bed has been cleared; it is accepted only in `blocked` or `waiting_clear` states.
`print_failure` and `clear_failure` require `printing` and `clearing`, respectively.
`offline` interrupts any phase, failing an active print and retaining the occupied
bed. `online` returns an occupied bed to `blocked` for operator inspection.

Each job includes `state` (`scheduled`, `queued`, `printing`, `completed`,
`partial_failure`, `failed`), `queuedCopies`, `activeCopies`, `startedCopies`,
`completedCopies`, `failedCopies` and `routingReason`. A failed copy consumes one
requested attempt; retries require another scenario job rather than silently
increasing the requested quantity. Completion counts refer to successful print
completion, before cooldown and bed clearing. Queue counts include future arrivals.

Each clearer includes `state` (`idle` or `clearing`), `printerId`,
`phaseEndMinutes`, and `busyMinutes`. Printer/resource assignments are reciprocal.

`metrics` contains `elapsedMinutes`, `completedCopies`, `failedCopies`,
`queuedCopies`, `activeCopies`, `throughputPerHour`, `utilizationPercent`,
`printMinutes`, `clearWaitMinutes`, `clearingMinutes`, `coolingMinutes`,
`blockedPrinters`, `waitingClearers`, `availablePrinters`, and `printerCount`.
Utilization is printing time divided by elapsed time times configured printer
count, including offline printers. Clearing wait includes shared-resource waits
and blocked occupied beds; it is a sum across printers, not wall-clock duration.

Balanced routing chooses the eligible idle printer with the least cumulative
assigned print time. Fastest chooses the shortest estimated print duration.
Round robin advances a fleet-wide cursor after each assignment. Ties retain
scenario order. Rules use exact material/tag matches and minimum priority;
the first matching enabled rule adds its zone restriction to all hard constraints.
Queue ties use arrival time, then scenario order. Build volume is checked in the
specified orientation; this simulator does not perform packing or model rotation.

Limits: 100 printers, 32 shared clearers, 500 jobs, 10,000 copies, 100 routing
rules, and the latest 1,000 events. One engine advance accepts up to 10,080 minutes.
The clock jumps between arrivals and phase endings rather than iterating each
second. A fixed seed and the same timed faults reproduce the same outcomes.
Serialization includes the random generator, queue counters and in-flight phases;
restore validates these invariants and does not advance time.

## Local API and UI

All routes require the existing local admin bearer token:

- `GET /api/simulation`: snapshot plus `{ running, speed, presets }`.
- `PUT /api/simulation/scenario`: replace with validated scenario, reset time and
  results; only allowed while paused. Body is scenario itself.
- `POST /api/simulation/preset`: `{ name }`, resets while paused.
- `POST /api/simulation/control`: `{ action: 'play'|'pause'|'step'|'reset',
  minutes?: 5, speed?: 60 }`. Step is paused-only. Speed is a clock multiplier.
- `POST /api/simulation/fault`: `{ type, printerId }`.
- `GET /api/simulation/preview/:jobId`: routing explanation.
- `GET /api/simulation/export`: scenario JSON download; importing uses PUT above.

`SimulationService` owns the engine and persistence, freezes the clock during
shutdown/backup, and resumes loaded work paused. Web intake never exposes these
routes. No arbitrary JavaScript, network addresses, commands or G-code in rules.

`#simulation` mounts an independent UI that polls this API without being replaced
by ordinary production-state refreshes. Its 3D scene uses a locally bundled
Three.js module with an explicit dispose lifecycle. A usable list/editor remains
available when WebGL is unavailable. Scenario edits must make their reset behavior
clear; export/import supports reproducible routing experiments.
