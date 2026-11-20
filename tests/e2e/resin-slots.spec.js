'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');
const { createProfile, importTicket, makeSlice } = require('../helpers/resin-slice');

test('operator configures two independent resin slots, customizes a profile copy and selects it for an order', async ({ page }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-resin-slots-browser-'));
  const app = await startServer({ dataDir: directory, port: 0, resinEngine: { prepareResin: makeSlice } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const config = await createProfile(directory), original = await fs.readFile(config.profilePath);
    const job = await importTicket(app.service);
    await page.goto(app.url);
    await page.locator('nav').getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByLabel('PrusaSlicer console executable', { exact: true }).fill(config.prusaExecutable);
    await page.getByLabel('UVtools command executable', { exact: true }).fill(config.uvtoolsExecutable);
    for (const name of ['Grey standard · 50 µm', 'Custom tough resin']) {
      await page.getByRole('button', { name: 'Add resin slot', exact: true }).click();
      const row = page.locator('.resin-profile-slot').last();
      await row.getByRole('textbox', { name: 'Slot name', exact: true }).fill(name);
      await row.getByRole('textbox', { name: 'Slot profile JSON', exact: true }).fill(config.profilePath);
    }
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByText('Workspace settings saved.', { exact: true })).toBeVisible();
    const slots = app.service.getSettings().resinEngine.slots;
    expect(slots).toHaveLength(2);
    await page.locator('.resin-profile-slot').nth(1).getByRole('button', { name: 'Customize profile', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('Customize Custom tough resin', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Resin / material profile', exact: true }).fill('Tough resin · custom review profile');
    await page.getByRole('textbox', { name: 'Orientation candidates (X, Y, Z degrees)', exact: true }).fill('0, 0, 0\n30, 15, 0');
    await expect(page.getByRole('spinbutton', { name: 'Normal exposure (seconds)', exact: true })).toHaveValue('2');
    await page.getByRole('button', { name: 'Save profile copy', exact: true }).click();
    await expect(page.getByText('Custom resin profile saved to this slot.', { exact: true })).toBeVisible();
    const changed = app.service.getSettings().resinEngine.slots;
    expect(changed[0].profilePath).toBe(config.profilePath);
    expect(changed[1].profilePath).not.toBe(config.profilePath);
    expect(await fs.readFile(config.profilePath)).toEqual(original);
    await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
    await page.locator(`button[data-action="job"][data-id="${job.id}"]`).first().click();
    await expect(page.getByLabel('Resin profile slot', { exact: true })).toHaveValue('');
    await page.getByLabel('Resin profile slot', { exact: true }).selectOption(slots[1].id);
    await page.locator('input[name="confirmedRequirements"]').check();
    await page.locator('input[name="confirmedOriginalSize"]').check();
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
    await expect(page.locator('.job-action-panel strong')).toHaveText('Slice captured for qualification');
    const slice = app.service.getJob(job.id).resinSlice;
    expect(slice.material).toBe('Tough resin · custom review profile');
    expect(slice.operatorReview.profileSlotId).toBe(slots[1].id);
    expect(slice.printReady).toBe(false);
    expect(errors).toEqual([]);
  } finally { await app.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
