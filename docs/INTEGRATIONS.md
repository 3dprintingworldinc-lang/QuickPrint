# Inputs and website integrations

All inputs create jobs in **Review**. Importing a file never authorizes starting a printer. Supported intake extensions are `.stl`, `.step`, `.stp`, `.obj`, `.3mf`, `.gcode` and `.gco`. A model still needs preparation with a compatible slicer. Binary G-code and native proprietary CAD formats are not supported.

Input source identities prevent repeated delivery from creating duplicate orders. Identical file contents can still be valid separate orders: a different website order ID, email UID or folder file/version creates a separate submission.

## Watched PC or network folders

In **Inputs**, add a folder, select its absolute path and enable it. Optional defaults provide customer, quantity and notes. A network share must already be mounted/reachable with the permissions of the Windows account running QuickPrint.

- Only top-level regular files are imported; subfolders and symbolic links are not followed.
- A file must remain unchanged for the configured settling interval, two seconds by default. Partial download extensions and dotfiles are ignored.
- Files are checked again while/after reading. A changing file waits for a later poll.
- Original files are never deleted or moved. Unsupported, empty or oversized files produce a diagnostic.
- The maximum file size is 100 MiB. Rejected/imported candidates are processed in bounded batches.
- A modified file at the same path is treated as a new submission once stable. A second filename containing the same model is also a distinct submission.

For a producing application, finish writing a temporary file before renaming it to its final supported extension. Checkpoints persist across restarts. Temporary disk/share failures use retry backoff; the app must remain running to poll.

## Email attachments

Add an email connector with an IMAP host, username, password or app password, and mailbox name. The default is TLS on port `993`, mailbox `INBOX`, with a 60-second poll interval. An explicitly configured non-implicit-TLS connection requires a successful STARTTLS upgrade before authentication. TLS verification stays enabled.

Use a dedicated mailbox/folder for print requests. **The first connection processes existing messages, including already-read messages**, followed by newly arriving mail. It is not an unread-only inbox watcher. Each poll handles at most 25 messages.

Only supported file attachments become jobs. Email subject is used as the submission label, and the sender supplies customer text unless a default customer is configured. Message bodies, inline web links and cloud-storage links are not imported as files. A message with multiple supported attachments creates one job per attachment under the same submission.

Mail is opened read-only. QuickPrint does not mark messages read, move/delete them, or send replies. IMAP UID and UIDVALIDITY checkpoints identify processed messages; retries after a failed job submission leave the checkpoint behind that message. A server reset that changes UIDVALIDITY represents a new mailbox identity and may cause existing messages to be imported again.

Messages are limited to 140 MiB; individual attachments to 100 MiB. Unsupported, empty or oversized attachments are skipped with a diagnostic. More than 50 supported attachments in one message pauses import: split that request into smaller messages and move the original out of the watched mailbox. A malformed message can also require operator attention before import continues.

This release supports password/app-password IMAP authentication. It does not include OAuth authorization, Exchange Graph, POP3 or outbound email. Providers that prohibit password IMAP need a separately configured delivery/forwarding account or another input path.

## Website order API

Enable website/LAN intake in **Settings** and obtain its URL and token through the authenticated local UI. Its default port is `9732`. The listener binds to IPv4 interfaces only when enabled; the desktop administration API remains on `127.0.0.1` with a separate per-process token.

Send requests from your website backend or a trusted delivery service, not from public browser JavaScript. Keep the token in server-side secret configuration. QuickPrint does not provide a hosted website, shopping cart, public tunnel, TLS reverse proxy or remote-delivery agent.

The caller needs a route to the QuickPrint PC. For a public website, arrange one of these outside QuickPrint:

- A private VPN route from the website backend to the PC.
- An authenticated HTTPS reverse proxy forwarding only the intake endpoint, with its PC-facing connection kept on a trusted local/VPN network.
- An externally implemented outbound bridge on the PC that retrieves queued website orders over HTTPS and posts them to local intake.

The built-in intake endpoint uses HTTP. Do not expose raw HTTP intake or the desktop administration endpoint as a public website integration. Configure the relevant Windows firewall/network rule for the intended private route. Enabling intake alone does not create Internet connectivity.

### Request

`POST /api/intake` accepts `multipart/form-data`:

| Field/header | Required | Meaning |
| --- | --- | --- |
| `Authorization: Bearer <token>` | Yes | Current website intake token |
| `Idempotency-Key` header or `sourceId` field | Yes | Stable unique delivery/order identifier; the header takes precedence |
| `files` | Yes | Repeated file parts; up to 10 files per HTTP request |
| `quantity` | No | Whole-number file-copy quantity, default `1`, applied to each file |
| `name` | No | Submission/job label |
| `customer` | No | Customer reference or display text |
| `notes` | No | Print requirements for operator review |

Each file must be nonempty and at most 100 MiB. The entire multipart request must be smaller than 110 MiB. A single quantity applies to all files in the request; use separate submissions for different quantities. Prefix order identities with the website/store name when multiple sources share the endpoint, for example `store-a:order-1042:v1`.

PowerShell example; `$env:QUICKPRINT_INTAKE_TOKEN` must already be populated from secure configuration:

```powershell
curl.exe --fail-with-body `
  --request POST "http://127.0.0.1:9732/api/intake" `
  --header "Authorization: Bearer $env:QUICKPRINT_INTAKE_TOKEN" `
  --header "Idempotency-Key: store-a:order-1042:v1" `
  --form "customer=Example customer" `
  --form "quantity=2" `
  --form "notes=Review orientation before printing" `
  --form "files=@C:\Orders\bracket.stl"
```

Use the same idempotency key when retrying a timed-out delivery. A new key means a new order even if file contents match. Reusing a key returns the original jobs; it does not update them. An order revision needing new jobs should have a distinct revision key.

### Response and errors

New submission: HTTP `201`. A repeated identity: HTTP `200` with `duplicate: true`.

```json
{
  "duplicate": false,
  "jobs": [
    { "id": "generated-job-id", "status": "review", "fileName": "bracket.stl" }
  ]
}
```

Errors have `{ "error": "CODE", "message": "Explanation" }`. Common statuses are `400` for invalid input/missing identity, `401` for a missing/incorrect token and `413` for upload limits. Retry transient connection/server failures with the same key; correct a validation error before retrying. The intake endpoint provides no job-status lookup, admin access or outbound completion webhook in this version.

Authenticated `GET /api/health` is available on the intake listener. Rotating the intake token through the local UI takes effect immediately; update callers' secret configuration. Rotation does not discard existing job identities.

## Local application API

The desktop serves its own administration UI on a random loopback port. Browser development mode uses `http://127.0.0.1:9731` by default. Its UI receives a per-process bearer token; this is separate from the persistent website intake token. Printer/mailbox secrets are redacted from ordinary state responses.

The local API includes job upload/preparation/dispatch/control/reconciliation, printer configuration/status tests, input configuration/manual polling, settings, original-file download and ZIP backup. Physical start requires an explicit `confirmed: true` request after review. These endpoints are intended for the local application, and the LAN intake listener does not expose them.
