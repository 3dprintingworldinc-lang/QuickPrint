# SDCP v3 integration

QuickPrint implements the published CBDtech SDCP v3 WebSocket control and HTTP file-transfer contracts. The observed target is an ELEGOO Saturn 4 Ultra 16K running firmware `V1.5.6`, advertising protocol `V3.0.0`. This is an independent implementation of the public protocol, not a replacement firmware or a SatelLite binary patch.

**Qualification is pending.** Read-only discovery, attributes and printing telemetry have been observed on the actual printer. The actual `SDCPAdapter.attributes()` and `status()` methods subsequently succeeded against that same Saturn 4 Ultra 16K running `V1.5.6`, validating the implementation's strict acknowledgement/report correlations with real firmware. The printer was actively printing, reported `15120x6230`, and supplied both task and file identities. Upload, remote start, pause, resume and stop have been tested against loopback fixtures only. No physical print, image scale, orientation, exposure or motion profile has been qualified through this adapter. A passing wire-protocol fixture does not establish that a resin artifact is safe or dimensionally correct for a physical printer.

The primary contract is [CBDtech's English SDCP v3 specification](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0/blob/main/SDCP%28Smart%20Device%20Control%20Protocol%29_V3.0.0_EN.md), specifically Connecting Device, Topic, Attribute Information, Status Information, commands 0/1/128–131, and Mainboard HTTP Server Interface Definition. The implementation sends only fields defined there. It does not guess at cloud endpoints, undocumented calibration commands, remote shell access, video transport, file deletion or a slicer command-line interface.

## Configuration and identity

`SDCPAdapter` accepts the same printer object as the other adapters, with these fields:

| Field | Meaning |
| --- | --- |
| `host` | Explicit printer hostname/IP or plain HTTP origin; no credentials or base path |
| `port` | SDCP port; defaults to 3030 |
| `mainboardId` | Exact 16-character hexadecimal `Data.MainboardID` from discovery |
| `brandId` | Exact top-level discovery `Id`; this is separate from the mainboard ID |
| `timeoutMs` | Connection, acknowledgement and fresh-report deadline, bounded to 100–30,000 ms; default 10,000 ms |
| `uploadTimeoutMs` | Whole HTTP packet-transfer deadline, bounded to 100–120,000 ms; default 120,000 ms |

Connections use `ws://<configured-address>:3030/websocket`; uploads use the same configured origin. Addresses are never replaced with an IP or URL received inside telemetry. The public contract documents plain LAN HTTP/WebSocket, so this adapter rejects TLS URLs rather than inventing a device TLS interface. SDCP does not provide an authentication secret in this contract; a matching ID is a routing and correlation check, not cryptographic authentication.

Automatic discovery is disabled. The adapter sends no UDP broadcast and does not scan the network. An operator can provision the IDs from a prior discovery record. A future discovery flow may explicitly target a known unicast address, but is not required for this implementation.

Every outgoing command carries a fresh 32-hex-character `RequestID`, the configured `Id`, mainboard ID, command number, timestamp, `From: 0` and exact request topic. A response is accepted only when its brand ID, board ID, response topic, request ID and command all match the outstanding request, and its `Ack` is numeric zero. A WebSocket write completing is not an acknowledgement. Nonzero acknowledgements are explicit rejections; missing or malformed acknowledgements for print controls are uncertain results. Commands are never automatically retried.

## Adapter contract

| Method | Published operation and result |
| --- | --- |
| `status()` | Cmd 0 plus a fresh matching status report; normalized state, timestamp, task ID, filename, layers and progress |
| `attributes()` | Cmd 1 plus fresh attributes; original reported geometry/capabilities/formats plus observation time |
| `upload({filePath,fileName})` | Multipart packets to the documented HTTP endpoint; returns `remotePath`, local whole-file `md5`, `sizeBytes` and transfer UUID |
| `start({remotePath})` | Cmd 128 with `Filename` and `StartLayer: 0`; returns acknowledgement and newly observed printer task ID |
| `pause()` / `resume()` / `cancel()` | Cmd 129 / 131 / 130 respectively, with empty data and explicit Ack 0 |
| `close()` | Stops heartbeats, closes the socket and rejects pending work; no device stop command |

Status/attribute reads require both the matching acknowledgement and a report received after the refresh began. Cached telemetry cannot satisfy a refresh. Status interpretation uses the top-level machine state: a retained completed sub-status alone never turns an active print into a completed run. Idle and 100% progress alone are not proof of completion. Terminal outcomes require explicit completed/stopped/error evidence together with a nonempty `TaskId` and `Filename`. The service must match that task ID and filename to the durable QuickPrint run before accepting the result; a terminal report may describe an earlier print.

Starting requires fresh idle status and advertised `PRINT_CONTROL` plus the artifact's advertised file format. Ack 0 is followed by a wait for active telemetry identifying the exact filename and a task ID different from the pre-start task ID. A missing new task, a different file, a disconnect or a lost acknowledgement produces an uncertainty error without a resend. The client must reconcile with the printer before another start. Controls require fresh active-print identity and suitable state; acknowledgements mean the request was accepted, while subsequent telemetry establishes the resulting state. The service retains ownership checks to avoid controlling a print started outside QuickPrint.

## Transfer behavior

The upload interface is `POST /uploadFile/upload` with `multipart/form-data`. A transfer uses one UUID, the full file's MD5, verification enabled, byte offsets and the same total size on every request. The form fields are exactly `S-File-MD5`, `Check`, `Offset`, `Uuid`, `TotalSize` and binary `File`. The original filename is the file part's filename parameter; `S-File-MD5` is a form field, not an invented HTTP authentication header.

Each packet contains at most 1 MiB of file data. Files must be nonempty and no larger than 512 MiB. Memory use is bounded to a packet and multipart overhead; the full file is not loaded into memory. A pinned file handle, metadata checks and a second digest over transmitted bytes detect artifact changes. Filenames must be unchanged ASCII `.goo` or `.ctb` basenames, at most 200 characters, without quotes, separators or control characters. The printer must advertise the corresponding format and `FILE_TRANSFER`, and be idle before transfer.

Packets are sent sequentially and require both `success: true` and `code: "000000"`. Redirects are refused. HTTP errors, malformed success envelopes, transfer-error notifications, socket loss, changed files and timeouts halt the transfer. There is no packet retry, offset guessing, automatic transfer termination, cleanup deletion or print start. A failed transfer can leave a partial remote file; inspect it before retrying. A final HTTP success is the documented packet acknowledgement with `Check: 1`; the specification does not define a separately correlated final checksum-completion event. QuickPrint does not claim a readback-verified remote checksum or hardware-qualified transfer from this acknowledgement.

## Conditional qualified resin runs

The adapter is connected to a separate qualified resin production path. Generic
resin preparation/dispatch remains rejected. The qualified path requires a
validated single-source-instance GOO, reviewed local profile bound to the local
SDCP printer UUID, confirmed device-bound portal receipt, explicit whole-model
one-order-unit declaration, approved portal plan and current studio binding.
Local `resinEngine.dispatchEnabled` defaults to false, and every physical run
requires a new readiness confirmation. See [production steps](RESIN-PRODUCTION.md).

`sdcp-identity.js` fingerprints configured board/brand IDs with reported
brand/machine, protocol, firmware, resolution and XYZ size. The studio binding
also identifies the exact profile/engine, material, printer label/UUID and GOO
format. Source, artifact, profile, configured-printer and device checks run before
upload. Fresh portal authorization is read again after upload; revocation,
changed files or a changed device can prevent start even when a file has already
been uploaded. A short-lived internal one-use permit cannot be supplied by an
HTTP client claiming `qualified: true`.

Each run durably records a new run ID and unique remote filename. Its
acknowledged start must identify that filename and a fresh SDCP task. Completion
must match the owned task and file before the operator can record one printed
unit. A zero-unit failed/stopped run provides no production credit. Printed unit
progress is synchronized through exact saved portal operations; remaining units
require separate starts and all requested printed units lead to post-processing,
not quality acceptance.

A lost/malformed printer start acknowledgement is held as an uncertain physical
result without a start retry, including after restart. A lost portal response
instead replays the same saved portal UUID/body/version without repeating the
hardware action. These software gates have been tested using injected adapters
and actual local portal handlers/SQLite. They do not change the pending hardware
qualification stated above.

## Observed geometry discrepancy

The observed firmware advertises `FILE_TRANSFER`, `PRINT_CONTROL` and `VIDEO_STREAM`, supports `CTB` and `GOO`, and reports `15120x6230` image resolution. Its `XYZsize` is `218.88x128.88x220` mm. The native/official target profile uses `211.68x118.37x220` mm. These values conflict and remain separate: the adapter returns the firmware value verbatim, while artifact qualification must use a reviewed target profile and a physical calibration result. Neither device capability advertisement nor a valid GOO container resolves this scale discrepancy. CTB advertisement also does not establish a CTB encoder or validated CTB artifact pipeline.

Private observed addresses, device IDs and raw reports, including the adapter read-only verification record, remain in ignored workspace evidence and are not embedded in source, tests or this document. The active real print was not uploaded to or controlled during this implementation.

## Verification

Run `node --test tests/adapters-sdcp.test.js`. All fixtures use synthetic identities and HTTP/WebSocket servers bound to `127.0.0.1`. Coverage includes request correlation, fresh reports, retained terminal states, new task identity, explicit rejection, malformed/lost acknowledgements, disconnect ambiguity, busy-device protection, capability/format checks, packet offsets/UUID/MD5/content, size and filename limits, partial transfer failure, redirects, transfer errors, timeouts and print-control command numbers. No test discovers or connects to a real printer.

`node --test tests/sdcp-service.test.js` verifies durable SDCP run ownership and operator sign-off in `QuickPrintService` using the legacy manual model-job path with injected adapter/slicer and fixture GOO metadata. The conditional resin path has dedicated checks in `tests/resin-dispatch.test.js` and `tests/layr-production-flow.test.js`, covering current qualification, local opt-in, permits, repeated one-unit starts, matched terminal evidence, explicit counts and exact portal replay. Private-portal cases explicitly skip if that source is absent; always-running transport cases remain. None qualifies physical hardware.
