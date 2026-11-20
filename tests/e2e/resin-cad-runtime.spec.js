'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function mutations(page) {
  const requests = [];
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) requests.push({ pathname, method: request.method(), body: request.postDataJSON() });
  });
  return requests;
}

async function settings(page, app) {
  await page.goto(app.url);
  await page.locator('nav').getByRole('link', { name: 'Settings', exact: true }).click();
}

test('automatic CAD setup persists only its managed runtime while preserving unsaved paths and resin slots', async ({ page }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-cad-runtime-browser-'));
  const gate = deferred(), calls = [];
  const app = await startServer({ dataDir, port: 0, cadRuntime: {
    async provisionResinCadRuntime(options) {
      calls.push(options);
      await gate.promise;
      const cadAuditPath = path.join(options.outputDir, 'site-packages');
      await fs.mkdir(cadAuditPath, { recursive: true });
      // This injected provisioner exercises the real server/core/UI boundary;
      // it does not claim these fixture files form an executable CAD runtime.
      await fs.writeFile(path.join(options.outputDir, 'quickprint-cad-runtime.json'), JSON.stringify({ fixture: true }));
      return { cadAuditPath, distributionVersion: '8.0.1.1.0', reused: false };
    },
  } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const original = {
      prusaExecutable: path.join(dataDir, 'original', 'prusa-console.exe'),
      uvtoolsExecutable: path.join(dataDir, 'original', 'UVtoolsCmd.exe'),
      freecadExecutable: path.join(dataDir, 'original', 'FreeCADCmd.exe'),
      cadAuditPath: path.join(dataDir, 'manual-audit', 'site-packages'),
      profilePath: path.join(dataDir, 'original', 'grey-resin.json'),
      slots: [{ id: 'grey-resin', name: 'Grey resin', profilePath: path.join(dataDir, 'original', 'grey-resin.json') }],
    };
    await app.service.updateSettings({ resinEngine: original });
    const baseline = app.service.getSettings(), requests = mutations(page);
    await settings(page, app);
    const edited = {
      freecadExecutable: path.join(dataDir, 'custom CAD tools', 'FreeCADCmd.exe'),
      prusaExecutable: path.join(dataDir, 'custom slicer', 'prusa-console.exe'),
      uvtoolsExecutable: path.join(dataDir, 'custom inspection', 'UVtoolsCmd.exe'),
      profilePath: path.join(dataDir, 'custom profiles', 'legacy-tough-resin.json'),
      slotPath: path.join(dataDir, 'custom profiles', 'tough-resin.json'),
      addedSlotPath: path.join(dataDir, 'custom profiles', 'clear-resin.json'),
    };
    await page.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('Unsaved resin workspace');
    await page.getByLabel('FreeCAD command executable', { exact: true }).fill(edited.freecadExecutable);
    await page.getByLabel('PrusaSlicer console executable', { exact: true }).fill(edited.prusaExecutable);
    await page.getByLabel('UVtools command executable', { exact: true }).fill(edited.uvtoolsExecutable);
    await page.getByText('Legacy single profile', { exact: true }).click();
    await page.getByLabel('Resin engine profile JSON', { exact: true }).fill(edited.profilePath);
    await page.getByLabel('CAD mesh accuracy (mm)', { exact: true }).fill('0.01');
    await page.getByLabel('CAD angular tolerance (radians)', { exact: true }).fill('0.2');
    const firstSlot = page.locator('.resin-profile-slot').first();
    await firstSlot.getByRole('textbox', { name: 'Slot name', exact: true }).fill('Tough resin · 50 µm');
    await firstSlot.getByRole('textbox', { name: 'Slot profile JSON', exact: true }).fill(edited.slotPath);
    await page.getByRole('button', { name: 'Add resin slot', exact: true }).click();
    const addedSlot = page.locator('.resin-profile-slot').last();
    await addedSlot.getByRole('textbox', { name: 'Slot name', exact: true }).fill('Clear resin · fine');
    await addedSlot.getByRole('textbox', { name: 'Slot profile JSON', exact: true }).fill(edited.addedSlotPath);
    const addedSlotId = await addedSlot.getAttribute('data-slot-id');
    await expect(page.getByRole('checkbox', { name: 'Enable qualified resin dispatch' })).not.toBeChecked();

    const setup = page.locator('[data-action="setup-cad-runtime"]');
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/resin/cad/runtime' && response.request().method() === 'POST');
    await setup.click();
    await expect(setup).toBeDisabled();
    await expect(setup).toHaveText('Setting up CAD transfer audit…');
    await expect.poll(() => calls.length).toBe(1);
    await setup.evaluate(button => button.click());
    expect(requests).toEqual([{ pathname: '/api/resin/cad/runtime', method: 'POST', body: {} }]);
    expect(calls[0].outputDir).toBe(path.join(dataDir, '.providers', 'cad-transfer', '8.0.1.1.0'));
    expect(Object.keys(calls[0]).sort()).toEqual(['outputDir', 'signal']);
    expect(app.service.getSettings()).toEqual(baseline);
    gate.resolve();
    const response = await completed;
    expect(response.ok()).toBe(true);
    const cadAuditPath = path.join(dataDir, '.providers', 'cad-transfer', '8.0.1.1.0', 'site-packages');
    expect(await response.json()).toEqual({ cadAuditPath, distributionVersion: '8.0.1.1.0', reused: false });
    await expect(setup).toBeEnabled(); await expect(setup).toHaveText('Set up CAD transfer audit');
    await expect(page.getByText('CAD transfer audit ready. Save any other settings before preparing STEP geometry.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('CAD transfer audit runtime', { exact: true })).toHaveValue(cadAuditPath);
    await expect(page.getByRole('textbox', { name: 'Workspace name', exact: true })).toHaveValue('Unsaved resin workspace');
    await expect(page.getByLabel('FreeCAD command executable', { exact: true })).toHaveValue(edited.freecadExecutable);
    await expect(page.getByLabel('PrusaSlicer console executable', { exact: true })).toHaveValue(edited.prusaExecutable);
    await expect(page.getByLabel('UVtools command executable', { exact: true })).toHaveValue(edited.uvtoolsExecutable);
    await expect(page.getByLabel('Resin engine profile JSON', { exact: true })).toHaveValue(edited.profilePath);
    await expect(page.getByLabel('CAD mesh accuracy (mm)', { exact: true })).toHaveValue('0.01');
    await expect(page.getByLabel('CAD angular tolerance (radians)', { exact: true })).toHaveValue('0.2');
    await expect(firstSlot.getByRole('textbox', { name: 'Slot name', exact: true })).toHaveValue('Tough resin · 50 µm');
    await expect(firstSlot.getByRole('textbox', { name: 'Slot profile JSON', exact: true })).toHaveValue(edited.slotPath);
    await expect(addedSlot.getByRole('textbox', { name: 'Slot name', exact: true })).toHaveValue('Clear resin · fine');
    const provisioned = app.service.getSettings();
    expect(provisioned).toEqual({ ...baseline, resinEngine: { ...baseline.resinEngine, cadAuditPath } });
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
    expect(persisted.settings.resinEngine).toEqual(provisioned.resinEngine);
    expect(persisted.settings.siteName).toBe(baseline.siteName);
    expect(requests).toEqual([{ pathname: '/api/resin/cad/runtime', method: 'POST', body: {} }]);

    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByText('Workspace settings saved.', { exact: true })).toBeVisible();
    const saved = app.service.getSettings();
    expect(saved.siteName).toBe('Unsaved resin workspace');
    expect(saved.resinEngine).toMatchObject({
      cadAuditPath, freecadExecutable: edited.freecadExecutable, prusaExecutable: edited.prusaExecutable,
      uvtoolsExecutable: edited.uvtoolsExecutable, profilePath: edited.profilePath,
      cadLinearDeflectionMm: 0.01, cadAngularDeflectionRad: 0.2, dispatchEnabled: false,
      slots: [{ id: 'grey-resin', name: 'Tough resin · 50 µm', profilePath: edited.slotPath }, { id: addedSlotId, name: 'Clear resin · fine', profilePath: edited.addedSlotPath }],
    });
    expect(requests.map(request => [request.method, request.pathname])).toEqual([['POST', '/api/resin/cad/runtime'], ['PUT', '/api/settings']]);
    expect(requests[1].body.resinEngine.cadAuditPath).toBe(cadAuditPath);
    expect(calls).toHaveLength(1); expect(errors).toEqual([]);
    await page.reload(); await page.locator('nav').getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('FreeCAD command executable', { exact: true })).toHaveValue(edited.freecadExecutable);
    await expect(page.getByLabel('CAD transfer audit runtime', { exact: true })).toHaveValue(cadAuditPath);
    await expect(page.locator('.resin-profile-slot')).toHaveCount(2);
    await expect(page.getByRole('checkbox', { name: 'Enable qualified resin dispatch' })).not.toBeChecked();
  } finally { gate.resolve(); await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});

test('CAD setup failure keeps saved and unsaved paths intact and resets the button for a retry', async ({ page }) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-cad-runtime-failure-browser-'));
  const gate = deferred(); let calls = 0;
  const message = 'The pinned CAD runtime download could not be verified.';
  const app = await startServer({ dataDir, port: 0, cadRuntime: {
    async provisionResinCadRuntime() { calls++; await gate.promise; throw Object.assign(new Error(message), { code: 'CAD_RUNTIME_CHECKSUM' }); },
  } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const oldPath = path.join(dataDir, 'existing-audit', 'site-packages');
    await app.service.updateSettings({ resinEngine: { cadAuditPath: oldPath } });
    const baseline = app.service.getSettings(), requests = mutations(page);
    await settings(page, app);
    const unsavedAudit = path.join(dataDir, 'unsaved-audit', 'site-packages'), unsavedFreecad = path.join(dataDir, 'unsaved-CAD', 'FreeCADCmd.exe');
    await page.getByLabel('CAD transfer audit runtime', { exact: true }).fill(unsavedAudit);
    await page.getByLabel('FreeCAD command executable', { exact: true }).fill(unsavedFreecad);
    const setup = page.locator('[data-action="setup-cad-runtime"]');
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/resin/cad/runtime');
    await setup.click(); await expect(setup).toBeDisabled();
    gate.resolve();
    const response = await completed; expect(response.status()).toBe(502);
    expect(await response.json()).toEqual({ error: 'CAD_RUNTIME_CHECKSUM', message });
    await expect(page.locator('.toast.error').getByText(message, { exact: true })).toBeVisible();
    await expect(setup).toBeEnabled(); await expect(setup).toHaveText('Set up CAD transfer audit');
    await expect(page.getByLabel('CAD transfer audit runtime', { exact: true })).toHaveValue(unsavedAudit);
    await expect(page.getByLabel('FreeCAD command executable', { exact: true })).toHaveValue(unsavedFreecad);
    expect(app.service.getSettings()).toEqual(baseline);
    expect(JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')).settings.resinEngine.cadAuditPath).toBe(oldPath);
    expect(requests).toEqual([{ pathname: '/api/resin/cad/runtime', method: 'POST', body: {} }]);
    const retried = page.waitForResponse(value => new URL(value.url()).pathname === '/api/resin/cad/runtime');
    await setup.click(); expect((await retried).status()).toBe(502); await expect(setup).toBeEnabled();
    expect(calls).toBe(2); expect(requests).toEqual(Array.from({ length: 2 }, () => ({ pathname: '/api/resin/cad/runtime', method: 'POST', body: {} })));
    expect(app.service.getSettings()).toEqual(baseline); expect(errors).toEqual([]);
    await expect(page.getByRole('checkbox', { name: 'Enable qualified resin dispatch' })).not.toBeChecked();
  } finally { gate.resolve(); await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
});
