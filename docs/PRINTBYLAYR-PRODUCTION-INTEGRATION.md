# PrintByLayr production API source and tests

QuickPrint's `production` connector targets the scoped `/api/production`
integration in the private `3dprintingworldinc-lang/printbylayr` repository. The
reviewable source is [draft PR #15](https://github.com/3dprintingworldinc-lang/printbylayr/pull/15).
The pushed portal branch is
`codex/quickprint-production-api`, commit
`e5c06d4d43fe2fec394451b42c656acb9e0194dd`, based on main commit
`492e67198c4dc7f4161887877711456a4aed31cc`.

No portal migration or production deployment has been performed. The private
portal checkout and local patch remain ignored workstation evidence under
`integrations/`; they are not distributed with QuickPrint. Do not add the nested
repository as a gitlink or copy private portal source into a public repository.

To run the actual-server contract tests, authenticate Git with the private portal
repository and materialize the reviewed commit in a separate private directory:

```powershell
git clone https://github.com/3dprintingworldinc-lang/printbylayr.git <private-checkout>
git -C <private-checkout> fetch origin codex/quickprint-production-api
git -C <private-checkout> switch --detach e5c06d4d43fe2fec394451b42c656acb9e0194dd
git -C <private-checkout> diff --check
$env:QUICKPRINT_PORTAL_SOURCE = '<absolute-private-checkout>'
node --test tests/layr-production-client.test.js tests/layr-production-flow.test.js tests/layr-cad-intake-flow.test.js tests/layr-plate-production-flow.test.js
```

Verify the checked-out SHA with `git -C <private-checkout> rev-parse HEAD` and
review the private PR before running it. No production secret is needed for these
tests: SQLite, model storage and notification paths use local test fixtures.
The v2 run/quantity contract adds `0006_production_quantities.sql` after
`0005_production.sql`; the actual-server test fixtures apply both locally.
Deployment requires reviewed application of both migrations in the target
environment, not only updating the server code.

The same reviewed commit adds preparation withdrawal and explicit studio QC
replacement targets. These use the existing production tables and immutable
operation ledger; they add no migration beyond 0005 and 0006. Each replacement
cycle has its own bounded print allowance and progress, with lifetime totals
kept separately. See [the production workflow](RESIN-PRODUCTION.md).

Customer resin intake accepts STL, OBJ, STEP and STP. CAD uploads receive an
explicit conversion-review message and remain eligible for the studio's manual
quote workflow. Actual intake-to-payment tests cover STEP/STP with declared
mm/in/m units, original model downloads and unqualified preparation receipts.
Both portal clients preserve these source formats and their receipt hashes
during import. Local measurement and slicing support STL and triangulated
OBJ; STEP/STP use the separately verified [CAD transfer and tessellation
workflow](RESIN-CAD.md). Intake itself preserves the original geometry for review.

Without a materialized private source, the production-client suite clearly
skips its actual-server tests and continues running its standalone transport
contract tests. With `QUICKPRINT_PORTAL_SOURCE`, or the default local
`integrations/printbylayr` checkout, those tests run the actual server handlers,
D1 SQL transactions and private model download path. The standalone tests
always cover allowed actions, fingerprints, credentials, bounded downloads,
unchanged retry bodies, lost-response ambiguity and receipt reconciliation.
The plate flow also exercises 20 units as 6 + 6 + 6 + 2 against these actual
handlers. A confirmed smaller remainder reopens preparation for a new plate and
receipt; it cannot reuse the larger artifact or grant QC acceptance.

The private portal branch's `docs/PRODUCTION-API.md` contains the complete request
and response contract, migration, dedicated token setup, qualification bindings and
deployment review steps. Qualified engine/profile/printer/material bindings
must be configured by the studio after physical validation. Capturing a slice
or a clean software-analysis report does not establish that qualification.

Slice-receipt metadata accepts artifacts up to 512 MiB, including the locally
validated 218,451,945-byte native GOO export. This stores only hashes and size
evidence; raw-model limits remain 100 MiB in QuickPrint and 200 MiB at intake.
