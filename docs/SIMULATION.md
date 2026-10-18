# Virtual print farm

QuickPrint's **Simulation** tab is a separate workspace for trying farm layouts,
job routing and bed-clearing setups. It includes an interactive 3D floor, virtual
printers, shared clearing robots, a test-job queue and an accelerated clock. You
can use it without owning or connecting a printer.

Simulation equipment and jobs are independent of the production **Printers** and
**Jobs** tabs. The simulator never calls printer adapters, sends G-code, imports
production jobs or enables real automatic clearing. Its routing rules are a
simulation feature; saving them does not change production dispatch.

## Try a first run

1. Open **Simulation**. A new workspace starts with the mixed-material farm.
2. Choose **Load a template** to try the starter or automated farm instead.
   Loading a template replaces the current scenario and resets its results.
3. Select a printer in the scene or the **Farm equipment** list. Its inspector
   shows capabilities, current work, clearing setup and available test actions.
4. Click **Run**, select a clock speed, or use **Step 5 min** while paused. At
   60×, one real second advances one simulated minute. Pausing stops the clock.
5. Select a job in **Job queue** to see which printers can accept it and why
   other printers are excluded. Open **Event log** to inspect the sequence of
   starts, completions, failures and clearing actions.
6. Export the scenario before replacing it or making a comparison. Change one
   setting, reset, and run the same workload again.

The three templates are:

| Template | Starting configuration | Useful experiment |
| --- | --- | --- |
| Starter farm | Three printers with manual bed clearing | Observe work stopping until an operator clears each bed. |
| Mixed-material farm | Four printers with different materials, nozzles and volumes; dedicated automatic clearing | Test compatibility limits, zones and priority routing. |
| Automated farm | Six printers sharing two clearing robots | Compare print speed with robot capacity and clearing wait. |

## Configure the farm in 3D

Drag the scene to orbit and scroll to zoom. **Top view** switches to a floor-plan
view; **Reset view** restores the camera. Select equipment in the scene or list
to inspect it.

**Edit farm** changes the scenario name, room dimensions and random seed.
**Move equipment** enters layout editing: drag a printer or clearer across the
floor, then choose **Apply layout & reset** or **Cancel**. Position and rotation
can also be entered in the equipment editor. The scene shows printer activity,
print progress, occupied beds and clearing resources.

In **Farm equipment**, add or configure virtual printers and shared clearers.
Each printer has:

- A name and model label, zone, position and rotation.
- Build volume in millimeters, accepted materials and nozzle diameter.
- A speed multiplier: a 20-minute job takes 10 minutes on a 2× printer.
- Initial enabled/offline status and a print-failure probability.
- A clearing mode, cooldown, clearing-cycle duration and clear-failure probability.

Model labels describe virtual equipment. They do not select a hardware adapter
or load measured performance for a real printer model. The engine supports up
to 100 printers and 32 shared clearers. Equipment positions must stay at least
0.5 meters inside the room boundary.

Editing configuration pauses the clock. Applying an edit resets simulated time,
progress, metrics and the event log; the dialog identifies this behavior. If 3D
rendering is unavailable, the equipment list, editors and simulation controls
remain usable.

Paused scenes redraw only when something changes. Computers using software
graphics automatically use lighter shadows and a lower animation rate so farm
configuration remains responsive.

## Define the test workload

Use **Add test job** to describe a part without uploading a model file. Set the
material, nozzle, part dimensions, estimated duration per copy, quantity,
priority, arrival time, optional due time, tag and optional required zone.
Arrival and due times are minutes from the beginning of the run. Jobs that have
not arrived cannot be assigned.

One copy occupies one printer. Copies can run on several printers at once;
there is no plate nesting or multi-part slicing. Failed copies count as failed
attempts within the requested quantity and are not automatically reprinted.
A scenario supports up to 500 jobs, 1,000 copies per job and 10,000 copies total.

## Configure routing

Open **Routing logic** to choose both queue order and printer selection.

| Setting | Behavior |
| --- | --- |
| Highest priority first | Higher numerical priority is considered first; ties use arrival time and scenario order. |
| First in, first out | Earlier arrivals are considered first; ties use scenario order. |
| Earliest due time first | Earlier due times are considered first; jobs without a due time come last. |
| Balanced | Selects the eligible printer with the least total assigned print time in the current run. |
| Fastest | Selects the eligible printer with the shortest estimated duration for this copy. |
| Round robin | Rotates through eligible printers in scenario order. |

These choices are non-preemptive: a new high-priority job does not interrupt an
active print. The scheduler considers available printers and can start later
jobs when an earlier job has no eligible printer.

Add ordered zone rules using material, job tag and minimum priority. All
specified conditions must match. The **first enabled matching rule** restricts
the job to its target zone; use **Move up** and **Move down** to set precedence.
An empty material or tag matches any value. Material names are normalized to
uppercase; zone and tag matching is exact.

Routing never overrides compatibility. A printer must accept the material,
have the required nozzle diameter, fit the part's configured X/Y/Z dimensions,
and satisfy both the job's required zone and the matching rule's target zone.
It must also be idle with a clear bed. Parts are not rotated automatically to
fit. A rule can deliberately leave a job without an eligible printer.

The job inspector's **Routing decision** lists each printer's exclusion reasons
and eligible routing score. Lower scores are preferred. Scores represent the
selected strategy, not a common cost or a predicted completion time. A preview
describes current eligibility for that job; it does not reserve a printer or
bypass jobs ahead of it in the queue.

## Test automatic clearing

Configure clearing per printer. After a successful print, the printer stays
occupied through cooldown and clearing before it can start another copy.

| Mode | Behavior after cooldown |
| --- | --- |
| Manual | The bed remains blocked until you select **Manually clear bed**. |
| Automatic | A dedicated mechanism runs that printer's clearing cycle. |
| Robot | The printer waits for its assigned shared clearing resource, then runs its clearing cycle. |

Create shared clearers in **Farm equipment**, then assign them in each printer's
**Auto clear setup**. A shared resource serves one printer at a time; waiting
printers retain their occupied beds. Earlier waiting printers receive the
resource first, with scenario order breaking ties. A clearer must be unassigned
from its printers before it can be removed.

A failed print or failed clearing cycle blocks the bed and requires manual
intervention; it does not silently retry or make the bed available. The printer
inspector also provides state-appropriate actions to take equipment offline,
bring it online, simulate a print failure, simulate a clearing failure or clear
a waiting/blocked bed. Taking a printing machine offline fails its active copy.
Bringing an occupied machine online still requires a bed check and manual clear.

Print and clearing failures use the scenario seed. Repeating the same scenario
with the same actions and timing reproduces the outcomes. Changing routing or
injecting an action can change which operation receives each random outcome.
The scene's robot movement is illustrative: robot travel, reach, collision
avoidance and physical part removal are not simulated.

## Read the results

- **Completed copies** counts successful print completions, including parts
  still cooling or waiting to be cleared. Failed copies are shown separately.
- **Throughput** is completed copies divided by total elapsed simulated time,
  expressed per hour.
- **Fleet utilization** is time spent printing divided by elapsed time across
  all configured printers, including disabled/offline equipment. Cooling and
  clearing do not count as printing.
- **Waiting to clear** counts printers waiting for a shared resource. The
  accompanying blocked count includes manual-clear and failure interventions;
  accumulated waiting time includes dirty blocked beds.
- **Event log** retains the latest 1,000 simulation events.

The clock continues when work is blocked or finished, so throughput and
utilization can decrease as additional idle time passes. Compare runs at the
same simulated time or another deliberately chosen stopping point.

## Save, import and reset

Progress is saved in the QuickPrint data folder under
`simulation/state.json`. Closing and reopening QuickPrint restores the saved
run **paused**; it does not simulate the time the application was closed.
Workspace backups include this state. A corrupt simulation checkpoint is
reported without replacing production data.

**Export scenario** downloads configuration as JSON, including layout, workload,
rules and seed. It does not export the current clock, results or event log.
**Import scenario** validates the configuration before replacing the current
scenario, then starts from minute zero. **Reset** keeps the configuration and
clears run progress. Export configurations for repeatable comparisons and use
workspace backups to preserve a run in progress.

## What the simulation measures

This is a discrete-event capacity and workflow simulation. Print durations,
speed multipliers, cooldowns, clear cycles and failure probabilities are inputs
you provide. Results are not slicer estimates, mechanical validation or proof
that a real auto-clear mechanism is safe. Floor placement changes the visual
layout; it does not change routing or clearing time.

The simulator does not model temperature, filament supply, tool changes, network
latency, robot travel, collisions, detailed CAD geometry or automatic physical
bed clearing. Use measured durations and failure data from your own farm when
testing planning assumptions, then validate any real workflow separately.
