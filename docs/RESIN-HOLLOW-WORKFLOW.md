# Controlled hollow preparation and order integration

QuickPrint can prepare a reviewed hollow model through its local HTTP API and
desktop interface. It runs the configured PrusaSlicer 2.9.7 and UVtools 7.1.2
under the Windows native job guard, validates the body and the final supported
rasters, and records the resulting artifact through the existing PrintByLayr
production connector. Digital conformance remains separate from physical
qualification. Captures retain `printReady: false` and `printerCompatible: false`.

The solid baseline profile must still have `hollowing_enable = 0`. The separate
controlled engine derives three exact native inputs from the reviewed recipe:
the final hollow/support model, the hollow body reference, and the solid body
reference. A hollow preset alone does not select this workflow.

## Operator workflow

1. Import the paid production ticket, resolve its requirements, and select one
   of the configured named resin/profile slots. Measure and confirm the numeric
   sizing plan. STEP/STP and explicitly repaired meshes retain their existing
   source and derivative verification requirements.
2. Under **Optional hollow preparation**, download the sized source STL. Author
   drain cylinders and any support contacts in that exact zero-origin,
   millimetre source frame, before orientation. Include its SHA-256 and the
   selected managed profile SHA-256 in the recipe JSON.
3. Import the canonical review JSON (maximum 256 KiB), enable the hollow option,
   and choose **Validate recipe**. Inspect the displayed dimensions, orientation,
   drains, support regions and resolution policy. Confirm the separate hollow
   review before choosing **Slice resin model**. Changing size or slot requires
   validation and confirmation again; imported hashes are never silently updated.
4. The controlled engine must complete its native captures, all six final-file
   UVtools checks, body conformance, final support/drain conformance and an
   independent replay. A resource hold or inconclusive result stops capture;
   the engine does not increase tolerances or substitute a coarser policy.
5. Optional plate copies use the verified hollow reference and exact raster
   replication. The final derived plate receives all six checks again. Its
   verified `modelCopiesPerRun` is the order-unit count, subject to the existing
   explicit whole-source-instance declaration.
6. Send the validated slice receipt through the production outbox. This records
   preparation evidence. Qualification, approval, readiness, individual starts,
   identified results, post-processing and QC follow the separate
   [production workflow](RESIN-PRODUCTION.md).

Automatic supports require prior permission regions. Authored support contacts
must address exact faces of the sized source. The final audit checks added
material against those permissions and keeps the hollow void and intended drain
channels protected. A permission region does not establish support strength or
physical printability.

## Local HTTP interface

These routes use the same local-server access controls as existing preparation
routes. Replace `JOB_ID` with the imported local job ID. Profile paths, provider
paths, executable arguments, scripts and build placement are not accepted in a
recipe or slice request; they come from local Settings or the controlled engine.

| Request | Body | Result |
| --- | --- | --- |
| `POST /api/jobs/JOB_ID/resin/geometry/plan` | `{ "sizing": { "mode": "original" } }` | Sized geometry hash, sizing hash, dimensions and mesh audit |
| `POST /api/jobs/JOB_ID/resin/geometry/source` | Same sizing choice | Exact sized STL attachment; `X-QuickPrint-Geometry-Sha256` and `X-QuickPrint-Sizing-Sha256` headers |
| `POST /api/jobs/JOB_ID/resin/hollow/review` | `{ "hollow": REVIEW, "sizing": SIZING, "profileSlotId": "SLOT_ID" }` | Canonical review, current geometry/profile identity, `digitalValidationPending: true`, `printReady: false` |
| `POST /api/jobs/JOB_ID/resin/slice` | Existing requirements/sizing confirmations plus `hollow: REVIEW` and `confirmedHollowPreparation: true` | Captured, verified, unqualified artifact or an explicit preparation error |

`profileSlotId` is optional only under the existing single/default profile
selection rules. Geometry planning and recipe review do not launch native
programs, approve production, or modify the imported source.

A canonical review has the following shape. Digest placeholders must be replaced
with the actual current values. The numerical example describes a digital test
fixture; it is not a resin or printer calibration profile.

```json
{
  "geometrySha256": "CURRENT_SIZED_STL_SHA256",
  "profileSha256": "CURRENT_MANAGED_PROFILE_SHA256",
  "recipe": {
    "orientation": { "x": 0, "y": 0, "z": 0 },
    "wallThicknessMm": 2,
    "quality": 0.75,
    "closingDistanceMm": 0,
    "drains": [
      { "id": "bottom-a", "startMm": { "x": 3, "y": 5, "z": 0 }, "direction": { "x": 0, "y": 0, "z": 1 }, "radiusMm": 1.25, "lengthMm": 3 },
      { "id": "bottom-b", "startMm": { "x": 7, "y": 5, "z": 0 }, "direction": { "x": 0, "y": 0, "z": 1 }, "radiusMm": 1.25, "lengthMm": 3 }
    ]
  },
  "supportRequest": { "mode": "none", "clearanceMm": 0, "points": [], "regions": [] },
  "resolutionRequest": { "maximumUncertaintyMm": 0.25 },
  "boundaryPolicy": "voxel-enclosure"
}
```

The support mode must match the selected profile. See the exact
[request and coordinate contract](RESIN-HOLLOWING.md) and
[body/final audit predicates](RESIN-HOLLOW-AUDIT.md). Automatic supports use
`mode: "automatic"` with prior regions. Authored contacts use `mode: "points"`.
There are at most 512 combined contacts/regions and 64 intended drains.

## Prior policies and evidence

The resolution planner selects bounded integer reductions before native model
exports. `minimumPitchMm` constrains automatic selection. Alternatively,
`reduction: { "x": 1, "y": 1, "z": 1 }` requests fixed reductions; the engine
never substitutes another value. Fixed mode permits a worst-case support box
larger than the selected allocation budget, but the actual full raster crop must
fit before grid allocation. Maximum uncertainty remains explicit and at most one
third of the requested wall thickness. Runtime interval proofs may still be
inconclusive even when a policy passes planning.

The controlled workflow defaults to 12 million cells, permits at most 20 million
when explicitly requested, and retains a 768 MiB grid working-byte cap and two
billion operation cap. Its prior resource policy declares a grid deadline up to
180 seconds under the configured overall timeout. Standalone grid callers retain
the 60-second default, with an explicit hard maximum of 300 seconds. Increasing
an explicit time budget changes no geometry, uncertainty, drain or memory
predicate. Each native process and its complete child tree have a 1 GiB committed
memory limit, plus bounded time, output and file sizes. These bounds are checked
before or during execution and are recorded in the preparation evidence.

For controlled hollow reference preparation, the Settings timeout covers all
three native roles and their audits together: 900 seconds by default, configurable
up to 3,600 seconds before capture. High-resolution captures can exceed the
default; the observed 16K verification request declared 3,600 seconds in advance.
An optional subsequent plate-replication operation has its own bounded deadline.

The engine freezes the prior policy, native inputs, command plans, generated
scripts and expected effective presets before exporting geometry. It captures
provider and selected implementation hashes, actual arguments, input/output
identities and native resource receipts. Provider hashing identifies configured
bytes; it is not publisher authentication or an inventory of every OS library.
All intermediate references, the final artifact and the complete audit record
remain in the managed job directory for verification.

Capture/download/receipt/dispatch checks bind the original or verified derivative
source, normalized sized mesh, current profile, recipe, tools and current files.
An in-memory private verification cache avoids rerunning unchanged grid proofs
inside the short production authorization window. It stores bindings and opaque
capabilities, not geometry buffers. Changed files or tools invalidate it; restart
requires full verification again. Persisted JSON flags cannot seed that cache or
prove controlled execution. Exact attempted portal operations retain the existing
durable replay semantics after a lost response.

## Reproduce software verification

The standalone tests use synthetic fixtures and do not require native providers:

```powershell
node --test tests/resin-hollow-review.test.js tests/resin-hollow-inputs.test.js tests/resin-hollow-preset.test.js tests/resin-hollow-resolution.test.js tests/resin-hollow-engine.test.js tests/resin-hollow-plate.test.js tests/resin-hollow-service.test.js
node node_modules/@playwright/test/cli.js test tests/e2e/resin-hollow.spec.js
```

Optional actual-provider tests require Windows and the configured native versions
at the test paths. The actual private portal test additionally needs the reviewed
private checkout described in the [portal setup guide](PRINTBYLAYR-PRODUCTION-INTEGRATION.md).
They create local synthetic models, use local fixture storage, and send no
printer upload or start commands:

```powershell
$env:QUICKPRINT_HOLLOW_SERVICE_NATIVE = '1'
node --test tests/resin-hollow-service.test.js
$env:QUICKPRINT_HOLLOW_PORTAL_NATIVE = '1'
node --test tests/layr-hollow-production-flow.test.js
```

## Observed native validation

The current controlled engine prepared an owned 10 mm cube at `(30,15,0)` with
two intended 1.25 mm drain radii, four authored source contacts and a pad. The
final model elevation was 7.037 mm. Source-specific support permissions were
declared as 8 mm before native execution. Its 512 x 512, 40 x 40 mm digital
target used 0.1 mm layers, quality 0.75, a 2 mm requested wall, fixed `(1,1,1)`
reductions and maximum uncertainty 0.16 mm.

All 15 real controlled calls completed: two interface-version probes, one
profile-only normalization and the 12 frozen export/conversion/parameter/issue
stages. The 228-layer final file passed all six issue checks. Both the full final
audit and exact re-verification from current inputs conformed with semantic proof SHA-256
`f9f22abb843ccfc56d606b7812c6ea8eb25071ecfdbe51e4b1f45f2f5ee32852`.
The unchanged source and complete current bindings passed; a caller JSON record
alone cannot reproduce the private in-process execution brand.

The 600,304-byte GOO SHA-256 is
`049920e54e94e7a71d988bbda0ee3752398272804107364703ec63971cb6138a`.
The preparation record SHA-256 is
`e2d4807917501730422ae20f766b97f15bbd84537b091c9480b7c219a0c31941`.
The local owned evidence is retained under
`artifacts/hollow-controlled-supported-Rdvgts/`; generated models and native
providers are excluded from the public repository and app bundle.

The final grid had 13,620,600 cells, charged 1,792,869,369 operations and declared
517,587,848 bytes of conservative visible input/working arrays. It used the
prior 180-second grid budget: the full audit took 64.6 seconds and replay took
83.3 seconds. Peak native process/tree commit was 136,364,032 / 137,646,080 bytes
under the unchanged 1 GiB limits. These are declared array accounting and native
commit observations, not overall application RSS measurements.

Earlier attempts remain held: an automatic coarse grid could not prove the
individual drains, and a finer attempt reached its prior 60-second grid budget.
The successful attempt declared its fixed resolution and 180-second time budget
before native execution; no failed record was retroactively accepted.

No hollowing software result resolves the outstanding physical geometry, resin,
exposure, drainage, washing, curing or dimensional qualification work. No printer
upload, start or control command was sent during these checks.

### Observed local order-to-receipt flow

The opt-in [hollow portal flow test](../tests/layr-hollow-production-flow.test.js)
passed with the real Windows native providers and actual reviewed private portal
handlers backed by local SQLite and fixture model storage. It imported a paid,
frozen two-unit STL ticket, reviewed the original 3 mm cube at an explicit 10 mm
size, and captured a hollow unit with two bottom drains. The selected profile
used 512 x 512 pixels, a 40 x 40 mm bed, 0.1 mm layers, no supports or pad, quality
0.75, a requested 2 mm wall, and a prior maximum raster uncertainty of 0.25 mm.
The default prior cell budget remained 12 million.

The 100-layer one-unit file passed all six native issue checks and the full
source-bound final audit/replay. After its preparation receipt committed, a
deliberately lost response and local restart replayed the exact saved operation
UUID, version and body; the outbox confirmed the original receipt. A separately
confirmed two-unit plate then passed complete pixel replication proof and its
own real guarded six-check native analysis. The original model, frozen ticket
and earlier one-unit receipt remained unchanged.

The one-unit artifact was 306,698 bytes with SHA-256
`087bd3b3dd925d7aef6a3610f2c2128a215b65ae4c47d43fed2ef880e4d83bde`.
The two-unit artifact was 400,020 bytes with SHA-256
`3a57b6c954b790905c316c19c18661779b0101a69daad94e38d3df2ccd3e4087`;
its independent raster-proof SHA-256 was
`a510882bebf18e42781071df6242e9f22cea32bd84c4498750fa0168d2bf4466`.
The complete flow passed in 211.5 seconds. Both portal receipts bound the
original source, current profile, pipeline tool fingerprint, artifact and actual
parts per run (one, then two). Both remained unqualified with `printReady:false`.
The portal stayed in preparation with zero printed units, zero QC credit and no
printer upload, start or control calls. These local fixture results do not deploy
the portal or qualify physical production.
