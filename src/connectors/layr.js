'use strict';

const { processOutbox } = require('./layr-production');

// Imports preparation tickets only. Portal workflow mutations are deliberately
// separate from local model receipt and from physical manufacturing evidence.
async function pollLayr(manager, config, checkpoint) {
  const controller = new AbortController();
  manager.controllers.add(controller);
  try {
    const production = config.apiMode === 'production';
    const client = production ? manager.layrProductionClient : manager.layrClient;
    if (!production && config.refreshToken && Date.parse(config.expiresAt) <= manager.now() + 60000) {
      const renewed = await manager.layrOAuth.refresh(config, { signal: controller.signal });
      // A rotating refresh token must reach durable storage before being used.
      await manager.service.saveConnector({ ...renewed, id: config.id });
      Object.assign(config, renewed);
    }
    const options = { signal: controller.signal };
    const failures = [];
    const processEvidence = production ? () => processOutbox(manager, controller.signal) : null;
    // Pending writes may already have committed. Reconcile them independently
    // of listing/import failures so a large or broken model cannot starve them.
    if (processEvidence) { try { await processEvidence(); } catch (error) { failures.push(error); } }
    let jobs = [];
    try { jobs = await client.listPreparationJobs(config, options); }
    catch (error) { failures.push(error); }
    checkpoint.receipts ||= {};
    for (const job of jobs) {
      if (manager.stopping) break;
      // Receipt checks happen against approved ticket identity, not list order.
      // The service also persists this identity atomically with the imported file.
      try {
        const expectedIdentity = `${job.id}:${client.ticketFingerprint(job)}`;
        if (checkpoint.receipts[expectedIdentity]) continue;
        const downloaded = await client.downloadModel(config, job, options);
        const { order, name, data } = downloaded;
        const identity = `${order.portalJobId}:${order.ticketFingerprint}`;
        if (checkpoint.receipts[identity]) continue;
        const result = await manager.service.submit({
          source: `layr:${order.portalUrl}`, sourceId: identity,
          name: `${order.reference || 'Layr'} · ${order.project?.name || name}`,
          quantity: 1, order, files: [{ name, data }],
          notes: `Resin order ${order.reference || order.portalJobId}. Requested parts: ${order.requestedQuantity}. Model units: ${order.units}.\nApproved requirements: ${JSON.stringify(order.production)}\n${order.project?.notes || ''}`,
        });
        checkpoint.receipts[identity] = { jobIds: result.jobs.map(item => item.id), importedAt: new Date(manager.now()).toISOString() };
        await manager.persist();
        if (!result.duplicate) manager.imported(config.id, result.jobs.length);
      } catch (error) { failures.push(error); }
    }
    if (config.apiMode === 'production') {
      if (config.autoSyncPreparation === true) {
        for (const local of manager.service.snapshot().jobs) {
          if (manager.stopping) break;
          const current = jobs.find(job => job.id === local.order?.portalJobId && client.ticketFingerprint(job) === local.order?.ticketFingerprint);
          if (!current || local.order?.portalUrl !== config.portalUrl || !local.resinSlice?.analysis?.passed || local.status !== 'review') continue;
          try { await manager.queueSliceEvidence(local.id, { connectorId: config.id }); }
          catch (error) { failures.push(error); }
        }
      }
      for (const local of manager.service.snapshot().jobs) {
        if (manager.stopping) break;
        if (local.technology !== 'resin' || local.order?.portalUrl !== config.portalUrl || !local.runs.some(run => run.startEvidence && run.receiptId)) continue;
        try { await manager.syncResinProductionEvidence(local.id); }
        catch (error) { failures.push(error); }
      }
      try { await processEvidence(); } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      const important = failures.find(error => ['LAYR_AUTH', 'LAYR_RECONNECT'].includes(error?.code)) || failures.find(error => error?.code === 'LAYR_TOO_LARGE') || failures[0];
      throw Object.assign(new Error('Some portal work requires review. Independent tickets and saved evidence were still processed.'), { code: important?.code, status: important?.status });
    }
  } finally {
    manager.controllers.delete(controller);
  }
}

module.exports = { pollLayr };
