# Verified multi-copy resin plates

QuickPrint can prepare explicit copies of a reviewed source model on one resin
plate, then bind the verified count to PrintByLayr preparation and production
evidence. It uses **PrusaSlicer 2.9.7 -> SL1 -> UVtools GOO** for one native
reference, then builds the plate by exact integer-pixel translation of that
reference's grayscale layer images. Independent verification reconstructs the
whole artifact byte for byte and separately compares every final layer.
Preparation never starts a printer. Every result retains `printReady: false`
and `printerCompatible: false`; the separate
[qualified production flow](RESIN-PRODUCTION.md) requires current studio
authorization, local dispatch opt-in and physical readiness for each run.

## Request an upper bound, review the actual fit

After resolving requirements and reviewing [model sizing](RESIN-SIZING.md),
expand **Plate copies and spacing** in the resin job:

- **Maximum copies on this plate:** 1 through 500, no more than this target's
  remaining order units.
- **Gap between support footprints:** nonnegative millimetres.
- **Plate edge margin:** at least 1 mm.

For example, the authenticated `POST /api/jobs/:id/resin/slice` body can contain:

```json
{
  "confirmedRequirements": true,
  "confirmedSizing": true,
  "profileSlotId": "standard-grey",
  "sizing": { "mode": "original" },
  "plate": { "copies": 20, "gapMm": 1, "marginMm": 2 }
}
```

For STEP/STP, include the `expectedGeometrySha256` of the converted mesh the
operator reviewed. See [CAD preparation](RESIN-CAD.md). Paths and executable
arguments come from the saved job and Settings, not this request. Omitting
`plate` retains the single-instance path; the UI uses that path for one copy.

The request is an upper bound. The deterministic layout places as many complete
instances as fit the measured footprint, bed, height and resource limits, up to
the requested number. The result reports `modelCopiesPerRun` and
`platePreparation.layout.copiesPlaced`, with `copiesRequested`, `remainingCopies`,
`complete`, capacity limits and placements in the layout. A six-copy fit from a
20-copy request means six instances in this artifact. It does not mean the
remaining 14 have been sliced or printed. A zero-copy fit fails preparation;
no empty or silently truncated plate is accepted.

One copy means one entire source instance after its reviewed sizing and
orientation. Disconnected mesh components, separate solids, supports and pad
components do not establish order quantity. The operator must declare that the
whole submitted model represents one ordered unit before approving production.
The layout duplicates that whole model and preserves the relative positions of
its components; it does not pack their components separately.

## What establishes the count and footprint

1. Preserve the original file and independently verify the normalized
   millimetre STL and sizing plan. Apply the candidate rotation in **Z -> X -> Y**
   order to actual vertices and normalize the rotated model with one common
   translation. Float32 conversion must preserve nondegenerate triangles and
   winding. Exactly identical coordinates share vertex indices in an indexed
   3MF mesh, retaining triangle adjacency without moving or tolerantly merging
   vertices. This canonical mesh supplies the reference and layout provenance.
2. Export a native single-copy reference at a known pixel-aligned placement
   using the reviewed support/pad settings. Read the union of exposed pixels
   across **all** reference GOO layers, including generated supports and pad.
   Convert that footprint through the display geometry and mirror policy,
   reserve a conservative symmetric XY envelope plus one pixel, and reserve
   support/pad height separately from XY spacing.
3. Build a deterministic grid within the reviewed zero-origin rectangular bed.
   Reserve the requested gap between full footprints and margin at the edges.
   Copy anchors and relative XY translations use exact integer pixel steps,
   preserving the reference's antialiasing phase. Pixel quantization rounds the
   reservation conservatively. Height policy includes support elevation, pad,
   layer rounding and supported tower-hop settings; the final GOO height is
   checked independently.
4. Retain a shared-mesh **3MF** with the explicit layout instances/transforms as
   provenance. Native slicing runs only for the single-copy reference, with
   orientation preapplied and automatic arrangement disabled. A bounded writer
   translates its exposed grayscale runs into the complete plate GOO. It
   preserves all physical settings and the 66-byte definition of every layer,
   rebuilding encoded image lengths, checksums and delimiters. There is no
   second native packed export that could alter supports or antialiasing.
   Prusa's `--duplicate`/`--duplicate-grid` options are unused; an actual
   `--duplicate 20` probe had exited successfully while exporting only ten
   cubes after bed filtering.
5. Independently rebuild the complete derived GOO from the saved reference and
   placements and require **byte-for-byte equality**. Also validate the
   reference and final GOO structure with a separate reader and compare
   every layer. The final nonzero grayscale pixels must be exactly the declared
   translated union of the reference pixels, with no missing/extra pixels,
   overlap, clipping or gap/margin violation. Machine geometry, image/AA
   settings, physical parameters and each layer's exposure/motion/Z/control
   schedule must match. Pixel totals and grayscale-intensity totals must equal
   the reference multiplied by the actual instance count. This does not infer
   counts by counting raster connected components.
6. Run the unchanged native UVtools checks for islands, resin traps, suction
   cups, touching bounds, print height and empty layers on the **actual derived
   plate GOO**. No property script or native re-encoding runs after derivation;
   a hash guard requires analysis to leave its bytes unchanged. A copy proof can
   pass while print-issue analysis fails. Such a candidate stays visible as
   `analysis_failed` and cannot be promoted through the qualified flow.

The engine records source/oriented-mesh hashes, original/effective preset
descriptors, reference input/GOO, canonical layout/3MF, final GOO and raster proof
under `platePreparation`, bound by `preparationSha256`. The required method is
`reference-raster-replication-v1`; `replication` also binds the writer version,
layer-definition/image hashes, estimates and previews. The service independently
rebuilds and verifies this evidence at capture, download and qualified dispatch.
Evidence must remain inside the managed job directory with matching real files,
sizes and hashes; changing the saved descriptor alone cannot establish a count.
Source and CAD conversion/sizing evidence remain bound alongside it.

The writer rebuilds both 116-square and 290-square RGB565 big-endian previews
from the final exposed-layer union, preserving aspect ratio. Material volume,
weight and cost estimates scale by the actual copy count. The reference time
estimate stays unchanged because its physical layer schedule is unchanged;
this is not a measured duration guarantee. Preview orientation preserves the
file's mirror policy and does not establish physical handedness.

Earlier packed records without this method are rejected with
`RESIN_PLATE_METHOD_UNSUPPORTED`, even if their old image proof passed. Prepare
them again with the current engine, then obtain fresh receipt/approval as
needed. Resolve any pending/approved preparation hold through the production
workflow first; existing run evidence can still be reconciled and is not reset
automatically. The legacy single-instance path without a plate request is
unchanged. User original files, profile slots and presets remain preserved.

Packed preparation currently requires the verified PrusaSlicer 2.9.7 interface,
standard elevated-pad policy, unit geometry-correction factors, disabled
automatic Z correction and the global target-parameter profile. Effective
exported settings must match. One narrow preset normalization copies
`faded_layers` to `material_ow_faded_layers` when the latter is absent, preventing
Prusa's material default from silently replacing the requested faded-layer
count. The managed effective copy records this rule and both preset hashes;
explicit conflicting values are rejected. User profiles and presets are not
overwritten. See the [engine guide](HEADLESS-RESIN-ENGINE.md) for profile rules.

Source/normalized geometry and generated model inputs are bounded at 100 MiB,
with at most two million expanded copy triangles, one million unique shared-mesh
vertices and 500 instances. GOO files
are bounded at 512 MiB and 25,000 layers. Raster comparison additionally bounds
segments, operations and elapsed time; exceeding a limit fails verification.
These are verification bounds, not a promise about native provider memory use.
The grid is deterministic, not an arbitrary nesting/optimal-packing solver.

## Orientation failures and quality holds

The earlier experimental method sliced a native reference and native multi-copy
layout separately. Tilted and curved examples changed raster/support output
between those exports and were rejected. The current method makes exact copies
of the one native reference instead. It never accepts grayscale tolerance,
approximate image similarity or a partially matching native plate.

Out-of-bounds, no-capacity or clipped-reference candidates can be rejected and
recorded while the engine tries the next configured orientation. Any final
copy-proof mismatch such as `GOO_PLATE_IMAGE_MISMATCH` is a deterministic
derivation/integrity failure and stops preparation. It cannot receive the
requested count or be hidden by trying another orientation. Profile and
provider failures also stop preparation.

The first copy-equivalent candidate with zero issue reports is selected. If
every retained candidate has issues, the one with the fewest reports is retained
for inspection, with no printing authority. The engine does not remove supports,
change orientation policy or weaken issue checks automatically to get a pass.
Up to **32 customized profile slots** remain available; saved edits create new
managed JSON/INI copies, preserve originals and need fresh capture/qualification.

## Counts through the order workflow

The confirmed `record_slice` receipt carries `partsPerRun` equal to the verified
actual count N, binding the artifact, source, profile, engine and device. Review
and approve that exact plate after studio qualification and the whole-model
one-unit declaration. Each physical start requires a fresh readiness check;
the dispatch request binds `{confirmedReady:true, receiptId, plannedParts:N}`.
A changed receipt or count after the dialog was opened is rejected. The manager
obtains current portal authority before upload and again before start; a request
body cannot mint a trusted production permit.

Each acknowledged run retains its own ID, filename, SDCP task identity and
`plannedParts:N`. Positive reconciliation requires that run's identified start
and matching explicit completed terminal telemetry. The operator records an
integer from 0 through N physically printed order units. Failed, cancelled and
verified-not-started runs record zero. Printed units are **not QC acceptance**;
washing, curing, support removal and inspection remain separate.

For a 20-unit target using a six-instance artifact:

| Confirmed run | Printed this run | Remaining | Next preparation |
| --- | --- | --- | --- |
| 1 | 6 | 14 | Reuse approved six-instance plate; confirm readiness again |
| 2 | 6 | 8 | Reuse approved six-instance plate; confirm readiness again |
| 3 | 6 | 2 | Portal returns to `preparing`; capture two-instance plate |
| 4 | 2 | 0 | Portal advances to `post_processing` |

The final two require a **fresh capture, device-bound receipt and approval**.
They cannot reuse a six-instance artifact with `plannedParts:2`. The old local
hold releases only after a fresh portal read proves the exact completed run,
same target and matching counts with a smaller positive remainder. A pending
writeback, stale version, uncertain run or newer approval keeps its hold. Exact
replay of an old release cannot clear a later plan. No remaining run starts
automatically. See [production steps and recovery](RESIN-PRODUCTION.md).

## Native file evidence and reproduction

Real local PrusaSlicer 2.9.7 and UVtools 7.1.2 produced these files with the
current `reference-raster-replication-v1` method:

| Explicit fixture policy | Actual copies | Layers | Copy proof | Six-check analysis |
| --- | --- | --- | --- | --- |
| Original supports/pad enabled, selected `(30,15,0)` | 3 of 3 | 234 | Exact 3x grayscale union and complete-byte rebuild | Zero reported issues |
| Copied profile with supports/pad disabled, flat `(0,0,0)` | 20 of 20 | 60 | Exact 20x grayscale union | Zero reported issues |
| Owned STEP cylinder through actual CAD/service path, supports/pad disabled | 20 of 20 | 60 | Exact 20x grayscale union; verified before/after reload | Zero reported issues |
| Native 15120 x 6230 thin reference, 211.68 x 118.37 mm display | 20 of 20 | 8 | Exact 20x grayscale union; independent PNG comparison of all layers | Zero reported issues |

Observed final GOO SHA-256 values:

- Supported three-copy cube: `a091ab5e2e2ab4e98179d2c08b24ed47e8190a0bf21ca2cf1bcd464b13da4a39`.
- Supports/pad-off 20-copy cube: `2e5dba75f9371db1346cb637a1249bf40067c09e6889124373466eb7de8ec8d7`.
- CAD/service 20-copy cylinder: `ab8ed3a0ab08fba5517e388fa77905ba288838d75f9b83d2736a54d2af4b18c0`.
- 16K thin 20-copy plate: `b20f77940e451abb013a42f189eaecefccc8576825af918a0ac899e1e02f2f22`.

Local reports are `artifacts/resin-packed-engine-verification/native-summary.json`
plus `supports-on-3-result.json`, `supports-off-20-result.json` and
`cad-packed/verification.json` in that directory. These ignored workspace
artifacts are observations, not deterministic-build promises. The original
source and public fixture profile/preset were unchanged. No printer upload,
start or physical qualification was performed. Disabling support/pad here is
an explicit synthetic-test policy, not a production repair recommendation.

The STEP case used the owned
[`verification-cylinder.step`](../tests/fixtures/resin/verification-cylinder.step).
It passed actual CAD transfer auditing, tessellation, source-bound sizing and
20-copy capture, then core `getResinSliceDownload` verification before and after
closing/reloading the service. The original STEP bytes remained unchanged;
ticket units were `in` while converted geometry stayed `mm` with unit scale 1.
Dispatch remained disabled, run history empty and `printReady` false. This
tested the core download method, not a separate HTTP download transaction.

The 16K case preserved X/Y mirrors `false,true`. Native UVtools PNG exports
were independently streamed and compared across all eight 94-million-pixel
layers: zero differing rows, with foreground pixel and grayscale-intensity
totals exactly 20 times the reference. Both native-exported previews showed
20 components and preserved the physical display aspect ratio of about 1.7883,
rather than the raw pixel ratio of about 2.4270. Its report is
`artifacts/resin-16k-raster-verification/summary.json`. This verifies file
geometry and image replication, not physical handedness or resolution of the
printer's firmware/profile dimension conflict.

Earlier experiments sliced the entire native 3MF layout a second time. One
supported three-copy request fit only two copies and stayed held on islands;
tilted/curved native packed exports also failed exact raster equivalence. Those
are historical results of the replaced method, not a limit imposed on current
reference-image replication. Their packed receipts cannot be reused by the
current verifier.

To reproduce the 20-copy file from a checkout, keep complete local provider
installations and run this PowerShell example from the repository root. Replace
the two `.cache` provider paths as needed. It creates uniquely named ignored
copies of the owned 3 mm cube's profile and preset; it does not change them.

```powershell
@'
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareResin } = require('./src/slicing/resin-engine');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
  const fixture = path.resolve('tests/fixtures/resin');
  const outputDir = path.resolve('artifacts/resin-packed-reproduction');
  await fs.mkdir(outputDir, { recursive: true });
  const copied = await fs.mkdtemp(path.join(outputDir, 'supports-off-'));
  const ini = (await fs.readFile(path.join(fixture, 'verification.ini'), 'utf8'))
    .replace(/^supports_enable[ \t]*=[ \t]*1[ \t]*$/m, 'supports_enable = 0')
    .replace(/^pad_enable[ \t]*=[ \t]*1[ \t]*$/m, 'pad_enable = 0');
  const presetPath = path.join(copied, 'preset.ini');
  const profile = JSON.parse(await fs.readFile(path.join(fixture, 'verification-profile.json'), 'utf8'));
  profile.presetPath = presetPath;
  const profilePath = path.join(copied, 'profile.json');
  await fs.writeFile(presetPath, ini, { flag: 'wx' });
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), { flag: 'wx' });
  const inputPath = path.join(fixture, 'verification-cube.stl');
  const originalHash = sha(await fs.readFile(inputPath));
  const result = await prepareResin({
    inputPath, profilePath, outputDir,
    prusaExecutable: path.resolve('.cache/prusa/PrusaSlicer-2.9.7/prusa-slicer-console.exe'),
    uvtoolsExecutable: path.resolve('.cache/uvtools/UVtoolsCmd.exe'),
    plate: { copies: 20, gapMm: 1, marginMm: 1 }
  });
  const reportPath = path.join(copied, 'result.json');
  await fs.writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (sha(await fs.readFile(inputPath)) !== originalHash) throw new Error('Source changed');
  console.log(JSON.stringify({ reportPath, method: result.platePreparation.method,
    copies: result.modelCopiesPerRun,
    layers: result.inspection.layerCount, issues: result.analysis.count,
    imageEquivalent: result.platePreparation.rasterProof.imageEquivalent,
    sha256: result.sha256, printReady: result.printReady }, null, 2));
  if (result.modelCopiesPerRun !== 20 || !result.analysis.passed) process.exitCode = 2;
})().catch(error => { console.error(error.code || 'VERIFICATION_FAILED', error.message); process.exitCode = 1; });
'@ | node
```

Native-free regressions use real layout/3MF/GOO verification with injected
renderers and printer fixtures:

```sh
node --test tests/resin-plate.test.js tests/goo-plate.test.js tests/goo-replication.test.js tests/resin-plate-engine.test.js tests/resin-plate-service.test.js tests/layr-plate-production-flow.test.js
```

Exact copy proof and zero automated issue reports do not establish resin cure,
support strength, peel forces, image handedness, dimensional accuracy or physical
acceptance. The observed Saturn 4 Ultra 16K's
[firmware/profile geometry conflict](SDCP-INTEGRATION.md#observed-geometry-discrepancy)
is still unresolved. Live portal deployment and qualification of the exact
printer/firmware/resin/profile combination remain required.
