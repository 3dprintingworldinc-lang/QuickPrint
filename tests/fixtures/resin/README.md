# Owned resin verification geometry

These synthetic shapes and settings test software behavior. They are not resin
calibrations or production profiles.

- `verification-cube.stl` is a 3 mm cube used for source measurement and uniform
  resizing checks.
- `verification-cylinder.step` is an owned FreeCAD 1.0.2 export of a radius
  1.5 mm, height 3 mm cylinder translated to `(10000000, 20000000, -30000000)` mm.
  Its STEP length unit is millimetres. The distant origin exercises the common
  CAD translation performed before float32 tessellation, and its curved faces
  exercise full face coverage and analytic-volume comparison. Export metadata
  contains no customer geometry or machine identifiers.
- `verification.ini` and `verification-profile.json` describe the synthetic
  512 by 256 pixel, 40 by 20 mm SLA target used in the file-only verifier.
- `verification-cad-profile.json` uses the same target settings with the
  `(45, 15, 0)` degree orientation verified for the resized cylinder. This
  changes neither automated issue checks nor exposure, support or pad values.

The native CAD check uses the separate source-transfer reader and FreeCAD
mesher. See [the CAD workflow](../../../docs/RESIN-CAD.md) for prerequisites and
the reproducible command. Native binaries and generated meshes/slices remain
outside these fixtures.
