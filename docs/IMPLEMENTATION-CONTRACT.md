# Shared implementation contract

Use CommonJS and Node built-ins where practical. Runtime is bundled Electron; no Python service dependency is required to run the desktop app. Preserve PS AM's separation of intake, preparation, queue/dispatch, and production reconciliation. Source code may now be changed: the user explicitly authorized building the app. Do not touch the running PS AM installation or contact real printers during development.

## Ownership

- Root: `src/server.js`, integration, top-level docs and final verification.
- Core agent: `src/core/**`, `tests/core*.test.js`.
- Adapter agent: `src/adapters/**`, `tests/adapters*.test.js`.
- Connector agent: `src/connectors/**`, `tests/connectors*.test.js`.
- UI agent: `src/renderer/**` only.
- Desktop/build agent: `src/desktop/**`, `assets/**`, `scripts/build*`, Electron builder settings in package.json, Windows workflows.
- Slicing agent: `src/slicing/**`, `tests/slicing*.test.js`, `docs/SLICING.md`.

Coordinate any contract change with root. Do not independently change dependency manifests except desktop build keys/scripts; send root additional dependency needs.

## Core

Export `{ QuickPrintService }` from `src/core/service.js`. Constructor options `{ dataDir, adapters, slicer, seal, unseal }`; async `init()` and `close()`. Events via EventEmitter optional. Public methods:

- `snapshot()` => `{ jobs, printers, settings, events, connectors }` with credentials redacted. Native UI may request token through dedicated secured endpoint; never return printer/mailbox secrets.
- `submit({source,sourceId,name,customer,quantity,notes,files:[{name,data:Buffer,quantity?}]})` => `{ jobs, duplicate }`. One job per file; shared submissionId. Same source+sourceId returns existing jobs; content hash alone must not erase repeat orders.
- `getJob(id)`, `getPrinter(id)`; throw errors with `.status` (400/404/409).
- `savePrinter(config)` / `removePrinter(id)`; preserve existing secret when omitted/blank. Fields `{id,name,type,host,port?,apiKey?,password?,serial?,accessCode?,caCertificate?,tlsFingerprint?,model?,capabilities?}`.
- `testPrinter(id)` => normalized status; `refreshPrinters()` polls and reconciles own jobs only.
- `prepareJob(id,printerId)` uses slicer; binds artifact to printer/profile. `dispatchJob(id,printerId,{confirmed:true})` serializes printer/job, persists dispatch intent before network action, and never retries ambiguous start automatically.
- `controlJob(id,action)` supports pause/resume/cancel as capabilities allow; `reconcileJob(id,{outcome,acceptedQuantity,notes})` records operator resolution of unknown result/completion. Job quantity denotes copies; each confirmed run prints one copy. Remaining quantity is explicit, not silently completed after one run.
- `updateSettings(patch)` returns redacted settings; `getSettings({secrets:true})` internal access.
- `saveConnector(config)` / `removeConnector(id)` and `getConnectors({secrets:true})`; configs persisted, immutable stable IDs. Types folder/email. Connectors implementation owns validation except shape.
- `recordEvent({level,type,message,jobId?,printerId?})` for internal diagnostics, no secrets.

Settings `{siteName:'QuickPrint',slicer:{executable:'',kind:'orca',profilePaths:[],extraArgs:[]},intake:{enabled:false,port:9732,token:''},pollIntervalMs:10000}`. Keep data paths portable under provided dataDir. Use atomic persistence, schema version, crash recovery, in-process serialization. Do not add seeded fake production jobs/printers. Adapter simulator is test-only unless explicitly selected by developer env.

Job statuses: `review`, `preparing`, `ready`, `dispatching`, `printing`, `paused`, `needs_attention`, `completed`, `cancelled`, `failed`. Job fields: `id,submissionId,name,fileName,source,customer,quantity,completedQuantity,acceptedQuantity,status,createdAt,updatedAt,printerId?,artifact?,error?,history[]`. Printer public fields plus `status` normalized below. Provide errors and status hints useful in UI.

## Adapters

Export `createAdapter(printer)` and `adapterCatalog()` from `src/adapters/index.js`. Registry extensible in source, no automatic loading of untrusted JS. Types `octoprint`, `moonraker`, `bambu`, `duet` (as feasible).

Instance methods async `status()`, `upload({filePath,fileName})` => `{remotePath,...}`, `start({remotePath,jobId})` => `{acknowledged:boolean,remoteId?}`, `pause()`, `resume()`, `cancel()`, `close()` optional. `capabilities` property `{upload,start,pause,resume,cancel,formats:[...],discovery?:boolean}`. `status()` => `{state:'idle'|'printing'|'paused'|'offline'|'error'|'unknown',progress:0..100,currentFile?,message?,observedAt,temperature?}`.

HTTP API keys sent only to configured endpoint, redirects refused. Secure TLS by default; Bambu's device certificate must use explicit CA/fingerprint trust, no silent blanket verification disable. Bounded timeouts. Tests exercise real request schemas via local mock servers; never physical printer actions. Document supported models/protocol prerequisites honestly.

## Slicing

Export `{ prepare }` from `src/slicing/index.js`. `prepare({inputPath,outputDir,printer,settings,signal})` returns `{filePath,fileName,format,sha256,profileFingerprint,metadata}`. For ready G-code validate/copy; model files need configured compatible slicer/profiles. Spawn without shell; timeout and bounded logs. Inspect 3MF to distinguish models from sliced artifacts. Reject wrong-family outputs. Use actual PS AM reusable source where isolated, record provenance. Never silently treat CAD as printer-ready. No slicer binary means actionable setup, not fake success.

## Connectors

Export `{ ConnectorManager }` from `src/connectors/index.js`. Constructor `{service}`, async `start()`, `reload()`, `stop()`, `status()` returns safe runtime status; `pollNow(id)` optional. Config folder `{id,type:'folder',name,path,enabled,defaults:{quantity,customer,notes},settleMs}`. Config email `{id,type:'email',name,host,port:993,secure:true,username,password,mailbox:'INBOX',enabled,pollIntervalMs,defaults}`. Use stable file/message identities, complete-write detection, persistent checkpoints via connector `state` or manager file under service.dataDir. Internal core APIs above. No credentials in logs. Email reads/imports only; no sending messages. Handle retries/backoff and unknown files clearly.

## HTTP and UI

`startServer({dataDir,port:0,host:'127.0.0.1',token?,adapters?,seal?,unseal?})` exported from `src/server.js` returns `{server,port,url,service,close}`. It starts core + connectors; separate opt-in LAN intake server. Core UI API authenticated with per-process token inserted into served HTML meta `quickprint-token`; renderer sends `Authorization: Bearer TOKEN`. No remote pages in desktop window. JSON responses except upload; errors `{error,message}`.

Routes:
- `GET /api/state` returns snapshot plus `adapterCatalog`, `connectorStatus` and `version`.
- `POST /api/jobs` multipart `files` plus fields `name,customer,quantity,notes,sourceId`; returns `{jobs,duplicate}`.
- `POST /api/printers` JSON config; `DELETE /api/printers/:id`; `POST /api/printers/:id/test`.
- `POST /api/jobs/:id/prepare` `{printerId}`; `/dispatch` `{printerId,confirmed:true}`; `/control` `{action}`; `/reconcile` `{outcome,acceptedQuantity,notes}`.
- `PUT /api/settings` JSON partial settings.
- `POST /api/connectors` JSON config; `DELETE /api/connectors/:id`; `POST /api/connectors/:id/poll`.
- `GET /api/integration` returns LAN intake URL hints + token to authenticated local operator only; `POST /api/integration/rotate` rotates intake token.
- `GET /api/jobs/:id/file` download original; `GET /api/health` non-sensitive readiness.

External opt-in intake listens on configured port/host `0.0.0.0`; token-authenticated `POST /api/intake` multipart. Requires `Idempotency-Key` or `sourceId`; fields compatible with upload. External endpoint exposes no desktop administration. It is LAN HTTP; public website uses secure reverse proxy/VPN or outbound delivery bridge, not raw public HTTP. Explain in docs/UI.

UI pages: Overview, Jobs, Printers, Inputs, Settings. Useful empty states, add-printer modal, file upload, job details and explicit physical-start confirmation; active actions call real API. Dark navy/cream/teal visual design, clear hierarchy, responsive desktop, accessible labels. No fake data default. Poll state with errors shown. Optional native bridge `window.quickprint.selectFolder/selectFile/openDataFolder/version` via safe preload; browser testing must still work with manual paths.
