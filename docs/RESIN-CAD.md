# STEP geometry preparation for resin

QuickPrint can audit and tessellate STEP/STP before the existing resin sizing and
slicing workflow. It preserves the uploaded CAD bytes, imports every retained
solid in its assembly position, and checks the resulting meshes against a second
native import. This is file preparation; it does not qualify a printer or start
hardware.

## Set up the two native providers

The verified installation is **FreeCAD 1.0.2 / OCCT 7.8.1**, using its bundled
**CPython 3.11 Windows x64** interpreter. In **Settings -> Resin model
preparation**, select the complete installation's `bin/FreeCADCmd.exe`, then use
**Set up CAD transfer audit**. The setup downloads two fixed, checksum-pinned
official PyPI wheels into a separate managed runtime: `cadquery-ocp-novtk` and
`cadquery-ocp-proxy`, distribution **8.0.1.1.0**. The OCP binding reports
**8.0.1.1**. It does not install into system/user Python or run pip/build hooks.

Save the paths and review **CAD mesh accuracy**. Defaults are absolute linear
deflection `0.005` mm and angular deflection `0.1` radians. Supported settings
are `0.0001..0.1` mm and `0.01..0.5` radians. Smaller values can increase native
runtime and triangle count; these parameters are tessellation inputs, not a
promise of physical print accuracy.

For a reproducible command-line setup:

```powershell
node scripts/setup-resin-cad.js --output-dir .cache/managed-cad-audit
```

Use the printed absolute `cadAuditPath` in Settings. To prepare offline, place
the exact two pinned wheel files in a directory and add
`--offline-dir C:/path/to/wheels`. Filenames, byte counts and SHA-256 values are
fixed in [the runtime installer](../src/slicing/resin-cad-runtime.js). Existing
unrecognized directories are refused; reuse verifies the receipt and every
installed file. Keep this runtime unchanged.

The in-app setup uses `<dataDir>/.providers/cad-transfer/8.0.1.1.0/` and saves its
`site-packages` path to `resinEngine.cadAuditPath`. Its authenticated API is
`POST /api/resin/cad/runtime` with an empty `{}` body; model/job requests cannot
choose a download URL, package or installation directory.

## Prepare a STEP ticket

1. Open the imported resin ticket. Review its CAD units and any conflict with
   the order's declared units.
2. Confirm the embedded-unit checkbox and choose **Prepare STEP geometry**.
   STEP intrinsic units are converted to millimetres by the CAD kernels. The
   order's `mm`/`in`/`m` field is retained for review and is **not applied again**.
3. Once conversion succeeds, use **Measure model** and review the millimetre
   dimensions. Choose original size, a uniform numeric factor, or one source-axis
   target dimension. Free-text requests still require operator interpretation.
4. Slice with the selected reviewed resin/profile slot, then follow the usual
   [receipt and qualified production steps](RESIN-PRODUCTION.md).

Conversion and slicing share the resin engine lock. Duplicate requests, active
print runs and pending/approved preparation holds prevent replacement work.
Cancellation and shutdown clear pending capture. A new conversion invalidates
the previous local slice and dispatch permits. Withdraw an existing queued
approval before revising it.

The authenticated job API is `POST /api/jobs/:id/resin/cad` with
`{"confirmedEmbeddedUnits":true}`. It returns the updated job. The existing
`GET /api/jobs/:id/resin/geometry` then verifies the saved conversion and returns
measurements without running native providers. It identifies both the original
`sourceSha256` and the converted `geometrySha256`.
For STEP slicing, submit that reviewed `geometrySha256` as
`expectedGeometrySha256` alongside the sizing/requirements confirmations. A
missing or stale hash fails with `RESIN_CAD_REVIEW_STALE` before SLA providers
run; refresh the measurements and confirm the current conversion again.

## What is verified

The [transfer auditor](../src/slicing/resin-cad-transfer-audit.py) and
[FreeCAD worker](../src/slicing/resin-cad-worker.py) run in **separate isolated
Python processes** (`-I -B`), avoiding mixed OCCT library versions. They use only
trusted worker code and a private copy of the original STEP.

The OCP reader must report successful loading, zero syntactic/semantic load
failures or warnings, all translatable roots transferred, positive shape counts,
and zero transfer failures or warnings. Native warnings are held conservatively.
This matters: owned malformed STEP fixtures made FreeCAD return a valid first
solid while silently dropping a second. Both dangling-reference and resolved
wrong-type examples are rejected by the independent audit.

Both imports must agree on global bounds, solid/face counts, area and volume,
and on each solid's face count, one-shell topology and analytic measurements,
compared as a multiset so traversal order need not match. Bounds use underlying
CAD geometry rather than cached meshes. Coordinate comparisons allow numerical
precision without accepting a displacement proportional to a large world origin.

Before meshing, each solid copy receives the **same global CAD-minimum
translation in kernel precision**. Reported CAD bounds and `originMm` retain
the source frame; STLs use the shared translated millimetre frame. This preserves
relative assembly placements and avoids collapsing small geometry at large
offsets when binary STL coordinates become float32.

Every CAD face must have a nonempty mesh segment. Segments must cover every
triangle exactly once. The Node verifier independently checks each binary STL's
hash/count, finite nondegenerate triangles, closed manifold edges, outward
winding and one component per CAD solid. Mesh bounds and volume must agree with
the analytic solid within bounded tessellation/float32 tolerances. It combines
the verified solids without merging or repositioning their relative geometry.
These checks are not a Hausdorff-distance or self-intersection certification.

The service saves the original STEP hash, per-solid evidence, transfer/mesh
reports, combined mesh hash, tolerances and provider manifest. It independently
revalidates them before measurement, slice capture, download and qualified
dispatch. The Prusa sizing plan binds to the converted mesh; the slice receipt
continues to bind the **original STEP hash**. A composite tool fingerprint binds
the slicer provider, CAD provider and tolerances, so changing that preparation
stack requires a new qualification binding.

## Supported bounds and held cases

Source and combined mesh are each limited to 100 MiB; CAD work is limited to
128 solids, 50,000 faces and 250,000 aggregate mesh triangles. Each JSON report
is at most 1 MiB. Native processes have bounded logs and a configured timeout.
The STEP preflight also bounds entity/reference counts and nesting, validates
string escapes, rejects undefined/duplicate entity IDs, and accepts one classic
Part 21 `HEADER`/`DATA` layout. XML STEP, external-resource entities/reference
sections and unsupported layouts are held rather than partly imported.

Invalid/open solids, non-solid geometry outside solids, internal void shells,
missing mesh faces, changed files, mismatching independent imports and any
native load/transfer warning fail preparation. Through-holes with one closed
shell can pass; sealed multi-shell cavities are held. A valid-looking NURBS
sphere fixture with a native transfer warning is conservatively held. General
surface tessellation, healing, hollow/drain design, inter-solid intersection and
cavity safety are not certified by this workflow.

## Reproduce a file-only verification

Use the repository's owned
[verification cylinder](../tests/fixtures/resin/verification-cylinder.step) and
the managed runtime from setup:

```powershell
node scripts/verify-resin-cad.js --model tests/fixtures/resin/verification-cylinder.step --freecad "C:/Program Files/FreeCAD 1.0/bin/FreeCADCmd.exe" --audit-runtime C:/absolute/managed-cad-audit/site-packages --output artifacts/resin-cad-verification
```

To continue through the synthetic 6 mm resin check, capture the CAD command's
JSON and use its verified mesh with the CAD-specific public profile:

```powershell
$cadCheck = node scripts/verify-resin-cad.js --model tests/fixtures/resin/verification-cylinder.step --freecad "C:/Program Files/FreeCAD 1.0/bin/FreeCADCmd.exe" --audit-runtime C:/absolute/managed-cad-audit/site-packages --output artifacts/resin-cad-verification | ConvertFrom-Json
node scripts/verify-resin-engine.js --model $cadCheck.filePath --profile tests/fixtures/resin/verification-cad-profile.json --prusa ".cache/prusa/PrusaSlicer-2.9.7/prusa-slicer-console.exe" --uvtools ".cache/uvtools/UVtoolsCmd.exe" --output artifacts/resin-cad-slice-verification --dimension-z 6
```

Replace native installation/runtime paths as needed. The cube-oriented
`verification-profile.json` is not the cylinder's zero-report profile.

Optional flags are `--linear-deflection-mm`, `--angular-deflection-rad` and
`--timeout-ms`. The report is independently reverified before success. Software
probes passed ten positive fixtures covering curved/chamfered/through-hole
geometry, repeated nested assemblies, mixed mm/in/metre roots and a 3 mm solid
at large CAD offsets. Five negative fixtures held void shells, non-solids,
dangling references, wrong-type references and a warning-bearing NURBS transfer.
No probe uploaded a file to or started a printer.

The public fixture is a 3 mm-high, 3 mm-diameter cylinder at large world
coordinates. Its source SHA-256 is
`1027d80bb487aef3fa91c758babf2f246fbeedf1c83b35152131d89252e48f3c`.
The actual local service imported it from a ticket declaring inches, retained
that ticket field, and measured approximately `3 x 2.9990674 x 3` mm from its
500-triangle CAD mesh. A source-Z target of 6 mm produced approximately
`6 x 5.9981346 x 6` mm; no second inch conversion occurred.

The first complete STEP-to-GOO service run correctly remained held: the
verification profile's flat orientation reported 28 resin traps, and
`(30,15,0)` degrees reported one, yielding a 306-layer review artifact.
Changing only the orientation to `(45,15,0)` produced a clean native probe.
The complete service was then rerun with the public
`tests/fixtures/resin/verification-cad-profile.json`: **309 layers and zero
reports across all six issue checks**, with original STEP bytes preserved,
embedded units applied once, dispatch disabled and no physical runs. Supports,
pad, exposure and motion settings were unchanged. Output remained
`printReady: false`. This is software/file evidence, not physical dimensional
or resin qualification. Native export timestamps can change the GOO file hash.

The primary API/source references are FreeCAD's
[STEP import implementation](https://github.com/FreeCAD/FreeCAD/blob/1.0.2/src/Mod/Part/App/TopoShape.cpp),
Open Cascade's [STEP translator guide](https://github.com/Open-Cascade-SAS/OCCT/wiki/step),
the [OCP binding source](https://github.com/CadQuery/OCP), and the pinned
[no-VTK distribution](https://pypi.org/project/cadquery-ocp-novtk/8.0.1.1.0/).
