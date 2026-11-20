'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');
const { createProfile, makeSlice, importTicket, goo, hash } = require('../helpers/resin-slice');

test('operator configures resin tools, confirms ticket size/profile and downloads a captured slice', async ({ page }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-browser-'));
  let calls = 0;
  const app = await startServer({ dataDir: directory, port: 0, resinEngine: { prepareResin: input => { calls++; return makeSlice(input); } } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const config = await createProfile(directory);
    const job = await importTicket(app.service, { project: { targetDimensions: 'Already present in model', scale: 'Original size' } });
    await page.goto(app.url);
    await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
    await page.locator(`button[data-action="job"][data-id="${job.id}"]`).first().click();
    await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeDisabled();
    await expect(page.getByText('Already present in model', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('nav').getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByLabel('PrusaSlicer console executable', { exact: true }).fill(config.prusaExecutable);
    await page.getByLabel('UVtools command executable', { exact: true }).fill(config.uvtoolsExecutable);
    await page.getByLabel('Resin engine profile JSON', { exact: true }).fill(config.profilePath);
    await page.getByLabel('Maximum time per resin operation (seconds)', { exact: true }).fill('10');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByText('Workspace settings saved.', { exact: true })).toBeVisible();
    expect(app.service.getSettings().resinEngine.profilePath).toBe(config.profilePath);
    await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
    await page.locator(`button[data-action="job"][data-id="${job.id}"]`).first().click();
    const slice = page.getByRole('button', { name: 'Slice resin model', exact: true });
    await expect(slice).toBeEnabled();
    await slice.click(); expect(calls).toBe(0);
    await page.locator('input[name="confirmedRequirements"]').check();
    await page.locator('input[name="confirmedOriginalSize"]').check();
    await slice.click();
    await expect(page.locator('.job-action-panel strong')).toHaveText('Slice captured for qualification');
    expect(calls).toBe(1);
    expect(app.service.getJob(job.id).resinSlice.printReady).toBe(false);
    expect(app.service.getJob(job.id).order.project.scale).toBe('Original size');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download captured GOO', exact: true }).click();
    const artifact = await download;
    expect(artifact.suggestedFilename()).toBe('prepared-unqualified.goo');
    expect(hash(await fs.readFile(await artifact.path()))).toBe(hash(goo()));
    expect(errors).toEqual([]);
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('resin print issues stay visible in the job review panel', async ({ page }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-browser-'));
  const app = await startServer({ dataDir: directory, port: 0, resinEngine: { prepareResin: input => makeSlice(input, { issues: 1 }) } });
  try {
    await app.service.updateSettings({ resinEngine: await createProfile(directory) });
    const job = await importTicket(app.service);
    await page.goto(app.url);
    await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
    await page.locator(`button[data-action="job"][data-id="${job.id}"]`).first().click();
    await page.locator('input[name="confirmedRequirements"]').check();
    await page.locator('input[name="confirmedOriginalSize"]').check();
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
    await expect(page.locator('.job-action-panel strong')).toHaveText('Print issues require review');
    await expect(page.getByText('Island 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download captured GOO', exact: true })).toBeVisible();
    expect(app.service.getJob(job.id).status).toBe('review');
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
