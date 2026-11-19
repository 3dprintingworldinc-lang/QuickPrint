# Resin order automation: implementation and qualification

This branch implements paid resin-ticket intake, local headless preparation,
validated GOO capture, and durable preparation-evidence synchronization with
PrintByLayr. Every captured resin slice remains `printReady: false` and
`printerCompatible: false`; resin production tickets cannot enter the generic
filament preparation or printer dispatch paths.

The companion portal changes are available in the private
[PrintByLayr draft PR #15](https://github.com/3dprintingworldinc-lang/printbylayr/pull/15).
They have not been migrated or deployed to the production portal. See
[production API source and setup](PRINTBYLAYR-PRODUCTION-INTEGRATION.md) for the
private-source test setup and deployment boundary.

## Working connection path

1. Deploy and configure the reviewed portal production API before connecting a
   live studio. In QuickPrint, open **Inputs -> Connect PrintByLayr -> Use machine
   API**, enter the HTTPS portal origin and separately scoped production machine
   token, and choose whether to send validated slice receipts automatically.
2. The production connector pages through paid resin tickets awaiting preparation.
   Downloads recheck the ticket version/fingerprint and record the source hash.
   Original model data, approved specifications, portal identity/version, units, requested
   scale/dimensions, support instructions and part count stay with the local job.
   Imported models are limited to 100 MiB; signed download links are not retained.
3. Configure PrusaSlicer and UVtools paths and reviewed named resin/profile slots
   in **Settings -> Resin model preparation**. Select a slot for each ticket and
   resolve its requirements before confirming the model's declared units/current
   size. Only mm, inches and metres have deterministic conversion; customer
   free-text sizing is not interpreted or applied automatically.
4. **Slice resin model** evaluates the profile's explicit orientation candidates,
   generates supports/pad according to the preset, exports SL1, converts to GOO,
   applies reviewed target parameters, validates every GOO layer and runs the six
   configured UVtools issue checks. The first candidate with no reported issues
   is retained. If none passes, the candidate with the fewest reports remains
   visible for review. All results preserve source/profile/tool/artifact hashes.
5. A validated, issue-free capture can be sent as `record_slice` preparation
   evidence through the durable outbox, manually or automatically on a connector
   poll. This records hashes and target metadata, not raw GOO bytes, approval for
   printing, or a completed order. Requested parts remain separate from file runs.

The legacy OAuth/PKCE MCP input remains available. It uses read tools and the
portal's broad `studio` consent; its newest-100-jobs window remains a limitation
of that legacy API. The new production connector uses a dedicated machine token,
pagination and separate preparation permissions. Credentials use QuickPrint's
protected credential store. Downloads stay on the configured HTTPS portal origin,
refuse redirects and never receive the API bearer token.

## Preparation and synchronization boundaries

The completed local headless pipeline used **PrusaSlicer 2.9.7 + UVtools 7.1.2**.
A small synthetic verification selected 234 layers after rejecting an orientation
with one island. A separate 15120 x 6230 probe produced eight layers with zero
reported issues. The independent GOO reader also validated the actual 1344-layer,
218,451,945-byte native SatelLite export. These are file/software observations;
none was a qualified physical production print. Reproduction commands, profile
schema, unit rules, resource bounds and observed hashes are in the
[headless resin engine guide](HEADLESS-RESIN-ENGINE.md).

Named profile slots keep separate reviewed printer/resin settings while sharing
provider executables and the timeout. Profile customization edits material,
layer height, exposure/motion/PWM, support/pad policy and orientation candidates.
Saving creates validated managed JSON/INI copies and updates only the selected
slot's path; original files and other slots are preserved. Printer identity,
geometry and mirrors are not editable through that customization form. Each new
profile fingerprint requires qualification for its actual printer/resin use.

The outbox durably saves each operation UUID, expected ticket version and exact
body before transmission. Lost responses and restart recovery replay those same
values. New, unsent slice evidence is checked against current local source/output
hashes; attempted operations remain available for exact replay even if local
files later change. Conflicts block later evidence for the same portal job.
Definite conflicts/rejections, and held operations that were never sent, can be
dismissed locally with a recorded reason. An attempted operation with an uncertain
remote outcome requires reconciliation; dismissal is not a rollback of portal
state. The portal separately controls qualified preparation approval.

SatelLite 1.0.2.18 exposes evaluation, repair and hollowing CLI flags, but no
supported unattended slicing/export CLI was established. Synthetic probes exited
0 without output while a user-owned instance was running; singleton forwarding
remains a possible confounder. The experimental adapter rejects missing output
as `SATELLITE_NO_OUTPUT`. Native DLL command names do not establish a public SDK.
See [SatelLite deconstruction](SATELLITE-DECONSTRUCTION.md).

## End-to-end process map

| Stage | Implemented and observed | Remaining work |
| --- | --- | --- |
| Paid intake | Scoped paginated production client; frozen ticket/version identity; private-model hash; deduplication | Live portal deployment/token and actual paid-order verification; larger-model policy |
| Units and sizing | Explicit mm/in/m conversion; instructions preserved; required human size confirmation | Interpret/resolve requested scale and target dimensions, then supply geometry that embodies them |
| Mesh/solid policy | STL/OBJ input; original preservation; solid-only slicer policy; SatelLite probe | Mesh repair qualification; detect existing cavities; drain-hole/wall and hollow-part validation |
| Orientation/supports | One to four explicit rotations; configurable supports/pad; six issue checks | Customer support/finish requirements, physical support strength, arbitrary orientation and plate packing |
| Slice/export | Callable Prusa SLA -> SL1 -> UVtools GOO; full bounded GOO-layer validation; target parameter checks | Printer/firmware/resin calibration, image handedness and dimensional acceptance |
| Profile customization | Named slots; managed copies; constrained material/exposure/motion/support/orientation editing | Qualification of each edited profile; no inference of safe resin values |
| Evidence synchronization | Stable operation UUID/body/version; durable retry/outbox; optional automatic issue-free slice receipts | Deploy portal migration/API, provision scoped token and qualified bindings, verify live reconciliation |
| Printer LAN | SDCP adapter; actual read-only attributes/status on Saturn 4 Ultra 16K V1.5.6 | Actual upload/start/control qualification and artifact acceptance; resin ticket dispatch remains blocked |
| Wash/cure/support removal | Requirements and portal production states remain available | Machine/operator evidence for the actual post-processing operations |
| QC/delivery | Requested part count retained separately from runs | Physical acceptance, rejected/accepted part counts and portal completion evidence |

Read-only SDCP implementation calls succeeded against the actual printer. No
upload, remote start, pause, resume or stop was performed on that printer.
Protocol fixtures cover those operations but do not qualify hardware. Firmware
reports 218.88 x 128.88 x 220 mm, while the native target/export uses
211.68 x 118.37 x 220 mm. That geometry conflict remains unresolved; see
[SDCP integration](SDCP-INTEGRATION.md#observed-geometry-discrepancy).

## Validation and production readiness

Local checks cover ticket eligibility/metadata, bounded model downloads,
credential protection, receipt deduplication/restart recovery, production paging,
actual private portal server transactions, durable outbox replay/conflicts,
source/output identity, provider failures, profile constraints, cancellation and
resin/filament separation. Browser and Windows development-desktop checks cover
the local workflows. Hardware tests use fixtures except for the separately
recorded native slice exports and read-only printer observations.

Use the linked engine and SDCP guides for reproducible checks and evidence.
Successful software tests, clean issue reports and a confirmed portal receipt
remain distinct from physical qualification, printing, post-processing, QC and
customer delivery. Live portal deployment/token setup and qualification of the
specific printer/firmware/resin/profile combination are still required.
