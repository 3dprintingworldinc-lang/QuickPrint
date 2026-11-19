# Qualified resin production

QuickPrint implements a conditional path from a reviewed resin slice to an
individually confirmed SDCP print run and PrintByLayr production evidence.
Generic model preparation/dispatch still rejects resin production tickets.
The qualified path requires current studio authorization, exact local
source/profile/device bindings, and local dispatch opt-in for every run.

This is implemented software, not a completed hardware qualification. Actual
printer observations were read-only. Upload, start, control and multi-run flows
have been verified with injected/loopback printer fixtures. No physical output
was qualified through this path. The companion private portal API still needs
its reviewed migration, deployment, production token and qualification settings;
see [portal source and setup](PRINTBYLAYR-PRODUCTION-INTEGRATION.md).

## 1. Establish the printer and reviewed profile

Add the exact SDCP printer under **Printers**, including its configured address,
mainboard ID and brand ID. Test its read-only status. The identity fingerprint
binds those IDs plus reported brand/machine, protocol, firmware, resolution and
physical dimensions. An address or machine name alone does not establish this
identity. See the [SDCP connection contract](SDCP-INTEGRATION.md).

Under **Settings -> Resin model preparation**, configure the complete
PrusaSlicer/UVtools installations and a named profile slot. Save Settings, open
that slot's **Customize profile**, and choose the configured printer in
**Bound local printer**. This sets the profile's `printerId` to the local SDCP
printer UUID. A model label, serial number or portal order ID is not that UUID.
The editor permits only an existing local SDCP printer; saving creates a new
managed profile/INI pair and leaves original files and other slots intact.

Review the material, exposure, motion, layer height, support/pad policy and
orientation candidates. Printer model label, geometry and mirror settings remain
in the reviewed profile. Binding a local printer does not change or calibrate
them. Resolve the known [native-versus-firmware geometry discrepancy](SDCP-INTEGRATION.md#observed-geometry-discrepancy)
before physical qualification. Keep **Enable qualified resin dispatch** off at
this stage; its default is false.

The [headless guide](HEADLESS-RESIN-ENGINE.md) defines the profile schema,
supported versions, file bounds and reproducible synthetic test. That synthetic
profile is not a production calibration.

## 2. Resolve the order and capture a slice

Connect the scoped production machine API under **Inputs** and import a paid
resin ticket awaiting preparation. Resolve scale, target dimensions, supports,
finish and other free-text requirements before slicing. Use **Measure model**,
then choose **Current model size**, **Uniform scale factor** or **Set one
source-axis dimension**. The latter choices scale the whole model uniformly
after its declared mm/in/m conversion. Review the millimetre preview and confirm
the chosen plan. Text instructions are not interpreted automatically.

Original bytes are preserved; a separate normalized and hashed millimetre STL
embodies the numeric plan. Exact candidate-vertex extents after Z -> X -> Y
rotation must fit the reviewed rectangular SLA bed and maximum height. See
[model sizing](RESIN-SIZING.md) for source-axis meaning, parser/float32 bounds and
reproduction. STEP/STP can arrive for review but needs reviewed tessellation
before this STL/triangulated-OBJ resin path.

Select the reviewed slot and choose **Slice resin model**. The engine evaluates
the configured rotations, captures GOO, validates its layers and target values,
and runs the six selected issue checks. Reported issues require review. A clean
capture still has `printReady: false` and `printerCompatible: false`.

Each file contains one submitted source instance (`modelCopiesPerRun: 1`).
Disconnected geometry and support components do not determine how many order
units that model represents. Multiple-copy packing is unavailable because the
Prusa duplication overflow probe silently omitted requested copies; see
[quantity evidence](HEADLESS-RESIN-ENGINE.md#source-copies-and-production-quantity).

## 3. Confirm the device-bound portal receipt

Use **Queue slice receipt**, or enable automatic validated-slice receipt
synchronization on the production input. The manager reads the selected SDCP
device identity and records a `record_slice` operation containing source,
artifact, profile, engine and device fingerprints, material/printer labels,
artifact size/format and `partsPerRun: 1`.

Wait for the outbox operation to be **confirmed**. A queued or pending write is
not a portal receipt. This synchronization sends evidence metadata; it neither
uploads the GOO to the printer nor starts it. A changed device/profile requires
a new capture or device-bound receipt as applicable, followed by review.

## 4. Qualify outside the app, then approve the plan

Open **Review production qualification**. Expand **Studio qualification
binding** to inspect the exact JSON object for this captured profile/engine,
local printer ID, printer model, material, GOO format and physical device
fingerprint. After independent physical calibration and review, the studio
administrator can place reviewed objects in the portal's
`PRODUCTION_QUALIFIED_BINDINGS` JSON array. The panel provides one object; the
portal setting contains an array of those objects.

The application does not perform calibration or establish resin cure,
dimensional accuracy, image handedness, support strength or acceptable motion.
Changing the engine/profile hash, material, printer binding or device/firmware
signature requires another qualification review. An immutable receipt's
historical qualified flag cannot replace the portal's current binding check.

Refresh **Review production qualification**. Once current qualification is
confirmed, explicitly declare that the **whole submitted model represents one
requested production unit**. Use **Approve one-unit run plan**. This stores the
local plan and sends `approve_preparation` through the durable outbox. Wait for
portal confirmation and the `queued` stage before a physical run. Approval is
not a physical start and does not count a printed unit.

The first approval transmission rechecks current files under the job lock and
holds that lock through the portal request and local acknowledgement. Pending or
approved plans block replacement slicing, including an already queued request.
An ambiguous approval stays held for exact replay; a verified zero-unit run
reconciliation clears the local preparation hold for further review. A local
failure before the first request is definitely sent remains an unsent paused
operation. These states must be resolved rather than replacing the bound slice.

## 5. Opt in and start one unit

After qualification, enable **Settings -> Resin model preparation -> Enable
qualified resin dispatch** and save. The API setting is
`resinEngine.dispatchEnabled: true`; the default is false. This switch permits
the qualified path to proceed, but supplies no server qualification itself.

Open the production review and choose **Start one resin unit** only after
checking the stopped/idle printer, build plate, resin and readiness for this
individual run. Confirm the start dialog. Each remaining unit needs another
explicit readiness confirmation.

The service then:

1. Reconciles saved portal evidence and reads fresh authorization for the exact
   queued ticket, receipt, device, current production target and remaining quantity.
2. Rechecks original/normalized-input/GOO/profile hashes, sizing proof, local printer binding, device attributes,
   GOO capabilities and fresh idle status. It creates a short-lived, one-use
   internal permit; HTTP-supplied `qualified`/approval flags cannot create one.
3. Durably records a new run ID and unique remote filename, then uploads that
   bound GOO once.
4. Reads authorization again after upload and rechecks local bindings, actual
   device, readiness and the dispatch switch before requesting a start.
5. Requires an acknowledged start identifying a fresh SDCP task ID and this
   exact filename. It records that identity before synchronizing `start_print`
   evidence to the portal.

A profile/device/source change or revoked qualification halts the flow. If it
occurs after upload, an uploaded file can remain on the printer without a start.
No print is automatically started by polling, receipt synchronization or recovery.

## 6. Record the physical result, then the next unit

Refresh the job's printer status. Idle or 100% progress alone is insufficient.
The service must observe an explicit terminal result for its own SDCP task ID
and filename. A different task/file or a print started outside QuickPrint cannot
complete this run.

When the run needs review, use **Record run outcome**. Verify the stopped printer
and record an outcome, notes and **0 or 1 printed order units**. One requires the
service's identified start and matching completed terminal evidence. Failed,
cancelled or verified-not-started runs contribute zero. Neither telemetry alone
nor a client-supplied completion object invents a printed count.

The manager durably synchronizes `finish_print` or `fail_print`. With one unit
recorded on a two-unit ticket, the portal returns to `queued` with one remaining;
it does not start the next run. Reopen production review, check readiness and
explicitly start that unit. Each run has a new local run ID, remote filename and
identified printer task. Starts/results also bind the current target identity.
When all units of that target are recorded, the
portal advances to `post_processing`.

These are printed-unit counts, not quality acceptance. Generic file-copy
quantity stays separate, and no local `acceptedQuantity`/QC credit is granted.
Washing, curing, support removal, physical inspection and delivery still need
their own evidence and studio workflow.

## 7. Reopen queued preparation for revision

With no active or uncertain local run and no unresolved physical evidence, open
**Review production qualification -> Reopen preparation**. Enter a required
reason and choose **Withdraw preparation**. This sends `withdraw_preparation`
for the exact queued receipt/current version and returns the portal to
`preparing`. It clears approval while preserving payment, the frozen ticket,
current target, printed/remaining counts and immutable run history.

Wait for a confirmed operation and fresh same-target portal read before the local
hold releases. A lost reply retains the hold and replays the same UUID/body after
restart. Withdrawal can recover a preparation whose local source/profile/artifact
is damaged; it supplies no qualification for those files. Restore the verified
source or follow the reviewed source-change workflow, then revise numeric sizing
or profile settings and capture the intended slice. Updating an original file in
place still violates its hash binding.

Review the receipt and approve again. A new approval operation is required even
if the same receipt is reused; an older acknowledgement cannot approve a newer
preparation generation. Withdrawal does not stop a printer, reset production
counts, cancel the order or award QC acceptance.

## 8. Follow an explicit studio QC replacement target

After the current target is completed and its physical evidence is reconciled,
the studio completes post-processing and performs quality inspection. A studio
`qc_fail` requires inspection notes and an explicit `replacementQuantity` integer
from **0 through the original frozen order quantity**. An empty input is not
assumed to be zero. Active runs or an incomplete managed target block that
decision. Machine credentials cannot create or enlarge replacement allowances.

A positive quantity creates a new `replacement` target/cycle and returns the
portal to `preparing`; its target ID is that QC operation's UUID. Use **Review
current target**, confirm the studio-defined allowance, then choose **Prepare
replacement target**. This fetches a fresh, unapproved, stopped target and adopts
the newer QC cycle locally. Confirmation submits the target ID returned by the
review; a different current target must be refreshed and reviewed rather than
silently adopted. It archives previous-target counters, retains source,
captured slice and run history, and clears only the previous target's local plan
hold. It sends no portal write and supplies no preparation approval or device
qualification. Repeating adoption of the same target cannot release a later
approval.

Target review/adoption does not require an intact old slice/profile or device
qualification, so it can reopen preparation for a revised sizing/profile.
Measure/reslice as needed, confirm the intended device-bound receipt, and approve
the new target's plan explicitly before separately confirming each run.
Every fresh authorization, start and result must name that target. Old run
evidence cannot be reused as replacement credit. Zero explicitly authorizes
no replacement printing and returns to `post_processing` for finishing-only
correction and another studio inspection; use **Record finishing-only target**
to adopt that local record without authorizing any physical start.

The original order quantity stays frozen. `production.progress` and the local
production review count only the current target; `production.totals` preserves
lifetime machine evidence and `targetHistory` preserves earlier targets. For
example, an original two-unit order followed by one authorized replacement has
three lifetime printed units, while the replacement target is one requested,
one printed, zero remaining. This is not a three-unit customer order or QC
acceptance. Washing, curing, inspection and explicit studio acceptance remain
separate from those counts.

## Uncertainty and synchronization recovery

| Situation | Handling |
| --- | --- |
| Start acknowledgement/task identity missing or ambiguous | Hold the durable run in `needs_attention`/`result_unknown`; never retry the hardware start automatically, including after restart. Inspect the printer before reconciling. |
| Unknown start later appears under a matching filename | A filename does not repair missing original start identity. Positive credit still requires the service's identified start/completion evidence. |
| Portal response lost after a physical start/result | Keep the physical evidence locally and replay the same saved operation UUID, expected version and exact body. Do not repeat the physical action. |
| Start/result writeback pending | Later evidence for that job waits for reconciliation; a new unit cannot overtake unconfirmed printed progress. |
| Definite portal conflict/rejection | Review the saved operation and current ticket. A recorded local dismissal preserves history and does not undo a remote operation. Attempted uncertain writes require exact replay/reconciliation. |

After independently verifying that an uncertain run did not start, or that a
stopped run failed, record zero units with the appropriate outcome. An active
printer cannot be released as a stopped zero-unit run. Do not guess a new task
identity or manufacture a completion receipt to release a hold.

## API and test boundary

All routes require the local QuickPrint access token:

| Route | Operation |
| --- | --- |
| `GET /api/jobs/:id/resin/production` | Read current receipt/device qualification, binding JSON, plan and quantities |
| `GET .../production/target` | Read the current studio target without slice/device qualification |
| `POST .../production/target` | `{confirmedTarget:true, targetId}` using the UUID returned by GET; locally adopt that newer stopped, unapproved replacement/finishing target; no portal write |
| `POST .../production/approve` | `{receiptId, confirmedWholeModel:true}`; review the exact plan and queue portal approval |
| `POST .../production/withdraw` | `{receiptId?, reason}`; withdraw the exact stopped queued approval without resetting counts |
| `POST .../production/dispatch` | `{confirmedReady:true}`; authorize and attempt one physical run |
| `POST .../production/reconcile` | `{runId, outcome, printedParts, notes}`; record the exact stopped run and synchronize evidence |

Run `node --test tests/resin-dispatch.test.js tests/layr-production-flow.test.js`.
The core fixtures verify permits, bindings, authorization and hardware uncertainty.
The flow suite exercises the local API/manager with injected hardware and runs
actual private portal handlers/SQLite when the reviewed source is available;
those cases explicitly skip without it, while the fake-transport cases still
run. The actual run flow requires the portal v2 quantity migration
`0006_production_quantities.sql` as well as the original production migration.
No case uploads to or starts a real printer.

## Remaining production work

Live portal migration/deployment/token setup and actual hardware qualification
remain. The engine does not interpret free-text sizing, perform resin STEP
tessellation, establish hollow/drain plans or cavity safety, infer arbitrary
supports/finish requirements, or pack multiple source instances. Post-processing,
QC decisions, replacement allowance and delivery remain explicit studio/operator
work; no automatic quality acceptance is inferred from printed-unit evidence.
