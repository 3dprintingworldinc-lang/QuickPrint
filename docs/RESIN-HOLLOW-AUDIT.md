# Source-bound hollow reference audit

The headless auditor compares actual solid/hollow reference GOO files with the
reviewed source and [hollow request](RESIN-HOLLOWING.md). It detects missing or
sealed cavities, unresolved gray occupancy, changes to the protected outer wall,
unexpected foreground and failed individual drain channels. A separate opened
drain cannot excuse a blocked one.

This is a **paired body-reference verification stage**, not a production slice
or a native invocation attestation. Both references currently require supports
and pad disabled, zero model Z placement, identical uniform layer positions and
the inspected PrusaSlicer 2.9.7 contract. Every report has
`nativeInvocationAttested: false`, `productionEligible: false`,
`geometricWallCertification: false` and `physicalDrainageCertification: false`.
The order engine's `hollowing_enable = 0` gate remains in place.

## Library and automation entry points

`src/slicing/resin-hollow-audit.js` exports:

```js
await auditResinHollowReferences({
  source,                 // reviewed normalized binary mm STL Buffer
  plan,                   // unchanged source-bound hollow request record
  expectedBinding,        // frozen source / geometry / sizing SHA-256 values
  solid, hollow,          // descriptors below
  provider,               // { name: 'PrusaSlicer', version: '2.9.7', sha256 }
  targetProperties,       // frozen slot's explicit UVtools properties
  placement,              // canonical source XY placement; z must be 0
  policy,                 // explicit reduction and maximum uncertainty
  limits, signal          // optional lower resource bounds / AbortSignal
});

await verifyResinHollowReferenceAudit(options, savedReport);
```

Each reference descriptor contains `filePath`, the frozen GOO `sha256`, a Buffer
of its actual `input3mf`, and a Buffer of its actual native `effectivePreset`
(`prusaslicer.ini`). The caller supplies frozen provenance from its native run;
the auditor does not prove that an arbitrary claimed process used those inputs.
Do not create a production receipt from caller-supplied provenance alone.

The CLI reads an equivalent JSON envelope with paths instead of Buffers:

```text
node scripts/audit-resin-hollow.js --request audit-request.json --output new-report.json
node scripts/audit-resin-hollow.js --request audit-request.json --verify saved-report.json
```

All paths in `audit-request.json` resolve relative to that JSON file. Its exact
top-level fields are `schemaVersion: 1`, `sourcePath`, `planPath`,
`expectedBinding`, `solid`, `hollow`, `provider`, `targetProperties`, `placement`,
`policy`, and optional `limits`. Both reference objects contain exactly
`filePath`, `sha256`, `input3mfPath` and `effectivePresetPath`. Populate bindings,
provider fingerprint and target properties from the frozen review/native run,
not from an unrelated current profile or a newly edited plan.

For the owned 20 mm verification cube, the explicit policy is:

```json
{
  "reduction": { "x": 1, "y": 1, "z": 1 },
  "maximumUncertaintyMm": 0.16
}
```

That number describes the encoded test raster, not a calibrated resin tolerance.
The command writes a new report only after completing the audit and refuses to
overwrite existing evidence. Exit codes are 0 for `conforming`, 2 for
`nonconforming`, 3 for `inconclusive`, and 1 for invalid input, cancellation or a
resource/provider-binding failure. Reports remain unqualified in every case.

## Source, settings and artifact identity

- The source is a bounded normalized binary STL, with at most 250,000 triangles,
  under the existing topology policy. Both source and rotated canonical mesh
  receive closed edge/vertex-manifold, winding and component checks. Rotation
  must preserve vertex, triangle and component counts. This is not a
  self-intersection or continuous-solid certificate.
- The plan is rederived under the separate expected source/geometry/sizing
  binding. The complete source mesh, explicit placement, version marker and
  exact drain metadata must match **all** native 3MF entry contents. The solid
  input has the same contents with the drain sidecar omitted. ZIP timestamps or
  compression may differ; additional or changed entry contents are rejected.
  The actual whole 3MF digests remain in the report.
- Effective settings must agree except for the four requested hollowing
  settings. Unit printer/material correction factors and disabled automatic Z
  correction are explicit. Native raster dimensions, handedness, height and
  exposure must match their effective presets. Source image bounds and height
  must agree with canonical dimensions and placement within the stated raster
  sampling bounds, and the source must have an empty image margin.
- The explicit UVtools target-property allowlist, required fields and numeric
  ranges are validated. Both GOO headers must match those properties. Native
  SLA exposure must also agree with the conversion targets. Native SLA lift
  settings are not claimed to map directly to MSLA motion; the supplied
  conversion properties and actual GOO schedule are bound separately.
- Every global physical field compared by the audit and every complete
  66-byte physical layer definition must match across the pair. Enabled
  per-layer settings are rejected until there is an explicit qualified
  per-layer schedule. Equal paired files cannot conceal zero per-layer
  exposures under otherwise valid global target values.
- Every GOO byte is validated and hashed again when building its interval
  grid. Changed files, truncated reads, rewritten identities and changed
  implementation sources stop the audit. Revalidation redoes the checks; it
  does not trust a saved `conforming` label.

The report's semantic SHA binds source/plan/reference digests, provider context,
target settings, alignment, declared limits/policy, selected implementation
source hashes, Node/V8/platform identity and the complete checked outcome.
Observed elapsed time, working-array measurements and remaining-time budgets
are excluded from that semantic digest. They are informational run observations;
verification returns freshly measured observations. The semantic digest is not
a cryptographic process attestation.

Selected implementation sources are pinned at module initialization and checked
before and after the audit. Run from one unchanged installation and restart the
whole process after code updates. Hot reloading cached helpers is unsupported.
This pin does not cover all runtime dependencies or prove native execution.

## Encoded raster policy

The independent streaming reader validates the complete V3.0 header, numeric
settings, increasing layer positions, RLE token grammar, checksums, delimiters,
footer and trailing-byte count. It retains one reusable encoded-layer payload,
not a complete file, pixel plane or native-resolution stack. Four-bit values
map exactly to eight-bit values by multiplication by 17.

Each explicitly reduced cell stores minimum and maximum grayscale across
**every** represented sample, including zeros. Missing samples at partial
reduction boundaries are zero. Full-white lower material occupancy therefore
requires every sample to be 255; upper material occupancy means any sample is
nonzero. Lower void is fully black; upper void is anything not fully white.
All excluded foreground is counted, including outside the source crop. The
auditor never silently drops added material in the crop halo.

The allowance is the full anisotropic voxel diagonal, plus measured layer-Z
rounding and native display-dimension rounding. It must fit the policy declared
before checking and cannot exceed one third of the nominal requested wall.
Reduction factors are explicit; the code never coarsens until a failed part
passes. An unresolved grid fails rather than selecting a wider allowance.

The audit derives the expected deep cavity and protected outer band from the
**solid source reference**, independently of the hollow result. Definite
retained material, gray ambiguity, thin-wall witnesses, changed protected
outer pixels and additions outside source occupancy have distinct results and
bounded witnesses. The reported wall interval is an encoded sample-distance
interval, not a continuous or cured-resin minimum-wall guarantee. A positive
result must also resolve its lower interval against the declared wall band.

Lower floods use six face neighbors; possible upper floods use 26 neighbors.
Gray-only straight or diagonal paths stay inconclusive. Drain seeds must lie
in source exterior connected to the boundary, not a sealed pre-existing air
pocket. Each requested cylinder needs its own fully black exterior-to-cavity
path and distinct definitely removed wall evidence outside the other drain
envelopes. Small unresolved holes and ambiguous overlapping claims are held.

Drain envelopes use the **requested canonical** start, direction, radius and
length, with the documented native 1 mm outside extension. No inferred actual
float32 displacement grants a larger exemption. Actual encoded cuts must meet
that intended envelope and its declared raster band.

## Resources, cancellation and desktop delivery

Bounds may only be lowered. The reader permits at most 512 MiB per file,
25,000 layers, 100 million pixels per layer, a 128 MiB encoded-layer payload,
20 million interval cells, 250 million charged reader operations and 60 seconds
per pass. Its owned byte-buffer accounting includes header, reused payload and
grid arrays; JavaScript runtime, metadata and callback-retained objects are
outside that accounting. Binary zero/white spans use exact bounded bulk
minimum/maximum updates rather than one JavaScript operation per pixel.

The grid audit permits at most 20 million cells, 64 drains, 768 MiB of declared
input/working-array accounting, two billion charged operations and 60 seconds.
Its two source distance fields use Float64. Dimensions, complete array memory
and transferable ownership are checked before growth or worker dispatch. These
are individual allocation/work bounds, not a global process RSS guarantee.
The wrapper has a 180-second total deadline and preflights both stages' grid
bounds together.

The CPU audit runs in a worker with unique input ArrayBuffers transferred and
detached instead of copied. Timers and cancellation remain responsive in the
parent; aborts, timeouts, malformed messages, errors and exits terminate and
clean up the worker. Initial bounded source/3MF preparation remains synchronous,
with cancellation/deadline checks before and between stages. It is not a
real-time mid-instruction interrupt.

The worker and matching pure auditor are explicitly unpacked beside the
desktop package. Development, installed and portable smoke checks run the real
worker on an owned solid negative control and compare both resource hashes to
their packaged copies. A solid cannot become a successful hollow fixture merely
because the worker started.

## Native evidence and remaining final-output work

The actual quality-0.75 cube passes the new source-bound wrapper on its unchanged
512 x 512 x 200 reference pair, with 6,447,032 expected deep-cavity cells and no
retained/ambiguous deep material, thin-wall witnesses, changed protected outer
band or outside additions. Both drains have 37,128 distinct definite wall-removal
witnesses. Pure and worker results agree. The same quality-0.5 baseline remains
inconclusive with its original 36 gray cells; it was not rescued by coarsening.

The reader was also cross-checked against the existing independent reader and
the owned 15120 x 6230 native file. A 128-layer synthetic 16K binary regression
aggregates under its explicit operation cap. Tests cover anisotropic EDT against
brute force, direct interval aggregation, source pockets, diagonal gray bridges,
individual plugs, missing cavity regions, outside additions, source/settings
tampering, code updates, worker cancellation and CLI report revalidation.

A separate real 10 mm tilted fixture with authored support points and pad passes
all six native issue checks. Its model is elevated 7 mm (5 mm supports plus 2 mm
pad), and all 541 native PNG planes across its two model references and final
227-layer file match independent GOO decoding. **The strict source-reference
audit remains held:** 57 outer gray values change by one and a separate source
zero becomes gray one. A research enclosure diagnostic locates those changes
inside the unchanged 0.149020 mm boundary band and preserves 1,028,609 eroded
outer-wall cells; actual away-boundary negative controls fail. That diagnostic
is not a new accepted audit policy or an exact-preservation pass.

The full final supported raster must remain unmasked during drain checks. An
owned added exterior cap blocks the first channel while the second channel and
global cavity remain open. Body-masked original and capped arrays are identical:
masking supports away would erase the obstruction and falsely reuse the earlier
channel pass. Final model elevation, support/pad material, intended boundary
enclosure and unmasked per-drain checks still need a complete source-bound
contract before the order workflow can accept hollow preparation. Trusted
native invocation, all six final checks, physical qualification and live portal
activation also remain separate requirements.
