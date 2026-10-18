'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test: base, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');

// Software rendering is explicit in these browser tests, so cloud machines
// exercise real Three.js/WebGL draws without requiring a physical GPU.
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  || (fsSync.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const test = base.extend({
  workspace: async ({}, use) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-sim-browser-'));
    const adapterCalls = [];
    const instance = await startServer({
      dataDir: path.join(directory, 'data'), port: 0, simulationAutoTick: false,
      adapters: () => { adapterCalls.push('createAdapter'); throw new Error('Virtual tests must never open a printer adapter.'); },
    });
    await instance.service.submit({
      source: 'browser-fixture', sourceId: 'existing-real-queue', name: 'Existing production job',
      files: [{ name: 'existing.gcode', data: Buffer.from('G28\nG1 X10 Y10\n') }],
    });
    const productionBefore = instance.service.snapshot();
    const json = async (route, body, method = 'POST') => {
      const response = await fetch(instance.url + route, {
        method, headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.ok, await response.clone().text()).toBeTruthy();
      return response.json();
    };
    try { await use({ ...instance, directory, json, adapterCalls }); }
    finally {
      try {
        expect(instance.service.snapshot()).toEqual(productionBefore);
        expect(adapterCalls).toEqual([]);
      } finally {
        await instance.close();
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  },
});

test.use({
  // Windows hosted runners render in software. Honor the application's existing
  // reduced-motion mode while still exercising the complete WebGL scene.
  reducedMotion: 'reduce',
  launchOptions: { executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});
test.setTimeout(60000);

async function enter(page, workspace) {
  await page.goto(workspace.url);
  await expect(page.locator('#connection-status')).toContainText('Workspace online');
  // Retain the public scene manager only in the test page. This observes real
  // renderer counters and disposal without adding any production test hooks.
  await page.evaluate(() => {
    const create = window.QuickPrintScene.createFarmScene;
    window.__testScenes = [];
    window.QuickPrintScene = { ...window.QuickPrintScene, createFarmScene: (...args) => {
      const manager = create(...args); window.__testScenes.push(manager); return manager;
    } };
  });
  await page.locator('nav').getByRole('link', { name: 'Simulation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make room for possibility.' })).toBeVisible();
  await expect(page.locator('[data-sim-name]')).not.toContainText('Loading');
}

async function applyDialog(page, name = 'Apply & reset simulation') {
  const response = page.waitForResponse(value => value.url().endsWith('/api/simulation/scenario') && value.request().method() === 'PUT');
  await page.getByRole('dialog').getByRole('button', { name, exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function clickControl(page, action) {
  const response = page.waitForResponse(value => value.url().endsWith('/api/simulation/control') && value.request().postDataJSON()?.action === action);
  await page.locator(`[data-sim-action="${action === 'pause' ? 'play' : action}"]`).click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('[data-sim-action="play"]')).toBeEnabled();
}

function shortScenario() {
  return {
    schemaVersion: 1, name: 'Clearing recovery experiment', seed: 84, room: { width: 12, depth: 10 },
    printers: [{ id: 'auto', name: 'Automatic test printer', zone: 'PLA', position: { x: 4, z: 4 },
      materials: ['PLA'], nozzle: 0.4, speedMultiplier: 1, buildVolume: { x: 256, y: 256, z: 256 },
      clearing: { mode: 'automatic', cooldownMinutes: 1, cycleMinutes: 4, failureRate: 0, resourceId: null } }],
    clearers: [], jobs: [{ id: 'copies', name: 'Recovery bracket', material: 'PLA', durationMinutes: 2, quantity: 3 }],
    routing: { strategy: 'balanced', queueOrder: 'priority', rules: [] },
  };
}

test('real 3D rendering, orbit, selection and layout edits survive leaving and reentering the workspace', async ({ page, workspace }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await enter(page, workspace);
  const scene = page.locator('[data-sim-scene]');
  const canvas = page.locator('.sim-three-canvas');
  await expect(scene).toHaveAttribute('data-webgl', 'available');
  await expect.poll(() => page.evaluate(() => window.__testScenes.at(-1).getDiagnostics().frames)).toBeGreaterThan(1);
  const diagnostics = await page.evaluate(() => window.__testScenes.at(-1).getDiagnostics());
  expect(diagnostics).toMatchObject({ available: true, printers: 4, clearers: 0, view: 'perspective', reducedMotion: true });
  expect(diagnostics.drawCalls).toBeGreaterThan(50);
  expect(diagnostics.triangles).toBeGreaterThan(1000);
  const screenshot = await page.screenshot({ path: path.join(os.tmpdir(), 'quickprint-simulator-desktop.png'), fullPage: true });
  expect(screenshot.length).toBeGreaterThan(20000);
  const idleFrames = await page.evaluate(async () => {
    const scene = window.__testScenes.at(-1);
    const before = scene.getDiagnostics().frames;
    await new Promise(resolve => setTimeout(resolve, 700));
    return scene.getDiagnostics().frames - before;
  });
  // A paused farm must leave time for ordinary form controls on software GPUs.
  // Allow a late resize, but reject the old continuous render loop.
  expect(idleFrames).toBeLessThanOrEqual(2);

  const beforeOrbit = await canvas.screenshot();
  const bounds = await canvas.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.6, { steps: 8 });
  await page.mouse.up();
  expect((await canvas.screenshot()).equals(beforeOrbit)).toBe(false);

  await page.getByRole('button', { name: 'Top view', exact: true }).click();
  expect(await page.evaluate(() => window.__testScenes.at(-1).getDiagnostics().view)).toBe('top');
  await page.getByRole('tab', { name: /Farm equipment/ }).click();
  await page.locator('[data-sim-detail] [data-sim-action="select"][data-id="p1"]').first().click();
  await expect(page.locator('[data-sim-inspector] h2')).toHaveText('Printer 01');
  expect(await page.evaluate(() => window.__testScenes.at(-1).getDiagnostics().selectedId)).toBe('p1');
  await clickControl(page, 'step');
  expect(workspace.simulation.snapshot().timeMinutes).toBe(5);
  const initialPosition = workspace.simulation.snapshot().scenario.printers[0].position;
  await page.getByRole('button', { name: 'Move equipment', exact: true }).click();
  await expect(page.locator('[data-sim-layout]')).toContainText('Applying changes resets this run');
  await expect(page.locator('[data-sim-action="play"]')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__testScenes.at(-1).getDiagnostics().editing)).toBe(true);
  await canvas.scrollIntoViewIfNeeded();
  const focused = await canvas.boundingBox();
  await page.mouse.move(focused.x + focused.width / 2, focused.y + focused.height / 2);
  await page.mouse.down();
  await page.mouse.move(focused.x + focused.width / 2 + 65, focused.y + focused.height / 2, { steps: 6 });
  await page.mouse.up();
  // An uncommitted layout is visible in the inspector but cannot mutate the
  // persisted scenario until Apply; the paused run remains intact meanwhile.
  await expect(page.locator('[data-sim-inspector]')).not.toContainText('3, 3 m');
  expect(workspace.simulation.snapshot().scenario.printers[0].position).toEqual(initialPosition);
  expect(workspace.simulation.snapshot().timeMinutes).toBe(5);
  await page.getByRole('button', { name: 'Apply layout & reset', exact: true }).click();
  await expect(page.locator('[data-sim-layout]')).toBeHidden();
  const moved = workspace.simulation.snapshot();
  expect(moved.scenario.printers[0].position).not.toEqual(initialPosition);
  expect(moved.scenario.printers[0].position.x - initialPosition.x).toBeGreaterThanOrEqual(0.5);
  expect(moved.scenario.printers[0].position.x - initialPosition.x).toBeLessThanOrEqual(2);
  expect(Math.abs(moved.scenario.printers[0].position.z - initialPosition.z)).toBeLessThanOrEqual(0.5);
  expect(moved.timeMinutes).toBe(0);

  await page.getByRole('button', { name: 'Move equipment', exact: true }).click();
  await canvas.focus(); await page.keyboard.press('ArrowRight');
  await page.locator('[data-sim-action="cancel-layout"]').click();
  expect(workspace.simulation.snapshot().scenario.printers[0].position).toEqual(moved.scenario.printers[0].position);
  await page.locator('nav').getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(canvas).toHaveCount(0);
  expect(await page.evaluate(() => window.__testScenes[0].getDiagnostics().available)).toBe(false);
  await page.locator('nav').getByRole('link', { name: 'Simulation', exact: true }).click();
  await expect(canvas).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__testScenes.at(-1).getDiagnostics().printers)).toBe(4);
  await clickControl(page, 'step');
  await expect(page.locator('[data-sim-time]')).toHaveText('00:05');
  expect(workspace.simulation.snapshot().timeMinutes).toBe(5);
  expect(errors).toEqual([]);
});

test('farm, shared auto clearing, routing rules and constrained jobs are configurable through real forms', async ({ page, workspace }) => {
  await enter(page, workspace);
  await page.getByRole('button', { name: 'Edit farm', exact: true }).click();
  await page.getByLabel('Scenario name', { exact: true }).fill('Configured prototype farm');
  await page.getByLabel('Floor width (m)', { exact: true }).fill('20');
  await page.getByLabel('Floor depth (m)', { exact: true }).fill('15');
  await page.getByLabel('Random seed', { exact: true }).fill('981');
  await applyDialog(page);
  await expect(page.locator('[data-sim-name]')).toHaveText('Configured prototype farm');

  await page.getByRole('tab', { name: /Farm equipment/ }).click();
  await page.getByRole('button', { name: '+ Shared clearer', exact: true }).click();
  await page.getByLabel('Resource name', { exact: true }).fill('Shared robot A');
  await applyDialog(page);
  const clearer = workspace.simulation.snapshot().scenario.clearers[0];
  expect(clearer.name).toBe('Shared robot A');
  await page.locator('[data-sim-action="edit-printer"][data-id="p1"]').click();
  await page.getByLabel('Printer name', { exact: true }).fill('Engineering printer');
  await page.getByLabel('Zone', { exact: true }).fill('Prototype');
  await page.getByLabel('Accepted materials', { exact: true }).fill('PLA, PETG');
  await page.getByLabel('Clearing method', { exact: true }).selectOption('robot');
  await page.getByLabel('Shared clearing resource', { exact: true }).selectOption(clearer.id);
  await page.getByLabel('Cooldown before clearing (min)', { exact: true }).fill('3');
  await page.getByLabel('Clearing cycle (min)', { exact: true }).fill('2.5');
  await page.getByLabel('Clear failure probability (%)', { exact: true }).fill('7');
  await applyDialog(page);
  expect(workspace.simulation.snapshot().scenario.printers[0]).toMatchObject({
    name: 'Engineering printer', zone: 'Prototype', clearing: { mode: 'robot', resourceId: clearer.id, cooldownMinutes: 3, cycleMinutes: 2.5, failureRate: 0.07 },
  });

  await page.getByRole('tab', { name: 'Routing logic', exact: true }).click();
  await page.getByRole('button', { name: 'Edit routing logic', exact: true }).click();
  await page.getByLabel('Printer selection', { exact: true }).selectOption('fastest');
  await page.getByLabel('Queue order', { exact: true }).selectOption('due_date');
  await page.getByRole('button', { name: '+ Add routing rule', exact: true }).click();
  const rule = page.locator('.sim-rule-editor').last();
  await rule.getByLabel('Name', { exact: true }).fill('Urgent PETG to prototype');
  await rule.getByLabel('Material', { exact: true }).fill('PETG');
  await rule.getByLabel('Job tag', { exact: true }).fill('urgent');
  await rule.getByLabel('Minimum priority', { exact: true }).fill('3');
  await rule.getByLabel('Target zone', { exact: true }).fill('Prototype');
  await applyDialog(page);
  expect(workspace.simulation.snapshot().scenario.routing).toMatchObject({ strategy: 'fastest', queueOrder: 'due_date' });

  await page.getByRole('tab', { name: /Job queue/ }).click();
  await page.locator('[data-sim-detail-actions] [data-sim-action="add-job"]').click();
  await page.getByLabel('Job name', { exact: true }).fill('Urgent oversized housing');
  await page.getByLabel('Material', { exact: true }).fill('PETG');
  await page.getByLabel('Width (X)', { exact: true }).fill('600');
  await page.getByLabel('Priority (higher first)', { exact: true }).fill('5');
  await page.getByLabel('Routing tag', { exact: true }).fill('urgent');
  await page.getByLabel('Number of copies', { exact: true }).fill('4');
  await applyDialog(page);
  await expect(page.locator('[data-sim-preview]')).toContainText('Part exceeds build volume');
  await expect(page.locator('[data-sim-preview]')).toContainText('restricts this job to zone Prototype');
  const saved = workspace.simulation.snapshot().scenario;
  expect(saved.jobs.at(-1)).toMatchObject({ name: 'Urgent oversized housing', quantity: 4, size: { x: 600 }, priority: 5, tag: 'urgent' });
  await page.reload();
  await expect(page.locator('[data-sim-name]')).toHaveText('Configured prototype farm');
  expect(workspace.simulation.snapshot().scenario).toEqual(saved);
});

test('stepping blocks occupied beds, fault injection recovers explicitly, and run controls stay independent of production', async ({ page, workspace }) => {
  await workspace.json('/api/simulation/scenario', shortScenario(), 'PUT');
  await enter(page, workspace);
  await page.getByRole('tab', { name: /Farm equipment/ }).click();
  await page.getByRole('button', { name: 'Automatic test printer', exact: true }).click();
  await clickControl(page, 'step');
  let value = workspace.simulation.snapshot();
  expect(value).toMatchObject({ timeMinutes: 5, running: false, metrics: { completedCopies: 1 } });
  expect(value.printers[0]).toMatchObject({ state: 'clearing', bedDirty: true });
  expect(value.jobs[0].startedCopies).toBe(1);
  await expect(page.locator('[data-sim-inspector] .sim-status')).toHaveText('Clearing');
  await page.getByRole('button', { name: 'Simulate clear failure', exact: true }).click();
  await expect(page.locator('[data-sim-inspector] .sim-status')).toHaveText('Blocked');
  await clickControl(page, 'step');
  expect(workspace.simulation.snapshot().jobs[0].startedCopies).toBe(1);
  await page.getByRole('button', { name: 'Manually clear bed', exact: true }).click();
  await expect(page.locator('[data-sim-inspector] .sim-status')).toHaveText('Printing');
  expect(workspace.simulation.snapshot().jobs[0].startedCopies).toBe(2);
  await page.getByRole('button', { name: 'Simulate print failure', exact: true }).click();
  await expect(page.locator('[data-sim-inspector] .sim-status')).toHaveText('Blocked');
  expect(workspace.simulation.snapshot().metrics.failedCopies).toBe(1);
  await page.getByRole('button', { name: 'Take offline', exact: true }).click();
  await expect(page.locator('[data-sim-inspector] .sim-status')).toHaveText('Offline');
  await page.getByRole('button', { name: 'Bring online', exact: true }).click();
  await expect(page.locator('[data-sim-inspector] .sim-status')).toHaveText('Blocked');
  await page.getByRole('button', { name: 'Manually clear bed', exact: true }).click();
  await expect(page.locator('[data-sim-inspector] .sim-status')).toHaveText('Printing');
  await page.getByLabel('Simulation speed', { exact: true }).selectOption('300');
  await expect.poll(() => workspace.simulation.snapshot().speed).toBe(300);
  await clickControl(page, 'play');
  await expect(page.locator('[data-sim-action="step"]')).toBeDisabled();
  await expect(page.locator('[data-sim-run-label]')).toContainText('Running at 300');
  await clickControl(page, 'pause');
  await expect(page.locator('[data-sim-action="step"]')).toBeEnabled();
  await page.getByRole('tab', { name: 'Event log', exact: true }).click();
  await expect(page.locator('[data-sim-detail]')).toContainText('injected clearing failure');
  await expect(page.locator('[data-sim-detail]')).toContainText('bed is clear');
  await page.getByRole('button', { name: '↺ Reset', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset simulation', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-sim-time]')).toHaveText('00:00');
  expect(workspace.simulation.snapshot().metrics).toMatchObject({ completedCopies: 0, failedCopies: 0 });
});

test('scenario export is portable JSON and import validates before replacing the virtual farm', async ({ page, workspace }) => {
  await enter(page, workspace);
  const original = workspace.simulation.snapshot().scenario;
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export scenario', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^QuickPrint-.*\.json$/);
  const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(exported).toEqual(original);
  await page.locator('[data-sim-import]').setInputFiles({ name: 'bad-farm.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...exported, schemaVersion: 99 })) });
  await page.getByRole('dialog').getByRole('button', { name: 'Import & reset simulation', exact: true }).click();
  await expect(page.locator('.sim-form-error')).toBeVisible();
  expect(workspace.simulation.snapshot().scenario).toEqual(original);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  exported.name = 'Imported laboratory layout'; exported.printers[0].position = { x: 5, z: 6 };
  await page.locator('[data-sim-import]').setInputFiles({ name: 'lab-farm.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await applyDialog(page, 'Import & reset simulation');
  await expect(page.locator('[data-sim-name]')).toHaveText('Imported laboratory layout');
  expect(workspace.simulation.snapshot().scenario).toEqual(exported);
  expect(workspace.simulation.snapshot().timeMinutes).toBe(0);
});

test('narrow screens and unavailable WebGL retain usable farm configuration and simulation controls', async ({ page, workspace }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /webgl/i.test(type) ? null : getContext.call(this, type, ...args);
    };
  });
  await enter(page, workspace);
  await expect(page.locator('[data-sim-scene]')).toHaveAttribute('data-webgl', 'unavailable');
  await expect(page.getByText('3D preview unavailable', { exact: true })).toBeVisible();
  await expect(page.locator('.sim-three-canvas')).toHaveCount(0);
  await page.getByRole('tab', { name: /Farm equipment/ }).click();
  await page.locator('[data-sim-action="edit-printer"][data-id="p1"]').click();
  await page.getByLabel('Printer name', { exact: true }).fill('Configured without a GPU');
  await page.getByLabel('Floor X (m)', { exact: true }).fill('5');
  await applyDialog(page);
  await clickControl(page, 'step');
  await expect(page.locator('[data-sim-time]')).toHaveText('00:05');
  expect(workspace.simulation.snapshot().scenario.printers[0]).toMatchObject({ name: 'Configured without a GPU', position: { x: 5 } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  for (const dismiss of await page.getByRole('button', { name: 'Dismiss notification', exact: true }).all()) await dismiss.click();
  await page.getByRole('heading', { name: 'Make room for possibility.', exact: true }).click();
  await page.screenshot({ path: path.join(os.tmpdir(), 'quickprint-simulator-mobile-fallback.png'), fullPage: true });
});
