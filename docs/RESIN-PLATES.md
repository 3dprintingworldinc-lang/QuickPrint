# Verified multi-copy resin plates

QuickPrint can prepare explicit copies of a reviewed source model on one resin
plate, then bind the verified count to PrintByLayr preparation and production
evidence. It uses **PrusaSlicer 2.9.7 -> SL1 -> UVtools GOO**, with a native
single-copy reference and independent comparison of every final layer.
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
   winding. The same canonical mesh supplies the reference and every instance.
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
4. Write one shared-mesh **3MF** with explicit build instances and transforms.
   Exactly identical source coordinates share vertex indices, retaining triangle
   adjacency, order and winding without moving or tolerantly merging vertices.
   Preapply orientation and disable native automatic arrangement. Do not use
   Prusa's `--duplicate` or `--duplicate-grid` switches. A real `--duplicate 20`
   probe had exited successfully while exporting only ten cubes after bed
   filtering; native exit status and material estimates cannot prove copies.
5. Independently validate the reference and final GOO structure and compare
   every layer. The final nonzero grayscale pixels must be exactly the declared
   translated union of the reference pixels, with no missing/extra pixels,
   overlap, clipping or gap/margin violation. Machine geometry, image/AA
   settings, physical parameters and each layer's exposure/motion/Z/control
   schedule must match. Pixel totals and grayscale-intensity totals must equal
   the reference multiplied by the actual instance count. This does not infer
   counts by counting raster connected components.
6. Run the unchanged UVtools checks for islands, resin traps, suction cups,
   touching bounds, print height and empty layers. A copy proof can pass while
   print-issue analysis fails. Such a candidate stays visible as
   `analysis_failed` and cannot be promoted through the qualified flow.

The engine records source/oriented-mesh hashes, original/effective preset
descriptors, reference input/GOO, canonical layout, final 3MF/GOO and raster proof
under `platePreparation`, bound by `preparationSha256`. The service independently
rebuilds and verifies this evidence at capture, download and qualified dispatch.
Evidence must remain inside the managed job directory with matching real files,
sizes and hashes; changing the saved descriptor alone cannot establish a count.
Source and CAD conversion/sizing evidence remain bound alongside it.

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

Native slicing of translated instances is not always translation-equivalent,
even when input transforms are exact. Some tilted orientations change native
support or raster output between reference and packed export. A mismatch is
rejected as `GOO_PLATE_IMAGE_MISMATCH`; it never receives the requested count.
The engine can try another configured orientation and records rejected ones.
If no equivalent candidate survives, it fails with
`RESIN_PLATE_NO_VERIFIED_CANDIDATE`. An earlier valid candidate with reported
issues can remain the selected held artifact when a later candidate is rejected.
Integrity, profile and provider failures still stop preparation.

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

Real local PrusaSlicer 2.9.7 and UVtools 7.1.2 produced these synthetic files:

| Explicit fixture policy | Actual copies | Layers | Copy proof | Six-check analysis |
| --- | --- | --- | --- | --- |
| Original supports/pad enabled, flat `(0,0,0)` | 2 of 3 requested | 200 | Exact 2x grayscale union | Two islands; held |
| Copied profile with supports/pad disabled, flat `(0,0,0)` | 20 of 20 | 60 | Exact 20x grayscale union | Zero reported issues |
| Supported tilted `(30,15,0)` candidate | Rejected | — | Raster mismatch | Cannot qualify as this plate |

The 20-copy GOO SHA-256 was
`4247d6776bfb41b6258f20a994d667fa49ff45aa7fb610ede6555025f494b86a`.
Local reports are `artifacts/resin-packed-engine-verification/native-summary.json`
and `supports-off-20-result.json` in that directory. These ignored workspace
artifacts are observations, not deterministic-build promises. The original
source and public fixture profile/preset were unchanged. No printer upload,
start or physical qualification was performed. Disabling support/pad here is
an explicit synthetic-test policy, not a production repair recommendation.
An additional curved CAD reference passed all six checks, but its native
20-instance export failed exact raster equivalence and was held. This path
does not promise that every valid reference can be packed by the native provider.

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
  console.log(JSON.stringify({ reportPath, copies: result.modelCopiesPerRun,
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
node --test tests/resin-plate.test.js tests/goo-plate.test.js tests/resin-plate-engine.test.js tests/resin-plate-service.test.js tests/layr-plate-production-flow.test.js
```

Exact copy proof and zero automated issue reports do not establish resin cure,
support strength, peel forces, image handedness, dimensional accuracy or physical
acceptance. The observed Saturn 4 Ultra 16K's
[firmware/profile geometry conflict](SDCP-INTEGRATION.md#observed-geometry-discrepancy)
is still unresolved. Live portal deployment and qualification of the exact
printer/firmware/resin/profile combination remain required.
