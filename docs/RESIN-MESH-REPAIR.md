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

Input is the zero-origin binary millimetre STL produced by numeric sizing. The
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

This primitive is not yet an order-service repair/adoption workflow. Calling it
does not replace the frozen portal model, qualify geometry, enable slicing of
the original invalid source or grant printing authority. Integrating its
source-bound derivative and explicit operator review into the sizing/capture
chain remains required before repaired models can enter production through
that workflow. Originals and existing preparation holds must be preserved.

Run the independent geometry and repair regressions:

```sh
node --test tests/resin-mesh.test.js tests/resin-mesh-repair.test.js tests/resin-geometry.test.js tests/resin-sizing-service.test.js
```

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
