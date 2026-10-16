'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test: base, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');

// Every test uses a real HTTP server and isolated persistent data. Printer
// transport is injected so browser tests cannot reach a physical printer.
const test = base.extend({
  workspace: async ({}, use) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-browser-'));
    const transports = new Map();
    const instance = await startServer({
      dataDir: path.join(directory, 'data'),
      port: 0,
      adapters: printer => {
        const transport = { state: 'idle', progress: 0, starts: 0, uploads: [] };
        transports.set(printer.id, transport);
        return {
          capabilities: { upload: true, start: true, pause: true, resume: true, cancel: true, formats: ['gcode'] },
          status: async () => ({
            state: transport.state, progress: transport.progress,
            currentFile: transport.currentFile, remoteId: transport.remoteId, outcome: transport.outcome,
            observedAt: new Date().toISOString(), message: 'Test adapter is available.',
          }),
          upload: async ({ filePath, fileName }) => {
            transport.uploads.push({ fileName, data: await fs.readFile(filePath, 'utf8') });
            return { remotePath: fileName };
          },
          start: async ({ remotePath, jobId }) => {
            Object.assign(transport, { state: 'printing', progress: 0, currentFile: remotePath, remoteId: jobId, outcome: undefined });
            transport.starts += 1;
            return { acknowledged: true, remoteId: jobId };
          },
          close: async () => {},
        };
      },
    });
    try { await use({ ...instance, directory, transports }); }
    finally {
      await instance.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
});

test.beforeEach(async ({ page, workspace }) => {
  await page.goto(workspace.url);
  await expect(page.getByRole('heading', { name: 'Your print floor, at a glance.' })).toBeVisible();
  await expect(page.locator('#connection-status')).toContainText('Workspace online');
});

async function navigate(page, name) {
  await page.locator('nav').getByRole('link', { name, exact: true }).click();
  await expect(page.locator('#breadcrumb-title')).toHaveText(name);
}

async function uploadJob(page, name = 'Test bracket') {
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await page.locator('#upload-files').setInputFiles({
    name: 'bracket.gcode', mimeType: 'text/plain',
    buffer: Buffer.from('; test submission\nG28\nG1 X10 Y10\n'),
  });
  await page.getByLabel('Job / order name').fill(name);
  await page.getByLabel('Customer or project').fill('Makerspace prototype');
  await page.getByLabel('Copies per file').fill('2');
  await page.getByLabel('Print requirements').fill('PLA · inspect fit before the second copy.');
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
}

test('real file upload creates a review job, downloads its original, and can be cancelled', async ({ page, workspace }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.getByText('A little quiet on the print floor.')).toBeVisible();
  expect(workspace.service.snapshot().jobs).toHaveLength(0);

  await uploadJob(page);
  const [job] = workspace.service.snapshot().jobs;
  expect(job).toMatchObject({ name: 'Test bracket', quantity: 2, acceptedQuantity: 0, status: 'review' });
  await page.getByRole('button', { name: 'Test bracket', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Job details' })).toBeVisible();
  await expect(page.getByText('PLA · inspect fit before the second copy.', { exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Original file' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('bracket.gcode');
  expect(await fs.readFile(await download.path(), 'utf8')).toContain('G1 X10 Y10');

  await page.getByRole('button', { name: 'Cancel job', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.badge')).toHaveText('Cancelled');
  expect(workspace.service.getJob(job.id).status).toBe('cancelled');
  expect(errors).toEqual([]);
});

test('a mutation refresh waits for a fresh snapshot when an older response is in flight', async ({ page, workspace }) => {
  // Hold a genuine server snapshot taken before submission. Other endpoints
  // remain real. Releasing this old snapshot must not hide the new job.
  let releaseSnapshot;
  const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
  let snapshotCaptured;
  const captured = new Promise(resolve => { snapshotCaptured = resolve; });
  let holdNextSnapshot = true;
  let snapshotsRequested = 0;
  await page.route('**/api/state', async route => {
    snapshotsRequested += 1;
    const response = await route.fetch();
    if (holdNextSnapshot) {
      holdNextSnapshot = false;
      snapshotCaptured();
      await snapshotGate;
    }
    await route.fulfill({ response });
  });

  try {
    await page.locator('.topbar [data-action="refresh"]').click();
    await captured;
    await page.getByRole('button', { name: 'New job', exact: true }).click();
    await page.locator('#upload-files').setInputFiles({
      name: 'overlap.gcode', mimeType: 'text/plain', buffer: Buffer.from('G28\nG1 X1 Y1\n'),
    });
    await page.getByLabel('Job / order name').fill('Visible after overlapping refresh');
    const uploadResponse = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
    expect((await uploadResponse).status()).toBe(201);
    expect(workspace.service.snapshot().jobs).toHaveLength(1);
    releaseSnapshot();
    await expect(page.getByRole('button', { name: 'Visible after overlapping refresh', exact: true })).toBeVisible();
    expect(snapshotsRequested).toBeGreaterThanOrEqual(2);
  } finally {
    releaseSnapshot();
  }
});

test('prepared job requires explicit starts and operator acceptance for every requested copy', async ({ page, workspace }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await navigate(page, 'Printers');
  await page.getByRole('button', { name: 'Add printer', exact: true }).click();
  await page.getByLabel('Printer name').fill('Mock Klipper');
  await page.getByLabel('Connection type').selectOption('moonraker');
  await page.getByLabel('Local host or URL').fill('127.0.0.1');
  await page.getByRole('button', { name: 'Add printer', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Mock Klipper', exact: true })).toBeVisible();
  const [printer] = workspace.service.snapshot().printers;

  await uploadJob(page, 'Two-copy production run');
  const [job] = workspace.service.snapshot().jobs;
  await page.getByRole('button', { name: 'Two-copy production run', exact: true }).click();
  await page.getByLabel('Target printer').selectOption(printer.id);
  await page.getByRole('button', { name: 'Prepare file', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.badge')).toHaveText('Ready to print');
  expect(workspace.service.getJob(job.id)).toMatchObject({ status: 'ready', printerId: printer.id, acceptedQuantity: 0 });
  expect(workspace.service.getJob(job.id).artifact.format).toBe('gcode');

  const runIds = [];
  for (let copy = 1; copy <= 2; copy += 1) {
    await page.getByRole('button', { name: 'Start one copy', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ready to make this real?' })).toBeVisible();
    await expect(page.locator('#confirm-action')).toBeDisabled();
    expect(workspace.transports.get(printer.id)?.starts || 0).toBe(copy - 1);
    await page.locator('#confirm-physical').check();
    await expect(page.locator('#confirm-action')).toBeEnabled();
    await page.locator('#confirm-action').click();
    await expect(page.getByRole('dialog').locator('.badge')).toHaveText('Printing');

    const transport = workspace.transports.get(printer.id);
    expect(transport.starts).toBe(copy);
    expect(transport.uploads).toHaveLength(copy);
    expect(transport.uploads[copy - 1].data).toContain('G1 X10 Y10');
    const activeJob = workspace.service.getJob(job.id);
    runIds.push(activeJob.currentRunId);
    expect(activeJob.acceptedQuantity).toBe(copy - 1);

    // Simulate identified printer completion. The browser requests the actual
    // server refresh, which must hold the job for operator sign-off.
    Object.assign(transport, { state: 'idle', progress: 100, outcome: 'completed' });
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await expect(page.getByRole('dialog').locator('.badge')).toHaveText('Needs attention');
    expect(workspace.service.getJob(job.id).acceptedQuantity).toBe(copy - 1);
    await page.getByRole('button', { name: 'Record run outcome', exact: true }).click();
    await page.getByLabel('Run outcome').selectOption('completed');
    await page.getByLabel('Accepted from this run (0 or 1)').fill('1');
    await page.getByLabel('Operator notes').fill(`Inspected copy ${copy}.`);
    await page.getByLabel('I checked the printer and verified this outcome.').check();
    const reconcileRequest = page.waitForRequest(request => request.url().endsWith(`/api/jobs/${job.id}/reconcile`));
    await page.getByRole('button', { name: 'Record outcome', exact: true }).click();
    expect((await reconcileRequest).postDataJSON()).toMatchObject({ runId: activeJob.currentRunId, outcome: 'completed', acceptedQuantity: 1 });
    await expect(page.getByRole('dialog').locator('.badge')).toHaveText(copy === 2 ? 'Completed' : 'Ready to print');
    expect(workspace.service.getJob(job.id).acceptedQuantity).toBe(copy);
  }
  expect(new Set(runIds).size).toBe(2);
  expect(workspace.service.getJob(job.id)).toMatchObject({ status: 'completed', quantity: 2, acceptedQuantity: 2, remainingQuantity: 0, currentRunId: null });
  await expect(page.getByRole('dialog').getByText('All requested copies have been accepted. This job is complete.')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('2 / 2', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('printer form saves supported Bambu trust and per-printer profiles without exposing secrets', async ({ page, workspace }) => {
  await navigate(page, 'Printers');
  await page.getByRole('button', { name: 'Add printer', exact: true }).click();
  await page.getByLabel('Printer name').fill('Local P1S');
  await page.getByLabel('Connection type').selectOption('bambu');
  await page.getByLabel('Local host or URL').fill('127.0.0.1');
  await page.getByLabel('Bambu model').selectOption('P1S');
  await page.getByLabel('Printer serial number').fill('TEST-SERIAL');
  await page.getByLabel('LAN access code').fill('test-access-code');
  await page.getByLabel('Trusted SHA-256 certificate fingerprint').fill('a'.repeat(64));
  await page.getByText('Printer-specific slicing profiles', { exact: true }).click();
  await page.getByLabel('Use a dedicated slicer configuration for this printer').check();
  await page.locator('#printer-slicer-kind').selectOption('orca');
  const executable = path.join(workspace.directory, 'orca-slicer.exe');
  const profilePaths = ['machine.json', 'process.json', 'filament.json'].map(name => path.join(workspace.directory, name));
  await page.locator('#printer-slicer-executable').fill(executable);
  await page.getByLabel('Profile paths for this printer').fill(profilePaths.join('\n'));
  await page.getByRole('button', { name: 'Add printer', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Local P1S', exact: true })).toBeVisible();

  const [printer] = workspace.service.snapshot().printers;
  expect(printer).toMatchObject({ type: 'bambu', model: 'P1S', hasAccessCode: true, slicer: { kind: 'orca', executable, profilePaths } });
  expect(printer).not.toHaveProperty('accessCode');
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('Available', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Local P1S', exact: true }).click();
  await expect(page.getByLabel('LAN access code')).toHaveValue('');
  await expect(page.getByLabel('Use a dedicated slicer configuration for this printer')).toBeChecked();
  await page.getByLabel('Use a dedicated slicer configuration for this printer').uncheck();
  await page.getByRole('button', { name: 'Save printer', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(workspace.service.getPrinter(printer.id)).not.toHaveProperty('slicer');
  expect(workspace.service.getPrinter(printer.id).hasAccessCode).toBe(true);
});

test('folder and mailbox forms persist disabled inputs and intake credentials remain hidden by default', async ({ page, workspace }) => {
  await navigate(page, 'Inputs');
  await page.getByRole('button', { name: 'Connect a folder', exact: true }).click();
  await expect(page.locator('#connector-path')).toHaveAttribute('placeholder', 'C:\\QuickPrint\\Incoming');
  const incoming = path.join(workspace.directory, 'incoming');
  await fs.mkdir(incoming);
  await page.getByLabel('Connection name').fill('Design team folder');
  await page.getByLabel('Folder path').fill(incoming);
  await page.getByLabel('Enable this connection').uncheck();
  await page.getByRole('button', { name: 'Connect input', exact: true }).click();
  await expect(page.getByText('Design team folder', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Connect a mailbox', exact: true }).click();
  await page.getByLabel('Connection name').fill('Print submissions');
  await page.getByLabel('IMAP host').fill('127.0.0.1');
  await page.getByLabel('Mailbox username').fill('test@example.invalid');
  await page.getByLabel('App password').fill('not-a-real-secret');
  await page.getByLabel('Enable this connection').uncheck();
  await page.getByRole('button', { name: 'Connect input', exact: true }).click();
  await expect(page.getByText('Print submissions', { exact: true })).toBeVisible();
  const connectors = workspace.service.snapshot().connectors;
  expect(connectors).toHaveLength(2);
  expect(connectors.every(connector => !connector.enabled)).toBe(true);
  expect(connectors.find(connector => connector.type === 'email')).toMatchObject({ hasPassword: true, secure: true });
  expect(connectors.find(connector => connector.type === 'email')).not.toHaveProperty('password');

  await page.getByRole('button', { name: 'Set up intake API', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A direct line from your website.' })).toBeVisible();
  await expect(page.locator('#integration-token')).toHaveText(/^•+$/);
  await page.getByRole('button', { name: 'Show token', exact: true }).click();
  await expect(page.locator('#integration-token')).not.toHaveText(/^•+$/);
  await page.getByRole('button', { name: 'Hide token', exact: true }).click();
  await expect(page.locator('#integration-token')).toHaveText(/^•+$/);
});

test('workspace and slicer settings persist and an authenticated backup downloads', async ({ page, workspace }) => {
  await navigate(page, 'Settings');
  await page.getByLabel('Workspace name').fill('UI smoke workspace');
  await page.getByLabel('Printer status refresh (seconds)').fill('15');
  await page.getByLabel('Slicer', { exact: true }).selectOption('prusa');
  const executable = path.join(workspace.directory, 'prusa-slicer.exe');
  const profile = path.join(workspace.directory, 'generic.ini');
  await page.getByLabel('Executable path').fill(executable);
  await page.getByLabel('Slicing profile paths').fill(profile);
  await expect(page.locator('#profile-hint')).toContainText('INI profiles');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByText('Workspace settings saved.', { exact: true })).toBeVisible();
  expect(workspace.service.getSettings()).toMatchObject({ siteName: 'UI smoke workspace', pollIntervalMs: 15000, slicer: { kind: 'prusa', executable, profilePaths: [profile] } });
  await page.reload();
  await expect(page.getByLabel('Workspace name')).toHaveValue('UI smoke workspace');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export workspace backup', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^QuickPrint-backup-.*\.zip$/);
  const bytes = await fs.readFile(await download.path());
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
});

test('all workspace pages fit a narrow viewport with a populated job table', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await uploadJob(page, 'Mobile layout bracket');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const destination of ['Overview', 'Jobs', 'Printers', 'Inputs', 'Settings']) {
    await navigate(page, destination);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${destination} should not overflow horizontally`).toBe(true);
    await expect(page.locator('main')).toBeVisible();
  }
  await navigate(page, 'Printers');
  await page.getByRole('button', { name: 'Add printer', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});
