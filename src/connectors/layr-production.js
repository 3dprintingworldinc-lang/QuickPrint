'use strict';

// Production orchestration consumes core-owned physical evidence. Polling this
// module can synchronize receipts, but can never upload or start a printer.
const { verifyQueuedEvidence } = require('./layr-evidence');
const issuers = new WeakMap();
const fail = (message, code = 'LAYR_PRODUCTION_REVIEW_REQUIRED') => Object.assign(new Error(message), { status: 409, code });
const filename = value => String(value || '').replaceAll('\\', '/').split('/').pop();

function context(manager, id, { sliceRequired = true } = {}) {
  if (manager.stopping || !manager.started) throw fail('Production inputs are stopped.', 'LAYR_OUTBOX_STOPPED');
  const job = manager.service.getJob(id), slice = job.resinSlice;
  if (job.technology !== 'resin' || !job.order || (sliceRequired && (!slice?.analysis?.passed || slice.analysis.count !== 0 || slice.inspection?.validatedLayerData !== true || slice.sourceSha256 !== job.sha256))) throw fail('Select a structurally validated, issue-free resin slice.');
  const configs = manager.service.getConnectors({ secrets: true }).filter(value => value.type === 'layr' && value.apiMode === 'production' && value.enabled !== false && value.portalUrl === job.order.portalUrl);
  if (configs.length !== 1) throw fail('Configure one enabled machine API input for this order’s portal.', 'LAYR_PRODUCTION_INPUT_REQUIRED');
  return { job, slice, config: configs[0] };
}
async function read(manager, operation) {
  const controller = new AbortController(); manager.controllers.add(controller);
  try {
    if (manager.stopping) throw fail('Production inputs are stopped.', 'LAYR_OUTBOX_STOPPED');
    const result = await operation({ signal: controller.signal });
    if (manager.stopping || controller.signal.aborted) throw fail('Production inputs stopped during authorization.', 'LAYR_OUTBOX_STOPPED');
    return result;
  } finally { manager.controllers.delete(controller); }
}
function assertTicket(job, ticket) {
  if (ticket?.id !== job.order.portalJobId || ticket.ticketFingerprint !== job.order.ticketFingerprint || ticket.ticket?.specifications?.project?.quantity !== job.order.requestedQuantity) throw fail('The frozen portal ticket no longer matches this local order.', 'LAYR_TICKET_CHANGED');
}
function assertReceipt(job, slice, receipt, deviceFingerprint) {
  if (slice.modelCopiesPerRun !== 1 || receipt?.kind !== 'slice' || receipt.jobId !== job.order.portalJobId || receipt.ticketFingerprint !== job.order.ticketFingerprint ||
      receipt.sourceSha256 !== job.sha256 || receipt.profileSha256 !== slice.profileSha256 || receipt.printerId !== slice.printerId || receipt.printerModel !== slice.printerModel || receipt.material !== slice.material ||
      receipt.tool?.executableSha256 !== slice.tool?.executableSha256 || receipt.artifact?.sha256 !== slice.sha256 || receipt.artifact?.sizeBytes !== slice.bytes || receipt.artifact?.format !== slice.format ||
      receipt.deviceFingerprint !== deviceFingerprint || receipt.partsPerRun !== 1) throw fail('The receipt must bind this exact single-model slice, profile and physical printer. Queue a new slice receipt if those details changed.', 'LAYR_RECEIPT_MISMATCH');
}
function receiptIdFor(manager, job, explicit) {
  if (explicit) return explicit;
  return manager.outbox.status().filter(entry => entry.portalUrl === job.order.portalUrl && entry.id === job.order.portalJobId && entry.action === 'record_slice' && entry.state === 'confirmed').at(-1)?.confirmation?.receiptId || job.resinProduction?.plan?.receiptId;
}
function stableLookup(manager, key) {
  let scoped = key, existing = manager.outbox.lookup(scoped);
  while (existing?.state === 'dismissed') { scoped = `${key}:after:${existing.operationId}`; existing = manager.outbox.lookup(scoped); }
  return { key: scoped, existing };
}
async function authority(manager, id, { receiptId, deviceFingerprint } = {}) {
  const { job, slice, config } = context(manager, id);
  const result = await read(manager, options => manager.layrProductionClient.getAuthorization(config, { id: job.order.portalJobId, receiptId, deviceFingerprint }, options));
  assertTicket(job, result.ticket); assertReceipt(job, slice, result.receipt, deviceFingerprint);
  if (result.authorization?.qualified !== true) throw fail('The current portal binding does not qualify this printer and profile.', 'LAYR_PREPARATION_UNQUALIFIED');
  return result;
}
function issuer(manager) {
  if (!issuers.has(manager)) issuers.set(manager, manager.service.createResinPermitIssuer({
    reauthorize: async value => {
      const result = await authority(manager, value.jobId, { receiptId: value.receiptId, deviceFingerprint: value.deviceFingerprint });
      if (result.authorization.artifactSha256 !== value.artifactSha256 || result.authorization.profileSha256 !== value.profileSha256 || result.authorization.sourceSha256 !== value.sourceSha256 ||
          result.authorization.engineSha256 !== value.engineSha256 || result.authorization.printerId !== value.printerId || result.authorization.plannedParts !== value.plannedParts) throw fail('The portal authorization changed during upload. No start is authorized.', 'LAYR_TICKET_CHANGED');
      return result;
    },
  }));
  return issuers.get(manager);
}

async function verifyQueuedProductionEvidence(manager, summary, command) {
  if (command.action === 'record_slice') return verifyQueuedEvidence(manager, summary, command);
  if (['start_print', 'finish_print', 'fail_print'].includes(command.action)) {
    const jobs = manager.service.snapshot().jobs.filter(job => job.order?.portalUrl === summary.portalUrl && job.order?.portalJobId === command.id && job.order?.ticketFingerprint === command.data.ticketFingerprint);
    const run = jobs.length === 1 ? jobs[0].runs.find(run => run.id === command.data.runId) : null, data = command.data;
    if (!run?.startEvidence || run.startEvidence.remoteId !== data.remoteId) throw fail('This unsent operation has no matching durable physical start evidence.');
    if (command.action === 'start_print') {
      if (run.receiptId !== data.receiptId || run.printerId !== data.printerId || run.artifactSha256 !== data.artifactSha256 || run.deviceFingerprint !== data.deviceFingerprint || run.plannedParts !== data.plannedParts || run.startEvidence.observedAt !== data.observedAt) throw fail('The saved physical start evidence does not match this operation.');
    } else if (!run.reconciliation || run.reconciliation.printedParts !== data.printedParts || (run.terminalEvidence?.observedAt || run.reconciliation.reviewedAt) !== data.observedAt ||
      (command.action === 'finish_print' && (data.printedParts !== 1 || run.terminalEvidence?.outcome !== 'completed' || run.terminalEvidence.remoteId !== data.remoteId || filename(run.terminalEvidence.currentFile) !== filename(run.startEvidence.currentFile)))) throw fail('The saved operator count and identified terminal evidence do not match this operation.');
    return;
  }
  if (command.action !== 'approve_preparation') return;
  const jobs = manager.service.snapshot().jobs.filter(job => job.order?.portalUrl === summary.portalUrl && job.order?.portalJobId === command.id && job.order?.ticketFingerprint === command.data.ticketFingerprint);
  if (jobs.length !== 1 || jobs[0].resinProduction?.plan?.receiptId !== command.data.receiptId) throw fail('The reviewed production plan changed before approval was sent.');
  const { job, slice, config } = context(manager, jobs[0].id);
  await manager.service.getResinSliceDownload(job.id);
  const device = await manager.service.inspectResinPrinter(slice.printerId);
  const result = await read(manager, options => manager.layrProductionClient.getReceipt(config, { id: job.order.portalJobId, receiptId: command.data.receiptId }, options));
  assertReceipt(job, slice, result.receipt, device.deviceFingerprint);
  if (result.qualification?.qualified !== true) throw fail('The current portal qualification was removed before approval.', 'LAYR_PREPARATION_UNQUALIFIED');
  const current = context(manager, job.id);
  if (current.job.resinProduction?.plan?.receiptId !== command.data.receiptId) throw fail('The production plan changed during approval validation.');
  assertReceipt(current.job, current.slice, result.receipt, device.deviceFingerprint);
  await manager.service.getResinSliceDownload(job.id);
}
async function sendProductionRequest(manager, summary, command, send) {
  if (command.action !== 'approve_preparation' || summary.attempts !== 1) return send();
  let transmitted = false;
  try {
    const jobs = manager.service.snapshot().jobs.filter(job => job.order?.portalUrl === summary.portalUrl && job.order?.portalJobId === command.id && job.order?.ticketFingerprint === command.data.ticketFingerprint);
    if (jobs.length !== 1) throw fail('The unsent approval no longer identifies a local order.');
    const { job, slice, config } = context(manager, jobs[0].id);
    const device = await manager.service.inspectResinPrinter(slice.printerId);
    const result = await read(manager, options => manager.layrProductionClient.getReceipt(config, { id: job.order.portalJobId, receiptId: command.data.receiptId }, options));
    assertReceipt(job, slice, result.receipt, device.deviceFingerprint);
    if (result.qualification?.qualified !== true) throw fail('This approval no longer has a current qualified binding.');
    return await manager.service.withResinPreparationEvidence(issuer(manager), job.id, { receipt: result.receipt, deviceFingerprint: device.deviceFingerprint }, async () => {
      const latest = context(manager, job.id);
      if (latest.config.id !== summary.connectorId || latest.config.portalUrl !== summary.portalUrl) throw fail('The production input changed before this approval was sent.');
      transmitted = true;
      return send();
    });
  } catch (error) { if (!transmitted) error.definitelyUnsent = true; throw error; }
}
function processOutbox(manager, signal) {
  return manager.outbox.process(manager.service.getConnectors({ secrets: true }), {
    client: manager.layrProductionClient, signal, getConfigs: () => manager.service.getConnectors({ secrets: true }),
    beforeSend: (entry, command) => verifyQueuedProductionEvidence(manager, entry, command),
    sendRequest: (entry, command, send) => sendProductionRequest(manager, entry, command, send),
  });
}

async function reviewProduction(manager, id, { receiptId } = {}) {
  const { job, slice, config } = context(manager, id);
  receiptId = receiptIdFor(manager, job, receiptId);
  if (!receiptId) return { qualified: false, reason: 'Queue and confirm a slice receipt before reviewing production.', dispatchEnabled: manager.service.getSettings().resinEngine?.dispatchEnabled === true };
  const device = await manager.service.inspectResinPrinter(slice.printerId);
  const { ticket, receipt, qualification } = await read(manager, async options => {
    const current = await manager.layrProductionClient.getTicket(config, job.order.portalJobId, options);
    const result = await manager.layrProductionClient.getReceipt(config, { id: job.order.portalJobId, receiptId }, options);
    return { ...current, ...result };
  });
  assertTicket(job, ticket); assertReceipt(job, slice, receipt, device.deviceFingerprint);
  const requestedParts = job.order.requestedQuantity, progress = ticket.production?.progress;
  const printedParts = progress?.printedParts ?? 0;
  return { receiptId, printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material, qualified: qualification?.qualified === true,
    checkedAt: qualification?.checkedAt, portalStatus: ticket.status, portalVersion: ticket.version, requestedParts, printedParts, remainingParts: requestedParts - printedParts,
    partsPerRun: 1, modelCopiesPerRun: slice.modelCopiesPerRun, planReviewed: job.resinProduction?.plan?.receiptId === receiptId,
    binding: { profileSha256: slice.profileSha256, engineSha256: slice.tool.executableSha256, printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material, format: slice.format, deviceFingerprint: device.deviceFingerprint },
    dispatchEnabled: manager.service.getSettings().resinEngine?.dispatchEnabled === true,
    ...(!qualification?.qualified ? { reason: 'The studio must qualify this exact engine, profile, resin and device signature.' } : {}) };
}

async function approvePreparation(manager, id, { receiptId, confirmedWholeModel } = {}) {
  if (confirmedWholeModel !== true) throw fail('Confirm that the whole submitted model represents one requested production unit.', 'RESIN_UNIT_DECLARATION_REQUIRED');
  const { job, slice, config } = context(manager, id);
  receiptId = receiptIdFor(manager, job, receiptId);
  if (!receiptId) throw fail('Queue and confirm the current slice receipt first.');
  await manager.service.getResinSliceDownload(id);
  const device = await manager.service.inspectResinPrinter(slice.printerId);
  const result = await read(manager, async options => ({
    ...(await manager.layrProductionClient.getTicket(config, job.order.portalJobId, options)),
    ...(await manager.layrProductionClient.getReceipt(config, { id: job.order.portalJobId, receiptId }, options)),
  }));
  assertTicket(job, result.ticket); assertReceipt(job, slice, result.receipt, device.deviceFingerprint);
  if (result.qualification?.qualified !== true) throw fail('This exact printer and preparation have not been qualified by the studio.', 'LAYR_PREPARATION_UNQUALIFIED');
  const saved = stableLookup(manager, `approve:${config.portalUrl}:${job.order.portalJobId}:${job.order.ticketFingerprint}:${receiptId}`);
  if (saved.existing) { await processOutbox(manager); return manager.outbox.get(saved.existing.operationId); }
  if (result.ticket.status !== 'preparing') throw fail('The order is no longer awaiting preparation approval.', 'LAYR_TICKET_CHANGED');
  await manager.service.reviewResinProductionPlan(issuer(manager), id, { receipt: result.receipt, deviceFingerprint: device.deviceFingerprint, confirmedWholeModel: true });
  const operation = await manager.outbox.enqueue({ connectorId: config.id, portalUrl: config.portalUrl, action: 'approve_preparation', id: job.order.portalJobId, version: result.ticket.version,
    data: { ticketFingerprint: job.order.ticketFingerprint, receiptId } }, saved.key);
  await processOutbox(manager);
  return manager.outbox.get(operation.operationId);
}

async function syncRunEvidence(manager, id) {
  const { job, config } = context(manager, id, { sliceRequired: false });
  const runs = job.runs.filter(run => run.receiptId && run.plannedParts === 1 && run.startEvidence);
  if (!runs.length) return [];
  const queued = [];
  for (const run of runs) {
    if (manager.stopping) break;
    const startKey = `start:${config.portalUrl}:${job.order.portalJobId}:${run.id}`, resultKey = `result:${config.portalUrl}:${job.order.portalJobId}:${run.id}`;
    const start = manager.outbox.lookup(startKey), result = manager.outbox.lookup(resultKey);
    if (result?.state === 'confirmed') continue;
    if (result || (start && start.state !== 'confirmed')) throw fail('Reconcile the held physical run evidence before another start.', 'LAYR_PHYSICAL_EVIDENCE_HELD');
    const { ticket } = await read(manager, options => manager.layrProductionClient.getTicket(config, job.order.portalJobId, options));
    assertTicket(job, ticket);
    const remote = ticket.production?.run;
    const matches = remote?.runId === run.id && remote.remoteId === run.startEvidence.remoteId && remote.receiptId === run.receiptId && remote.artifactSha256 === run.artifactSha256 && remote.printerId === run.printerId && remote.deviceFingerprint === run.deviceFingerprint && remote.plannedParts === run.plannedParts;
    if (!start && ticket.status === 'queued' && !matches) {
      queued.push(await manager.outbox.enqueue({ connectorId: config.id, portalUrl: config.portalUrl, action: 'start_print', id: job.order.portalJobId, version: ticket.version,
        data: { ticketFingerprint: job.order.ticketFingerprint, receiptId: run.receiptId, runId: run.id, artifactSha256: run.artifactSha256, printerId: run.printerId,
          remoteId: run.startEvidence.remoteId, observedAt: run.startEvidence.observedAt, deviceFingerprint: run.deviceFingerprint, plannedParts: 1 } }, startKey));
      break;
    }
    if (!matches) throw fail('The portal does not identify this local physical run. Reconcile its saved evidence before continuing.', 'LAYR_RUN_MISMATCH');
    if (!run.reconciliation) continue;
    if (ticket.status !== 'printing') {
      if (['completed', 'failed'].includes(remote.status)) continue;
      throw fail('The portal is not awaiting a result for this run.', 'LAYR_RUN_MISMATCH');
    }
    const printedParts = run.reconciliation.printedParts;
    if (![0, 1].includes(printedParts)) throw fail('The reconciled run has no explicit production unit count.');
    if (printedParts === 1 && (run.terminalEvidence?.outcome !== 'completed' || run.terminalEvidence.remoteId !== run.startEvidence.remoteId || filename(run.terminalEvidence.currentFile) !== filename(run.startEvidence.currentFile))) throw fail('A printed unit requires identified completion telemetry.');
    queued.push(await manager.outbox.enqueue({ connectorId: config.id, portalUrl: config.portalUrl, action: printedParts === 1 ? 'finish_print' : 'fail_print', id: job.order.portalJobId, version: ticket.version,
      data: { ticketFingerprint: job.order.ticketFingerprint, runId: run.id, remoteId: run.startEvidence.remoteId, observedAt: run.terminalEvidence?.observedAt || run.reconciliation.reviewedAt, printedParts } }, resultKey));
    break;
  }
  return queued;
}
async function syncAfterPhysicalAction(manager, id) {
  try { await processOutbox(manager); await syncRunEvidence(manager, id); await processOutbox(manager); return {}; }
  catch {
    await manager.service.recordEvent({ level: 'error', type: 'connector.production_sync', jobId: id, message: 'Physical run evidence is saved locally. Portal synchronization needs review; no hardware start was retried.' }).catch(() => {});
    return { syncError: 'The physical result is saved locally; portal synchronization needs review.' };
  }
}
async function dispatchProduction(manager, id, { confirmedReady } = {}) {
  if (confirmedReady !== true) throw fail('Confirm the physical printer is ready for one production unit.', 'CONFIRMATION_REQUIRED');
  if (manager.service.getSettings().resinEngine?.dispatchEnabled !== true) throw fail('Qualified resin dispatch is disabled in Settings.', 'RESIN_DISPATCH_DISABLED');
  const { job, slice } = context(manager, id), receiptId = job.resinProduction?.plan?.receiptId;
  if (!receiptId) throw fail('Review and approve this order’s single-unit production plan first.');
  await processOutbox(manager); await syncRunEvidence(manager, id); await processOutbox(manager);
  const device = await manager.service.inspectResinPrinter(slice.printerId);
  const proof = await authority(manager, id, { receiptId, deviceFingerprint: device.deviceFingerprint });
  const permit = await manager.service.issueResinDispatchPermit(issuer(manager), id, { printerId: slice.printerId, ...proof, deviceFingerprint: device.deviceFingerprint, observedAt: new Date(manager.now()).toISOString(), confirmedWholeModel: true });
  await manager.service.dispatchQualifiedResinJob(id, { permitId: permit.permitId, confirmedReady: true });
  const sync = await syncAfterPhysicalAction(manager, id);
  return { job: manager.service.getJob(id), ...sync };
}
async function reconcileProduction(manager, id, request) {
  await manager.service.reconcileResinRun(id, request);
  const sync = await syncAfterPhysicalAction(manager, id);
  return { job: manager.service.getJob(id), ...sync };
}
async function releaseDismissedApproval(manager, entry, command) {
  if (entry.state !== 'dismissed' || command?.action !== 'approve_preparation') return;
  const jobs = manager.service.snapshot().jobs.filter(job => job.order?.portalUrl === entry.portalUrl && job.order?.portalJobId === command.id && job.order?.ticketFingerprint === command.data.ticketFingerprint && job.resinProduction?.plan?.receiptId === command.data.receiptId);
  if (jobs.length === 1) await manager.service.releaseResinPreparationApproval(issuer(manager), jobs[0].id, { receiptId: command.data.receiptId });
}

module.exports = { reviewProduction, approvePreparation, dispatchProduction, reconcileProduction, syncRunEvidence, processOutbox, verifyQueuedProductionEvidence, sendProductionRequest, releaseDismissedApproval };
