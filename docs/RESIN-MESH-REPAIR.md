# Exact mesh repair and source preservation

Native repair is not evidence that the complete submitted model survived. An
owned PrusaSlicer 2.9.7 probe exported a 12-face closed cube after receiving that
cube plus an isolated, nondegenerate thirteenth triangle. It exited successfully.
FreeCAD's nearby vertex repair also merged two extremely close cubes into a
nonmanifold result. Neither a successful exit nor a closed output certifies
preservation of the original faces.

## Source gate used by slicing

The engine and service independently audit the normalized millimetre STL before
native slicing. The source must have closed edge- and vertex-manifold topology,
consistent winding and positive signed volume for every connected component.
Duplicate faces, open boundaries, inconsistent winding, nonmanifold edges or
vertices and negative-winding shells require explicit review or repair. No
native provider is invoked when this gate fails.

The service retains the independently computed `inputGeometry.meshAudit` and
rederives it during capture, download and dispatch. Edited stored evidence is
rejected. Older records without that field are audited again; their absence
does not exempt the original geometry from the gate. Source hashes, sizing and
CAD evidence continue to be checked separately.

The audit is bounded to 250,000 triangles, 250,000 exact vertices, 375,000 edges,
4,096 components and 20 seconds, within the existing 100 MiB source byte bound.
These topology bounds are stricter than measurement's two-million-triangle
limit. Exceeding them fails preparation rather than delegating unchecked repair
to the native slicer. The audit explicitly reports intersections as
`not_checked`, cavities as `not_classified` and `solidCertified: false`.
Positive multiple shells do not establish a part count or certify absence of
overlap or hidden cavities.

## Callable exact repair primitive

[`resin-mesh-repair.js`](../src/slicing/resin-mesh-repair.js) provides a separate
bounded primitive for constructing an explicitly reviewed derivative:

```js
const { prepareResinMeshRepair, verifyResinMeshRepair } =
  require('./src/slicing/resin-mesh-repair');
const repaired = prepareResinMeshRepair(normalizedMillimetreStl);
verifyResinMeshRepair(normalizedMillimetreStl, repaired);
// repaired.stl is a separate Buffer; repaired.proof accounts for every face.
```

Input is a zero-origin binary millimetre STL. The managed order workflow first
normalizes declared units at original size and repairs that derivative; later
reviewed numeric sizing remains a separate step. The
primitive preserves retained coordinate bytes exactly. It can remove only
coordinate-identical duplicate geometric triangles, reconstruct consistent
winding, orient a single closed component positively and recompute facet normals.
Every source face maps to a retained output face with explicit duplicate and
orientation accounting. Output bytes and the complete proof must reproduce
deterministically from the same source.

Multiple components may be oriented outward only when their bounding boxes are
strictly disjoint. Touching, overlapping or nested boxes are held because their
shell/cavity meaning is ambiguous. Open boundaries, nonmanifold geometry and
nonorientable topology cannot be repaired by deleting unique faces. The
primitive never fills holes, changes coordinates, joins nearby vertices,
removes isolated unique triangles or infers ordered production units. Its
limits may only be lowered, and face-accounting JSON is bounded to 64 MiB.

## Repair an imported order

For an imported STL or triangulated OBJ, choose **Review exact mesh repair**,
review its limits and explicitly confirm **Repair exact mesh issues**. This is
optional; valid models can use the existing path unchanged. Exact repair is a
separate managed derivative and never overwrites the frozen original model.
STEP/STP retains its separately audited CAD preparation path.

The result shows removed duplicate and reoriented face counts, unchanged
normalized bounds and an unqualified STL download. Full per-face proof stays in
a bounded managed JSON file rather than the job summary. Choose **Measure
model** again, review the repaired millimetre size and select the desired
uniform sizing. Ticket units remain recorded; the engine uses millimetres and
unit scale 1, so inches or metres are not applied a second time.

Normalization independently checks that distinct original face-vertex coordinates
never collapse into the same float32 point. Otherwise a high-precision OBJ
could acquire apparent exact duplicates during conversion and lose unique
geometry during repair. Such inputs fail with `RESIN_REPAIR_PRECISION` before
capture. Unit/origin conversion is recorded separately from the exact repair's
promise of zero changes to retained normalized vertex coordinates.

The authenticated automation sequence is:

1. `POST /api/jobs/:id/resin/repair` with `{"confirmedExactRepair":true}`.
   The returned job includes `resinRepair`, its summary and managed descriptors.
2. `GET /api/jobs/:id/resin/repair/download` to review the unqualified STL, and
   `GET /api/jobs/:id/resin/geometry` to obtain verified millimetre dimensions
   and `geometrySha256` for this derivative.
3. `POST /api/jobs/:id/resin/slice` with the usual requirements/sizing/slot
   confirmations and that hash as `expectedGeometrySha256`. A missing or stale
   hash fails with `RESIN_REPAIR_REVIEW_STALE` before the provider runs.

The service rederives unit normalization, full face accounting, repaired bytes,
summary and implementation manifest from the original source. Original source,
normalized source, proof and repaired STL have separate hashes. Captured slices
retain the original portal `sourceSha256`, with `repairedSourceSha256` and
`repairPreparation` binding the derivative. A composite tool signature includes
the fixed repair implementation/method and slicing engine; model-specific proof
hashes remain preparation evidence rather than changing the process signature.

Capture, download, receipt synchronization, approval and dispatch recheck the
chain. Regenerating a repair invalidates the old slice and local permits.
Pending or committed approval must be withdrawn first. Active runs, preparation
locks, cancellation, backup and shutdown use the same lifecycle gates as CAD
preparation. Restart does not waive proof or review checks. Repair grants no
printer qualification, start permission, printed-unit count or QC acceptance.

Run the independent geometry and repair regressions:

```sh
node --test tests/resin-mesh.test.js tests/resin-mesh-repair.test.js tests/resin-repair.test.js tests/resin-repair-service.test.js tests/resin-geometry.test.js tests/resin-sizing-service.test.js
```

## Native order evidence

A real file-only service run used an owned curved mesh with 501 triangles: 500
unique faces, one exact duplicate and one incorrectly wound face. Its ticket
declared inches. Repair normalized that source to approximately 76.2 mm once,
removed exactly one duplicate and reoriented one unique face. All 252 distinct
vertices stayed distinct; retained normalized coordinates were unchanged.

The operator's later numeric plan set source Z to 6 mm, producing a model of
6 x 5.99813509 x 6 mm. PrusaSlicer 2.9.7 and UVtools 7.1.2 produced two verified
copies over 120 layers with zero reports from all six issue checks. The captured
slice kept the original damaged upload's source hash separately from the
repaired source. Core download verification passed before and after closing and
reloading the service; original bytes stayed unchanged, dispatch stayed disabled
and there were zero physical runs.

The observed final GOO SHA-256 was
`95842c753912182636168759dbb16a1af4f5d6be02ce7d716e9a8993a13c5031`.
The local report is `artifacts/native-repair-order/verification.json`. Generated
files and provider binaries remain ignored workstation evidence. This tests
the core download method, not a live portal or hardware transaction;
authenticated HTTP and portal-boundary fixtures are separate regressions. A clean software report
does not establish physical qualification.

## Hollowing and drain planning

Hollowing remains disabled in production profiles. Separate owned CAD probes
produced a valid drained 20 mm cube with 2 mm walls and two 3 mm holes, but also
found an offset operation silently discarding half of a narrow-neck cavity while
returning a valid contained solid. OCP face-history checks detected that case.
Validity, global wall clearance and agreement between two OCCT versions alone
do not prove complete intended hollowing. A future hollow/drain stage needs
source-face coverage, explicit sized-millimetre hole plans, cavity/exterior
connectivity, independent derived-mesh evidence and the usual final GOO checks.
These probes do not establish physical drain performance or general wall safety.
