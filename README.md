# QuickPrint

QuickPrint is a Windows desktop workspace for receiving print requests, preparing files, managing LAN printers, and recording accepted production. Website orders, email attachments, watched folders, and manual uploads feed the same job workflow.

**Windows downloads:** [Installer](https://github.com/3dprintingworldinc-lang/QuickPrint/releases/download/v0.1.0/QuickPrint-Setup-0.1.0-x64.exe) · [Portable executable](https://github.com/3dprintingworldinc-lang/QuickPrint/releases/download/v0.1.0/QuickPrint-Portable-0.1.0-x64.exe) · [Release and checksums](https://github.com/3dprintingworldinc-lang/QuickPrint/releases/tag/v0.1.0)

For help configuring a PC with Codex, use the [PC setup prompt](SETUP-PC.md).

The installer and portable executable include the Electron/Node runtime. End users do not need Node, Python, or a separate Bambuddy installation. Model slicing uses a separately installed compatible slicer; already-prepared printer files do not need one.

## Start using it

1. Download the Windows x64 **installer** (`QuickPrint-Setup-<version>-x64.exe`) or **portable executable** (`QuickPrint-Portable-<version>-x64.exe`) supplied with the build. Supported desktop targets are Windows 10 and 11 x64.
2. Launch QuickPrint, open **Printers**, add a supported connection, and test its status.
3. For model files, configure the installed slicer and exported profiles in **Settings**. For an existing printer-compatible G-code file, skip slicer setup.
4. Add a job or configure an input. Select its printer and prepare the file.
5. Review the prepared job and physical printer, then explicitly start one run. After printing, record its outcome and accepted quantity.

See [installation and operation](docs/INSTALLATION.md), [input integrations](docs/INTEGRATIONS.md), and [slicer configuration](docs/SLICING.md).

## What this version includes

| Area | Implemented behavior |
| --- | --- |
| Intake | Authenticated multipart website API, read-only IMAP attachment import, stable-file folder monitoring, manual uploads |
| Preparation | STEP/STP, STL, OBJ and model 3MF through a configured slicer; validation of prepared plain G-code and single-plate G-code 3MF |
| Fleet | OctoPrint, Klipper/Moonraker, Bambu LAN and standalone Duet/RepRapFirmware protocol adapters |
| Jobs | File originals, prepared-artifact hashes, printer binding, explicit starts, status polling, supported pause/resume/cancel controls |
| Production | Per-run history, uncertain-result holds, accepted file-copy quantities, operator reconciliation before another run |
| Desktop | Local administration, persistent data, Windows account-encrypted credentials, installer and portable build targets |

Printer support depends on the available protocol and firmware. A printer being reachable on the LAN is not enough. The [connection requirements](docs/INSTALLATION.md#printer-connections) describe model, API, certificate and file-format restrictions. Protocol fixtures and application tests do not establish physical qualification of every listed printer or firmware.

Generic job quantities count repetitions of a file. If a prepared plate contains six parts and quantity is three, QuickPrint tracks three runs of that plate. The separate qualified resin order flow binds an independently verified source-instance count to each plate and records printed order units after operator reconciliation. Each physical run needs a separate confirmed start; QuickPrint does not automatically start the remaining quantity.

QuickPrint preserves PS AM Print's separation of intake, preparation, dispatch and production reconciliation. It implements these stages in a self-contained Node service. This is not a complete copy of PS AM's factory-specific deployment, automation or manufacturing policies. [Architecture and reuse](docs/ARCHITECTURE.md) describes the boundary and source provenance.

## Resin automation work in this branch

QuickPrint imports paid preparation tickets through the scoped, paginated
PrintByLayr production API and preserves approved requirements, model hashes and
requested part counts. A durable outbox records validated slice receipts with
stable operation IDs and expected versions, supports automatic synchronization,
and retains conflicts for review. The legacy OAuth/MCP read connection remains
available with its newest-100-jobs limit.

The callable **PrusaSlicer SLA -> SL1 -> UVtools GOO** pipeline evaluates explicit
orientation candidates, validates every GOO layer and target parameter, and runs
six print-issue checks. Up to 32 named profile slots support separate resin settings;
customization saves validated profile/preset copies while preserving originals.
STL/triangulated OBJ measurement supports explicit uniform factors or one
source-axis target dimension, preserving original bytes and hashing the
normalized input. STEP/STP can first pass independent native transfer auditing,
per-solid FreeCAD tessellation and closed-mesh/CAD measurement checks. Embedded
CAD units convert to millimetres once; originals and conversion evidence stay bound.
Real local file preparation succeeded with PrusaSlicer 2.9.7 and UVtools 7.1.2.
SatelLite's evaluation/repair/hollowing CLI remains an experimental output probe.

Explicit multi-copy resin plates reserve the native single-copy support/pad
footprint, place copies on the printer pixel grid, and require every final GOO
layer to equal the declared translated grayscale copies with matching physical
parameters. The requested copy count is an upper bound; the captured result
reports the number that actually fits. A real synthetic 20-copy file passed
this proof and all six issue checks with supports/pad explicitly disabled.
The supported three-copy request fit two copies, passed their copy proof and
remained held on two islands. These file checks do not qualify physical output.

Captured resin slices stay unqualified and cannot enter generic printer dispatch.
The separate qualified resin flow requires current studio/device/profile
authorization, local dispatch opt-in (off by default), and a new readiness
confirmation for each approved plate run. Identified terminal telemetry and operator
printed counts update the portal's remaining quantity without granting QC credit.
When the remaining quantity is smaller than the approved plate, preparation
reopens for a smaller plate, fresh receipt and approval; for example, 20 units
can use confirmed runs of 6 + 6 + 6 + 2.
Queued preparation can be withdrawn for revision without resetting counts.
Studio QC can authorize a bounded replacement target with separate current and
lifetime production totals; it cannot turn printed counts into QC acceptance.
The actual Saturn 4 Ultra 16K SDCP adapter was verified for read-only status and
attributes; uploads, starts and physical output remain unqualified. Production
still requires the portal update/token, resolved sizing/support instructions,
printer/resin/profile calibration, post-processing and QC. The portal changes
are in [private draft PR #15](https://github.com/3dprintingworldinc-lang/printbylayr/pull/15)
and have not been deployed.

See [resin integration and remaining work](docs/RESIN-AUTOMATION.md), the
[qualified production steps](docs/RESIN-PRODUCTION.md),
[headless engine guide](docs/HEADLESS-RESIN-ENGINE.md),
[verified multi-copy plates](docs/RESIN-PLATES.md),
[model sizing](docs/RESIN-SIZING.md),
[STEP geometry preparation](docs/RESIN-CAD.md),
[SatelLite deconstruction](docs/SATELLITE-DECONSTRUCTION.md), and
[SDCP integration](docs/SDCP-INTEGRATION.md).

## Develop and build

Use Node.js 22 or newer and the repository lockfile:

```sh
npm ci
npm test
npm start
```

Additional commands:

```sh
npm run serve          # Browser development server at http://127.0.0.1:9731
npm run test:ui        # Playwright browser tests; install its browser first
npm run smoke:desktop # Start the desktop, check local API/renderer, then exit
npm run build:win     # Windows x64 installer and portable executable
npm run build:checksums
```

For Playwright, install its test browser with `npx playwright install chromium`. A desktop or suitable display session is required to run Electron. Windows builds are produced under `dist/`, with `SHA256SUMS.txt` and `release-manifest.json`. The build command does not publish releases.

The Windows GitHub Actions workflow builds both executables and runs a packaged startup/Windows credential-storage smoke check. A workflow definition is not a successful run; inspect the actual workflow result and generated report for a particular build. Physical printing, actual mailbox credentials and a production website connection require validation in the destination environment.

Development server data defaults to `./data`; desktop data defaults to `%APPDATA%\QuickPrint`. Set `QUICKPRINT_DATA_DIR` to an absolute path for an isolated development profile. Do not point development tests at a working print-farm profile or the existing PS AM installation.
