'use strict';

// Production orchestration consumes core-owned physical evidence. Polling this
// module can synchronize receipts, but can never upload or start a printer.
const { verifyQueuedEvidence } = require('./layr-evidence');
const issuers = new WeakMap();
const fail = (message, code = 'LAYR_PRODUCTION_REVIEW_REQUIRED') => Object.assign(new Error(message), { status: 409, code });
const filename = value => String(value || '').replaceAll('\\', '/').split('/').pop();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

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
function targetFor(job, ticket) {
  const target = ticket.production?.target || { id: job.order.portalJobId, kind: 'order', cycle: 0, requiredParts: job.order.requestedQuantity };
  const progress = ticket.production?.progress;
  if (!UUID.test(target.id || '') || !Number.isSafeInteger(target.cycle) || target.cycle < 0 || !Number.isSafeInteger(target.requiredParts) || target.requiredParts < 0 || target.requiredParts > job.order.requestedQuantity ||
      (target.cycle === 0 ? target.kind !== 'order' || target.id !== job.order.portalJobId || target.requiredParts !== job.order.requestedQuantity : target.kind !== 'replacement') ||
      (progress && (progress.requestedParts !== target.requiredParts || !Number.isSafeInteger(progress.printedParts) || progress.printedParts < 0 || progress.printedParts > target.requiredParts || progress.remainingParts !== target.requiredParts - progress.printedParts))) throw fail('The current portal production target is inconsistent.', 'LAYR_TARGET_CHANGED');
  return target;
}
const localTargetId = job => job.resinProduction?.target?.id || job.resinProduction?.plan?.targetId || job.order.portalJobId;
const belongs = (job, entry) => entry.portalUrl === job.order.portalUrl && entry.id === job.order.portalJobId;
function matchingOperations(manager, job, action, receiptId) {
  return manager.outbox.status().filter(entry => belongs(job, entry) && entry.action === action && (!receiptId || manager.outbox.command(entry.operationId)?.data.receiptId === receiptId));
}
function assertNoLocalRun(job) {
  if (job.currentRunId || ['printing', 'paused', 'dispatching', 'needs_attention'].includes(job.status)) throw fail('Resolve the physical resin run before changing its preparation.', 'LAYR_PHYSICAL_EVIDENCE_HELD');
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
          result.authorization.engineSha256 !== value.engineSha256 || result.authorization.printerId !== value.printerId || result.authorization.plannedParts !== value.plannedParts ||
          (value.targetId !== undefined && targetFor(manager.service.getJob(value.jobId), result.ticket).id !== value.targetId)) throw fail('The portal authorization changed during upload. No start is authorized.', 'LAYR_TICKET_CHANGED');
      return result;
    },
  }));
  return issuers.get(manager);
}

async function verifyQueuedProductionEvidence(manager, summary, command) {
  if (command.action === 'record_slice') return verifyQueuedEvidence(manager, summary, command);
  if (command.action === 'withdraw_preparation') {
    const jobs = manager.service.snapshot().jobs.filter(job => belongs(job, summary) && job.order.ticketFingerprint === command.data.ticketFingerprint);
    if (jobs.length !== 1) throw fail('This unsent withdrawal no longer identifies one local order.');
    const { job, config } = context(manager, jobs[0].id, { sliceRequired: false });
    assertNoLocalRun(job);
    const { ticket } = await read(manager, options => manager.layrProductionClient.getTicket(config, job.order.portalJobId, options));
    assertTicket(job, ticket);
    if (ticket.status !== 'queued' || ticket.version !== command.version || ticket.production?.approvedReceiptId !== command.data.receiptId || ticket.production?.run?.status === 'printing' || targetFor(job, ticket).id !== localTargetId(job)) throw fail('The queued preparation changed before withdrawal could be sent.', 'LAYR_TARGET_CHANGED');
    return;
  }
  if (['start_print', 'finish_print', 'fail_print'].includes(command.action)) {
    const jobs = manager.service.snapshot().jobs.filter(job => job.order?.portalUrl === summary.portalUrl && job.order?.portalJobId === command.id && job.order?.ticketFingerprint === command.data.ticketFingerprint);
    const run = jobs.length === 1 ? jobs[0].runs.find(run => run.id === command.data.runId) : null, data = command.data;
    if (!run?.startEvidence || run.startEvidence.remoteId !== data.remoteId) throw fail('This unsent operation has no matching durable physical start evidence.');
    if ((data.targetId !== undefined && (run.targetId || jobs[0].order.portalJobId) !== data.targetId) || (run.reconciliation?.targetId !== undefined && run.reconciliation.targetId !== (run.targetId || jobs[0].order.portalJobId))) throw fail('The saved physical run belongs to a different production target.', 'LAYR_TARGET_CHANGED');
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
    return await manager.service.withResinPreparationEvidence(issuer(manager), job.id, { receipt: result.receipt, deviceFingerprint: device.deviceFingerprint, operationId: summary.operationId, expectedVersion: summary.version }, async () => {
      const latest = context(manager, job.id);
      if (latest.config.id !== summary.connectorId || latest.config.portalUrl !== summary.portalUrl) throw fail('The production input changed before this approval was sent.');
      transmitted = true;
      return send();
    });
  } catch (error) { if (!transmitted) error.definitelyUnsent = true; throw error; }
}
async function processOutbox(manager, signal) {
  const status = await manager.outbox.process(manager.service.getConnectors({ secrets: true }), {
    client: manager.layrProductionClient, signal, getConfigs: () => manager.service.getConnectors({ secrets: true }),
    beforeSend: (entry, command) => verifyQueuedProductionEvidence(manager, entry, command),
    sendRequest: (entry, command, send) => sendProductionRequest(manager, entry, command, send),
  });
  // A reply can be lost after remote withdrawal committed. Only a confirmed
  // exact replay plus a fresh target/generation read may release the local hold.
  for (const entry of status.filter(value => value.action === 'withdraw_preparation' && value.state === 'confirmed')) {
    if (signal?.aborted || manager.stopping) break;
    const command = manager.outbox.command(entry.operationId);
    const jobs = manager.service.snapshot().jobs.filter(job => belongs(job, entry) && job.order.ticketFingerprint === command.data.ticketFingerprint);
    if (jobs.length !== 1) continue;
    const job = jobs[0], plan = job.resinProduction?.plan;
    if (!plan || plan.receiptId !== command.data.receiptId || plan.withdrawalOperationId === entry.operationId || !['pending', 'approved'].includes(plan.approvalState)) continue;
    const approval = plan.approvalOperationId && manager.outbox.get(plan.approvalOperationId);
    if ((approval && approval.version >= entry.confirmation.version) || (plan.approvalVersion && plan.approvalVersion >= entry.confirmation.version) ||
        (entry.confirmation.target && entry.confirmation.target.id !== localTargetId(job))) continue;
    const { config } = context(manager, job.id, { sliceRequired: false });
    const { ticket } = await read(manager, options => manager.layrProductionClient.getTicket(config, job.order.portalJobId, options));
    assertTicket(job, ticket);
    if (ticket.status !== 'preparing' || ticket.production?.approvedReceiptId != null || ticket.production?.approvedTargetId != null || targetFor(job, ticket).id !== localTargetId(job)) continue;
    await manager.service.applyResinPreparationWithdrawal(issuer(manager), job.id, { ticket, receiptId: command.data.receiptId, operationId: entry.operationId, withdrawalVersion: entry.confirmation.version });
  }
  return status;
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
  const target = targetFor(job, ticket), requestedParts = target.requiredParts, progress = ticket.production?.progress;
  const printedParts = progress?.printedParts ?? 0;
  const local = manager.service.getJob(id);
  return { receiptId, printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material, qualified: qualification?.qualified === true,
    hasActiveRun: Boolean(local.currentRunId), localStatus: local.status,
    checkedAt: qualification?.checkedAt, portalStatus: ticket.status, portalVersion: ticket.version, target, originalRequestedParts: job.order.requestedQuantity,
    requestedParts, printedParts, remainingParts: requestedParts - printedParts, totals: ticket.production?.totals,
    partsPerRun: 1, modelCopiesPerRun: slice.modelCopiesPerRun, planReviewed: job.resinProduction?.plan?.receiptId === receiptId && localTargetId(job) === target.id,
    binding: { profileSha256: slice.profileSha256, engineSha256: slice.tool.executableSha256, printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material, format: slice.format, deviceFingerprint: device.deviceFingerprint },
    dispatchEnabled: manager.service.getSettings().resinEngine?.dispatchEnabled === true,
    ...(!qualification?.qualified ? { reason: 'The studio must qualify this exact engine, profile, resin and device signature.' } : {}) };
}

async function currentTarget(manager, id) {
  const { job, config } = context(manager, id, { sliceRequired: false });
  const { ticket } = await read(manager, options => manager.layrProductionClient.getTicket(config, job.order.portalJobId, options));
  assertTicket(job, ticket);
  const target = targetFor(job, ticket), local = manager.service.getJob(id);
  const hasActiveRun = Boolean(local.currentRunId) || ['printing', 'paused', 'dispatching', 'needs_attention'].includes(local.status);
  return { job: local, ticket, target, observedAt: new Date().toISOString(), hasActiveRun };
}
async function reviewTarget(manager, id) {
  const { job, ticket, target, hasActiveRun } = await currentTarget(manager, id);
  const needsAdoption = target.id !== localTargetId(job);
  return { target, originalRequestedParts: job.order.requestedQuantity, portalStatus: ticket.status, portalVersion: ticket.version,
    progress: ticket.production?.progress, hasActiveRun, needsAdoption,
    canAdopt: needsAdoption && !hasActiveRun && target.kind === 'replacement' && (target.requiredParts > 0 ? ticket.status === 'preparing' : ticket.status === 'post_processing') &&
      ticket.production?.approvedReceiptId == null && ticket.production?.approvedTargetId == null && ticket.production?.run?.status !== 'printing' };
}
async function prepareTarget(manager, id, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['confirmedTarget', 'targetId'].includes(key)) || request.confirmedTarget !== true || !UUID.test(request.targetId || '')) throw fail('Confirm the current studio replacement target before preparing it.', 'RESIN_TARGET_REVIEW_REQUIRED');
  assertNoLocalRun(context(manager, id, { sliceRequired: false }).job);
  await processOutbox(manager);
  await syncRunEvidence(manager, id);
  await processOutbox(manager);
  const { job, ticket, target, observedAt } = await currentTarget(manager, id);
  if (target.id !== request.targetId) throw fail('The studio target changed after review. Review its current quantity before preparing it.', 'LAYR_TARGET_CHANGED');
  assertNoLocalRun(job);
  if (manager.outbox.status().some(entry => belongs(job, entry) && ['approve_preparation', 'withdraw_preparation', 'start_print', 'finish_print', 'fail_print'].includes(entry.action) && !['confirmed', 'dismissed'].includes(entry.state))) throw fail('Reconcile held approval and physical-run evidence before adopting another target.', 'LAYR_PHYSICAL_EVIDENCE_HELD');
  return manager.service.adoptResinPreparationTarget(issuer(manager), id, { ticket, observedAt, confirmedTarget: true });
}

async function approvePreparation(manager, id, { receiptId, confirmedWholeModel } = {}) {
  if (confirmedWholeModel !== true) throw fail('Confirm that the whole submitted model represents one requested production unit.', 'RESIN_UNIT_DECLARATION_REQUIRED');
  await processOutbox(manager);
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
  const target = targetFor(job, result.ticket);
  const prior = matchingOperations(manager, job, 'approve_preparation', receiptId);
  const held = prior.findLast(entry => !['confirmed', 'dismissed'].includes(entry.state));
  if (held) return held;
  if (result.ticket.status === 'queued' && result.ticket.production?.approvedReceiptId === receiptId) {
    const confirmed = prior.findLast(entry => entry.state === 'confirmed' && (entry.confirmation.target?.id || job.order.portalJobId) === target.id && entry.confirmation.version <= result.ticket.version);
    if (confirmed) return confirmed;
  }
  const saved = stableLookup(manager, `approve:${config.portalUrl}:${job.order.portalJobId}:${job.order.ticketFingerprint}:${target.id}:${receiptId}:${result.ticket.version}`);
  if (saved.existing) return manager.outbox.get(saved.existing.operationId);
  if (result.ticket.status !== 'preparing') throw fail('The order is no longer awaiting preparation approval.', 'LAYR_TICKET_CHANGED');
  if (target.requiredParts < 1 || result.ticket.production?.progress?.remainingParts === 0) throw fail('This target authorizes no remaining replacement printing.', 'LAYR_TARGET_COMPLETE');
  await manager.service.reviewResinProductionPlan(issuer(manager), id, { ticket: result.ticket, receipt: result.receipt, deviceFingerprint: device.deviceFingerprint, confirmedWholeModel: true });
  const operation = await manager.outbox.enqueue({ connectorId: config.id, portalUrl: config.portalUrl, action: 'approve_preparation', id: job.order.portalJobId, version: result.ticket.version,
    data: { ticketFingerprint: job.order.ticketFingerprint, receiptId } }, saved.key);
  await processOutbox(manager);
  return manager.outbox.get(operation.operationId);
}

async function withdrawPreparation(manager, id, request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['reason', 'receiptId'].includes(key)) ||
      typeof request.reason !== 'string' || !request.reason.trim() || request.reason !== request.reason.trim() || request.reason.length > 2000 || /[\u0000-\u001f\u007f]/.test(request.reason) ||
      (request.receiptId !== undefined && !UUID.test(request.receiptId))) throw fail('Give a reason of 1 to 2000 characters for withdrawing this preparation.', 'LAYR_WITHDRAWAL_REASON_REQUIRED');
  let current = context(manager, id, { sliceRequired: false });
  assertNoLocalRun(current.job);
  await processOutbox(manager);
  current = context(manager, id, { sliceRequired: false });
  const { job, config } = current, receiptId = request.receiptId || job.resinProduction?.plan?.receiptId;
  assertNoLocalRun(job);
  if (!UUID.test(receiptId || '') || job.resinProduction?.plan?.receiptId !== receiptId) throw fail('Withdraw the currently reviewed preparation receipt.', 'LAYR_RECEIPT_MISMATCH');
  // Held physical evidence can represent a start the portal has not confirmed.
  // It must be reconciled before changing the queued preparation.
  await syncRunEvidence(manager, id);
  await processOutbox(manager);
  const { ticket } = await read(manager, options => manager.layrProductionClient.getTicket(config, job.order.portalJobId, options));
  assertTicket(job, ticket);
  const target = targetFor(job, ticket);
  if (target.id !== localTargetId(job)) throw fail('Review the current production target before changing preparation.', 'LAYR_TARGET_CHANGED');
  const prior = matchingOperations(manager, job, 'withdraw_preparation', receiptId).findLast(entry => entry.state !== 'dismissed' && entry.version >= (job.resinProduction.plan.approvalVersion || 0));
  if (prior && (ticket.status === 'preparing' || !['confirmed', 'dismissed'].includes(prior.state))) {
    if (manager.outbox.command(prior.operationId).data.reason !== request.reason) throw fail('Reconcile the saved withdrawal before changing its reason.', 'LAYR_PRODUCTION_CONFLICT');
    return manager.outbox.get(prior.operationId);
  }
  if (ticket.status !== 'queued' || ticket.production?.approvedReceiptId !== receiptId || ticket.production?.run?.status === 'printing') throw fail('Only a queued approval without an active physical run can be withdrawn.', 'LAYR_WITHDRAWAL_UNAVAILABLE');
  const saved = stableLookup(manager, `withdraw:${config.portalUrl}:${job.order.portalJobId}:${job.order.ticketFingerprint}:${target.id}:${receiptId}:${ticket.version}`);
  if (saved.existing) return saved.existing;
  const reason = manager.service._safeMessage?.(request.reason) || request.reason;
  const operation = await manager.outbox.enqueue({ connectorId: config.id, portalUrl: config.portalUrl, action: 'withdraw_preparation', id: job.order.portalJobId, version: ticket.version,
    data: { ticketFingerprint: job.order.ticketFingerprint, receiptId, reason } }, saved.key);
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
    const targetId = run.targetId || job.order.portalJobId;
    const startKey = `start:${config.portalUrl}:${job.order.portalJobId}:${targetId}:${run.id}`, resultKey = `result:${config.portalUrl}:${job.order.portalJobId}:${targetId}:${run.id}`;
    const start = manager.outbox.lookup(startKey) || manager.outbox.lookup(`start:${config.portalUrl}:${job.order.portalJobId}:${run.id}`);
    const result = manager.outbox.lookup(resultKey) || manager.outbox.lookup(`result:${config.portalUrl}:${job.order.portalJobId}:${run.id}`);
    if (result?.state === 'confirmed') continue;
    if (result || (start && start.state !== 'confirmed')) throw fail('Reconcile the held physical run evidence before another start.', 'LAYR_PHYSICAL_EVIDENCE_HELD');
    const { ticket } = await read(manager, options => manager.layrProductionClient.getTicket(config, job.order.portalJobId, options));
    assertTicket(job, ticket);
    const remote = ticket.production?.run;
    const matches = remote?.runId === run.id && (remote.targetId || job.order.portalJobId) === targetId && remote.remoteId === run.startEvidence.remoteId && remote.receiptId === run.receiptId && remote.artifactSha256 === run.artifactSha256 && remote.printerId === run.printerId && remote.deviceFingerprint === run.deviceFingerprint && remote.plannedParts === run.plannedParts;
    if (!start && ticket.status === 'queued' && !matches) {
      if (targetFor(job, ticket).id !== targetId) throw fail('The saved physical run belongs to a different production target.', 'LAYR_TARGET_CHANGED');
      queued.push(await manager.outbox.enqueue({ connectorId: config.id, portalUrl: config.portalUrl, action: 'start_print', id: job.order.portalJobId, version: ticket.version,
        data: { ticketFingerprint: job.order.ticketFingerprint, receiptId: run.receiptId, runId: run.id, artifactSha256: run.artifactSha256, printerId: run.printerId,
          remoteId: run.startEvidence.remoteId, observedAt: run.startEvidence.observedAt, deviceFingerprint: run.deviceFingerprint, plannedParts: 1, targetId } }, startKey));
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
      data: { ticketFingerprint: job.order.ticketFingerprint, runId: run.id, remoteId: run.startEvidence.remoteId, observedAt: run.terminalEvidence?.observedAt || run.reconciliation.reviewedAt, printedParts, targetId } }, resultKey));
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
  if (jobs.length === 1) {
    const plan = jobs[0].resinProduction?.plan;
    if (plan.approvalOperationId && plan.approvalOperationId !== entry.operationId) return;
    if (entry.confirmation?.target && entry.confirmation.target.id !== localTargetId(jobs[0])) return;
    await manager.service.releaseResinPreparationApproval(issuer(manager), jobs[0].id, { receiptId: command.data.receiptId, operationId: entry.operationId });
  }
}

module.exports = { reviewProduction, reviewTarget, prepareTarget, approvePreparation, withdrawPreparation, dispatchProduction, reconcileProduction, syncRunEvidence, processOutbox, verifyQueuedProductionEvidence, sendProductionRequest, releaseDismissedApproval };
