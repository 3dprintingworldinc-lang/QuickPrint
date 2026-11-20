'use strict';

// Source-bound comparison of a complete supported output. No native program,
// network endpoint or printer is invoked here. A conforming result remains an
// unqualified raster result until a separate controlled production workflow.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const { auditResinHollowReferences } = require('./resin-hollow-audit');
const { verifyResinHollowSupports, createSupportedHollow3mf, assertSupportedHollowInput } = require('./resin-hollow-supports');
const { scanResinGooFile, buildResinHollowGrid, RESIN_HOLLOW_RASTER_LIMITS } = require('./resin-hollow-raster');
const { auditResinHollowFinalGridAsync, resolveHollowFinalGridWorkerPath } = require('./resin-hollow-final-grid-async');
const { RESIN_HOLLOW_FINAL_GRID_LIMITS } = require('./resin-hollow-final-grid');
const { assertTargetProperties } = require('./resin-engine');

const AXES = ['x', 'y', 'z'], HASH = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_HOLLOW_FINAL_AUDIT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function keys(value, allowed, required, label) { if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail(`Invalid ${label}.`); }
function snapshot(value, maximum, label) { if (!Buffer.isBuffer(value) || value.length < 1 || value.length > maximum || (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer)) throw fail(`${label} must be a bounded owned Buffer.`, 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT', 413); return Buffer.from(value); }
function reference(value) {
  keys(value, ['filePath', 'sha256', 'input3mf', 'effectivePreset'], ['filePath', 'sha256', 'input3mf', 'effectivePreset'], 'native artifact');
  if (typeof value.filePath !== 'string' || !path.isAbsolute(value.filePath) || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) throw fail('Native artifacts require an absolute path and frozen SHA-256.');
  return { filePath: value.filePath, sha256: value.sha256, input3mf: snapshot(value.input3mf, 32 * 1024 * 1024, 'Native input'), effectivePreset: snapshot(value.effectivePreset, 1024 * 1024, 'Native effective preset') };
}
function sublimits(value, caps) { if (value === undefined) return {}; keys(value, Object.keys(caps), [], 'resource limits'); for (const [key, item] of Object.entries(value)) if (!Number.isSafeInteger(item) || item < 1 || item > caps[key]) throw fail('Resource limits may only lower positive whole-number hard bounds.', 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT', 413); return { ...value }; }
const workerDirectory = path.dirname(resolveHollowFinalGridWorkerPath());
const SOURCE_PIN = [
  ...['resin-hollow-final-audit.js', 'resin-hollow-audit.js', 'resin-hollow-supports.js', 'resin-hollow-raster.js', 'resin-hollow-final-grid-async.js'].map(name => ({ name, filePath: path.join(__dirname, name) })),
  ...['resin-hollow-final-grid-worker.js', 'resin-hollow-final-grid.js', 'resin-hollow-grid.js'].map(name => ({ name, filePath: path.join(workerDirectory, name) })),
].map(item => { const bytes = syncFs.readFileSync(item.filePath); if (!bytes.length || bytes.length > 512 * 1024) throw fail('A final audit implementation module exceeds its source bound.'); return { ...item, sha256: hash(bytes) }; });
async function manifest() {
  const modules = [];
  for (const item of SOURCE_PIN) { const bytes = await fs.readFile(item.filePath); if (!bytes.length || bytes.length > 512 * 1024 || hash(bytes) !== item.sha256) throw fail('Final audit sources changed after initialization; restart from an unchanged installation.', 'RESIN_HOLLOW_FINAL_AUDIT_TOOL_CHANGED', 409); modules.push({ name: item.name, sha256: item.sha256 }); }
  return { modules, nodeVersion: process.versions.node, v8Version: process.versions.v8, platform: process.platform, arch: process.arch, sourceCachePolicy: 'unchanged installation at initialization; restart after source updates' };
}
function semantic(record) {
  const result = { ...record, gridAudit: { ...record.gridAudit, finalMaterialAudit: { ...record.gridAudit?.finalMaterialAudit } } };
  delete result.sha256; delete result.resources; delete result.gridAudit.resources; delete result.gridAudit.limits;
  delete result.gridAudit.finalMaterialAudit.resources; delete result.gridAudit.finalMaterialAudit.limits;
  return result;
}
function compatible(left, right) {
  // Matching complete definitions also forbids hidden pause, motion, delay or
  // exposure changes, including when global per-layer-settings is disabled.
  const fields = ['layerCount', 'resolutionX', 'resolutionY', 'displayWidthMm', 'displayHeightMm', 'machineZMm', 'layerHeightMm', 'mirrorX', 'mirrorY', 'antiAliasingLevel', 'greyLevel', 'blurLevel', 'grayscaleBits', 'exposureTimeSeconds', 'bottomExposureTimeSeconds', 'bottomLayerCount', 'transitionLayerCount', 'delayMode', 'timing', 'motion', 'bottomLightPwm', 'lightPwm', 'perLayerSettings'];
  if (left.definitionsSha256 !== right.definitionsSha256 || fields.some(key => !isDeepStrictEqual(left.metadata[key], right.metadata[key]))) throw fail('Final output and body references require identical complete layer definitions, image geometry and physical settings.', 'RESIN_HOLLOW_FINAL_ALIGNMENT_UNSUPPORTED', 409);
}

async function implementation(options) {
  keys(options, ['source', 'plan', 'expectedBinding', 'solid', 'hollow', 'final', 'supports', 'provider', 'targetProperties', 'placement', 'policy', 'limits', 'signal'], ['source', 'plan', 'expectedBinding', 'solid', 'hollow', 'final', 'supports', 'provider', 'targetProperties', 'placement', 'policy'], 'final hollow audit');
  const started = performance.now(), signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('Use a native AbortSignal.');
  const limits = options.limits ?? {}; keys(limits, ['reference', 'scan', 'grid', 'timeoutMs'], [], 'final audit limits');
  const timeoutMs = limits.timeoutMs ?? 300000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw fail('Use a bounded positive whole-number final audit timeout.');
  const check = () => { if (signal?.aborted) throw fail('Final hollow audit cancelled.', 'PREPARATION_CANCELLED', 409); if (performance.now() - started > timeoutMs) throw fail('The complete final audit exceeded its deadline.', 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT', 413); };
  const remaining = () => Math.max(1, Math.floor(timeoutMs - (performance.now() - started)));
  check();
  const source = snapshot(options.source, 84 + 250000 * 50, 'Sized source'), plan = structuredClone(options.plan), expectedBinding = structuredClone(options.expectedBinding);
  const solid = reference(options.solid), hollow = reference(options.hollow), final = reference(options.final);
  keys(options.supports, ['plan', 'preset'], ['plan', 'preset'], 'support authority');
  const supports = { plan: structuredClone(options.supports.plan), preset: snapshot(options.supports.preset, 1024 * 1024, 'Frozen support preset') };
  const support = verifyResinHollowSupports(source, plan, expectedBinding, supports.preset, supports.plan).plan;
  const policy = structuredClone(options.policy), provider = structuredClone(options.provider), targetProperties = structuredClone(options.targetProperties), placement = structuredClone(options.placement);
  if (support.geometry.modelElevationMm !== 0 && policy.referenceMode !== 'suppressed-support-elevation') throw fail('The body references must retain the exact final model elevation and sampling phase.', 'RESIN_HOLLOW_FINAL_ALIGNMENT_UNSUPPORTED', 409);
  if (!final.effectivePreset.equals(supports.preset)) throw fail('Final effective preset differs from its frozen support authority.', 'RESIN_HOLLOW_SUPPORT_CHANGED', 409);
  const expected = createSupportedHollow3mf(source, plan, expectedBinding, supports.preset, support, placement).threeMf;
  assertSupportedHollowInput(final.input3mf, expected, 'final'); check();
  const scanLimits = sublimits(limits.scan, RESIN_HOLLOW_RASTER_LIMITS), gridLimits = sublimits(limits.grid, RESIN_HOLLOW_FINAL_GRID_LIMITS);
  const referenceLimits = structuredClone(limits.reference ?? {}); keys(referenceLimits, ['scan', 'grid', 'timeoutMs'], [], 'body reference limits');
  if (referenceLimits.timeoutMs !== undefined && (!Number.isSafeInteger(referenceLimits.timeoutMs) || referenceLimits.timeoutMs < 1 || referenceLimits.timeoutMs > 180000)) throw fail('Body reference timeout may only lower its positive whole-number hard bound.', 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT', 413);
  const tool = await manifest(); check();
  const body = await auditResinHollowReferences({ source, plan, expectedBinding, solid, hollow, supports, provider, targetProperties, placement, policy,
    limits: { ...referenceLimits, timeoutMs: Math.min(referenceLimits.timeoutMs ?? 180000, 180000, timeoutMs) }, signal }); check();
  if (body.disposition !== 'conforming' || body.wallPolicyResolved !== true) throw fail('A conforming source-bound body reference audit is required before comparing final supports.', 'RESIN_HOLLOW_FINAL_BODY_UNQUALIFIED', 409);
  if (body.alignment.modelElevationMm !== support.geometry.modelElevationMm) throw fail('Body reference elevation differs from the verified final support plan.', 'RESIN_HOLLOW_FINAL_ALIGNMENT_UNSUPPORTED', 409);
  const scanOptions = () => ({ limits: { ...scanLimits, timeoutMs: Math.min(scanLimits.timeoutMs ?? 60000, remaining()) }, signal });
  const scans = {};
  for (const [name, item] of Object.entries({ solid, hollow, final })) { scans[name] = await scanResinGooFile(item.filePath, scanOptions()); check(); if (scans[name].sha256 !== item.sha256) throw fail('A complete native artifact changed from its frozen digest.', 'RESIN_HOLLOW_FINAL_ARTIFACT_CHANGED', 409); }
  compatible(scans.solid, scans.hollow); compatible(scans.hollow, scans.final);
  assertTargetProperties(scans.final.metadata, targetProperties);
  const bounds = Object.values(scans).map(item => item.boundsPx);
  if (bounds.some(item => !item)) throw fail('Every final audit artifact must contain exposed material.');
  const crop = { x: Math.min(...bounds.map(item => item.x)), y: Math.min(...bounds.map(item => item.y)) };
  crop.width = Math.max(...bounds.map(item => item.x + item.width)) - crop.x; crop.height = Math.max(...bounds.map(item => item.y + item.height)) - crop.y;
  const metadata = scans.final.metadata, reduction = body.policy.reduction;
  if (crop.x < 1 || crop.y < 1 || crop.x + crop.width >= metadata.resolutionX || crop.y + crop.height >= metadata.resolutionY) throw fail('The complete final material touches the native image boundary.', 'RESIN_HOLLOW_FINAL_REFERENCE_CLIPPED', 409);
  const dimensions = { x: Math.ceil(crop.width / reduction.x) + 2, y: Math.ceil(crop.height / reduction.y) + 2, z: Math.ceil(metadata.layerCount / reduction.z) + 2 }, cells = dimensions.x * dimensions.y * dimensions.z;
  if (!Number.isSafeInteger(cells) || cells > Math.min(scanLimits.maxCells ?? RESIN_HOLLOW_RASTER_LIMITS.maxCells, gridLimits.maxVoxels ?? RESIN_HOLLOW_FINAL_GRID_LIMITS.maxVoxels) || AXES.some(axis => dimensions[axis] > (gridLimits.maxAxisLength ?? RESIN_HOLLOW_FINAL_GRID_LIMITS.maxAxisLength)) || cells * 38 + Math.max(...Object.values(dimensions)) * 20 + 8 > (gridLimits.maxWorkingBytes ?? RESIN_HOLLOW_FINAL_GRID_LIMITS.maxWorkingBytes)) throw fail('The complete six-interval final comparison exceeds its declared bounds.', 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT', 413);
  const grids = {};
  for (const [name, item] of Object.entries({ solid, hollow, final })) {
    const grid = await buildResinHollowGrid(item.filePath, { expectedSha256: item.sha256, crop, reduction, ...scanOptions() }); check();
    if (grid.definitionsSha256 !== scans[name].definitionsSha256 || grid.foregroundOutsideCropPixels !== 0) throw fail('An artifact changed between complete inspection and interval aggregation.', 'RESIN_HOLLOW_FINAL_ARTIFACT_CHANGED', 409);
    grids[name] = grid;
  }
  const pitchMm = body.alignment.frame.pitchMm, direction = body.alignment.frame.direction, pixelX = metadata.displayWidthMm / metadata.resolutionX, pixelY = metadata.displayHeightMm / metadata.resolutionY;
  const frame = { nx: dimensions.x, ny: dimensions.y, nz: dimensions.z, pitchMm, direction, originMm: {
    x: (metadata.mirrorX ? metadata.resolutionX - crop.x + reduction.x : crop.x - reduction.x) * pixelX - placement.x,
    y: (metadata.mirrorY ? crop.y - reduction.y : metadata.resolutionY - crop.y + reduction.y) * pixelY - placement.y,
    z: -support.geometry.modelElevationMm - pitchMm.z,
  } };
  const interval = name => ({ lower: grids[name].lower, upper: grids[name].upper });
  const gridAudit = await auditResinHollowFinalGridAsync({ solidBody: interval('solid'), hollowBody: interval('hollow'), final: interval('final'), frame,
    wallThicknessMm: plan.request.wallThicknessMm, uncertaintyMm: body.uncertainty.totalMm, drains: body.alignment.drains,
    supportEnvelope: support.geometry.supportEnvelope, supportRegions: support.geometry.supportRegions, boundaryPolicy: body.policy.boundaryPolicy,
    limits: { ...gridLimits, maxTimeMs: Math.min(gridLimits.maxTimeMs ?? 60000, remaining()) }, signal }); check();
  if (!isDeepStrictEqual(tool, await manifest())) throw fail('Final audit implementation changed while checking native artifacts.', 'RESIN_HOLLOW_FINAL_AUDIT_TOOL_CHANGED', 409);
  const record = { schemaVersion: 1, method: 'source-bound-final-supported-hollow-raster-v1', sourceBinding: expectedBinding, planSha256: plan.sha256, supportPlanSha256: support.sha256,
    bodyReferenceAudit: { sha256: body.sha256, disposition: body.disposition, wallPolicyResolved: body.wallPolicyResolved, nativeInvocationAttested: false },
    tool, native: { provider, ...Object.fromEntries(Object.entries({ solid, hollow, final }).map(([name, item]) => [name, { sha256: item.sha256, input3mfSha256: hash(item.input3mf), effectivePresetSha256: hash(item.effectivePreset), definitionsSha256: scans[name].definitionsSha256 }])) },
    targetProperties, alignment: { placement, modelElevationMm: support.geometry.modelElevationMm, frame, crop, completeFinalMaterial: true, maskedFinalMaterial: false, nativeLayerCount: metadata.layerCount },
    policy: body.policy, uncertainty: body.uncertainty, limits: { reference: referenceLimits, scan: { ...RESIN_HOLLOW_RASTER_LIMITS, ...scanLimits }, grid: { ...RESIN_HOLLOW_FINAL_GRID_LIMITS, maxTimeMs: 60000, ...gridLimits }, timeoutMs },
    disposition: gridAudit.disposition, gridAudit, nativeInvocationAttested: false, functionalVoidClearanceCertified: false, geometricWallCertification: false, physicalDrainageCertification: false, productionEligible: false,
    resources: { elapsedMs: Math.ceil(performance.now() - started), scans: Object.fromEntries(Object.entries(scans).map(([name, item]) => [name, item.stats])), grids: Object.fromEntries(Object.entries(grids).map(([name, item]) => [name, item.stats])) } };
  record.sha256 = digest(semantic(record)); check(); return freeze(record);
}

async function auditResinHollowFinal(options) {
  const signal = plain(options) ? options.signal : undefined;
  const timeoutMs = plain(options) && (options.limits === undefined || plain(options.limits)) ? options.limits?.timeoutMs ?? 300000 : null;
  const deadline = new AbortController(); let timer;
  let input = options;
  if ((signal === undefined || signal instanceof AbortSignal) && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300000) {
    // Keep the declared child deadline stable in the semantic record. The
    // outer timer supplies the shorter remaining total budget independently.
    timer = setTimeout(() => deadline.abort(), timeoutMs); timer.unref?.();
    input = { ...options, signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal };
  }
  try { return await implementation(input); }
  catch (error) {
    if (signal instanceof AbortSignal && signal.aborted) throw fail('Final hollow audit cancelled.', 'PREPARATION_CANCELLED', 409);
    if (deadline.signal.aborted) throw fail('The complete final audit exceeded its deadline.', 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT', 413);
    throw error;
  } finally { clearTimeout(timer); }
}
async function verifyResinHollowFinalAudit(options, record) {
  if (!plain(record) || typeof record.sha256 !== 'string' || !HASH.test(record.sha256) || digest(semantic(record)) !== record.sha256) throw fail('Stored final audit evidence changed.', 'RESIN_HOLLOW_FINAL_AUDIT_CHANGED', 409);
  const actual = await auditResinHollowFinal(options);
  if (actual.sha256 !== record.sha256) throw fail('Final source, profiles, native artifacts, implementation or checked result changed.', 'RESIN_HOLLOW_FINAL_AUDIT_CHANGED', 409);
  return actual;
}
module.exports = { auditResinHollowFinal, verifyResinHollowFinalAudit };
