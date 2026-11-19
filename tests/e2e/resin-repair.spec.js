'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');
const { forEachResinTriangle, measureResinGeometry } = require('../../src/slicing/resin-geometry');
const { MODEL, createProfile, makeSlice, importTicket } = require('../helpers/resin-slice');

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function flawedCube({ open = false } = {}) {
  const triangles = [];
  forEachResinTriangle(MODEL, { format: 'stl', units: 'mm' }, points => triangles.push(points));
  const faces = open ? triangles.slice(1) : triangles.map((points, index) => index ? points : [points[0], points[2], points[1]]);
  if (!open) faces.push(triangles[0]);
  const data = Buffer.alloc(84 + faces.length * 50); data.write('Owned browser repair fixture'); data.writeUInt32LE(faces.length, 80);
  faces.forEach((points, index) => points.forEach((point, vertex) => point.forEach((value, axis) => data.writeFloatLE(value, 84 + index * 50 + 12 + vertex * 12 + axis * 4))));
  return data;
}
async function fixture(page, { open = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-repair-browser-')), inputs = [], errors = [], data = flawedCube({ open });
  const app = await startServer({ dataDir: directory, port: 0, resinEngine: { prepareResin: input => { inputs.push(input); return makeSlice(input); } } });
  page.on('pageerror', error => errors.push(error.message));
  await app.service.updateSettings({ resinEngine: await createProfile(directory) });
  const job = await importTicket(app.service, { data, project: { name: 'Exact repair study', targetDims: '6 mm source Z', quantity: 3 } }), base = `/api/jobs/${job.id}`;
  const post = (route, body) => page.request.post(app.url + route, { headers: { Authorization: `Bearer ${app.token}` }, data: body });
  const show = async () => { await page.goto(app.url); await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click(); await page.locator(`button[data-action="job"][data-id="${job.id}"]`).first().click(); };
  const repair = async () => {
    await page.getByRole('button', { name: 'Review exact mesh repair', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Repair exact mesh issues?', exact: true })).toBeVisible();
    await page.getByLabel('I reviewed the exact repair limits and will review the repaired geometry before slicing.', { exact: true }).check();
    const response = page.waitForResponse(value => value.url().endsWith(base + '/resin/repair') && value.request().method() === 'POST');
    await page.getByRole('button', { name: 'Repair exact mesh issues', exact: true }).click();
    return response;
  };
  return { app, job, base, inputs, data, errors, post, show, repair, current: () => app.service.getJob(job.id), async close() { await app.close(); if (path.dirname(directory) !== os.tmpdir()) throw new Error('Unexpected fixture cleanup path'); await fs.rm(directory, { recursive: true, force: true }); } };
}

test('explicit exact repair preserves the ticket and original, then requires fresh measured sizing for the bound derivative', async ({ page }) => {
  const f = await fixture(page), repairRequests = [], sliceRequests = [];
  page.on('request', request => { if (request.method() !== 'POST') return; if (request.url().endsWith(f.base + '/resin/repair')) repairRequests.push(request.postDataJSON()); if (request.url().endsWith(f.base + '/resin/slice')) sliceRequests.push(request.postDataJSON()); });
  try {
    await f.show(); expect(f.current().resinRepair).toBeUndefined(); expect(repairRequests).toEqual([]);
    await page.getByRole('button', { name: 'Measure model', exact: true }).click();
    await expect(page.getByText('Measured source: 3 × 3 × 3 mm (X × Y × Z).', { exact: true })).toBeVisible();
    await page.locator('[name="confirmedRequirements"]').check(); await page.locator('[name="confirmedOriginalSize"]').check();
    const rejected = page.waitForResponse(response => response.url().endsWith(f.base + '/resin/slice') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click(); expect((await rejected).ok()).toBe(false); expect(f.inputs).toHaveLength(0);
    await page.getByRole('button', { name: 'Review exact mesh repair', exact: true }).click();
    await expect(page.getByText(/first converts the ticket’s mm units to millimetres and sets a common origin/)).toBeVisible();
    await expect(page.getByText(/does not fill holes, weld nearby vertices, or resolve intersecting shells and cavities/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Repair exact mesh issues', exact: true })).toBeDisabled(); expect(repairRequests).toEqual([]);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(f.current().resinRepair).toBeUndefined();
    expect((await f.repair()).ok()).toBe(true);
    await expect(page.getByText('Exact duplicate faces removed', { exact: true })).toBeVisible();
    await expect(page.locator('.details-grid div').filter({ has: page.getByText('Exact duplicate faces removed', { exact: true }) }).locator('dd')).toHaveText('1');
    await expect(page.locator('.details-grid div').filter({ has: page.getByText('Unique faces reoriented', { exact: true }) }).locator('dd')).toHaveText('1');
    await expect(page.getByText('Unchanged · 3 × 3 × 3 mm', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeDisabled();
    await expect(page.getByText('Measured source: 3 × 3 × 3 mm (X × Y × Z).', { exact: true })).toHaveCount(0);
    await expect(page.locator('[name="confirmedRequirements"]')).not.toBeChecked(); await expect(page.locator('[name="confirmedOriginalSize"]')).not.toBeChecked();
    expect(repairRequests).toEqual([{ confirmedExactRepair: true }]);
    const repair = f.current().resinRepair;
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download unqualified repaired STL', exact: true }).click();
    const file = await download; expect(file.suggestedFilename()).toBe('repaired-unqualified.stl'); const downloaded = await fs.readFile(await file.path()); expect(hash(downloaded)).toBe(repair.sha256); expect(downloaded.readUInt32LE(80)).toBe(12);
    await page.getByRole('button', { name: 'Measure model', exact: true }).click();
    await expect(page.getByText('Measured source: 3 × 3 × 3 mm (X × Y × Z).', { exact: true })).toBeVisible();
    await page.getByLabel('Sizing method').selectOption('dimension'); await page.getByLabel('Source axis', { exact: true }).selectOption('z'); await page.getByLabel('Target source dimension (mm)', { exact: true }).fill('6');
    await expect(page.getByText('Expected model: 6 × 6 × 6 mm before orientation and supports.', { exact: true })).toBeVisible();
    await page.locator('[name="confirmedRequirements"]').check(); await page.locator('[name="confirmedSizing"]').check();
    await page.getByLabel('Target source dimension (mm)', { exact: true }).fill('7'); await expect(page.locator('[name="confirmedSizing"]')).not.toBeChecked(); await page.getByLabel('Target source dimension (mm)', { exact: true }).fill('6'); await page.locator('[name="confirmedSizing"]').check();
    await page.setViewportSize({ width: 480, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const captured = page.waitForResponse(response => response.url().endsWith(f.base + '/resin/slice') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click(); expect((await captured).ok()).toBe(true);
    await expect(page.getByText('Slice captured for qualification', { exact: true })).toBeVisible();
    const current = f.current(), slice = current.resinSlice;
    expect(sliceRequests.at(-1).expectedGeometrySha256).toBe(repair.sha256); expect(sliceRequests.at(-1).sizing).toEqual({ mode: 'dimension', axis: 'z', millimeters: 6 });
    expect(f.inputs).toHaveLength(1); expect(f.inputs[0].inputPath).toBe(repair.filePath); expect(f.inputs[0].unitScale).toBe(1);
    expect(slice.sourceSha256).toBe(f.job.sha256); expect(slice.repairedSourceSha256).toBe(repair.sha256); expect(slice.printReady).toBe(false);
    expect(measureResinGeometry(await fs.readFile(slice.inputGeometry.filePath), { format: 'stl', units: 'mm' }).sourceDimensionsMm).toEqual({ x: 6, y: 6, z: 6 });
    expect(await fs.readFile(f.job.inputPath)).toEqual(f.data); expect(current.order).toEqual(f.job.order); expect(current.quantity).toBe(1); expect(current.acceptedQuantity).toBe(0); expect(current.runs).toEqual([]); expect(f.errors).toEqual([]);
    await page.reload(); await page.locator(`button[data-action="job"][data-id="${f.job.id}"]`).first().click();
    await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Measure model', exact: true }).click(); await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeEnabled();
    expect((await f.repair()).ok()).toBe(true); await expect(page.getByText('Slice captured for qualification', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeDisabled();
    await expect(page.locator('[name="confirmedRequirements"]')).not.toBeChecked(); expect(f.current().resinSlice).toBeUndefined(); expect(await fs.readFile(f.job.inputPath)).toEqual(f.data);
  } finally { await f.close(); }
});

test('stale derivative review and tampered repaired bytes fail visibly before the native slice boundary', async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.show(); expect((await f.repair()).ok()).toBe(true); await page.getByRole('button', { name: 'Measure model', exact: true }).click();
    // Measurement replaces the repaired-model form and clears its confirmations.
    // Wait for that form before checking it or replacing its reviewed hash.
    await expect(page.getByText('Measured source: 3 × 3 × 3 mm (X × Y × Z).', { exact: true })).toBeVisible();
    await expect(page.locator('#resin-slice-form')).toHaveAttribute('data-geometry-sha', f.current().resinRepair.sha256);
    await page.locator('[name="confirmedRequirements"]').check(); await page.locator('[name="confirmedOriginalSize"]').check();
    await page.locator('#resin-slice-form').evaluate(form => { form.dataset.geometrySha = '0'.repeat(64); });
    const stale = page.waitForResponse(response => response.url().endsWith(f.base + '/resin/slice') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click(); const rejected = await stale; expect(rejected.ok()).toBe(false); expect((await rejected.json()).error).toBe('RESIN_REPAIR_REVIEW_STALE');
    await expect(page.locator('#modal-error')).not.toBeEmpty(); expect(f.inputs).toHaveLength(0); expect(f.current().resinSlice).toBeUndefined();
    await page.getByRole('button', { name: 'Measure model', exact: true }).click(); await expect(page.locator('[name="confirmedRequirements"]')).not.toBeChecked();
    const repaired = f.current().resinRepair; await fs.appendFile(repaired.filePath, 'tampered');
    const invalidDownload = page.waitForResponse(response => response.url().endsWith(f.base + '/resin/repair/download'));
    await page.getByRole('button', { name: 'Download unqualified repaired STL', exact: true }).click(); expect((await invalidDownload).ok()).toBe(false);
    await expect(page.locator('#modal-error')).not.toBeEmpty(); await expect(page.getByRole('button', { name: 'Download unqualified repaired STL', exact: true })).toBeEnabled();
    expect(f.inputs).toHaveLength(0); expect(await fs.readFile(f.job.inputPath)).toEqual(f.data); expect(f.current().acceptedQuantity).toBe(0); expect(f.current().runs).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('an open source is held by actual repair validation and approval holds disable repair without a request', async ({ page }) => {
  const f = await fixture(page, { open: true });
  try {
    await f.show(); const failed = await f.repair(); expect(failed.ok()).toBe(false); expect((await failed.json()).error).toBe('RESIN_MESH_REPAIR_OPEN');
    await expect(page.locator('#modal-error')).not.toBeEmpty(); expect(f.current().resinRepair).toBeUndefined(); expect(f.inputs).toHaveLength(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    for (const approvalState of ['pending', 'approved']) {
      await f.app.service._mutate(() => { f.app.service._job(f.job.id).resinProduction = { plan: { approvalState } }; });
      await f.show(); await expect(page.getByRole('button', { name: 'Review exact mesh repair', exact: true })).toBeDisabled();
      const rejected = await f.post(f.base + '/resin/repair', { confirmedExactRepair: true }); expect(rejected.ok()).toBe(false); expect((await rejected.json()).error).toBe('RESIN_APPROVAL_LOCKED');
    }
    expect(await fs.readFile(f.job.inputPath)).toEqual(f.data); expect(f.current().acceptedQuantity).toBe(0); expect(f.current().runs).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('failed regeneration removes the old repair summary and cached derivative measurement', async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.show(); expect((await f.repair()).ok()).toBe(true);
    await page.getByRole('button', { name: 'Measure model', exact: true }).click();
    await expect(page.getByText('Measured source: 3 × 3 × 3 mm (X × Y × Z).', { exact: true })).toBeVisible();
    const repair = f.current().resinRepair, root = path.dirname(path.dirname(repair.filePath)), expectedRoot = path.join(f.app.service.dataDir, 'jobs', f.job.id, 'resin-repair');
    expect(root).toBe(expectedRoot);
    // An owned fixture filesystem failure occurs after the core clears its old
    // capture. The original model lives outside this derived-output directory.
    await fs.rename(root, path.join(path.dirname(expectedRoot), 'old-repair-fixture'));
    await fs.writeFile(expectedRoot, 'Fixture blocks regeneration with a regular file.');
    const failed = await f.repair(); expect(failed.ok()).toBe(false);
    await expect(page.locator('#modal-error')).not.toBeEmpty(); expect(f.current().resinRepair).toBeUndefined();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Exact duplicate faces removed', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Measured source: 3 × 3 × 3 mm (X × Y × Z).', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download unqualified repaired STL', exact: true })).toHaveCount(0);
    await expect(page.locator('#resin-sizing-mode option[value="dimension"]')).toBeDisabled();
    await expect(page.locator('[name="confirmedRequirements"]')).not.toBeChecked();
    expect(await fs.readFile(f.job.inputPath)).toEqual(f.data); expect(f.inputs).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
