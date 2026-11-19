# Resin model measurement and uniform sizing

QuickPrint can measure and uniformly resize bounded STL and triangulated OBJ
models before resin slicing. The uploaded source bytes remain unchanged. Free-text
order dimensions, scale ratios, support requests and finish instructions remain
operator-reviewed requirements; they are not parsed into transformations.
STEP/STP can first use the [verified CAD conversion](RESIN-CAD.md). Choose
**Prepare STEP geometry** after reviewing embedded units, then measure and size
the resulting millimetre mesh. The ticket's declared units are retained and are
not applied a second time to CAD coordinates.

## Choose an explicit sizing method

In the resin job, select **Measure model**, then choose a **Sizing method**:

| Method | Result |
| --- | --- |
| Current model size | Convert declared mm/in/m units to millimetres; keep source dimensions |
| Uniform scale factor | Multiply all three converted dimensions by one numeric factor; `2` doubles size |
| Set one source-axis dimension | Set source X, Y or Z to the entered millimetres and apply that same factor to every axis |

For STEP, “current size” is the CAD kernel's intrinsic-unit conversion to mm;
for STL/OBJ it is the declared mm/in/m conversion shown above.

Axes and displayed dimensions refer to the source before print orientation,
supports and pad. Proportions are preserved. Review the resulting X/Y/Z preview
against the order, confirm the selected sizing and requirements, then slice.
Changing sizing fields clears the previous confirmation. A 3 mm cube with target
source Z of 6 mm becomes a 6 x 6 x 6 mm model; it does not become a model with
only its Z stretched.

Uniform factors must be finite numbers from `0.0001` through `10000`. Every final
source dimension must be positive and no larger than 10000 mm, and the selected
orientation must also fit the reviewed printer. These software bounds are not
recommended physical resin settings.

## What is measured and preserved

The parser accepts exact-length binary STL, complete ASCII STL facets and
triangle-only OBJ. OBJ bounds include face-referenced vertices, so unused vertex
outliers do not enlarge the model. Positive/negative vertex indices and valid
texture/normal references are checked. Polygon tessellation, external material or
geometry files, free-form geometry and command directives are rejected.

Coordinates and triangles must be finite and nondegenerate, with positive source
X/Y/Z extents. Source and normalized files are each bounded to 100 MiB. Hard caps
are two million triangles, one million OBJ vertices, 65536 characters per text
line and coordinate magnitude 1e9 in source units. These checks do not establish
manifoldness, closedness, cavity safety or the number of production parts.

`sizingPlan` records the original hash/units/bounds, pre-orientation dimensions,
explicit request, uniform factor, final dimensions and `sizingSha256`. The
normalizer emits a separate binary `prepared-input.stl` in millimetres. It applies
one global transformation:

```text
prepared coordinate = (source coordinate - originSourceUnits) * scale
scale = declared unit conversion * uniform sizing factor
```

The origin is the whole model's minimum coordinate. One shared translation
preserves relative positions between disconnected components. Normals are
recomputed with winding preserved. Float32 collapse or invalid output is rejected;
the emitted file is reread to verify triangle count and bounds.

`inputGeometry` records the normalized file's hash, byte count and bounds. The
service independently derives the expected plan/file, checks the actual managed
file without symbolic links, and rechecks geometry evidence before qualified
production. Original bytes and ticket text are retained. For converted STEP,
the sizing plan identifies the verified mesh hash; the slice receipt identifies
the original CAD hash and separately retains the mesh/transfer reports and
composite CAD-plus-slicer tool fingerprint. Source axes remain the imported CAD
axes, before print orientation, supports and pad.

## Printer fit and provider input

Prusa receives the normalized millimetre STL with `--scale 1`. For each configured
candidate, QuickPrint measures its actual vertices after Z, then X, then Y
rotation. It compares those extents with display width/height and the explicit
maximum print height before native slicing. Candidates that cannot fit are
skipped; if none fits, preparation fails with `RESIN_MODEL_OUT_OF_BOUNDS`.

The SLA preset must describe a zero-origin rectangular bed matching the display:
four boundary corners, with an optional fifth point repeating the first. Either
winding is accepted. `max_print_height` must be explicit and positive, and match
`expected.machineZMm` when supplied. The effective exported preset is checked
again. Source-fit checks exclude generated supports/pad; layer validation and
print-issue analysis still run, and physical qualification remains necessary.

## API and reproducible file-only check

The authenticated `GET /api/jobs/:id/resin/geometry` returns source measurements
without changing the job. A slice request can use:

```json
{
  "confirmedRequirements": true,
  "confirmedSizing": true,
  "profileSlotId": "standard-grey",
  "sizing": { "mode": "dimension", "axis": "z", "millimeters": 6 }
}
```

The other plans are `{ "mode": "original" }` and
`{ "mode": "scale", "factor": 2 }`. Original size is the default and also
accepts the existing `confirmedOriginalSize` confirmation. Resizing requires
`confirmedSizing: true`. Requests do not supply model/output paths or scripts.

From the repository root, with complete provider installations at these local
development paths:

```powershell
node scripts/verify-resin-engine.js --model tests/fixtures/resin/verification-cube.stl --profile tests/fixtures/resin/verification-profile.json --prusa ".cache/prusa/PrusaSlicer-2.9.7/prusa-slicer-console.exe" --uvtools ".cache/uvtools/UVtoolsCmd.exe" --output artifacts/resin-sizing-verification --unit-scale 1 --dimension-z 6
```

Replace provider paths as needed; providers and generated artifacts are not
shipped. Alternatives are `--sizing-scale 2`, `--dimension-x`, `--dimension-y` or
`--dimension-z`; supply only one sizing option. The actual Prusa 2.9.7 / UVtools 7.1.2 file-only run
produced a 684-byte normalized 6 mm cube with SHA-256
`29138c01a3e83a61ace114bac0c2395ee74bcae97b8e0cb704dadc44865e84b7`,
then a 329-layer GOO with zero reported issues at `(30, 15, 0)` degrees.
No printer was uploaded to or started, and no physical dimensions were verified.

See the [headless engine](HEADLESS-RESIN-ENGINE.md) for provider/schema details and
[qualified production](RESIN-PRODUCTION.md) for receipt, calibration and run gates.
