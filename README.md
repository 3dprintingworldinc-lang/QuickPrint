# QuickPrint

QuickPrint is a Windows desktop workspace for receiving print requests, preparing files, managing LAN printers, and recording accepted production. Website orders, email attachments, watched folders, and manual uploads feed the same job workflow.

**Windows downloads:** [Installer](https://github.com/3dprintingworldinc-lang/QuickPrint/releases/download/v0.2.0/QuickPrint-Setup-0.2.0-x64.exe) · [Portable executable](https://github.com/3dprintingworldinc-lang/QuickPrint/releases/download/v0.2.0/QuickPrint-Portable-0.2.0-x64.exe) · [Release and checksums](https://github.com/3dprintingworldinc-lang/QuickPrint/releases/tag/v0.2.0)

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
| Simulation | Interactive 3D farm, configurable virtual printers and workloads, routing rules, manual/automatic/shared-robot clearing, seeded failures and scenario import/export |

Printer support depends on the available protocol and firmware. A printer being reachable on the LAN is not enough. The [connection requirements](docs/INSTALLATION.md#printer-connections) describe model, API, certificate and file-format restrictions. Protocol fixtures and application tests do not establish physical qualification of every listed printer or firmware.

Quantities count repetitions of a file. If a prepared plate contains six parts and quantity is three, QuickPrint tracks three runs of that plate. It does not count or individually inspect the six parts. Each run needs a separate confirmed start; this version does not automatically run the remaining quantity.

QuickPrint preserves PS AM Print's separation of intake, preparation, dispatch and production reconciliation. It implements these stages in a self-contained Node service. This is not a complete copy of PS AM's factory-specific deployment, automation or manufacturing policies. [Architecture and reuse](docs/ARCHITECTURE.md) describes the boundary and source provenance.

## Virtual print farm

Version 0.2 adds a **Simulation** tab in the Windows installer, portable executable and development app. Start with a farm template, arrange equipment in 3D, configure printer capabilities and clearing cycles, then run test jobs with accelerated time. Routing explanations, seeded failures and an event log help compare different setups.

Virtual equipment, jobs and routing rules stay separate from production dispatch. No printer connection is needed, and simulation actions never operate physical clearing hardware. Print times and failure rates are scenario inputs; the scene does not model physical collisions or robot travel. See the [simulation guide](docs/SIMULATION.md) for controls, routing behavior and result interpretation.

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
