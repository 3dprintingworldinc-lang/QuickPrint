# Printer adapters

`createAdapter(printer)` constructs one explicitly registered adapter. Instances
provide `status`, `upload`, `start`, `pause`, `resume`, `cancel`, and optional
`close`. Upload never starts a print. Core persists a run intent before calling
start and does not retry an uncertain start.

| Adapter | Prerequisites | Prepared format |
| --- | --- | --- |
| OctoPrint | Connected printer; OctoPrint HTTP(S) endpoint and API key with printer, file and job permissions | `.gcode`, `.gco`, `.g` |
| Moonraker | Klipper + Moonraker endpoint, usually port 7125; virtual_sdcard and pause_resume; API key if enabled | `.gcode` |
| Bambu | LAN/Developer mode as required by firmware; serial, LAN access code, supported model, trusted certificate; MQTT 8883 and implicit FTPS 990 | Single-plate, single-filament `.gcode.3mf`, external spool |
| Duet | Standalone RepRapFirmware HTTP API and printer password if configured; SD storage | `.gcode`, `.gco`, `.g` |

Duet Software Framework SBC mode has a different API and is not supported by the
standalone adapter. HTTP endpoints may include a reverse-proxy base path. HTTP
redirects are rejected before credentials could be forwarded. HTTPS uses normal
certificate validation; a custom CA certificate or explicit SHA-256 certificate
fingerprint can establish trust for a local device.

## Bambu trust and scope

No credential-bearing connection is made without an explicit CA or fingerprint.
For a self-signed certificate, obtain the SHA-256 fingerprint through an
independently trusted device/network connection. The fingerprint covers the DER
certificate, not its public key. A certificate change requires operator review
and updating the printer setting. Do not approve an unexplained mismatch.

When only a fingerprint is configured, a TLS-only bootstrap connection reads the
certificate, compares its SHA-256 digest, and sends no application bytes. The
verified certificate becomes the trust anchor for actual MQTT/FTPS connections;
those connections retain `rejectUnauthorized: true` and verify the pin again.
The FTP data channel is encrypted and uses the same trust settings and TLS
session reuse. There is no plaintext-data fallback. Firmware that requires such
a fallback is outside this adapter's support.

The model selections are X1, X1C, X1E, P1P, and P1S.
These are protocol targets, not a claim of physical-device validation.
Firmware permissions and encrypted FTP compatibility vary. H2D/H2C/X2D require
additional nozzle-routing metadata and are deliberately rejected. AMS routing
is not implemented. The operator must load the intended external spool and use
a compatible single-filament profile. The prepared archive must contain the
first plate (`Metadata/plate_1.gcode`). Slicing validates artifacts before they
reach the adapter.

The MQTT broker's PUBACK confirms transport only. A start succeeds only when
the report topic acknowledges its sequence or matching active-job telemetry
arrives. A timeout does not imply the printer stayed idle. The command is never
automatically replayed. Device `subtask_id` is returned as `remoteId` for later
reconciliation; generic internal plate paths are not reliable identities.
`deriveRemoteId(runId)` maps the core's persisted UUID to a stable nonzero signed
32-bit firmware identity. The core records it before starting, so a lost start
acknowledgment does not erase the identity needed for later telemetry.

## Telemetry and verification

`outcome` is present only for explicit terminal source evidence. Moonraker exposes
complete/cancelled/error; Bambu exposes FINISH/FAILED (FAILED also covers some
stops). OctoPrint and Duet polling cannot reliably distinguish success from a
cancelled run after returning idle, so they require operator reconciliation.
Progress is omitted when the source does not report it. The core always requires
operator acceptance before crediting a completed copy.

Run `node --test tests/adapters*.test.js`. Tests use local HTTP, TLS MQTT and FTPS
servers. TLS tests generate a temporary self-signed certificate with the
development machine's `openssl` command; OpenSSL is not an application runtime
dependency. No test contacts a physical printer.

Wire-format research used the supplied PS AM source snapshot's
`print-server-source/backend/app/services/bambu_mqtt.py` (start_print,
pause_print, resume_print, stop_print) and `bambu_ftp.py` (ImplicitFTP_TLS), plus
the OctoPrint, Moonraker and RepRapFirmware API contracts. Implementations here
are independent JavaScript code. PS AM's disabled certificate verification and
model-specific plaintext FTP fallback were not imported.

New adapter modules must be added to the explicit registry in `index.js` and
include protocol tests for request shape, rejected commands, timeouts, file
identity, and telemetry. Credentials must stay on the configured endpoint.
