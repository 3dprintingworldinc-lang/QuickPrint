'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');
const { measureResinGeometry } = require('../../src/slicing/resin-geometry');
const { MODEL, createProfile, makeSlice, importTicket } = require('../helpers/resin-slice');

test('operator measures the original, reviews a uniform source-axis resize and slices the verified millimetre mesh', async ({ page }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-sizing-browser-'));
  let calls = 0;
  const app = await startServer({ dataDir, port: 0, resinEngine: { prepareResin: input => { calls++; return makeSlice(input); } } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.service.updateSettings({ resinEngine: await createProfile(dataDir) });
    const job = await importTicket(app.service, { project: { scale: '200%', targetDims: '6 mm tall in the source Z axis' } });
    await page.goto(app.url);
    await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
    await page.locator(`button[data-action="job"][data-id="${job.id}"]`).first().click();
    await expect(page.getByLabel('Sizing method')).toHaveValue('original');
    await expect(page.locator('#resin-sizing-mode option[value="dimension"]')).toBeDisabled();
    await page.getByRole('button', { name: 'Measure model', exact: true }).click();
    await expect(page.getByText('Measured source: 3 × 3 × 3 mm (X × Y × Z).', { exact: true })).toBeVisible();
    await page.getByLabel('Sizing method').selectOption('dimension');
    await page.getByLabel('Source axis', { exact: true }).selectOption('z');
    await page.getByLabel('Target source dimension (mm)', { exact: true }).fill('6');
    await expect(page.getByText('Expected model: 6 × 6 × 6 mm before orientation and supports.', { exact: true })).toBeVisible();
    await expect(page.locator('input[name="confirmedOriginalSize"]')).toBeHidden();
    await page.locator('input[name="confirmedRequirements"]').check();
    await page.locator('input[name="confirmedSizing"]').check();
    await page.getByLabel('Target source dimension (mm)', { exact: true }).fill('7');
    await expect(page.locator('input[name="confirmedSizing"]')).not.toBeChecked();
    await page.getByLabel('Target source dimension (mm)', { exact: true }).fill('6');
    await page.setViewportSize({ width: 480, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.locator('input[name="confirmedSizing"]').check();
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
    await expect(page.locator('.job-action-panel strong')).toHaveText('Slice captured for qualification');
    const slice = app.service.getJob(job.id).resinSlice;
    expect(calls).toBe(1); expect(slice.sizingPlan.uniformScale).toBe(2);
    expect(slice.operatorReview).toMatchObject({ confirmedOriginalSize: false, confirmedSizing: true, sizing: { mode: 'dimension', axis: 'z', millimeters: 6 } });
    expect(measureResinGeometry(await fs.readFile(slice.inputGeometry.filePath), { format: 'stl', units: 'mm' }).sourceDimensionsMm).toEqual({ x: 6, y: 6, z: 6 });
    expect(await fs.readFile(job.inputPath)).toEqual(MODEL); expect(slice.printReady).toBe(false); expect(errors).toEqual([]);
  } finally { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('a paid STEP ticket remains reviewable with conversion required before measurement or slicing', async ({ page }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-step-browser-'));
  let calls = 0;
  const app = await startServer({ dataDir, port: 0, resinEngine: { prepareResin: () => { calls++; throw new Error('STEP must not reach the mesh engine'); } } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.service.updateSettings({ resinEngine: await createProfile(dataDir) });
    const id = require('node:crypto').randomUUID(), portalUrl = 'https://printbylayr.example';
    const model = Buffer.from('ISO-10303-21;\nEND-ISO-10303-21;');
    const portalJob = { id, reference: `PBL-${id.toUpperCase()}`, version: 5, status: 'preparing', payment: { amountCents: 2000, confirmedAt: '2026-11-19T15:00:00Z' }, ticket: { model: { size: model.length, fileId: 'private-fixture' }, quote: { amountCents: 2000 }, specifications: { file: { name: 'source.step', format: 'step', sizeBytes: model.length, units: 'mm' }, project: { name: 'STEP study', quantity: 2 }, production: { printType: 'resin', supports: 'allowed', qualityTier: 'standard', properties: 'standard', colour: 'grey' } } } };
    const order = require('../../src/connectors/layr-client').buildOrderMetadata(portalJob, portalUrl, model);
    const job = (await app.service.submit({ source: `layr:${portalUrl}`, sourceId: `${id}:${order.ticketFingerprint}`, quantity: 1, order, files: [{ name: 'source.step', data: model }] })).jobs[0];
    await page.goto(app.url);
    await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
    await page.locator(`button[data-action="job"][data-id="${job.id}"]`).first().click();
    await expect(page.getByText('To prepare this STEP model, configure FreeCAD and the CAD transfer audit runtime in Settings.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Measure model', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeDisabled();
    expect(await fs.readFile(job.inputPath)).toEqual(model);
    expect(app.service.getJob(job.id)).toMatchObject({ status: 'review', runs: [], acceptedQuantity: 0 });
    expect(calls).toBe(0); expect(errors).toEqual([]);
  } finally { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('STEP preparation retains the CAD source and applies embedded units once before reviewed resizing', async ({ page }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-cad-browser-'));
  const { createCadFixture, STEP } = require('../helpers/resin-cad');
  const cad = await createCadFixture(path.join(dataDir, 'provider'), { descriptors: [{ origin: [10,20,30], dimensions: [2,3,4] }] });
  const inputs = [];
  const app = await startServer({ dataDir: path.join(dataDir, 'workspace'), port: 0, resinCad: cad.implementation,
    resinEngine: { prepareResin: input => { inputs.push(input); return makeSlice(input); } } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await app.service.updateSettings({ resinEngine: { ...(await createProfile(dataDir)), freecadExecutable: cad.options.freecadExecutable, cadAuditPath: cad.options.cadAuditPath } });
    const id = require('node:crypto').randomUUID(), portalUrl = 'https://printbylayr.example';
    const portalJob = { id, reference: `PBL-${id.toUpperCase()}`, version: 5, status: 'preparing', payment: { amountCents: 2000, confirmedAt: '2026-11-19T15:00:00Z' }, ticket: { model: { size: STEP.length, fileId: 'private-fixture' }, quote: { amountCents: 2000 }, specifications: { file: { name: 'source.step', format: 'step', sizeBytes: STEP.length, units: 'in' }, project: { name: 'CAD resizing study', quantity: 2, targetDims: '8 mm tall along source Z' }, production: { printType: 'resin', supports: 'allowed', qualityTier: 'standard', properties: 'standard', colour: 'grey' } } } };
    const order = require('../../src/connectors/layr-client').buildOrderMetadata(portalJob, portalUrl, STEP);
    const job = (await app.service.submit({ source: `layr:${portalUrl}`, sourceId: `${id}:${order.ticketFingerprint}`, quantity: 1, order, files: [{ name: 'source.step', data: STEP }] })).jobs[0];
    await page.goto(app.url);
    await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
    await page.locator(`button[data-action="job"][data-id="${job.id}"]`).first().click();
    await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Prepare STEP geometry', exact: true }).click();
    expect(cad.calls).toHaveLength(0);
    await page.locator('[name="confirmedEmbeddedUnits"]').check();
    await page.getByRole('button', { name: 'Prepare STEP geometry', exact: true }).click();
    await expect(page.getByText('Measured source: 2 × 3 × 4 mm (X × Y × Z).', { exact: true })).toBeVisible();
    expect(cad.calls).toHaveLength(2); expect(inputs).toHaveLength(0);
    await page.getByLabel('Sizing method').selectOption('dimension');
    await page.getByLabel('Source axis', { exact: true }).selectOption('z');
    await page.getByLabel('Target source dimension (mm)', { exact: true }).fill('8');
    await expect(page.getByText('Expected model: 4 × 6 × 8 mm before orientation and supports.', { exact: true })).toBeVisible();
    await page.locator('[name="confirmedRequirements"]').check(); await page.locator('[name="confirmedSizing"]').check();
    const response = page.waitForResponse(value => value.url().endsWith(`/api/jobs/${job.id}/resin/slice`) && value.request().method() === 'POST');
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
    expect((await response).ok()).toBe(true);
    await expect(page.getByText('Slice captured for qualification', { exact: true })).toBeVisible();
    const current = app.service.getJob(job.id), slice = current.resinSlice;
    expect(inputs).toHaveLength(1); expect(inputs[0].unitScale).toBe(1); expect(inputs[0].inputPath).toBe(current.resinCad.filePath);
    expect(slice.sourceSha256).toBe(job.sha256); expect(slice.meshSourceSha256).toBe(current.resinCad.sha256);
    expect(slice.tool.executableSha256).not.toBe(slice.rawSliceTool.executableSha256);
    expect(slice.operatorReview).toMatchObject({ embeddedUnits: true, ticketUnits: 'in', units: 'mm', unitScale: 1 });
    expect(measureResinGeometry(await fs.readFile(slice.inputGeometry.filePath), { format: 'stl', units: 'mm' }).sourceDimensionsMm).toEqual({ x: 4, y: 6, z: 8 });
    expect(await fs.readFile(job.inputPath)).toEqual(STEP); expect(current.runs).toEqual([]); expect(current.acceptedQuantity).toBe(0); expect(slice.printReady).toBe(false); expect(errors).toEqual([]);
  } finally { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});
