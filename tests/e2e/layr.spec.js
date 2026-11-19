'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test: base, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');
const { LayrOAuth } = require('../../src/connectors/layr-oauth');
const { buildOrderMetadata, ticketFingerprint } = require('../../src/connectors/layr-client');
const productionClient = require('../../src/connectors/layr-production-client');
const { createProfile, makeSlice } = require('../helpers/resin-slice');

const PORTAL = 'https://printbylayr.example';
const CODE = 'a'.repeat(43);
const MODEL = Buffer.from('solid fixture\nendsolid fixture\n');
const PROJECT = 'Resin <Fixture> & assembly';
const NOTES = 'Keep <b data-fixture-injection="yes">detail</b> & no visible supports.';
const PROBE_ERROR = 'Fixture SatelLite evaluation produced no validated output.';
const MACHINE_TOKEN = 'm'.repeat(43);

function preparationJob() {
  return {
    id: '00000000-0000-4000-8000-000000000009', reference: 'PBL-RESIN-009', version: 7, status: 'preparing',
    payment: { amountCents: 2150, reference: 'bank-fixture', confirmedAt: '2026-11-19T15:00:00.000Z' },
    ticket: {
      specifications: {
        production: { printType: 'resin', qualityTier: 'presentation', colour: 'grey', properties: 'standard', supports: 'no-visible' },
        project: { name: PROJECT, quantity: 7, scale: '100%', targetDims: '80 × 40 × 20 mm', notes: NOTES },
        file: { name: 'resin-part.stl', format: 'stl', sizeBytes: MODEL.length, units: 'mm' },
      },
      model: { size: MODEL.length }, quote: { amountCents: 2150 },
    },
  };
}

// Browser navigation, local HTTP, OAuth credential storage, connector polling,
// and model receipt are real. All remote service and native printer/slicer
// interfaces are fixtures, so these tests cannot start software or hardware.
const test = base.extend({
  workspace: async ({}, use) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-layr-browser-'));
    const job = preparationJob();
    const calls = { downloads: 0, list: 0, probes: [], fdmPreparations: 0, adapters: 0 };
    const machine = { version: job.version, mode: 'success', writes: [], operations: new Map(), releases: [] };
    const machineTicket = () => ({ id: job.id, reference: job.reference, version: machine.version, status: 'preparing', ticketFingerprint: ticketFingerprint(job),
      ticket: { specifications: structuredClone(job.ticket.specifications) }, production: null });
    const oauth = new LayrOAuth({ fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url === `${PORTAL}/oauth/register`) return Response.json({ client_id: `pbl_${'c'.repeat(22)}`, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' }, { status: 201 });
      if (url === `${PORTAL}/oauth/token`) return Response.json({ access_token: 't'.repeat(43), token_type: 'Bearer', expires_in: 3600, refresh_token: 'r'.repeat(43), scope: 'studio' });
      throw new Error('Unexpected OAuth fixture endpoint.');
    } });
    const instance = await startServer({
      dataDir: path.join(directory, 'data'), port: 0, layrOAuth: oauth,
      layrClient: {
        listPreparationJobs: async () => { calls.list++; return [structuredClone(job)]; },
        ticketFingerprint,
        downloadModel: async (config, current) => {
          calls.downloads++;
          return { name: 'resin-part.stl', data: Buffer.from(MODEL), order: buildOrderMetadata(current, config.portalUrl, MODEL) };
        },
      },
      layrProductionClient: {
        ticketFingerprint: productionClient.ticketFingerprint,
        listPreparationJobs: async config => { expect(config.token).toBe(MACHINE_TOKEN); calls.list++; return [machineTicket()]; },
        getTicket: async (config, id) => { expect(config.token).toBe(MACHINE_TOKEN); expect(id).toBe(job.id); return { ticket: machineTicket() }; },
        downloadModel: async (config, current) => { calls.downloads++; return { name: 'resin-part.stl', data: Buffer.from(MODEL), order: productionClient.buildOrderMetadata(current, config.portalUrl, MODEL) }; },
        postEvidence: async (config, command, { signal } = {}) => {
          expect(config.token).toBe(MACHINE_TOKEN);
          expect(command.action).toBe('record_slice');
          const body = JSON.stringify(command); machine.writes.push(body);
          if (machine.mode === 'hold') await new Promise((resolve, reject) => {
            machine.releases.push(resolve);
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          const prior = machine.operations.get(command.operationId);
          if (prior) { expect(body).toBe(prior.body); return structuredClone(prior.result); }
          if (machine.mode === 'conflict') { machine.version = Math.max(machine.version, command.version + 1); throw Object.assign(new Error('Fixture version conflict'), { status: 409 }); }
          if (command.version !== machine.version) throw Object.assign(new Error('Fixture version conflict'), { status: 409 });
          machine.version++;
          const result = { ticket: machineTicket(), receipt: { id: command.operationId, jobId: command.id, ticketFingerprint: command.data.ticketFingerprint,
            sourceSha256: command.data.sourceSha256, qualified: false, printReady: false } };
          machine.operations.set(command.operationId, { body, result });
          return structuredClone(result);
        },
      },
      satellite: {
        inspectInstallation: async () => ({ installed: false, available: false }),
        preprocess: async options => {
          calls.probes.push(options);
          throw Object.assign(new Error(PROBE_ERROR), { code: 'SATELLITE_OUTPUT_MISSING', status: 422 });
        },
      },
      slicer: { prepare: async () => { calls.fdmPreparations++; throw new Error('FDM preparation must not handle a resin ticket.'); } },
      adapters: () => { calls.adapters++; throw new Error('No physical printer connection is allowed in this fixture.'); },
    });
    const capture = async id => {
      const current = instance.service.getJob(id);
      const settings = await createProfile(directory);
      const slice = await makeSlice({ inputPath: current.inputPath, outputDir: path.join(instance.service.dataDir, 'jobs', id, 'resin-slicing'), ...settings });
      slice.tool.binaryManifest = [{ path: 'C:/private/test-binary.dll', sha256: 'a'.repeat(64) }];
      await instance.service._mutate(() => { instance.service._job(id).resinSlice = { ...slice, printReady: false, printerCompatible: false, finishedAt: new Date().toISOString() }; });
    };
    try { await use({ ...instance, directory, calls, machine, capture }); }
    finally { machine.releases.forEach(resolve => resolve()); await instance.close(); await fs.rm(directory, { recursive: true, force: true }); }
  },
});

test.beforeEach(async ({ page, context, workspace }) => {
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === PORTAL && url.pathname === '/oauth/authorize') {
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', CODE);
      callback.searchParams.set('state', url.searchParams.get('state'));
      callback.searchParams.set('iss', PORTAL);
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><title>Fixture PrintByLayr consent</title><h1>Approve fixture studio access</h1><a href="${callback.href.replaceAll('&', '&amp;')}">Approve test connection</a></html>` });
    } else if (url.origin === new URL(workspace.url).origin) await route.continue();
    else await route.abort();
  });
  await page.goto(workspace.url);
  await expect(page.locator('#connection-status')).toContainText('Workspace online');
});

async function connectAndImport(page, workspace) {
  await page.locator('nav').getByRole('link', { name: 'Inputs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PrintByLayr resin orders', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Connect PrintByLayr', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Connect PrintByLayr', exact: true })).toBeVisible();
  await expect(dialog.getByText(/portal currently grants studio access/)).toBeVisible();
  await page.getByLabel('Order portal address').fill(PORTAL);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in to portal', exact: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(new RegExp(`^${PORTAL.replaceAll('.', '\\.')}/oauth/authorize\\?`));
  const authorization = new URL(popup.url());
  expect(authorization.searchParams.get('redirect_uri')).toBe(`${workspace.url}/integrations/layr/callback`);
  expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorization.searchParams.get('scope')).toBe('studio');
  await popup.getByRole('link', { name: 'Approve test connection', exact: true }).click();
  await expect(popup.getByRole('heading', { name: 'PrintByLayr connected', exact: true })).toBeVisible();
  await popup.close();
  await page.bringToFront();
  await page.locator('.topbar [data-action="refresh"]').click();
  const connectorRow = page.locator('.connector-row').filter({ hasText: 'PrintByLayr resin orders' });
  await expect(connectorRow).toBeVisible();
  await expect(connectorRow).toContainText(PORTAL);
  // A user can check immediately; scheduled import uses the same real manager.
  await connectorRow.getByRole('button', { name: 'Check PrintByLayr resin orders now', exact: true }).click();
  await expect.poll(() => workspace.service.snapshot().jobs.length).toBe(1);
  expect(workspace.calls.downloads).toBe(1);
  const [job] = workspace.service.snapshot().jobs;
  await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: job.name, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
  return job;
}

test('PrintByLayr browser sign-in imports a paid resin ticket with escaped requirements and separate part quantity', async ({ page, workspace }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const job = await connectAndImport(page, workspace);
  expect(job).toMatchObject({ technology: 'resin', quantity: 1, status: 'review', acceptedQuantity: 0, order: { requestedQuantity: 7, portalVersion: 7, units: 'mm', production: { supports: 'no-visible' } } });
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Requested parts', { exact: true })).toBeVisible();
  await expect(dialog.getByText('7 parts requested · model units mm · presentation quality', { exact: true })).toBeVisible();
  await expect(dialog.getByText('grey resin · standard · supports: no-visible', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Awaiting resin qualification', { exact: true })).toBeVisible();
  await expect(dialog.locator('.file-name')).toHaveText(job.name);
  await expect(dialog.locator('.body-copy')).toContainText(NOTES);
  await expect(dialog.locator('[data-fixture-injection]')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Prepare file', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Start one copy', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Target printer', { exact: true })).toHaveCount(0);
  await dialog.getByText('SatelLite preparation probe', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Probe SatelLite evaluation', exact: true })).toBeVisible();
  expect(job.runs).toEqual([]);
  expect(workspace.calls.fdmPreparations).toBe(0);
  expect(workspace.calls.adapters).toBe(0);
  expect(errors).toEqual([]);
});

test('SatelLite probe failure is visible while the resin order remains in review', async ({ page, workspace }) => {
  const job = await connectAndImport(page, workspace);
  await page.getByRole('dialog').getByText('SatelLite preparation probe', { exact: true }).click();
  const responsePromise = page.waitForResponse(response => response.url().endsWith(`/api/jobs/${job.id}/resin/preprocess`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Probe SatelLite evaluation', exact: true }).click();
  expect((await responsePromise).status()).toBe(422);
  await expect(page.getByRole('dialog').getByText(PROBE_ERROR, { exact: true })).toBeVisible();
  expect(workspace.calls.probes).toHaveLength(1);
  expect(workspace.calls.probes[0].evaluate).toBe(true);
  const current = workspace.service.getJob(job.id);
  expect(current).toMatchObject({ status: 'review', error: PROBE_ERROR, acceptedQuantity: 0, currentRunId: null });
  expect(current.artifact).toBeUndefined();
  expect(current.runs).toEqual([]);
  expect(workspace.calls.fdmPreparations).toBe(0);
  expect(workspace.calls.adapters).toBe(0);
});

async function connectMachineAndImport(page, workspace) {
  await page.locator('nav').getByRole('link', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Connect PrintByLayr', exact: true }).click();
  await page.getByRole('button', { name: 'Use machine API', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Connect the production API', exact: true })).toBeVisible();
  await dialog.getByLabel('Order portal address').fill(`${PORTAL}/`);
  const token = dialog.getByLabel('Production machine token');
  await expect(token).toHaveAttribute('type', 'password');
  await token.fill(MACHINE_TOKEN);
  const automatic = dialog.getByRole('checkbox', { name: /Send validated slice receipts automatically/ });
  await expect(automatic).toBeChecked();
  await automatic.uncheck();
  const savedResponse = page.waitForResponse(response => response.url().endsWith('/api/connectors') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Connect machine API', exact: true }).click();
  expect((await savedResponse).ok()).toBe(true);
  await expect.poll(() => workspace.service.getConnectors().length).toBe(1);
  const [connector] = workspace.service.getConnectors();
  expect(connector).toMatchObject({ apiMode: 'production', portalUrl: PORTAL, hasToken: true, autoSyncPreparation: false });
  expect(connector.token).toBeUndefined();
  const file = await fs.readFile(path.join(workspace.service.dataDir, 'state.json'), 'utf8');
  expect(file).not.toContain(MACHINE_TOKEN);
  expect(JSON.parse(file).connectors[0].token.protected).toBe(true);
  const row = page.locator('.connector-row').filter({ hasText: 'PrintByLayr production' });
  await expect(row).toBeVisible();
  await expect(page.locator('body')).not.toContainText(MACHINE_TOKEN);
  await row.getByRole('button', { name: 'Edit PrintByLayr production', exact: true }).click();
  await expect(page.getByLabel('Production machine token')).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: /Send validated slice receipts automatically/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await row.getByRole('button', { name: 'Check PrintByLayr production now', exact: true }).click();
  await expect.poll(() => workspace.service.snapshot().jobs.length).toBe(1);
  const [job] = workspace.service.snapshot().jobs;
  await workspace.capture(job.id);
  await page.locator('.topbar [data-action="refresh"]').click();
  await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.getByRole('button', { name: job.name, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Queue slice receipt', exact: true })).toBeVisible();
  return { job, connector };
}

async function stateFromApi(page, workspace) {
  const response = await page.request.get(`${workspace.url}/api/state`, { headers: { Authorization: `Bearer ${workspace.token}` } });
  expect(response.ok()).toBe(true);
  return response.json();
}

test('machine API form stores its token privately and shows pending then confirmed preparation evidence', async ({ page, workspace }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const { job, connector } = await connectMachineAndImport(page, workspace);
  workspace.machine.mode = 'hold';
  await page.getByRole('button', { name: 'Queue slice receipt', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/record_slice · pending/)).toBeVisible();
  const poll = page.request.post(`${workspace.url}/api/connectors/${connector.id}/poll`, { headers: { Authorization: `Bearer ${workspace.token}` }, data: {} });
  await expect.poll(() => workspace.machine.writes.length).toBe(1);
  expect((await stateFromApi(page, workspace)).productionOutbox[0].state).toBe('pending');
  workspace.machine.mode = 'success'; workspace.machine.releases.forEach(resolve => resolve());
  expect((await poll).ok()).toBe(true);
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/record_slice · confirmed/)).toBeVisible();
  await expect(page.getByRole('dialog').getByText(/portal version 8/)).toBeVisible();
  const [receipt] = (await stateFromApi(page, workspace)).productionOutbox;
  expect(receipt).toMatchObject({ state: 'confirmed', confirmation: { status: 'preparing', version: 8, qualified: false } });
  expect(JSON.parse(workspace.machine.writes[0]).data.tool.binaryManifest).toBeUndefined();
  expect(workspace.machine.writes[0]).not.toContain('C:/private');
  expect(workspace.service.getJob(job.id)).toMatchObject({ status: 'review', runs: [], resinSlice: { printReady: false, printerCompatible: false } });
  await expect(page.getByRole('button', { name: 'Start one copy', exact: true })).toHaveCount(0);
  expect(workspace.calls.adapters).toBe(0);
  expect(errors).toEqual([]);
});

test('machine receipt conflicts are visible and can be dismissed locally without dropping their history', async ({ page, workspace }) => {
  const { connector } = await connectMachineAndImport(page, workspace);
  workspace.machine.mode = 'conflict';
  await page.getByRole('button', { name: 'Queue slice receipt', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/record_slice · pending/)).toBeVisible();
  const poll = await page.request.post(`${workspace.url}/api/connectors/${connector.id}/poll`, { headers: { Authorization: `Bearer ${workspace.token}` }, data: {} });
  expect(poll.ok()).toBe(true);
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/record_slice · conflict/)).toBeVisible();
  const before = (await stateFromApi(page, workspace)).productionOutbox[0];
  await page.getByRole('button', { name: 'Dismiss held evidence', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dismiss held evidence', exact: true })).toBeVisible();
  await page.getByLabel('Reason for dismissing this evidence').fill('Reviewed the newer portal version; retry with a fresh receipt.');
  await page.getByRole('button', { name: 'Dismiss evidence', exact: true }).click();
  await expect(page.getByText('Held evidence dismissed locally. Its history is preserved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByText(/record_slice · dismissed/)).toBeVisible();
  const resolved = (await stateFromApi(page, workspace)).productionOutbox[0];
  expect(resolved).toMatchObject({ operationId: before.operationId, state: 'dismissed', resolution: { reason: 'Reviewed the newer portal version; retry with a fresh receipt.' } });
  expect(workspace.machine.operations.size).toBe(0);
  workspace.machine.mode = 'success';
  await page.getByRole('button', { name: 'Queue slice receipt', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/record_slice · pending/)).toBeVisible();
  await page.request.post(`${workspace.url}/api/connectors/${connector.id}/poll`, { headers: { Authorization: `Bearer ${workspace.token}` }, data: {} });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(/record_slice · confirmed/)).toBeVisible();
  const final = (await stateFromApi(page, workspace)).productionOutbox;
  expect(final).toHaveLength(2);
  expect(final[0].state).toBe('dismissed'); expect(final[1].state).toBe('confirmed');
  expect(workspace.machine.operations.size).toBe(1);
  expect(workspace.calls.adapters).toBe(0);
});
