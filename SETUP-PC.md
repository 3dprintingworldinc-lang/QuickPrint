# Set up QuickPrint on a Windows PC

Copy the prompt below into Codex running **on the destination Windows PC**, with local file and command access. This setup is for Windows 10/11 x64. The release is unsigned; Windows startup and printer behavior must be verified on that PC.

---

Install and configure QuickPrint v0.1.0 on this Windows PC. Installation, creating its input folder, and ordinary setup are authorized. Continue independently; ask only for missing printer details or choices that cannot be inferred safely. Do not start a physical print without my explicit approval.

Use these release assets:

- Release: https://github.com/3dprintingworldinc-lang/QuickPrint/releases/tag/v0.1.0
- Installer: https://github.com/3dprintingworldinc-lang/QuickPrint/releases/download/v0.1.0/QuickPrint-Setup-0.1.0-x64.exe
- Checksums: https://github.com/3dprintingworldinc-lang/QuickPrint/releases/download/v0.1.0/SHA256SUMS.txt
- Expected installer SHA-256: `fab57d5f8fc146ad31d7b3216fa69ad685eb647bf815ff56337b2a384468a607`

First verify that you are executing locally on Windows 10/11 x64, not in a cloud/Linux workspace. Inspect existing QuickPrint and PS AM Print installations, processes and configuration. Preserve PS AM Print, existing jobs and `%APPDATA%\QuickPrint`. Never overwrite an existing profile or stop active work to complete setup. QuickPrint has its own bundled runtime and needs no Node.js, Python or PS AM Print installation.

Download the installer and checksum asset to a local staging folder. If GitHub requires authentication, use the already authenticated GitHub session or have me sign in securely. Do not request tokens in chat. Verify the installer with PowerShell `Get-FileHash -Algorithm SHA256`; it must match both the pinned hash above and its checksum entry. Stop installation on any mismatch. Install for the current Windows user and record the actual installed executable path. Do not disable SmartScreen, Defender, TLS verification or other Windows protections. If an OS policy blocks installation or launch, report the exact barrier and finish independent setup steps.

Before opening the normal profile, run the installed executable with `--smoke-test`, `--smoke-report=<absolute-report-path>` and `--data-dir=<absolute-temporary-data-directory>`. Create a fresh isolated directory and quote arguments containing spaces. Wait for exit, read the JSON report, and require exit code 0, `ok: true`, `platform: "win32"`, `arch: "x64"`, `packaged: true`, and `credentialRoundTrip: "passed"`. Retain the report. Then launch normally without temporary-data or smoke arguments; normal data belongs in `%APPDATA%\QuickPrint`.

Configure supplied printer endpoints and perform read-only connection/status tests. Supported connections are OctoPrint, Klipper/Moonraker, standalone Duet RepRapFirmware, and Bambu X1/X1C/X1E/P1P/P1S. Bambu support requires single-plate, single-filament external-spool files, encrypted LAN connectivity and verified certificate trust; AMS, dual-nozzle and other models are unsupported. There is no automatic fleet discovery. Obtain missing endpoint/model details from me. Enter API keys, access codes and passwords through secure local UI; never print credentials in logs or chat.

For CAD preparation, locate an installed compatible OrcaSlicer, Bambu Studio or PrusaSlicer and configure the correct per-printer nozzle/material profiles. Orca/Bambu needs complete machine, process and filament JSON presets in that order; Prusa uses compatible INI profiles. Do not substitute generic presets. Prepared compatible print files need no slicer.

Create `%USERPROFILE%\QuickPrint Inbox` and add it as a watched input folder unless an existing configured folder should be retained. Verify ingestion with a clearly labelled harmless test file; leave it in Review. Configure email or website intake only if requested and the required details are available. Email initially imports existing attachments; use a dedicated mailbox. Website intake needs a private route or HTTPS proxy, not public raw HTTP.

Leave QuickPrint open on its normal profile. Report executable/data/input-folder paths, smoke results, connected printers, slicer readiness and any remaining setup or physical-printer validation. Do not claim a successful print from a status test.
