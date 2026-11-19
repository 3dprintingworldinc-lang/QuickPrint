'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { test: base, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');
const { fingerprintSDCPDevice } = require('../../src/adapters/sdcp-identity');
const { ticketFingerprint } = require('../../src/connectors/layr-client');
const productionClient = require('../../src/connectors/layr-production-client');
const { MODEL, CONFIRMED, createProfile, makeSlice } = require('../helpers/resin-slice');

const PORTAL = 'https://printbylayr.example';
const MACHINE_TOKEN = 'p'.repeat(43);
const mutations = adapter => adapter.calls.filter(([action]) => ['upload', 'start', 'pause', 'resume', 'cancel'].includes(action));

// The browser, HTTP routes, imported model, validated GOO capture, manager,
// durable outbox and core lifecycle are real. The two boundaries below never
// open a printer socket or contact a portal, so no physical run is possible.
const test = base.extend({
  workspace: async ({}, use) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-production-ui-'));
    const settings = await createProfile(directory);
    const adapter = {
      capabilities: { upload: true, start: true, pause: true, resume: true, cancel: true, formats: ['goo'], discovery: false },
      attrs: { MainboardID: '0123456789abcdef', BrandName: 'ELEGOO', MachineName: 'Synthetic SDCP model', ProtocolVersion: 'V3.0.0', FirmwareVersion: 'V1.5.6', Resolution: '4x2', XYZsize: '41x21x30', Capabilities: ['FILE_TRANSFER', 'PRINT_CONTROL'], SupportFileType: ['GOO'] },
      telemetry: { state: 'idle' }, calls: [], serial: 0, uncertainStart: false,
      async attributes() { this.calls.push(['attributes']); return { ...this.attrs, observedAt: new Date().toISOString() }; },
      async status() { this.calls.push(['status']); return { ...this.telemetry, observedAt: new Date().toISOString() }; },
      async upload(input) { this.calls.push(['upload', input]); this.remotePath = input.fileName; await this.onUpload?.(); return { remotePath: input.fileName }; },
      async start(input) {
        this.calls.push(['start', input]); this.remoteId = `fixture-task-${++this.serial}`;
        this.telemetry = { state: 'printing', remoteId: this.remoteId, currentFile: this.remotePath };
        if (this.uncertainStart) throw Object.assign(new Error('Fixture physical start acknowledgement is uncertain.'), { status: 504, code: 'SDCP_START_UNCERTAIN', uncertain: true });
        return { acknowledged: true, ...this.telemetry, observedAt: new Date().toISOString() };
      },
      async pause() { this.calls.push(['pause']); return { acknowledged: true }; },
      async resume() { this.calls.push(['resume']); return { acknowledged: true }; },
      async cancel() { this.calls.push(['cancel']); return { acknowledged: true }; },
      async close() {},
    };
    const source = { id: randomUUID(), reference: 'PBL-BROWSER-TWO-UNITS', version: 5, status: 'preparing',
      payment: { amountCents: 2000, confirmedAt: '2026-11-19T15:00:00Z' },
      ticket: { model: { size: MODEL.length }, quote: { amountCents: 2000 }, specifications: {
        project: { name: 'Two-unit qualified resin order', quantity: 2, notes: 'Print counts require separate quality inspection.' },
        production: { printType: 'resin', supports: 'allowed', qualityTier: 'standard', properties: 'standard', colour: 'grey' },
        file: { name: 'source.stl', format: 'stl', sizeBytes: MODEL.length, units: 'mm' },
      } },
    };
    const fingerprint = ticketFingerprint(source);
    const remote = { version: 5, status: 'preparing', printedParts: 0, completedRuns: 0, failedRuns: 0,
      target: { id: source.id, kind: 'order', cycle: 0, requiredParts: 2, authorizedAt: new Date().toISOString(), qcOperationId: null },
      targetHistory: [], totals: { printedParts: 0, completedRuns: 0, failedRuns: 0 },
      approvedReceiptId: null, approvedTargetId: null, receipt: null, run: null, qualified: true, writes: [], reads: [], operations: new Map() };
    const progress = () => ({ requestedParts: remote.target.requiredParts, printedParts: remote.printedParts, remainingParts: remote.target.requiredParts - remote.printedParts, completedRuns: remote.completedRuns, failedRuns: remote.failedRuns });
    const ticket = () => ({ id: source.id, reference: source.reference, version: remote.version, status: remote.status, ticketFingerprint: fingerprint,
      ticket: { specifications: structuredClone(source.ticket.specifications) },
      production: { target: structuredClone(remote.target), targetHistory: structuredClone(remote.targetHistory), totals: structuredClone(remote.totals),
        progress: progress(), approvedReceiptId: remote.approvedReceiptId, approvedTargetId: remote.approvedTargetId, run: structuredClone(remote.run) } });
    remote.authorizeReplacement = count => {
      expect(remote.status).toBe('post_processing'); expect(progress().remainingParts).toBe(0);
      remote.targetHistory.push({ ...structuredClone(remote.target), progress: progress() });
      const id = randomUUID(); remote.target = { id, kind: 'replacement', cycle: remote.target.cycle + 1, requiredParts: count, authorizedAt: new Date().toISOString(), qcOperationId: id };
      remote.printedParts = 0; remote.completedRuns = 0; remote.failedRuns = 0; remote.approvedReceiptId = null; remote.approvedTargetId = null;
      remote.status = count ? 'preparing' : 'post_processing'; remote.version++;
    };
    const checkConfig = config => { expect(config.portalUrl).toBe(PORTAL); expect(config.token).toBe(MACHINE_TOKEN); };
    const client = {
      ticketFingerprint: productionClient.ticketFingerprint,
      async listPreparationJobs(config) { checkConfig(config); return remote.status === 'preparing' ? [ticket()] : []; },
      async downloadModel(config, current) { checkConfig(config); return { name: 'source.stl', data: MODEL, order: productionClient.buildOrderMetadata(current, PORTAL, MODEL) }; },
      async getTicket(config, id) { checkConfig(config); expect(id).toBe(source.id); remote.reads.push('ticket'); return { ticket: ticket() }; },
      async getReceipt(config, input) {
        checkConfig(config); expect(input).toEqual({ id: source.id, receiptId: remote.receipt.id }); remote.reads.push('receipt');
        return { receipt: structuredClone(remote.receipt), qualification: { qualified: remote.qualified, checkedAt: new Date().toISOString(), qualificationFingerprint: remote.qualified ? 'f'.repeat(64) : null } };
      },
      async getAuthorization(config, input) {
        checkConfig(config); expect(input).toEqual({ id: source.id, receiptId: remote.receipt.id, deviceFingerprint: remote.receipt.deviceFingerprint });
        remote.reads.push('authorization');
        if (!remote.qualified) throw Object.assign(new Error('The current physical printer binding was revoked.'), { code: 'LAYR_PREPARATION_UNQUALIFIED', status: 409 });
        expect(remote.status).toBe('queued'); expect(remote.approvedReceiptId).toBe(remote.receipt.id);
        const receipt = structuredClone(remote.receipt), checkedAt = new Date().toISOString();
        return { ticket: ticket(), receipt, authorization: { qualified: true, checkedAt, expiresAt: new Date(Date.now() + 30000).toISOString(),
          jobVersion: remote.version, ticketFingerprint: fingerprint, receiptId: receipt.id, sourceSha256: receipt.sourceSha256,
          artifactSha256: receipt.artifact.sha256, profileSha256: receipt.profileSha256, engineSha256: receipt.tool.executableSha256,
          printerId: receipt.printerId, printerModel: receipt.printerModel, material: receipt.material, format: 'goo', deviceFingerprint: receipt.deviceFingerprint,
          partsPerRun: 1, plannedParts: 1, remainingParts: progress().remainingParts, qualificationFingerprint: 'f'.repeat(64),
          targetId: remote.target.id, targetKind: remote.target.kind, targetCycle: remote.target.cycle, targetParts: remote.target.requiredParts } };
      },
      async postEvidence(config, command) {
        checkConfig(config);
        const body = JSON.stringify(command), prior = remote.operations.get(command.operationId);
        if (prior) { expect(body).toBe(prior.body); return structuredClone(prior.result); }
        expect(command.id).toBe(source.id); expect(command.version).toBe(remote.version); expect(command.data.ticketFingerprint).toBe(fingerprint);
        const data = command.data;
        switch (command.action) {
          case 'record_slice':
            expect(remote.status).toBe('preparing'); expect(data.partsPerRun).toBe(1);
            remote.receipt = { id: command.operationId, jobId: source.id, machineId: 'browser-fixture', kind: 'slice', ...structuredClone(data), qualified: false, qualifiedAtCapture: false, printReady: false };
            break;
          case 'approve_preparation':
            expect(remote.status).toBe('preparing'); expect(data.receiptId).toBe(remote.receipt.id); expect(remote.qualified).toBe(true);
            remote.approvedReceiptId = data.receiptId; remote.approvedTargetId = remote.target.id; remote.status = 'queued'; break;
          case 'withdraw_preparation':
            expect(remote.status).toBe('queued'); expect(data.receiptId).toBe(remote.approvedReceiptId); expect(remote.run?.status).not.toBe('printing');
            remote.approvedReceiptId = null; remote.approvedTargetId = null; remote.status = 'preparing'; break;
          case 'start_print':
            expect(remote.status).toBe('queued'); expect(data.plannedParts).toBe(1); expect(data.receiptId).toBe(remote.approvedReceiptId);
            expect(adapter.calls.filter(([action]) => action === 'start')).toHaveLength(remote.totals.completedRuns + 1);
            expect(data.targetId).toBe(remote.target.id);
            expect(data.remoteId).toBe(adapter.remoteId); expect(data.deviceFingerprint).toBe(remote.receipt.deviceFingerprint);
            remote.run = { ...structuredClone(data), status: 'printing', startedAt: data.observedAt }; remote.status = 'printing'; break;
          case 'finish_print':
            expect(remote.status).toBe('printing'); expect(data.runId).toBe(remote.run.runId); expect(data.remoteId).toBe(remote.run.remoteId); expect(data.printedParts).toBe(1);
            expect(data.targetId).toBe(remote.target.id);
            remote.printedParts++; remote.completedRuns++; remote.totals.printedParts++; remote.totals.completedRuns++;
            remote.run = { ...remote.run, status: 'completed', printedParts: 1, finishedAt: data.observedAt };
            remote.status = progress().remainingParts === 0 ? 'post_processing' : 'queued'; break;
          default: throw new Error(`Unexpected production mutation ${command.action}`);
        }
        remote.version++; remote.writes.push(structuredClone(command));
        const result = { ticket: ticket(), ...(command.action === 'record_slice' ? { receipt: structuredClone(remote.receipt) } : {}) };
        remote.operations.set(command.operationId, { body, result }); return structuredClone(result);
      },
    };
    const instance = await startServer({ dataDir: path.join(directory, 'data'), port: 0, adapters: () => adapter, resinEngine: { prepareResin: makeSlice }, layrProductionClient: client });
    const api = async (url, body, method = 'POST') => {
      const response = await fetch(`${instance.url}${url}`, { method, headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json(); expect(response.ok, JSON.stringify(data)).toBe(true); return data;
    };
    try {
      await api('/api/settings', { pollIntervalMs: 3600000, resinEngine: settings }, 'PUT');
      const printer = await instance.service.savePrinter({ name: 'Isolated SDCP fixture', type: 'sdcp', host: 'printer-fixture.invalid', mainboardId: adapter.attrs.MainboardID, brandId: 'a'.repeat(32), model: 'QuickPrint Test' });
      const profile = JSON.parse(await fs.readFile(settings.profilePath)); profile.printerId = printer.id;
      await fs.writeFile(settings.profilePath, JSON.stringify(profile));
      const connector = await api('/api/connectors', { name: 'Production fixture', type: 'layr', apiMode: 'production', portalUrl: PORTAL, token: MACHINE_TOKEN, enabled: true, autoSyncPreparation: false, pollIntervalMs: 3600000 });
      await api(`/api/connectors/${connector.id}/poll`, {});
      const [job] = instance.service.snapshot().jobs; expect(job).toMatchObject({ quantity: 1, order: { requestedQuantity: 2, apiMode: 'production' } });
      await instance.service.sliceResinJob(job.id, CONFIRMED);
      const captured = instance.service.getJob(job.id);
      expect(captured.resinSlice.printerId).toBe(printer.id); expect(captured.resinSlice.printReady).toBe(false);
      const deviceFingerprint = fingerprintSDCPDevice(printer, adapter.attrs);
      await use({ ...instance, api, adapter, connector, job, remote, deviceFingerprint });
    } finally { await instance.close(); await fs.rm(directory, { recursive: true, force: true }); }
  },
});

test.beforeEach(async ({ page, context, workspace }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === workspace.url ? route.continue() : route.abort());
  await page.goto(workspace.url);
  await expect(page.locator('#connection-status')).toContainText('Workspace online');
  await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: workspace.job.name, exact: true }).click();
  await page.getByRole('button', { name: 'Queue slice receipt', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/record_slice · pending/)).toBeVisible();
  await workspace.api(`/api/connectors/${workspace.connector.id}/poll`, {});
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/record_slice · confirmed/)).toBeVisible();
  expect(workspace.remote.receipt.deviceFingerprint).toBe(workspace.deviceFingerprint);
});

async function review(page) {
  await page.getByRole('button', { name: 'Review production qualification', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review resin production', exact: true })).toBeVisible();
}

async function approve(page, workspace) {
  await review(page);
  await expect(page.getByText('Qualified by the studio', { exact: true })).toBeVisible();
  const approveButton = page.getByRole('button', { name: 'Approve one-unit run plan', exact: true });
  await approveButton.click(); // Browser required-field validation must prevent this request.
  expect(workspace.remote.writes.map(value => value.action)).toEqual(['record_slice']);
  await page.locator('[name="confirmedWholeModel"]').check();
  await approveButton.click();
  await expect(page.getByRole('button', { name: 'Start one resin unit', exact: true })).toBeDisabled();
  expect(workspace.remote.status).toBe('queued'); expect(mutations(workspace.adapter)).toEqual([]);
}

async function enableDispatch(page) {
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('nav').getByRole('link', { name: 'Settings', exact: true }).click();
  const enabled = page.getByRole('checkbox', { name: /Enable qualified resin dispatch/ });
  await expect(enabled).not.toBeChecked(); await enabled.check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Workspace settings saved.', { exact: true })).toBeVisible();
}

async function openJob(page, workspace) {
  await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: workspace.job.name, exact: true }).click();
}

test('two resin units require separate physical confirmations and counted runs, with no quality acceptance', async ({ page, workspace }) => {
  test.setTimeout(60000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const dispatchBodies = [];
  page.on('request', request => { if (request.url().endsWith('/resin/production/dispatch')) dispatchBodies.push(request.postDataJSON()); });
  expect(workspace.service.getSettings().resinEngine.dispatchEnabled).toBe(false);
  await approve(page, workspace);
  // The disabled setting is enforced on the API as well as the HTML button.
  const denied = await page.request.post(`${workspace.url}/api/jobs/${workspace.job.id}/resin/production/dispatch`, { headers: { Authorization: `Bearer ${workspace.token}` }, data: { confirmedReady: true } });
  expect(denied.status()).toBe(409); expect(mutations(workspace.adapter)).toEqual([]);
  await enableDispatch(page);
  await openJob(page, workspace);
  for (let index = 0; index < 2; index++) {
    await review(page);
    await expect(page.getByText(`${index} printed · ${2 - index} remaining`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Start one resin unit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Start one resin unit?', exact: true })).toBeVisible();
    const confirm = page.getByRole('button', { name: 'Start one resin unit', exact: true });
    await expect(confirm).toBeDisabled();
    expect(workspace.adapter.calls.filter(([action]) => action === 'start')).toHaveLength(index);
    const notReady = await page.request.post(`${workspace.url}/api/jobs/${workspace.job.id}/resin/production/dispatch`, { headers: { Authorization: `Bearer ${workspace.token}` }, data: {} });
    expect(notReady.status()).toBe(409);
    await page.getByRole('checkbox', { name: /The correct resin is loaded, the build plate is clear/ }).check();
    await confirm.click();
    await expect.poll(() => workspace.service.getJob(workspace.job.id).status).toBe('printing');
    await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
    const run = workspace.service.getJob(workspace.job.id).runs.at(-1);
    expect(workspace.remote.status).toBe('printing'); expect(workspace.remote.run.runId).toBe(run.id);
    expect(workspace.remote.reads.filter(value => value === 'authorization')).toHaveLength((index + 1) * 2);
    workspace.adapter.telemetry = { state: 'idle', outcome: 'completed', remoteId: run.remoteId, currentFile: run.remotePath, progress: 100 };
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Record run outcome', exact: true })).toBeVisible();
    expect(workspace.service.getJob(workspace.job.id).resinProduction.printedParts).toBe(index);
    expect(workspace.remote.printedParts).toBe(index);
    await page.getByRole('button', { name: 'Record run outcome', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Record this resin run', exact: true })).toBeVisible();
    await page.getByLabel('Printed order units from this run (0 or 1)').fill('1');
    await page.getByLabel('Operator notes', { exact: true }).fill('One order unit printed; washing, curing and QC remain separate.');
    await page.getByRole('checkbox', { name: /I checked the stopped printer/ }).check();
    await page.getByRole('button', { name: 'Record resin run', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
    await expect.poll(() => workspace.remote.printedParts).toBe(index + 1);
    const current = workspace.service.getJob(workspace.job.id);
    expect(current).toMatchObject({ status: 'review', quantity: 1, acceptedQuantity: 0, currentRunId: null, resinProduction: { printedParts: index + 1, remainingParts: 1 - index } });
    expect(current.resinSlice.printReady).toBe(false);
    expect(workspace.remote.status).toBe(index ? 'post_processing' : 'queued');
    expect(workspace.adapter.calls.filter(([action]) => action === 'start')).toHaveLength(index + 1);
  }
  await review(page);
  await expect(page.getByText('2 printed · 0 remaining', { exact: true })).toBeVisible();
  await expect(page.getByText('The requested print units are recorded. Washing, curing and quality inspection remain to be completed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start one resin unit', exact: true })).toHaveCount(0);
  expect(workspace.remote.writes.map(value => value.action)).toEqual(['record_slice', 'approve_preparation', 'start_print', 'finish_print', 'start_print', 'finish_print']);
  expect(new Set(workspace.remote.writes.filter(value => value.action === 'start_print').map(value => value.data.runId)).size).toBe(2);
  expect(dispatchBodies).toEqual([{ confirmedReady: true, receiptId: workspace.remote.receipt.id, plannedParts: 1 }, { confirmedReady: true, receiptId: workspace.remote.receipt.id, plannedParts: 1 }]);
  expect(mutations(workspace.adapter).map(([action]) => action)).toEqual(['upload', 'start', 'upload', 'start']);
  expect(errors).toEqual([]);
  // The studio can authorize a separately identified replacement target. The
  // browser must show its quantity while retaining the frozen two-unit order.
  workspace.remote.authorizeReplacement(1);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openJob(page, workspace); await review(page);
  await expect(page.getByText('QC replacement 1 · 1 units', { exact: true })).toBeVisible();
  await expect(page.getByText('0 printed · 1 remaining', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve one-unit run plan', exact: true })).toBeVisible();
  expect(workspace.service.getJob(workspace.job.id).order.requestedQuantity).toBe(2);
  expect(workspace.remote.totals.printedParts).toBe(2);
  expect(workspace.adapter.calls.filter(([action]) => action === 'start')).toHaveLength(2);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openJob(page, workspace);
  await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeDisabled();
  const previousSlice = workspace.service.getJob(workspace.job.id).resinSlice;
  const profilePath = workspace.service.getSettings().resinEngine.profilePath;
  const profile = JSON.parse(await fs.readFile(profilePath)); profile.material = 'Revised replacement fixture';
  await fs.writeFile(profilePath, JSON.stringify(profile));
  workspace.remote.qualified = false;
  const readsBeforeTarget = workspace.adapter.calls.length;
  await page.getByRole('button', { name: 'Review current target', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review current production target', exact: true })).toBeVisible();
  await expect(page.getByText('QC replacement 1 · 1 units', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare replacement target', exact: true }).click();
  expect(workspace.service.getJob(workspace.job.id).resinProduction.target.kind).toBe('order');
  await page.locator('[name="confirmedTarget"]').check();
  await page.getByRole('button', { name: 'Prepare replacement target', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeEnabled();
  expect(workspace.adapter.calls.length).toBe(readsBeforeTarget);
  expect(workspace.remote.writes.filter(value => value.action === 'approve_preparation')).toHaveLength(1);
  expect(workspace.service.getJob(workspace.job.id)).toMatchObject({ runs: [expect.any(Object), expect.any(Object)], acceptedQuantity: 0, resinProduction: { target: { kind: 'replacement', cycle: 1 }, printedParts: 0, remainingParts: 1, lifetimeLocalPrintedParts: 2 } });
  await page.locator('[name="confirmedRequirements"]').check();
  await page.locator('[name="confirmedOriginalSize"]').check();
  const replacementResponse = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${workspace.job.id}/resin/slice`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
  expect((await replacementResponse).ok()).toBe(true);
  await expect(page.getByText('Slice captured for qualification', { exact: true })).toBeVisible();
  const replacementSlice = workspace.service.getJob(workspace.job.id).resinSlice;
  expect(replacementSlice.profileSha256).not.toBe(previousSlice.profileSha256);
  expect(replacementSlice.material).toBe('Revised replacement fixture');
  expect(await fs.readFile(workspace.service.getJob(workspace.job.id).inputPath)).toEqual(MODEL);
  expect(workspace.remote.totals.printedParts).toBe(2); expect(errors).toEqual([]);
});

test('a current qualification revocation is visible and cannot approve or start a resin order', async ({ page, workspace }) => {
  workspace.remote.qualified = false;
  await review(page);
  await expect(page.getByText('Requires studio qualification', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve one-unit run plan', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start one resin unit', exact: true })).toHaveCount(0);
  expect(workspace.remote.receipt.qualifiedAtCapture).toBe(false);
  expect(workspace.remote.writes.map(value => value.action)).toEqual(['record_slice']);
  expect(mutations(workspace.adapter)).toEqual([]);
  expect(workspace.service.getJob(workspace.job.id)).toMatchObject({ status: 'review', acceptedQuantity: 0, runs: [] });
});

test('confirmed withdrawal reopens slicing and reapproval creates a new operation with the same order target and counts', async ({ page, workspace }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await approve(page, workspace);
  const initial = workspace.remote.writes.find(value => value.action === 'approve_preparation');
  const target = structuredClone(workspace.remote.target), counts = structuredClone(workspace.remote.totals);
  await expect(page.getByText('Original order · 2 units', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await openJob(page, workspace);
  await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeDisabled();
  await review(page);
  await page.getByRole('button', { name: 'Reopen preparation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reopen resin preparation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw preparation', exact: true }).click();
  expect(workspace.remote.writes.filter(value => value.action === 'withdraw_preparation')).toHaveLength(0);
  const reason = 'Recheck support placement and prepare the reviewed model again.';
  await page.getByLabel('Reason for reopening preparation').fill(reason);
  const withdrawalResponse = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${workspace.job.id}/resin/production/withdraw`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Withdraw preparation', exact: true }).click();
  const withdrawn = await withdrawalResponse; expect(withdrawn.ok()).toBe(true);
  expect(withdrawn.request().postDataJSON()).toEqual({ receiptId: workspace.remote.receipt.id, reason });
  await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeEnabled();
  expect(workspace.remote.status).toBe('preparing');
  expect(workspace.service.getJob(workspace.job.id).resinProduction.plan.approvalState).toBe('withdrawn');
  expect(workspace.remote.target).toEqual(target); expect(workspace.remote.totals).toEqual(counts);
  const oldCapture = workspace.service.getJob(workspace.job.id).resinSlice.filePath;
  await page.locator('[name="confirmedRequirements"]').check();
  await page.locator('[name="confirmedOriginalSize"]').check();
  const sliceResponse = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${workspace.job.id}/resin/slice`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
  expect((await sliceResponse).ok()).toBe(true);
  await expect.poll(() => workspace.service.getJob(workspace.job.id).resinSlice.filePath).not.toBe(oldCapture);
  await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
  const receiptResponse = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${workspace.job.id}/resin/sync`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Queue slice receipt', exact: true }).click();
  expect((await receiptResponse).ok()).toBe(true);
  await workspace.api(`/api/connectors/${workspace.connector.id}/poll`, {});
  await expect(page.getByRole('button', { name: 'Review production qualification', exact: true })).toBeVisible();
  await review(page); await page.locator('[name="confirmedWholeModel"]').check();
  await page.getByRole('button', { name: 'Approve one-unit run plan', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reopen preparation', exact: true })).toBeVisible();
  const approvals = workspace.remote.writes.filter(value => value.action === 'approve_preparation');
  expect(approvals).toHaveLength(2); expect(approvals[1].operationId).not.toBe(initial.operationId); expect(approvals[1].version).toBeGreaterThan(initial.version);
  expect(approvals[1].data.receiptId).toBe(initial.data.receiptId);
  expect(workspace.remote.target).toEqual(target); expect(workspace.remote.totals).toEqual(counts);
  expect(workspace.service.getJob(workspace.job.id)).toMatchObject({ quantity: 1, acceptedQuantity: 0, runs: [], order: { requestedQuantity: 2 }, resinProduction: { printedParts: 0, remainingParts: 2, plan: { approvalState: 'approved', approvalOperationId: approvals[1].operationId } } });
  expect(mutations(workspace.adapter)).toEqual([]); expect(errors).toEqual([]);
});

test('queued preparation remains withdrawable through target review after device qualification changes', async ({ page, workspace }) => {
  await approve(page, workspace);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openJob(page, workspace);
  workspace.adapter.attrs.FirmwareVersion = 'V1.5.7'; workspace.remote.qualified = false;
  const reads = workspace.adapter.calls.length;
  await page.getByRole('button', { name: 'Review current target', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review current production target', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen preparation', exact: true }).click();
  await page.getByLabel('Reason for reopening preparation').fill('Firmware changed; review qualification before preparing again.');
  await page.getByRole('button', { name: 'Withdraw preparation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeEnabled();
  expect(workspace.service.getJob(workspace.job.id).resinProduction.plan.approvalState).toBe('withdrawn');
  expect(workspace.remote.status).toBe('preparing'); expect(workspace.remote.qualified).toBe(false);
  expect(workspace.adapter.calls.length).toBe(reads); expect(mutations(workspace.adapter)).toEqual([]);
  expect(workspace.remote.writes.map(value => value.action)).toEqual(['record_slice', 'approve_preparation', 'withdraw_preparation']);
});

for (const mode of ['active', 'uncertain']) test(`${mode} physical resin run cannot expose preparation withdrawal`, async ({ page, workspace }) => {
  await approve(page, workspace); await enableDispatch(page); await openJob(page, workspace); await review(page);
  workspace.adapter.uncertainStart = mode === 'uncertain';
  await page.getByRole('button', { name: 'Start one resin unit', exact: true }).click();
  await page.getByRole('checkbox', { name: /The correct resin is loaded, the build plate is clear/ }).check();
  const dispatchResponse = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${workspace.job.id}/resin/production/dispatch`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start one resin unit', exact: true }).click();
  const response = await dispatchResponse;
  expect(response.status()).toBe(mode === 'active' ? 200 : 504);
  if (mode === 'active') await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
  else await expect(page.getByRole('alert')).toContainText('Fixture physical start acknowledgement is uncertain.');
  const guarded = await page.request.post(`${workspace.url}/api/jobs/${workspace.job.id}/resin/production/withdraw`, { headers: { Authorization: `Bearer ${workspace.token}` }, data: { receiptId: workspace.remote.receipt.id, reason: 'This physical run is still unresolved.' } });
  expect(guarded.status()).toBe(409);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await openJob(page, workspace); await review(page);
  await expect(page.getByRole('button', { name: 'Reopen preparation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start one resin unit', exact: true })).toHaveCount(0);
  const current = workspace.service.getJob(workspace.job.id);
  expect(current.currentRunId).toBeTruthy(); expect(current.status).toBe(mode === 'active' ? 'printing' : 'needs_attention');
  expect(workspace.remote.writes.filter(value => value.action === 'withdraw_preparation')).toHaveLength(0);
  expect(workspace.adapter.calls.filter(([action]) => action === 'start')).toHaveLength(1);
});
