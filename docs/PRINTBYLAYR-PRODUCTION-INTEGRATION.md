# PrintByLayr production API source and tests

QuickPrint's `production` connector targets the scoped `/api/production`
integration in the private `3dprintingworldinc-lang/printbylayr` repository. The
reviewable source is [draft PR #15](https://github.com/3dprintingworldinc-lang/printbylayr/pull/15).
The pushed portal branch is
`codex/quickprint-production-api`, commit
`58e72102f7149362d191cf7b6478e6e06278f5b1`, based on main commit
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
git -C <private-checkout> switch --detach 58e72102f7149362d191cf7b6478e6e06278f5b1
git -C <private-checkout> diff --check
$env:QUICKPRINT_PORTAL_SOURCE = '<absolute-private-checkout>'
node --test tests/layr-production-client.test.js
```

Verify the checked-out SHA with `git -C <private-checkout> rev-parse HEAD` and
review the private PR before running it. No production secret is needed for these
tests: SQLite, model storage and notification paths use local test fixtures.

Without a materialized private source, the production-client suite clearly
skips its actual-server tests and continues running its standalone transport
contract tests. With `QUICKPRINT_PORTAL_SOURCE`, or the default local
`integrations/printbylayr` checkout, those tests run the actual server handlers,
D1 SQL transactions and private model download path. The standalone tests
always cover allowed actions, fingerprints, credentials, bounded downloads,
unchanged retry bodies, lost-response ambiguity and receipt reconciliation.

The private portal branch's `docs/PRODUCTION-API.md` contains the complete request
and response contract, migration, dedicated token setup, qualification bindings and
deployment review steps. Qualified engine/profile/printer/material bindings
must be configured by the studio after physical validation. Capturing a slice
or a clean software-analysis report does not establish that qualification.

Slice-receipt metadata accepts artifacts up to 512 MiB, including the locally
validated 218,451,945-byte native GOO export. This stores only hashes and size
evidence; raw-model limits remain 100 MiB in QuickPrint and 200 MiB at intake.
