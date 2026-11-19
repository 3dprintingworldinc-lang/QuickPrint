'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const fail = (message, code = 'LAYR_EVIDENCE_INVALID', status = 409) => Object.assign(new Error(message), { status, code });
const digest = value => createHash('sha256').update(value).digest('hex');

function context(manager, id) {
  const job = manager.service.getJob(id);
  if (job.technology !== 'resin' || !job.order || job.status !== 'review') throw fail('Select a reviewed resin ticket with a captured slice.');
  const slice = job.resinSlice;
  if (!slice?.analysis?.passed || slice.analysis.count !== 0 || slice.inspection?.validatedLayerData !== true || slice.sourceSha256 !== job.sha256) throw fail('Only a structurally validated, issue-free slice can be sent as preparation evidence.');
  return { job, slice };
}
async function verifyFiles(manager, job, slice) {
  const descriptor = await manager.service.getResinSliceDownload(job.id);
  const source = await fs.readFile(job.inputPath);
  if (digest(source) !== job.sha256) throw fail('The original model changed after slicing.', 'ORIGINAL_CHANGED');
  const stat = await fs.stat(descriptor.filePath);
  if (!stat.isFile() || stat.size !== slice.bytes || digest(await fs.readFile(descriptor.filePath)) !== slice.sha256) throw fail('The selected resin artifact changed after slicing.', 'RESIN_ARTIFACT_CHANGED');
  if (manager.stopping) throw fail('Production inputs stopped before evidence was queued.', 'LAYR_OUTBOX_STOPPED');
}

async function verifyQueuedEvidence(manager, summary, command) {
  if (command.action !== 'record_slice') return;
  const matches = manager.service.snapshot().jobs.filter(job => job.order?.portalUrl === summary.portalUrl && job.order?.portalJobId === command.id && job.order?.ticketFingerprint === command.data.ticketFingerprint);
  if (matches.length !== 1) throw fail('The saved evidence no longer has a unique local production ticket.');
  const { job, slice } = context(manager, matches[0].id);
  const data = command.data;
  if (data.sourceSha256 !== job.sha256 || data.artifact?.sha256 !== slice.sha256 || data.artifact?.sizeBytes !== slice.bytes || data.artifact?.format !== slice.format ||
      data.profileSha256 !== slice.profileSha256 || data.tool?.executableSha256 !== slice.tool?.executableSha256 || data.printerId !== slice.printerId || data.printerModel !== slice.printerModel || data.material !== slice.material) {
    throw fail('The local slice changed after this unsent evidence was queued. Review the held operation before sending another slice.');
  }
  await verifyFiles(manager, job, slice);
}

async function queueSliceEvidence(manager, id, { connectorId, version } = {}) {
  const { job, slice } = context(manager, id);
  const configs = manager.service.getConnectors({ secrets: true }).filter(config => config.type === 'layr' && config.apiMode === 'production' && config.enabled !== false && config.portalUrl === job.order.portalUrl && (!connectorId || config.id === connectorId));
  if (configs.length !== 1) throw fail('Select one enabled production input for this ticket’s portal.', 'LAYR_PRODUCTION_INPUT_REQUIRED');
  const config = configs[0];
  let deviceFingerprint = null;
  if (manager.service.snapshot().printers.some(printer => printer.id === slice.printerId && printer.type === 'sdcp')) deviceFingerprint = (await manager.service.inspectResinPrinter(slice.printerId)).deviceFingerprint;
  const key = ['slice', config.portalUrl, job.order.portalJobId, job.order.ticketFingerprint, slice.sha256, slice.profileSha256, slice.tool?.executableSha256, deviceFingerprint || 'unbound', 1].join(':');
  await verifyFiles(manager, job, slice);
  let evidenceKey = key;
  let existing = manager.outbox.lookup?.(evidenceKey);
  while (existing?.state === 'dismissed') {
    evidenceKey = `${key}:after:${existing.operationId}`;
    existing = manager.outbox.lookup?.(evidenceKey);
  }
  if (existing) return existing;
  if (version === undefined) {
    const controller = new AbortController();
    manager.controllers.add(controller);
    try {
      const { ticket } = await manager.layrProductionClient.getTicket(config, job.order.portalJobId, { signal: controller.signal });
      if (ticket.status !== 'preparing' || ticket.ticketFingerprint !== job.order.ticketFingerprint) throw fail('The portal no longer has this ticket awaiting preparation.', 'LAYR_TICKET_CHANGED');
      version = ticket.version;
    } catch (error) {
      if (manager.stopping || controller.signal.aborted) throw fail('Production inputs stopped before evidence was queued.', 'LAYR_OUTBOX_STOPPED');
      throw error;
    } finally { manager.controllers.delete(controller); }
  }
  if (manager.stopping) throw fail('Production inputs stopped before evidence was queued.', 'LAYR_OUTBOX_STOPPED');
  // Dismissed history is retained. A reviewed retry uses a new stable key tied
  // to that local resolution, rather than changing the original saved body.
  return manager.outbox.enqueue({ connectorId: config.id, portalUrl: config.portalUrl, action: 'record_slice', id: job.order.portalJobId, version,
    data: { ticketFingerprint: job.order.ticketFingerprint, sourceSha256: job.sha256,
      tool: { name: slice.tool.name, version: slice.tool.version, executableSha256: slice.tool.executableSha256 },
      profileSha256: slice.profileSha256, printerId: slice.printerId, printerModel: slice.printerModel, material: slice.material, deviceFingerprint, partsPerRun: 1,
      artifact: { sha256: slice.sha256, sizeBytes: slice.bytes, format: slice.format },
    } }, evidenceKey);
}

module.exports = { queueSliceEvidence, verifyQueuedEvidence };
