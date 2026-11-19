# Headless resin preparation

QuickPrint implements a callable **PrusaSlicer SLA -> SL1 -> UVtools GOO**
preparation pipeline in `src/slicing/resin-engine.js`. It evaluates explicit
orientation candidates, checks the resulting layers and target parameters, and
retains the selected slice with inspectable evidence. It does not start a printer.
Every result has `printReady: false` and `printerCompatible: false`.
The separate [qualified production flow](RESIN-PRODUCTION.md) can authorize an
individually confirmed run after current studio qualification and local opt-in;
a preparation result alone never supplies that authority.

This pipeline is separate from the installed SatelLite application. SatelLite's
native export and internal automation boundaries are documented in
[SatelLite deconstruction](SATELLITE-DECONSTRUCTION.md).

## Provider installation and verified versions

The completed local verification used **PrusaSlicer 2.9.7** and **UVtools 7.1.2**
on Windows x64. Configure `prusa-slicer-console.exe` and `UVtoolsCmd.exe`, keeping
each provider's adjacent libraries and resources intact. The engine fingerprints
the Prusa console/core DLL and UVtools console/command/core DLLs. Its QuickPrint
manifest covers `resin-engine.js`, `goo.js`, `resin-profiles.js`,
`resin-geometry.js`, the process runner in `slicing/index.js`, and
`psam/zip-inspection.js`. These selected hashes
are not a complete manifest of every runtime dependency in the provider
installations.

The code checks that Prusa's help identifies PrusaSlicer and advertises
`--export-sla`, and that UVtools reports a recognizable core version. It does not
pin all accepted versions to the verified pair; another accepted interface still
requires its own end-to-end verification.

Installed UVtools 4.4.3 has a known command exit-code behavior: commands can return
1 after running. Only that exact version receives an exit policy of `[0, 1]`;
other versions require 0. Required output, property receipts, file structure,
parameter matching, and issue reports remain mandatory. Acceptance of exit code
1 is not evidence that a command succeeded. The documented successful complete
pipeline used 7.1.2, not an assumption of 4.4.3 compatibility.

The implementation invokes providers through argument arrays without a shell.
Its provider contracts can be inspected in the upstream
[PrusaSlicer entry point](https://github.com/prusa3d/PrusaSlicer/blob/master/src/PrusaSlicer.cpp),
[UVtools command host](https://github.com/sn4k3/UVtools/blob/master/UVtools.Cmd/Program.cs),
[UVtools run command](https://github.com/sn4k3/UVtools/blob/master/UVtools.Cmd/Symbols/RunCommand.cs),
and [ScriptGlobals interface](https://github.com/sn4k3/UVtools/blob/master/UVtools.Core/Scripting/ScriptGlobals.cs).
The exact commands below were additionally exercised against the installed
providers; upstream branch contents can change independently of those binaries.

## Reproduce the small synthetic verification

From the repository root, use the included
[cube](../tests/fixtures/resin/verification-cube.stl),
[profile](../tests/fixtures/resin/verification-profile.json), and
[standalone preset](../tests/fixtures/resin/verification.ini).
They describe a **synthetic 512 x 256, 40 x 20 mm test machine**, not a qualified
production printer or resin.

```powershell
node scripts/verify-resin-engine.js --model tests/fixtures/resin/verification-cube.stl --profile tests/fixtures/resin/verification-profile.json --prusa ".cache/prusa/PrusaSlicer-2.9.7/prusa-slicer-console.exe" --uvtools ".cache/uvtools/UVtoolsCmd.exe" --output artifacts/resin-engine-verification --unit-scale 1
```

The `.cache` provider paths above are the locations used on the development
workstation and are not shipped with this repository. Replace them with the paths
to your complete provider installations. The verification script accepts relative
CLI paths and resolves them to absolute paths; the engine API and desktop
configuration require absolute local paths.

The script creates a unique preparation directory and
`verification-<uuid>.json`, then prints a compact report containing the selected
artifact, hashes, provider identity, orientation, geometry and issue count. Exit
codes are 0 for an issue-free capture awaiting qualification, 2 for a captured
slice with reported issues, and 1 for a failed preparation. `--timeout-ms` accepts
whole values from 1000 to 3600000, with a 900000-ms default per native operation.
Ctrl+C aborts the operation through the process runner. No printer connection is
needed for this command.

On the recorded run, the first `(0, 0, 0)` candidate had one reported island.
The `(30, 15, 0)` candidate produced 234 layers and zero reported issues across
the selected checks. The final synthetic GOO SHA-256 was
`87a69b586eb749e8cea65884aba35c35210760a244fe663a7b438f3b5cab1726`.
This is an observed artifact hash, not a deterministic-build promise: file
creation timestamps and provider changes can alter bytes on another run.
The local receipt is
`artifacts/resin-engine-verification/verification-3fb79962-3d33-4a71-8f02-0c7f1d1545bb.json`;
verification artifacts and provider binaries are ignored workspace evidence.

A separate local thin-model probe exercised the native target geometry:
15120 x 6230 pixels, 211.68 x 118.37 mm, 50-micrometre layers, X mirror false,
Y mirror true. It produced eight layers, zero reported issues, and GOO SHA-256
`e12d58fff165ba563ac3ada412e72289c51159b4aabcaedfeb0b150622b8070e`.
That probe demonstrates full-resolution file preparation and validation. It was
not physically printed or calibrated and is not the included small-machine
fixture.
The full-resolution local receipt is
`artifacts/resin-16k-verification/verification-695ab5a3-2135-4c8d-afc5-e83d91273b04.json`.

## Pipeline and selection behavior

1. Read and hash the original STL/OBJ, JSON profile and standalone INI. Copy the
   original and preset into a new work directory; never overwrite the original.
   Measure the source, apply its explicit unit conversion/uniform sizing and one
   global origin shift, then emit and reread a separate millimetre binary STL.
   Retain the canonical `sizingPlan` and hashed `inputGeometry` proof.
2. For each configured candidate, independently measure exact source-vertex
   bounds after Z -> X -> Y rotation and reject candidates exceeding the reviewed
   rectangular bed or maximum height. Invoke Prusa with the copied preset,
   normalized STL, `--scale 1`, rotations, `--export-sla`, and managed
   `prepared.sl1` output. Configuration compatibility substitutions are disabled.
3. Inspect the SL1 archive. Require bounded `prusaslicer.ini` and `config.ini`,
   contiguous `prepared00000.png` layer names, consistent layer counts, expected
   PNG header dimensions, and matching effective geometry, mirrors, orientation,
   layer/exposure settings, supports, pad and disabled hollowing. The PNG header
   checks alone do not certify complete PNG image data; subsequent conversion
   and GOO image validation provide additional independent checks.
4. Convert the SL1 with `UVtoolsCmd --quiet convert ... GooFile ...
   --no-overwrite`.
5. Apply allowed target properties through a QuickPrint-generated local C#
   `ScriptGlobals` script using `UVtoolsCmd --quiet run`. The host loads the
   complete slice. Require the expected profile-hash receipt, then independently
   compare the actual serialized target properties. This avoids treating the
   observed `set-properties` partial-load/save failure as successful editing.
   Submitted models and order fields cannot choose a script path or supply code.
6. Independently inspect the GOO header, layer records, finite numeric fields,
   RLE tokens, checksums, exact decoded pixel counts, delimiters and footer.
   Require the profile's geometry, machine label and target parameter values.
   Custom per-layer parameter overrides are currently rejected: this engine
   validates a global exposure/movement profile.
7. Run UVtools checks for islands, resin traps, suction cups, touching bounds,
   print height and empty layers. Require a complete `Issues: N` report with
   exactly N detail lines. Truncated or unrecognized reports fail preparation.
8. Verify that analysis did not change the GOO bytes. Save per-attempt evidence,
   retain the first candidate with zero reported issues, and stop trying further
   candidates. If every candidate reports issues, retain the candidate with the
   fewest reports and return `analysis_failed`. Ties retain the earlier candidate.
   A process, integrity or profile failure stops the operation; it is not hidden
   by trying more orientations.

If every source orientation is out of bounds, fail with
`RESIN_MODEL_OUT_OF_BOUNDS` before native slicing. These fit checks exclude
generated supports/pad, which still need layer/issue analysis and qualification.
The candidate search is finite and preset-driven. It does not infer customer
intent, search arbitrary orientations, repair every mesh defect, or establish
that one orientation is aesthetically or mechanically best.

## Profile JSON schema

Use the included verification JSON as the exact structural example. Schema
version 1 has these fields:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Numeric `1` |
| `printerId` | Nonempty target identity for standalone preparation; production requires the selected local SDCP printer UUID |
| `printerModel` | Nonempty target model label |
| `material` | Nonempty reviewed resin/material label |
| `presetPath` | Standalone INI path, absolute or relative to the JSON file |
| `expected` | Explicit numeric printer geometry and boolean image mirrors |
| `orientationCandidates` | One to four objects containing finite X/Y/Z angles |
| `uvtoolsProperties` | Explicit allowed target machine, exposure and motion values |

The metadata strings reject newline/NUL characters. `MachineName` must exactly
match `printerModel`, fit 32 UTF-8 bytes, and contain no newline, NUL or equals
character. The profile and preset are each limited to 1 MiB. The profile
fingerprint hashes the original JSON bytes, a NUL separator, and preset bytes;
formatting changes therefore intentionally produce a new fingerprint.

Required `expected` fields map to the standalone preset as follows:

| JSON field | INI field | Unit/type |
| --- | --- | --- |
| `resolutionX` / `resolutionY` | `display_pixels_x` / `display_pixels_y` | Positive whole pixel counts |
| `displayWidthMm` / `displayHeightMm` | `display_width` / `display_height` | Millimetres |
| `layerHeightMm` | `layer_height` | Millimetres |
| `mirrorX` / `mirrorY` | `display_mirror_x` / `display_mirror_y` | JSON booleans / INI `0` or `1` |

Each pixel dimension is at most 20000 and their product is at most 100 million.
The GOO reader applies its own numeric/layout bounds in addition to profile
validation. The standalone preset must provide positive `max_print_height`;
`machineZMm`, when supplied, must match it exactly. `bed_shape` must follow the
four zero-origin boundary corners for the selected display dimensions, with an
optional closing fifth point and either winding. Unsupported/shifted beds fail
profile validation, and the effective exported bed/height are checked again.
The wrapper does not silently derive physical display dimensions from a model
name, a filename, or a firmware advertisement.

Required `uvtoolsProperties` are:

```text
MachineName, LayerHeight, ExposureTime, BottomExposureTime, BottomLayerCount,
BottomLiftHeight, LiftHeight, BottomLiftSpeed, LiftSpeed, RetractSpeed,
LightPWM, BottomLightPWM
```

The allowed optional fields are:

```text
TransitionLayerCount, BottomRetractSpeed,
BottomLiftHeight2, LiftHeight2, BottomLiftSpeed2, LiftSpeed2,
BottomRetractHeight2, RetractHeight2, BottomRetractSpeed2, RetractSpeed2,
WaitTimeBeforeCure, BottomWaitTimeBeforeCure,
WaitTimeAfterCure, BottomWaitTimeAfterCure,
WaitTimeAfterLift, BottomWaitTimeAfterLift
```

Exposure and wait values use seconds, heights use millimetres, motion speeds use
millimetres/minute, and light PWM is a 0-255 setting. The output reader checks
the serialized numeric bounds; an accepted number is not a cure calibration.
`LayerHeight` must equal `expected.layerHeightMm`. Positive normal and bottom
exposures must match the standalone INI. `BottomLayerCount` must be a whole
number. Unknown property names are rejected. Optional properties left unspecified
retain the provider's conversion behavior; set every property that matters to
your qualified target profile explicitly.

The UVtools names use cure-relative timing labels. In this reader,
`WaitTimeBeforeCure` corresponds to waiting after retract,
`WaitTimeAfterCure` to waiting before lift, and `WaitTimeAfterLift` to waiting
after lift, with corresponding `Bottom...` fields. They are compared against the
actual GOO fields after script execution.

## Standalone INI and model restrictions

The parser accepts flat `key=value` lines and blank/comment lines. INI sections,
duplicate keys and nonempty `inherits` are rejected. Use explicit:

```ini
printer_technology = SLA
sla_archive_format = SL1
display_orientation = landscape
supports_enable = 1
pad_enable = 1
hollowing_enable = 0
```

Supports and pad may independently be `0` or `1`; they must be explicit and must
match the effective exported configuration. Supply the geometry/mirror fields
above and `layer_height`, `initial_layer_height`, `exposure_time`, and
`initial_exposure_time`. The included INI also supplies `bed_shape`,
`max_print_height`, support elevation, faded layers and preview sizes. They remain
provider settings; use a complete reviewed preset rather than assuming the small
fixture contains every useful production setting.

Credential-bearing preset keys such as API keys, passwords, tokens, access codes
or secrets must be empty. Slicing does not need printer/account credentials.
The wrapper does not accept an alternate command string from the preset or model.

Inputs are nonempty `.stl` or triangulated `.obj` files up to 100 MiB. OBJ polygons
and external/free-form geometry are rejected. STEP/STP can first pass the
separate [CAD preparation](RESIN-CAD.md), which audits native transfer and
tessellates every retained solid to a verified millimetre STL. Embedded CAD units
are converted once, without reapplying declared ticket units. The service binds
the original CAD, converted mesh, reports and composite provider fingerprint.
Models are treated as
solid: `hollowing_enable=0` is mandatory because there is no qualified drain-hole
plan or hollow-part inspection contract in this engine. This restriction does
not detect a cavity already modeled into an uploaded mesh.

Declared units convert deterministically: millimetres `1`, inches `25.4`, or
metres `1000`. An explicit numeric plan keeps the current size, applies a uniform
factor, or sets one source-axis dimension in millimetres while preserving
proportions. Free-text requirements remain unparsed. Source-axis sizing precedes
orientation/supports/pad; see [measurement and sizing](RESIN-SIZING.md) for limits,
normalization, proof fields and the reproducible 3 mm -> 6 mm provider check.
Candidate angles are degrees in `[-360, 360]`; up to four are configured.

### Source copies and production quantity

Each completed attempt and selected result records `modelCopiesPerRun: 1`;
the verification CLI reports the same field. This means one submitted source
instance. It does not count disconnected mesh components, physical parts,
supports, or accepted production units. The engine passes no `--duplicate` or
`--duplicate-grid` option and does not pack additional source instances.
A single-unit repeat plan counts one order unit per file run only after an
operator declares that the whole submitted model represents exactly one order
unit. Repeated runs and physically accepted quantities still need separate
production evidence; a slice never supplies QC counts.
The actual provider rerun recorded this field in
`artifacts/resin-single-instance-verification/verification-dd630f36-9c06-473c-a6aa-5afcd5281d16.json`:
234 layers, zero reported issues, GOO SHA-256
`c4e56cffb26b8f89d7cea14202fd053feb9e0769b6a73ba3b0fd2d65ed3df3d5`.

Prusa 2.9.7 advertises duplication flags, but an actual overflow probe shows why
they are not enabled here. The included 3 mm cube was sliced on the synthetic
40 x 20 mm bed, with supports/pad disabled and 60 layers:

| Requested `--duplicate` value | Reported material (mL) | Separate cube footprints in layer 30 |
| --- | --- | --- |
| 1 | 0.027 | 1 |
| 2 | 0.054 | 2 |
| 20 | 0.270 | 10 |

All three invocations exited 0. The 20-copy request silently exported only ten
cube equivalents. Tagged primary source shows
[duplication before rotation/scale](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/CLI/ProcessTransform.cpp)
and [arrangement followed by bed-0 selection before slicing](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/CLI/ProcessActions.cpp).
The inspected SL1 `config.ini`/`config.json` contain no instance-count or
placement-footprint contract. Raster component counting confirmed this simple
cube probe, but cannot establish part counts for arbitrary geometry/supports.
Local help, logs, SL1 files and raster-count evidence are retained under
`scratch/resin-plate-plan/` and excluded from version control. Multiple-copy
packing needs an independently checked placement/count contract before use.

## Desktop use and order requirements

Configure local provider paths, reviewed profile settings and operation timeout
in **Settings -> Resin model preparation**. Named resin slots share the provider
executables and timeout, while each slot points to its own profile JSON. For
example, the `resinEngine` settings object can contain:

```json
{
  "prusaExecutable": "C:\\Slicing\\PrusaSlicer\\prusa-slicer-console.exe",
  "uvtoolsExecutable": "C:\\Slicing\\UVtools\\UVtoolsCmd.exe",
  "timeoutMs": 900000,
  "dispatchEnabled": false,
  "slots": [
    {
      "id": "standard-grey",
      "name": "Reviewed standard grey",
      "profilePath": "C:\\Slicing\\profiles\\standard-grey.json"
    },
    {
      "id": "tough-black",
      "name": "Reviewed tough black",
      "profilePath": "C:\\Slicing\\profiles\\tough-black.json"
    }
  ]
}
```

Configure at most 32 slots. Slot IDs must be unique, use 1-80 letters, digits,
underscores or hyphens, and stay stable when renaming a slot. Names must be
nonempty, at most 100 characters, and contain no control characters. Profile
paths must be absolute local paths. A legacy single `profilePath` remains usable
when `slots` is empty; configured slots take precedence over that fallback.
The UI can add, rename and remove slots; each selected slot references its own
JSON/INI files. Save Settings before using that slot's **Customize profile**
button. The editor exposes material name, layer height, normal/bottom exposure,
layer counts, movement/wait values, PWM, support/pad toggles and one to four
orientation candidates. **Bound local printer** binds `printerId` to an existing
configured SDCP printer UUID. The model label, physical geometry and image
mirrors remain in the reviewed profile. Hollowing remains disabled.

The authenticated customization API is `GET /api/resin/profiles/:id` and
`PUT /api/resin/profiles/:id`, where `id` is a saved named slot. The GET response
contains `{slot, profile, profileSha256}`. PUT accepts the editable fields
`printerId`, `material`, `layerHeightMm`, `uvtoolsProperties`, `supportsEnabled`,
`padEnabled`, and `orientationCandidates`; omitted fields retain their current
values. It also accepts the optional `expectedProfileSha256` control, which the UI always submits
from its GET response. A mismatched or invalid digest rejects the save with HTTP
409 before managed files are written, so a stale editor must reload first.
The service synchronizes layer height and exposure changes into both JSON and
INI, validates the generated files, and saves a new pair under
`<dataDir>/profiles/resin/profile-<unique>/`. It updates only that slot's
`profilePath`; source files, other slots and existing slice receipts retain their
original identities. Source/slot changes detected during the operation reject
the save rather than overwriting concurrent work. Numerical bounds and consistent
motion settings are input validation, not resin calibration. An edited profile
has a new fingerprint and needs physical qualification for its intended use.

For an imported paid resin ticket, use **Slice resin model** only after resolving
all requirements and confirming the selected slot/profile. With multiple slots,
the slice request must explicitly select a configured `profileSlotId`; a sole
slot can be selected automatically. Missing or removed selections fail review
rather than falling back to another profile. The saved result records the slot
ID/name in `resinSlice.operatorReview` and the actual profile fingerprint in
`resinSlice.profileSha256`.

The authenticated API equivalent is `POST /api/jobs/:id/resin/slice` with:

```json
{
  "confirmedRequirements": true,
  "confirmedSizing": true,
  "profileSlotId": "standard-grey",
  "sizing": { "mode": "dimension", "axis": "z", "millimeters": 6 }
}
```

This request accepts the explicit sizing plan and review fields;
model/output/profile paths come from the imported job and local Settings.
The authenticated download route is
`GET /api/jobs/:id/resin/slice/download`.

Use **Measure model** to inspect source dimensions, choose the current size,
uniform factor or one source-axis target, and confirm the chosen plan. Original
mode also accepts the existing `confirmedOriginalSize` confirmation; resizing
requires `confirmedSizing`. The service independently verifies canonical plan,
normalized input hash, bounds and managed-file identity before capture and
qualified production. Ticket free text remains an operator-reviewed instruction.
Clarify unresolved requirements before confirming the numeric transformation.

The service keeps the job in `review`, stores the full result under `resinSlice`,
and leaves reported issues visible. Successful capture is
`sliced_pending_qualification`; a captured candidate with issues is
`analysis_failed`. Neither becomes a generic dispatch-ready artifact.
Authenticated GOO downloads recheck stored source/output hashes. Files with
reported issues remain available for inspection.
After a device-bound receipt is confirmed, use **Review production
qualification** for the separate studio binding, whole-model one-unit declaration,
portal approval and per-run authorization. **Enable qualified resin dispatch**
defaults to false. The engine's unqualified result flags remain unchanged even
when that separate run path is available; see the [production guide](RESIN-PRODUCTION.md).
Pending/approved plans hold replacement slicing. Use confirmed queued-preparation
withdrawal, or explicitly adopt a newer studio QC replacement target, before
revising that preparation. Both preserve earlier production evidence; neither
grants a new print authorization or QC credit.

Native resin slicing and the SatelLite preprocessing probe share one service
engine lock. Duplicate preparations for the same job are rejected. Active work
can be aborted; queued cancellation is persisted immediately and never starts
that queued engine callback. Cancelled queue entries retain lock ordering until
their predecessors finish. Shutdown aborts registered active/queued work, drains
the operation barrier, and preserves retryable job state.

## Evidence, resource bounds and trust

The engine API accepts absolute local paths for input, output, both executables
and profile JSON. Desktop job requests accept review confirmations rather than
arbitrary paths or executable arguments. Provider installations and profile files
are trusted operator configuration; this is not a sandbox for arbitrary native
executables or uploaded scripts.

Managed SL1/GOO files are limited to 512 MiB. SL1 ZIP inspection limits individual
entries to 128 MiB, total expanded archive entries to 1 GiB, entry count to
25010, compression ratio to 10000, and image layers to 25000. The independent GOO
reader bounds layers, encoded layer bytes, numeric fields and pixels per layer;
it validates RLE streams without allocating full image arrays. Native providers
have their own memory/disk behavior, so these file bounds do not impose a hard
process-memory limit. Full-resolution long jobs still need workstation testing.

Provider help/version probes use 15-second deadlines. Each subsequent native
operation uses the configured 1-second to 1-hour timeout. The process runner
captures bounded log output and terminates process trees on abort/timeout.
Overlong or truncated issue reports fail rather than being treated as clean.

The work directory retains original/preset copies and the independently measured,
hashed `prepared-input.stl`. Each completed attempt
retains its SL1/GOO, parameter script, receipt and `evidence.json` with target
inspection, sizing/input/orientation proof, issue report, hashes and bounded process logs. The top-level
verification JSON records the selected
attempt and attempted orientations. Evidence directories are retained for review;
the engine does not automatically delete failed attempts or manage long-term
disk retention.

## Physical qualification and the known geometry conflict

The observed Saturn 4 Ultra 16K firmware reports `15120x6230` but physical
`XYZsize=218.88x128.88x220` mm. The installed SatelLite target/native export uses
`211.68x118.37x220` mm. These values conflict. The eight-layer headless probe
matched the latter profile; it did not resolve which dimensions produce correct
physical output. See [SDCP integration](SDCP-INTEGRATION.md#observed-geometry-discrepancy).

GOO structure and selected automated issue checks do not prove image handedness,
dimensional accuracy, resin cure, peel/motion behavior, support strength, printer
firmware compatibility, or physical part acceptance. Resolve the geometry
conflict and validate a specific printer/firmware/resin/profile combination with
physical measurements before production. Zero reported issues is a captured
analysis result, not a production release or automatic portal completion.

The independent GOO reader follows ELEGOO's
[GOO format specification](https://github.com/elegooofficial/GOO/blob/main/Goo%20Format%20Spec%20V1.2.pdf),
with the V3.0 byte layout/checksum/footer cross-checked against public
[UVtools format source](https://github.com/sn4k3/UVtools/blob/master/UVtools.Core/FileFormats/GooFile.cs)
and real native/generated files. Those format contracts do not certify a
particular device's physical behavior.
