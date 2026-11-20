# Source-bound hollow and supported-output audits

The headless auditor compares actual solid/hollow reference GOO files with the
reviewed source and [hollow request](RESIN-HOLLOWING.md). It detects missing or
sealed cavities, unresolved gray occupancy, changes to the protected outer wall,
unexpected foreground and failed individual drain channels. A separate opened
drain cannot excuse a blocked one.

The paired reference audit and complete supported-output audit use the inspected
PrusaSlicer 2.9.7 contract and identical uniform native layer positions. References
contain only the body; their sampling elevation can match the supported output
exactly. Every report has
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
  supports,               // optional { plan, preset } support authority
  limits, signal          // optional lower resource bounds / AbortSignal
});

await verifyResinHollowReferenceAudit(options, savedReport);

// Same source/reference options, plus the final native artifact and mandatory
// support authority. Includes a freshly verified conforming body audit.
await auditResinHollowFinal({ ...options, supports, final });
await verifyResinHollowFinalAudit({ ...options, supports, final }, savedFinalReport);
```

The final functions are exported by `src/slicing/resin-hollow-final-audit.js`.
`final` uses the same four descriptor fields as a reference. Its complete
effective preset must equal the frozen support preset, and its complete 3MF
must match the source, placement, drains and authored contacts.

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
`policy`, and optional `limits`, `supports` and `final`. `supports` contains
exactly `planPath` and `presetPath`. Each native artifact object contains exactly
`filePath`, `sha256`, `input3mfPath` and `effectivePresetPath`. Populate bindings,
provider fingerprint and target properties from the frozen review/native run,
not from an unrelated current profile or a newly edited plan.

For the owned 20 mm verification cube, the explicit policy is:

```json
{
  "reduction": { "x": 1, "y": 1, "z": 1 },
  "maximumUncertaintyMm": 0.16,
  "boundaryPolicy": "voxel-enclosure",
  "referenceMode": "suppressed-support-elevation"
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
  settings, with the explicit support-suppression exceptions described below.
  Unit printer/material correction factors and disabled automatic Z
  correction are explicit. Native raster dimensions, handedness, height and
  exposure must match their effective presets. Source image bounds and height
  must agree with canonical dimensions and placement within the stated raster
  sampling bounds, and the source must have an empty image margin. The first
  and last layers containing actual source material must reach the canonical
  Z bounds within the unchanged uncertainty. Blank terminal definitions cannot
  substitute for occupied source height.
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

`boundaryPolicy` defaults to `exact-raster`. The explicit `voxel-enclosure`
policy permits changes only in the original source boundary band, with both
source-material and source-black distance witnesses within the same allowance.
The eroded full-white outer wall must remain full white. Reverse enclosure
requires protected source-upper outer-wall samples to remain within the band
of hollow-upper material, catching loss of a thin gray feature. Exact change
counts remain visible. The stricter definite thin-wall guard also remains
active; some binary erosion inside the band can therefore still be held.

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
envelopes. The entire resolved, shrunken requested cylinder must also be black;
an open thread through a partly blocked channel is insufficient. Exterior seeds
must remain connected to the halo through actual processed void while staying
outside the original source. A second open drain cannot supply exterior access
through the cavity for a capped first drain. Small unresolved holes and
ambiguous overlapping claims are held.

Drain envelopes use the **requested canonical** start, direction, radius and
length, with the documented native 1 mm outside extension. No inferred actual
float32 displacement grants a larger exemption. Actual encoded cuts must meet
that intended envelope and its declared raster band.

## Support authority and native sampling phase

`resin-hollow-supports.js` provides `prepareResinHollowSupports`,
`verifyResinHollowSupports`, `createSupportedHollow3mf` and
`assertSupportedHollowInput`. Requests declare `mode` (`none`, `automatic`, or
`points`), `clearanceMm`, `points` and `regions`. Authored points identify a
reviewed source face and a position on that exact triangle, head radius and
prior allowed radius. Rotation and native object centering travel with the
contacts. Native manual type 2, version 1, object ordinal 1 and float32 fields
are checked. Automatic generation requires specifically approved prior regions.
The combined contacts, explicit regions and pad are limited to 512 regions.
Default and branching support head settings use their corresponding native
fields and supported material overrides.

Regions authorize temporary support occupancy. They do not certify that all
functional holes remain clear before supports are removed. The final audit
requires each added exterior cell's whole box to fit both the global envelope
and a specific approved region, in original black air connected to the halo.
The default empty region list permits no additions. New hollow voids and drain
cores are protected regardless of support regions. The complete unmasked final
grid supplies all cavity and individual drain traversals.

The default reference mode is `zero-elevation`, with supports and pad disabled.
For supported output, `suppressed-support-elevation` uses native
`supports_enable=1`, `support_enforcers_only=1`, `pad_enable=0` and
`support_object_elevation` equal to the verified full model elevation. Exact
reference 3MFs contain no enforcer volumes and **no manual contact sidecar**:
manual contacts bypass native enforcer filtering. Other profile fields remain
identical except the four hollow settings and these declared selectors.
Native-generated empty leading layers are retained. The coordinate frame
subtracts the full elevation; there is no integer layer rounding or resampling.
The current final audit requires complete physical layer definitions and layer
counts to match all three stacks; differing schedules are held explicitly.

## Resources, cancellation and desktop delivery

Bounds may only be lowered. The reader permits at most 512 MiB per file,
25,000 layers, 100 million pixels per layer, a 128 MiB encoded-layer payload,
20 million interval cells, 250 million charged reader operations and 60 seconds
per pass. Its owned byte-buffer accounting includes header, reused payload and
grid arrays; JavaScript runtime, metadata and callback-retained objects are
outside that accounting. Binary zero/white spans use exact bounded bulk
minimum/maximum updates rather than one JavaScript operation per pixel.

The grid audit permits at most 20 million cells, 64 drains, 768 MiB of declared
input/working-array accounting and two billion charged operations. Its default
deadline is 60 seconds; a caller may explicitly declare up to 300 seconds before
execution. The controlled workflow records its own prior budget, at most 180
seconds. A longer declared deadline changes no geometry or uncertainty predicate.
Its two source distance fields use Float64. Dimensions, complete array memory
and transferable ownership are checked before growth or worker dispatch. These
are individual allocation/work bounds, not a global process RSS guarantee.
The body wrapper has a 180-second total deadline. The final wrapper has a
300-second total deadline, runs the body audit first, and preflights six input
arrays plus a conservative 32N working-array bound before final dispatch.

The CPU audit runs in a worker with unique input ArrayBuffers transferred and
detached instead of copied. Timers and cancellation remain responsive in the
parent; aborts, timeouts, malformed messages, errors and exits terminate and
clean up the worker. Initial bounded source/3MF preparation remains synchronous,
with cancellation/deadline checks before and between stages. It is not a
real-time mid-instruction interrupt.

The body and final workers and matching pure auditors are explicitly unpacked
beside the desktop package. Development, installed and portable smoke checks
run both workers on owned negative controls and record their resource hashes.
CI independently compares these hashes with checked-out source bytes for both
installed and portable packages. A solid cannot become a successful hollow
fixture merely because a worker started. The separate
[Windows native runner](RESIN-NATIVE-RUNNER.md) enforces native commit limits;
these raster auditors do not invoke it or attest a native run.

## Native evidence and remaining production work

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

A real 10 mm tilted fixture with four authored contacts and a pad passes all six
native issue checks. The explicit enclosure policy accepts its body boundary
at the original uncertainty while the exact policy retains its hold. An
arbitrary 7.037 mm model elevation (5.037 mm support elevation plus 2 mm pad)
produces three stacks with the same 228 physical layer definitions. All 684
native PNG planes match independent GOO decoding: 179,306,496 pixels, zero
differences. The body reference audit and replay conform at an unchanged
0.149021 mm total allowance, with 294,961 deep-cavity cells, no missing or
ambiguous cavity, and independently clear requested drain cores.
The same native fixture's complete final audit is **nonconforming** because pad
material exceeds its prior 3 mm authorization; replay preserves that result.
Full-wrapper positive/replay tests use an owned support-disabled fixture, while
the pure final-grid tests also include a tilted body and authorized pad.

A separate fresh native attempt froze 8 mm fixture authorization regions,
contacts, source, profiles, complete 3MFs, provider/source hashes and all command
arguments before its first native call. All 12 slicing/conversion/check stages
completed through the 1 GiB process/tree runner. Its full final audit and replay
conform: all 793,197 exterior support/pad cells fit the prior regions, required
voids remain clear, and both requested drain cores and individual paths pass.
All six final native checks are zero, and all 684 PNG planes again match GOO
decoding exactly. The original 3 mm rejection remains preserved. The 8 mm
authorization is a fixture-specific choice; each new request declares its own
regions and still undergoes the complete audit.

The full final supported raster must remain unmasked during drain checks. An
owned added exterior cap blocks the first channel while the second channel and
global cavity remain open. Body-masked original and capped arrays are identical:
masking supports away would erase the obstruction and falsely reuse the earlier
channel pass. The supported-output auditor now binds these checks to the
source, support authority and full final artifact. The
[controlled workflow](RESIN-HOLLOW-WORKFLOW.md) now supplies native orchestration,
all six final checks and order-workflow integration. Physical qualification and
live portal activation remain separate requirements. No standalone audit report
creates a printer permit.
