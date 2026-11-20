'use strict';

const { test: base, expect } = require('@playwright/test');
const { createPlateProductionFixture } = require('../helpers/resin-plate-production');
const { fingerprintSDCPDevice } = require('../../src/adapters/sdcp-identity');

// Real local HTTP/core/manager, geometry/layout and GOO proof. Only the remote
// portal, native rasterizer and printer transport are fixtures, with no sockets
// or executable native tools behind those boundaries.
const test = base.extend({
  workspace: async ({}, use) => {
    const cleanups = [], workspace = await createPlateProductionFixture({ after: cleanup => cleanups.push(cleanup) });
    try { await use(workspace); } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  },
});

async function openJob(page, workspace) {
  await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.locator(`button[data-action="job"][data-id="${workspace.id}"]`).first().click();
  await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
}
async function refreshJob(page) { await page.getByRole('button', { name: 'Refresh status', exact: true }).click(); }
async function review(page) {
  await page.getByRole('button', { name: 'Review production qualification', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Review resin production', exact: true })).toBeVisible();
}
async function qualify(workspace) {
  const slice = workspace.current().resinSlice;
  workspace.portal.qualify({ profileSha256: slice.profileSha256, engineSha256: slice.tool.executableSha256,
    deviceFingerprint: fingerprintSDCPDevice(workspace.printer, await workspace.adapter.attributes()),
    printerId: workspace.printer.id, printerModel: slice.printerModel, material: slice.material, format: 'goo' });
}
async function queueReceipt(page, workspace) {
  const pending = page.waitForResponse(response => response.url().endsWith('/resin/sync') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Queue slice receipt', exact: true }).click();
  const response = await pending; expect(response.ok()).toBe(true); const entry = await response.json();
  await workspace.poll(); await refreshJob(page);
  await expect(page.getByRole('dialog').getByText(/record_slice · confirmed/).last()).toBeVisible();
  return entry;
}
async function approvePlate(page, count) {
  await review(page);
  await expect(page.getByText(`${count} order unit(s)`, { exact: true })).toBeVisible();
  await expect(page.getByText('Qualified by the studio', { exact: true })).toBeVisible();
  await page.locator('[name="confirmedWholeModel"]').check();
  const response = page.waitForResponse(value => value.url().endsWith('/resin/production/approve') && value.request().method() === 'POST');
  await page.getByRole('button', { name: `Approve plate of ${count} units`, exact: true }).click();
  expect((await response).ok()).toBe(true);
}
async function startPlate(page, workspace, count) {
  await page.getByRole('button', { name: `Start plate of ${count} units`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `Start plate of ${count} units?`, exact: true })).toBeVisible();
  const confirm = page.getByRole('button', { name: `Start plate of ${count} units`, exact: true });
  await expect(confirm).toBeDisabled();
  await page.getByRole('checkbox', { name: new RegExp(`ready for this plate of ${count} order units`) }).check();
  const response = page.waitForResponse(value => value.url().endsWith('/resin/production/dispatch') && value.request().method() === 'POST');
  await confirm.click(); expect((await response).ok()).toBe(true);
  await expect.poll(() => workspace.current().status).toBe('printing');
  await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
}
async function recordCount(page, workspace, planned, printed) {
  await workspace.terminal(); await refreshJob(page);
  await page.getByRole('button', { name: 'Record run outcome', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Record this resin run', exact: true })).toBeVisible();
  const count = page.getByRole('spinbutton', { name: `Printed order units from this run (0 to ${planned})`, exact: true });
  await expect(count).toHaveAttribute('min', '0'); await expect(count).toHaveAttribute('max', String(planned));
  await count.fill(String(printed));
  await page.getByRole('checkbox', { name: /I checked the stopped printer/ }).check();
  const response = page.waitForResponse(value => value.url().endsWith('/resin/production/reconcile') && value.request().method() === 'POST');
  await page.getByRole('button', { name: 'Record resin run', exact: true }).click(); expect((await response).ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
}
function noQC(job) { expect(job.quantity).toBe(1); expect(job.acceptedQuantity).toBe(0); expect(job.remainingQuantity).toBe(1); expect(job.runs.every(run => !run.acceptedQuantity)).toBe(true); }

test('operator reviews a six-unit plate and a smaller final plate with separately bound physical confirmations and zero quality credit', async ({ page, context, workspace }) => {
  test.setTimeout(60000);
  const errors = [], dispatch = [], reconciliations = [], slices = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/resin/production/dispatch')) dispatch.push(request.postDataJSON());
    if (request.url().endsWith('/resin/production/reconcile')) reconciliations.push(request.postDataJSON());
    if (request.url().endsWith('/resin/slice')) slices.push(request.postDataJSON());
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === workspace.app.url ? route.continue() : route.abort());
  await page.goto(workspace.app.url); await openJob(page, workspace);
  await page.getByText('Plate copies and spacing', { exact: true }).click();
  const copies = page.getByRole('spinbutton', { name: 'Maximum copies on this plate', exact: true });
  await page.locator('[name="confirmedRequirements"]').check(); await page.locator('[name="confirmedOriginalSize"]').check();
  await copies.fill('6'); await expect(page.locator('[name="confirmedRequirements"]')).not.toBeChecked();
  await page.getByLabel('Gap between support footprints (mm)', { exact: true }).fill('1');
  await page.locator('[name="confirmedRequirements"]').check();
  await page.getByLabel('Plate edge margin (mm)', { exact: true }).fill('1');
  await expect(page.locator('[name="confirmedRequirements"]')).not.toBeChecked();
  await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
  expect(workspace.packed.calls).toHaveLength(0); expect(slices).toEqual([]);
  await page.locator('[name="confirmedRequirements"]').check();
  const sliced = page.waitForResponse(value => value.url().endsWith('/resin/slice') && value.request().method() === 'POST');
  await page.getByRole('button', { name: 'Slice resin model', exact: true }).click(); expect((await sliced).ok()).toBe(true);
  await expect(page.getByText('Slice captured for qualification', { exact: true })).toBeVisible();
  expect(slices[0].plate).toEqual({ copies: 6, gapMm: 1, marginMm: 1 });
  expect(workspace.current().resinSlice.platePreparation.rasterProof.copiesPerRun).toBe(6);
  const first = await queueReceipt(page, workspace); await qualify(workspace); await approvePlate(page, 6);
  await expect(page.getByRole('button', { name: 'Start plate of 6 units', exact: true })).toBeDisabled();
  expect(workspace.app.service.getSettings().resinEngine.dispatchEnabled).toBe(false); expect(workspace.adapter.calls).toEqual([]);
  const forbidden = await page.request.post(workspace.app.url + workspace.base + '/resin/production/dispatch', { headers: { Authorization: 'Bearer ' + workspace.app.token }, data: { confirmedReady: true, receiptId: first.operationId, plannedParts: 6 } });
  expect(forbidden.status()).toBe(409); expect(workspace.adapter.calls).toEqual([]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('nav').getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('checkbox', { name: /Enable qualified resin dispatch/ }).check();
  await page.getByRole('button', { name: 'Save settings', exact: true }).click(); await expect(page.getByText('Workspace settings saved.', { exact: true })).toBeVisible();
  await openJob(page, workspace); await review(page); await startPlate(page, workspace, 6);
  expect(dispatch).toEqual([{ confirmedReady: true, receiptId: first.operationId, plannedParts: 6 }]);
  expect(workspace.current().resinProduction.printedParts).toBe(0); noQC(workspace.current());
  await workspace.terminal(); await refreshJob(page); await page.getByRole('button', { name: 'Record run outcome', exact: true }).click();
  const recorded = page.getByRole('spinbutton', { name: 'Printed order units from this run (0 to 6)', exact: true });
  await expect(recorded).toHaveAttribute('min', '0'); await expect(recorded).toHaveAttribute('max', '6'); await expect(recorded).toHaveValue('0');
  await recorded.fill('7'); await page.getByRole('checkbox', { name: /I checked the stopped printer/ }).check();
  await page.getByRole('button', { name: 'Record resin run', exact: true }).click();
  expect(reconciliations).toEqual([]); expect(workspace.current().resinProduction.printedParts).toBe(0);
  await recorded.fill('6'); const finished = page.waitForResponse(value => value.url().endsWith('/resin/production/reconcile') && value.request().method() === 'POST');
  await page.getByRole('button', { name: 'Record resin run', exact: true }).click(); expect((await finished).ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'Job details', exact: true })).toBeVisible();
  expect(workspace.current().resinProduction.printedParts).toBe(6); noQC(workspace.current());

  // The Node flow tests exercise all four full runs. Advance the two middle
  // confirmed runs through that same fixture API, then review the final UI.
  for (let index = 0; index < 2; index++) { await workspace.start(); await workspace.finish(6); }
  await refreshJob(page); expect(workspace.current().resinProduction.remainingParts).toBe(2);
  await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeEnabled();
  const finalCopies = page.getByRole('spinbutton', { name: 'Maximum copies on this plate', exact: true });
  await expect(finalCopies).toHaveAttribute('max', '2'); await expect(finalCopies).toHaveValue('2');
  await page.locator('[name="confirmedRequirements"]').check(); await page.locator('[name="confirmedOriginalSize"]').check();
  const resliced = page.waitForResponse(value => value.url().endsWith('/resin/slice') && value.request().method() === 'POST');
  await page.getByRole('button', { name: 'Slice resin model', exact: true }).click(); expect((await resliced).ok()).toBe(true);
  await expect(page.getByText('Slice captured for qualification', { exact: true })).toBeVisible();
  expect(slices[1].plate).toEqual({ copies: 2, gapMm: 1, marginMm: 1 });
  const last = await queueReceipt(page, workspace); expect(last.operationId).not.toBe(first.operationId);
  await approvePlate(page, 2); await startPlate(page, workspace, 2); await recordCount(page, workspace, 2, 2);
  expect(dispatch).toEqual([{ confirmedReady: true, receiptId: first.operationId, plannedParts: 6 }, { confirmedReady: true, receiptId: last.operationId, plannedParts: 2 }]);
  expect(workspace.current().resinProduction).toMatchObject({ printedParts: 20, remainingParts: 0 }); noQC(workspace.current());
  expect((await workspace.portal.current()).status).toBe('post_processing');
  await review(page); await expect(page.getByText('20 printed · 0 remaining', { exact: true })).toBeVisible();
  await expect(page.getByText('The requested print units are recorded. Washing, curing and quality inspection remain to be completed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Start plate/ })).toHaveCount(0); expect(errors).toEqual([]);
});

test('operator records four of six planned units after identified completion without granting QC acceptance', async ({ page, workspace }) => {
  const errors = [], bodies = []; page.on('pageerror', error => errors.push(error.message));
  await workspace.reviewed(6); await workspace.start();
  await page.goto(workspace.app.url); await openJob(page, workspace);
  page.on('request', request => { if (request.url().endsWith('/resin/production/reconcile') && request.method() === 'POST') bodies.push(request.postDataJSON()); });
  await recordCount(page, workspace, 6, 4);
  expect(bodies).toHaveLength(1); expect(bodies[0]).toMatchObject({ outcome: 'completed', printedParts: 4 });
  expect(workspace.current().runs.at(-1)).toMatchObject({ plannedParts: 6, printedParts: 4 });
  expect(workspace.current().resinProduction).toMatchObject({ printedParts: 4, remainingParts: 16 }); noQC(workspace.current());
  expect((await workspace.portal.current()).status).toBe('queued'); expect(workspace.adapter.calls.filter(call => call.action === 'start')).toHaveLength(1);
  await review(page); await expect(page.getByText('4 printed · 16 remaining', { exact: true })).toBeVisible(); expect(errors).toEqual([]);
});
