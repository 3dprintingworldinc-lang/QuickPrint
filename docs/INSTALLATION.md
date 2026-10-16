# Installation and operation

## Windows packages

QuickPrint targets Windows 10/11 x64. Choose one of the build's artifacts:

- `QuickPrint-Setup-<version>-x64.exe`: installation wizard with a selectable destination and desktop/Start-menu shortcuts.
- `QuickPrint-Portable-<version>-x64.exe`: starts without installing the application. Its data still lives in the Windows user's QuickPrint data folder; it is not automatically stored beside the executable.

Both include the application runtime. A separate Node.js, Python, database server or PS AM Print installation is unnecessary. A slicer is required only to prepare model files.

Compare the downloaded file's SHA-256 with the supplied `SHA256SUMS.txt`. In PowerShell:

```powershell
Get-FileHash .\QuickPrint-Setup-<version>-x64.exe -Algorithm SHA256
```

Builds without a publisher signing certificate can show an unrecognized-publisher prompt. Checksums establish that a download matches the supplied build; they do not replace publisher signing. Use artifacts from your trusted project distribution.

## First setup

1. Start QuickPrint and open **Printers**. Add one connection using the table below, then test it.
2. In **Settings**, configure a slicer only if you want QuickPrint to prepare models. Choose its executable and compatible exported profiles.
3. Submit one known file using **New job**, or configure a folder/email input under **Inputs**.
4. Choose the target printer, prepare the job, and review its material, nozzle, plate, geometry and toolpath using the appropriate slicer/printer tools.
5. Check that the physical printer is ready and explicitly start one run. Monitor it, then record the actual outcome and accepted file-copy quantity.

QuickPrint must remain open for inputs, printer polling and queue management to run. Closing it does not reliably stop an already-running physical print. After restart, interrupted or uncertain runs require review before further dispatch.

## Printer connections

Add printers by their configured endpoint; automatic fleet discovery is not included. All four adapters implement status, upload, start, pause, resume and cancel where the selected firmware/API accepts those operations. QuickPrint only controls a run when current telemetry identifies that run.

| Connection | Required configuration | Restrictions |
| --- | --- | --- |
| OctoPrint | OctoPrint host, port and application API key with file/job/printer permissions | The physical printer must be connected and operational in OctoPrint. Uses plain G-code. REST idle/100% status alone cannot prove success; operator reconciliation is required. |
| Klipper / Moonraker | Moonraker host, usually port `7125`; API key when authentication is enabled | Connect to Moonraker itself, not only a Mainsail/Fluidd web page. Requires configured `virtual_sdcard` and `pause_resume`. Uses plain G-code. |
| Bambu LAN | Model, host, serial, LAN access code, and trusted device CA certificate or SHA-256 certificate fingerprint | Single-nozzle, single-plate, single-filament `.gcode.3mf`; external spool only. LAN/Developer mode as required by firmware; MQTT `8883`, implicit FTPS `990` with encrypted data transfers. See below. |
| Duet / RepRapFirmware | Standalone RepRapFirmware HTTP endpoint, printer password if configured, and SD storage | Supports modern object-model status and a legacy status fallback. Duet Software Framework SBC mode uses a different API and is unsupported. Uses plain G-code; idle status requires operator reconciliation. |

Bambu's configured single-nozzle protocol targets are **X1, X1C, X1E, P1P and P1S**. This list is an implementation allowlist, not a claim of physical testing on every device. Validate the exact model/firmware before relying on it. Other Bambu models, dual-nozzle routing and AMS selection are not implemented. Firmware requiring unencrypted FTP data is unsupported; QuickPrint does not downgrade the transfer.

For HTTPS printer endpoints, normal certificate validation remains enabled. A private device certificate requires an explicitly trusted CA or verified SHA-256 fingerprint. Obtain trust information through an independent trusted device/admin channel, then enter it in printer settings. A changed fingerprint requires investigation and an intentional settings update. Mailbox connections use system certificate trust rather than printer-specific pins.

## Slicer setup

Install OrcaSlicer, Bambu Studio or PrusaSlicer separately on the same PC and select its executable in **Settings**. For Orca/Bambu, supply complete exported presets in this order: **machine, process, filament**. For Prusa, supply compatible exported INI configuration files. Use profiles for the actual printer, nozzle and material.

Settings provides the default slicer configuration. Each printer can override the slicer executable and profiles in its own connection settings, so a mixed fleet can keep separate presets for each machine. Changing a printer's configuration invalidates its prepared jobs and requires preparation again. STEP import depends on Orca/Bambu build support; Prusa users should convert STEP to STL first. The separate PS AM STEP orientation engine is not bundled.

Already-prepared files need no installed slicer. Bambu needs a compatible single-plate `.gcode.3mf`; the other adapters use compatible plain G-code. Preparing an imported file does not prove its physical setup is correct. See [SLICING.md](SLICING.md) for the complete preparation behavior.

## Runs, quantities and recovery

Each submitted file becomes a job. Quantity is the number of **file-copies**, not the number of individual parts inside a file or prepared plate. One confirmed dispatch prints one file-copy.

The normal flow is review → preparation → ready → confirmed start → printing → outcome review. Completion reported by the printer does not automatically accept the result. In outcome review, record completed, failed, cancelled or not started. A completed run may contribute zero or one accepted file-copy. Other outcomes contribute zero. Add notes when recording a failure or uncertain result.

After accepting a completed run, the job becomes completed when its requested quantity is satisfied; otherwise it returns to ready for another explicitly confirmed run. Cancelling marks the job cancelled. QuickPrint preserves run history and records remaining quantity.

A lost start response, application restart during an active run, unidentified printer activity or uncertain completion can place a job in **Needs attention**. Check the printer before reconciling it. A timeout is not evidence that printing never started. QuickPrint saves dispatch intent before issuing a start and does not automatically resend an ambiguous start.

## Data, credentials and backups

Desktop data defaults to `%APPDATA%\QuickPrint`. It includes configuration, job history, original and prepared files, input checkpoints and application data. Windows credentials use Electron's Windows account encryption (DPAPI). Uninstalling the application does not delete this data folder.

Use **Open data folder** in Settings to locate it. For a full consistent backup, stop new intake, finish or deliberately hold active work, quit QuickPrint, and copy the complete folder to a private backup location. Back up input checkpoints with job history; they identify messages/files already imported.

The application also provides an authenticated ZIP backup download for an idle workspace up to 512 MiB. Disable incoming connectors/website intake before exporting so new orders do not arrive while files are being copied. For larger profiles, quit and copy the folder.

To restore on the same Windows account/machine, quit QuickPrint, preserve the current folder, then restore the complete backup to the configured data directory. Confirm printer conditions and review uncertain runs before starting further work. Do not delete a service lock unless you have verified that no QuickPrint instance uses the folder.

DPAPI credentials are not portable to another Windows account or PC. A copied encrypted profile may refuse startup there. Set up a fresh profile and re-enter printer/mailbox credentials for the new account; keep the original backup intact. Automated cross-account history/credential migration is not included in this version. The portable executable does not change this credential binding.

## Connection troubleshooting

| Symptom | Check |
| --- | --- |
| Printer stays offline | Correct host/port/API endpoint, Windows/LAN reachability, printer mode, credentials and certificate trust. A successful status test does not start a print. |
| Model cannot prepare | Slicer executable path, exported profile order, selected printer family, model format and slicer error. Prepared output is never fabricated when slicing fails. |
| Email import errors | IMAP enabled for the account, app password/provider policy, correct dedicated mailbox and valid TLS certificate. OAuth-only accounts are not supported. |
| Folder appears inactive | Absolute accessible path, top-level supported files, completed file writes, and read/storage permissions. Network drives must be available to the Windows account running QuickPrint. |
| Website intake cannot listen | Intake enabled, free configured port, firewall/network route and correct intake token. Administration stays on localhost. |
| Job needs attention | Inspect the physical printer and run history, then reconcile the actual outcome. Do not assume a failed HTTP/MQTT response means no print began. |

## Developer validation

Run `npm ci`, `npm test` and `npm run test:ui` from the checkout. Playwright needs its Chromium installation. `npm run smoke:desktop` checks the desktop window, bridge and authenticated local API, then exits. `npm run build:win` creates Windows x64 installer/portable artifacts and checksum manifests without publication. `.github/workflows/windows-build.yml` defines the Windows packaged startup and DPAPI round-trip check.

Review actual command/workflow results for each build. Mock protocol tests verify request and recovery behavior; they do not replace validation with the destination printer, slicer version, mailbox and network.
