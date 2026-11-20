'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { startServer } = require('../../src/server');
const { loadProfile } = require('../../src/slicing/resin-engine');
const { MODEL, createProfile, importTicket } = require('../helpers/resin-slice');

async function fixture(page, { slots = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-hollow-browser-'));
  const app = await startServer({ dataDir: path.join(root, 'workspace'), port: 0 });
  const settings = await createProfile(root);
  const presetPath = path.join(root, 'resin-preset.ini');
  await fs.writeFile(presetPath, (await fs.readFile(presetPath, 'utf8')).replace('supports_enable=1', 'supports_enable=0').replace('pad_enable=1', 'pad_enable=0'));
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  if (slots) {
    const second = path.join(root, 'second-profile.json'), profile = JSON.parse(await fs.readFile(settings.profilePath, 'utf8'));
    await fs.writeFile(second, JSON.stringify({ ...profile, material: 'Second synthetic resin' }));
    settings.slots = [{ id: ids[0], name: 'First resin', profilePath: settings.profilePath }, { id: ids[1], name: 'Second resin', profilePath: second }];
  }
  await app.service.updateSettings({ resinEngine: settings });
  const job = await importTicket(app.service);
  const geometry = await app.service.planResinGeometry(job.id, { sizing: { mode: 'original' } });
  const loaded = await loadProfile(settings.profilePath);
  const review = { geometrySha256: geometry.geometrySha256, profileSha256: loaded.profileSha256,
    recipe: { orientation: { x: 0, y: 0, z: 0 }, wallThicknessMm: 1, quality: .5, closingDistanceMm: 0,
      drains: [{ id: 'base-drain', startMm: { x: 1.5, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: .2, lengthMm: 3 }] },
    supportRequest: { mode: 'none', clearanceMm: .1, points: [], regions: [] },
    resolutionRequest: { maximumUncertaintyMm: .2, reduction: { x: 1, y: 1, z: 1 }, maxCells: 2000000 }, boundaryPolicy: 'voxel-enclosure' };
  const requests = [], errors = []; page.on('pageerror', error => errors.push(error.message));
  // Exercise real source/review routes. Native preparation is a controller seam,
  // so these UI tests never execute a provider or contact a printer.
  app.service.sliceResinJob = async (id, request) => { requests.push(structuredClone(request)); return { ...app.service.getJob(id), resinSlice: { analysis: { passed: true } } }; };
  await page.goto(app.url);
  await page.locator('nav').getByRole('link', { name: 'Jobs', exact: true }).click();
  await page.locator(`button[data-action="job"][data-id="${job.id}"]`).first().click();
  if (slots) await page.getByLabel('Resin profile slot', { exact: true }).selectOption(ids[0]);
  await page.locator('#resin-hollow-fields > summary').click();
  return { app, root, job, review, ids, requests, errors, close: async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); } };
}
async function upload(page, review, envelope = false) {
  await page.locator('#resin-hollow-file').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope ? { hollow: review } : review)) });
  await expect(page.locator('#resin-hollow-summary')).toContainText('base-drain');
}
async function enableAndValidate(page) {
  await page.locator('[name="resinHollowEnabled"]').check();
  await page.getByRole('button', { name: 'Validate recipe', exact: true }).click();
  await expect(page.locator('[name="confirmedHollowPreparation"]')).toBeEnabled();
}
async function confirmSize(page) {
  await page.locator('[name="confirmedRequirements"]').check();
  await page.locator('[name="confirmedOriginalSize"]').check();
}

test('hollow recipe needs current server review and explicit confirmation; its source download and request remain bound', async ({ page }) => {
  const f = await fixture(page);
  try {
    await expect(page.locator('[name="resinHollowEnabled"]')).not.toBeChecked();
    await upload(page, f.review, true);
    await expect(page.locator('#resin-hollow-summary')).toContainText('radius 0.2 mm · length 3 mm');
    await expect(page.locator('#resin-hollow-summary')).toContainText('none · 0 contact(s) · 0 prior region(s)');
    await expect(page.locator('[name="confirmedHollowPreparation"]')).toBeDisabled();
    await page.locator('[name="resinHollowEnabled"]').check();
    await expect(page.getByRole('button', { name: 'Slice resin model', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Validate recipe', exact: true }).click();
    await expect(page.locator('#resin-hollow-status')).toContainText('Recipe validated');
    await confirmSize(page);
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
    expect(f.requests).toHaveLength(0);
    await page.locator('[name="confirmedHollowPreparation"]').check();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download sized source STL', exact: true }).click();
    const download = await downloadEvent, bytes = await fs.readFile(await download.path());
    expect(download.suggestedFilename()).toBe('reviewed-sized-source.stl');
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(f.review.geometrySha256);
    await page.setViewportSize({ width: 480, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
    await expect.poll(() => f.requests.length).toBe(1);
    expect(f.requests[0]).toEqual({ confirmedRequirements: true, confirmedOriginalSize: true, confirmedSizing: false, sizing: { mode: 'original' }, hollow: f.review, confirmedHollowPreparation: true });
    expect(await fs.readFile(f.job.inputPath)).toEqual(MODEL); expect(f.app.service.getJob(f.job.id).runs).toEqual([]); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('size and resin slot changes clear hollow confirmation and stale hashes are never rebound', async ({ page }) => {
  const f = await fixture(page, { slots: true });
  try {
    await upload(page, f.review); await enableAndValidate(page);
    await page.locator('[name="confirmedHollowPreparation"]').check();
    await page.getByLabel('Resin profile slot', { exact: true }).selectOption(f.ids[1]);
    await expect(page.locator('[name="confirmedHollowPreparation"]')).toBeDisabled();
    await expect(page.locator('[name="confirmedHollowPreparation"]')).not.toBeChecked();
    await page.getByRole('button', { name: 'Validate recipe', exact: true }).click();
    await expect(page.locator('#resin-hollow-error')).toContainText('different sized geometry or profile');
    await expect(page.locator('#resin-hollow-summary')).toContainText(f.review.profileSha256.slice(0, 12));
    await page.getByLabel('Resin profile slot', { exact: true }).selectOption(f.ids[0]);
    await page.getByRole('button', { name: 'Validate recipe', exact: true }).click();
    await expect(page.locator('[name="confirmedHollowPreparation"]')).toBeEnabled();
    await page.locator('[name="confirmedHollowPreparation"]').check();
    await page.getByRole('button', { name: 'Measure model', exact: true }).click();
    await expect(page.locator('[name="confirmedHollowPreparation"]')).toBeDisabled();
    await page.getByLabel('Sizing method', { exact: true }).selectOption('scale');
    await page.getByLabel('Uniform scale factor', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Validate recipe', exact: true }).click();
    await expect(page.locator('#resin-hollow-error')).toContainText('different sized geometry or profile');
    await expect(page.locator('#resin-hollow-summary')).toContainText(f.review.geometrySha256.slice(0, 12));
    expect(f.requests).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});

test('late review cannot authorize changed sizing, and disabling hollow keeps solid requests unchanged', async ({ page }) => {
  const f = await fixture(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    await upload(page, f.review); await page.locator('[name="resinHollowEnabled"]').check();
    let started; const began = new Promise(resolve => { started = resolve; });
    await page.route(`**/api/jobs/${f.job.id}/resin/hollow/review`, async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }); });
    await page.getByRole('button', { name: 'Validate recipe', exact: true }).click();
    await began;
    await page.getByRole('button', { name: 'Measure model', exact: true }).click();
    await page.getByLabel('Sizing method', { exact: true }).selectOption('scale');
    await page.getByLabel('Uniform scale factor', { exact: true }).fill('2');
    release();
    await expect(page.locator('[name="confirmedHollowPreparation"]')).toBeDisabled();
    await page.locator('[name="resinHollowEnabled"]').uncheck();
    await page.getByLabel('Sizing method', { exact: true }).selectOption('original');
    await confirmSize(page);
    await page.getByRole('button', { name: 'Slice resin model', exact: true }).click();
    await expect.poll(() => f.requests.length).toBe(1);
    expect(f.requests[0]).not.toHaveProperty('hollow'); expect(f.requests[0]).not.toHaveProperty('confirmedHollowPreparation');
    expect(f.errors).toEqual([]);
  } finally { release(); await f.close(); }
});

test('invalid, oversized and executable-bearing imports show errors; recipe labels are escaped', async ({ page }) => {
  const f = await fixture(page);
  try {
    const input = page.locator('#resin-hollow-file');
    await input.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
    await expect(page.locator('#resin-hollow-error')).toContainText('not valid JSON');
    await input.setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(256 * 1024 + 1, 32) });
    await expect(page.locator('#resin-hollow-error')).toContainText('256 KiB');
    await input.setInputFiles({ name: 'unsafe.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...f.review, executable: 'C:\\unsafe.exe' })) });
    await expect(page.locator('#resin-hollow-error')).toContainText('unsupported fields');
    const unsafe = structuredClone(f.review); unsafe.recipe.drains[0].id = '<img src=x onerror="window.hollowXss=true">';
    await input.setInputFiles({ name: 'escaped.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(unsafe)) });
    await expect(page.locator('#resin-hollow-summary')).toContainText(unsafe.recipe.drains[0].id);
    expect(await page.locator('#resin-hollow-summary img').count()).toBe(0);
    await page.locator('[name="resinHollowEnabled"]').check();
    await page.getByRole('button', { name: 'Validate recipe', exact: true }).click();
    await expect(page.locator('#resin-hollow-error')).toContainText('identifiers');
    expect(await page.evaluate(() => Boolean(window.hollowXss))).toBe(false);
    expect(f.requests).toHaveLength(0); expect(f.errors).toEqual([]);
  } finally { await f.close(); }
});
