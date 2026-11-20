# Source-bound hollowing and drain requests

QuickPrint can now build a deterministic native hollowing/drain request from a
reviewed, sized, zero-origin millimetre STL. This is an automation interface for
provider verification. It does **not** qualify hollow output for an order.
The production engine still requires `hollowing_enable = 0` and returns
`RESIN_DRAIN_PLAN_REQUIRED` for a hollow preset.
The separate [source-bound reference raster audit](RESIN-HOLLOW-AUDIT.md) now
checks paired native body references, including cavity coverage and individual
drains. It remains unqualified pending the final supported-output contract.

The request pins three separate SHA-256 values: the original order source, the
reviewed sized STL bytes, and the sizing review. The caller must supply the
original-source and sizing bindings from that review; the builder independently
checks the sized STL digest. Input files remain unchanged. Verification
rederives the entire request, including native metadata, under the caller's
expected binding. Editing a record cannot turn it into a production receipt.

## Callable interface

`src/slicing/resin-hollow-plan.js` exports:

```js
prepareResinHollowPlan(sizedNormalizedStl, request)
// => { stl: rotatedCanonicalStl, drainMetadata, plan }

verifyResinHollowPlan(sizedNormalizedStl, plan, expectedBinding)
// => the independently rederived request artifacts, or an error

createResinHollow3mf(sizedNormalizedStl, plan, expectedBinding, placement)
// => { threeMf, sha256, planSha256, placement, productionEligible: false }
```

`request` contains exactly:

```json
{
  "binding": {
    "sourceSha256": "ORIGINAL_ORDER_SOURCE_SHA256",
    "geometrySha256": "REVIEWED_SIZED_STL_SHA256",
    "sizingSha256": "SIZING_REVIEW_SHA256"
  },
  "orientation": { "x": 0, "y": 0, "z": 0 },
  "wallThicknessMm": 2,
  "quality": 0.5,
  "closingDistanceMm": 0,
  "drains": [
    {
      "id": "bottom-1",
      "startMm": { "x": 6, "y": 10, "z": 0 },
      "direction": { "x": 0, "y": 0, "z": 1 },
      "radiusMm": 2,
      "lengthMm": 5
    }
  ]
}
```

Replace the three digest placeholders with actual lowercase SHA-256 values.
Drain starts use the sized, zero-origin source frame **before orientation**.
Directions must be explicit unit vectors pointing into the desired cylinder.
The builder applies the same Z -> X -> Y rotation and minimum translation to
both mesh and drains, then subtracts the actual emitted mesh's bounding-box
center for the native sidecar. Build placement is separate; it does not alter
the object-local drain metadata. Sizes are already in the STL bytes: native
scaling, geometry corrections and additional build rotations are outside this
request contract.

The strict request allows 1..64 uniquely named drains, radii 0.001..1000 mm,
lengths 0.001..10000 mm, finite starts within +/-10000 mm and rotations within
+/-360 degrees. Identical native rows are rejected. Same-direction cylinders
with identical native radius/height must differ in serialized start by more
than 0.01 mm on at least one axis. This conservative policy also catches
distinct sidecar positions that collapse during native float32 compensation;
it does not prove each remaining hole has a distinct effective opening. Models use the existing
100 MiB, two-million-triangle, bounded canonicalization policy. The generated
3MF also retains the shared exact-coordinate vertex policy and its byte/vertex
limits. These are resource and request limits, not a statement that any such
hole intersects the model or is printable.

Wall thickness 1..10 mm, quality 0..1 and closing distance 0..10 mm follow the
[pinned native option definitions](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/libslic3r/PrintConfig.cpp).
No resin exposure or physical wall calibration is inferred.

## Headless request preparation

Save a JSON envelope containing exactly `schemaVersion: 1`, the `request` above,
and `placement`, for example `{ "x": 10, "y": 10, "z": 0 }`.

```text
node scripts/prepare-resin-hollow.js --model sized-normalized-mm.stl \
  --request hollow-request.json --output new-hollow-request-directory
```

The output directory must be new and its parent must exist. The command writes
`input.3mf`, `hollow-overrides.ini`, `plan.json` and a hash/size `manifest.json`.
It validates the request before creating the directory and refuses to overwrite
an existing request. The CLI reads bounded regular source and JSON files and
checks that their size/timestamps did not change during reading. The library
uses a private source snapshot and verifies its expected geometry digest.

The output deliberately records `request-only`, `geometryVerified: false`,
`drainConnectivityVerified: false`, `wallThicknessVerified: false` and
`productionEligible: false`. The command performs no slicing or printer action.
Future native verification must check the generated settings against the actual
effective preset rather than assuming an override file was applied.

## Native format and precision

The generated single-object 3MF includes `slic3rpe:Version3mf = 1` and
`Metadata/Slic3r_PE_sla_drain_holes.txt`. The sidecar addresses the imported
**object ordinal 1**, not an arbitrary XML resource ID. Each drain contains
position XYZ, direction XYZ, radius and height. Format version 1 stores a point
one millimetre outside the intended start and adds one millimetre to length;
the importer reverses that compatibility adjustment. Native processing then
extends the cylinder outside by a further millimetre to avoid coplanar cuts.
These behaviors are established by the pinned
[3MF importer/exporter](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/libslic3r/Format/3mf.cpp),
[mesh centering](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/libslic3r/Model.cpp)
and [hollow/drill transforms](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/libslic3r/SLA/Hollowing.cpp).

Serialized fields are explicit float32 values written as round-trippable decimal
numbers. Requested canonical/object-local positions and serialized positions are
stored separately. Native import uses float32 normalization and addition, so the
requested position is **not** claimed to equal the imported position exactly.
The plan records that distinction, the scalar length after import and the extra
native stick-out. A resulting-geometry verifier must account for this rounding
and the actual cylinder extent. Native 3MF re-export uses six decimal places and
can introduce additional rounding; it is not the original exact request.

## Observed validation and remaining gate

The owned 20 mm cube request with a 2 mm nominal wall and two bottom drains
(radius 2 mm, requested length 5 mm) was prepared through the new CLI, then
processed by actual PrusaSlicer 2.9.7 and UVtools 7.1.2. The effective hollow
settings matched all four overrides. All 200 native layer images matched the
previous independent explicit-sidecar probe: **52,428,800 pixels compared,
zero differences**. The resulting GOO passed all six issue checks. Its SHA-256
was `dbfe25a46fad32f9eebde1934b9f30156bde8ce9cbeb27a2508b42b84d64cfd2`.
Manifest hashes, stale-source rejection and refusal to overwrite also passed.
This is an owned provider test, not printer qualification.

Additional independent research established useful failure controls:

- A sealed native hollow cube reports a resin trap; the drained counterpart has
  actual raster channels to its interior. A full-volume raster prototype detects
  a missing half-cavity, an individually plugged drain, material added outside
  the solid and a thin-wall edit. Conservative lower/upper occupancy keeps gray
  edge pixels ambiguous; coarse-grid conformance describes a declared voxel
  band, not exact geometric or physical wall certification.
  At quality 0.5 the owned drained cube has 36 ambiguous gray samples in the
  fine expected cavity. Actual quality 0.75 and 1 runs with supports and pad
  disabled eliminate those samples at the **same** 512 x 512 x 200 grid and
  0.149020 mm allowance: no missing cavity, outside additions, changed outer band
  or thin-wall witnesses; both
  individual black drain channels and global exterior reachability pass. Each
  also passes all six native checks. All 200 SL1 PNG layers per quality match
  independent GOO decoding (52,428,800 pixels each, zero differences). The wall
  resolution interval remains about 1.951..2.249 mm, so these positive encoded
  raster cases still do not certify a geometric or physical minimum of 2 mm.
- Two OCCT versions agree on a valid inward-offset result that silently omits
  one lobe of a dumbbell cavity. Bounds, containment, shell validity and minimum
  clearance alone do not prove complete hollowing. Source-face history catches
  that example but is not a general coverage proof. Adaptive whole-cell distance
  research catches the omitted lobe, conditional on distance/classifier error
  bounds that have not been independently established.
- Native `--export-stl` exports the original solid rather than the processed
  hollow/drilled result. Actual release trace logging produced no processed
  mesh dump. The GUI has a processed preview mesh getter, but it follows Boolean
  fallback paths and is not a supported unattended export or a completeness
  certificate. See the pinned
  [CLI action implementation](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/CLI/ProcessActions.cpp)
  and [SLA processing stages](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.7/src/libslic3r/SLAPrintSteps.cpp).

The [bounded body and final raster auditors](RESIN-HOLLOW-AUDIT.md) now bind the
original source, requests, support authority, effective settings and final layer
artifact. They check cavity coverage, each drain, wall policy and full unmasked
support material at the exact native sampling elevation. Reports remain
unqualified: controlled native orchestration and production workflow adoption
are still required, followed by all six native issue checks and physical
qualification. There is no hollowing production receipt, order approval or
printer permit in this request module.
