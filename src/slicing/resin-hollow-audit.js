'use strict';

// Compares actual paired reference rasters against a source-bound requested
// cavity/drain policy. It is not a native invocation or physical certificate.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { inspectZip, readZipEntry } = require('./psam/zip-inspection');
const { parseIni, assertTargetProperties } = require('./resin-engine');
const { validateUVtoolsProperties, UV_PROPERTIES } = require('./resin-profiles');
const { auditResinMesh } = require('./resin-mesh');
const { verifyResinHollowPlan, createResinHollow3mf } = require('./resin-hollow-plan');
const { verifyResinHollowSupports, createSupportedHollow3mf, assertSupportedHollowInput } = require('./resin-hollow-supports');
const { scanResinGooFile, buildResinHollowGrid, RESIN_HOLLOW_RASTER_LIMITS } = require('./resin-hollow-raster');
const { RESIN_HOLLOW_GRID_LIMITS } = require('./resin-hollow-grid');
const { auditResinHollowGridAsync, resolveHollowGridWorkerPath } = require('./resin-hollow-grid-async');

const AXES = ['x', 'y', 'z'], HASH = /^[a-f0-9]{64}$/;
const MAX_SOURCE = 84 + 250000 * 50, MAX_INPUT = 32 * 1024 * 1024;
const ZIP_LIMITS = { maxArchiveBytes: MAX_INPUT, maxEntryBytes: MAX_INPUT, maxTotalUncompressedBytes: MAX_INPUT, maxEntries: 4, maxCompressionRatio: 10000 };
const HOLLOW_KEYS = ['hollowing_enable', 'hollowing_min_thickness', 'hollowing_quality', 'hollowing_closing_distance'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_HOLLOW_AUDIT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
function implementationSources() {
  const worker = resolveHollowGridWorkerPath(), files = ['resin-hollow-audit.js', 'resin-hollow-plan.js', 'resin-hollow-supports.js', 'resin-hollow-raster.js', 'resin-hollow-grid-async.js', 'resin-geometry.js', 'resin-mesh.js', 'resin-plate.js', 'resin-plate-engine.js', 'resin-engine.js', 'resin-profiles.js', 'psam/zip-inspection.js'].map(name => ({ name, filePath: path.join(__dirname, name) }));
  files.push({ name: 'resin-hollow-grid-worker.js', filePath: worker }, { name: 'resin-hollow-grid.js', filePath: path.join(path.dirname(worker), 'resin-hollow-grid.js') });
  return files;
}
// Long-lived callers must restart after an in-place source update. Pinning at
// initialization prevents later disk bytes being attributed to cached helpers.
// This selected source pin assumes one unchanged installation at startup; it is
// not a whole-runtime or native-invocation attestation.
const SOURCE_PIN = implementationSources().map(item => {
  const bytes = syncFs.readFileSync(item.filePath);
  if (!bytes.length || bytes.length > 512 * 1024) throw fail('An audit implementation module exceeds its source bound.', 'RESIN_HOLLOW_AUDIT_TOOL_CHANGED', 409);
  return { ...item, sha256: hash(bytes) };
});
function keys(value, allowed, required, label) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail(`Invalid ${label}.`);
}
function finite(value, min, max, label) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(`Invalid ${label}.`); return value === 0 ? 0 : value; }
function vector(value, min, max, label) { keys(value, AXES, AXES, label); return Object.fromEntries(AXES.map(axis => [axis, finite(value[axis], min, max, label)])); }
function snapshot(value, maximum, label) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > maximum || (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer)) throw fail(`${label} must be an owned bounded Buffer.`, 'RESIN_HOLLOW_AUDIT_LIMIT', 413);
  return Buffer.from(value);
}
function sublimits(value, caps) {
  if (value === undefined) return {};
  keys(value, Object.keys(caps), [], 'resource limits');
  for (const [key, item] of Object.entries(value)) if (!Number.isSafeInteger(item) || item < 1 || item > caps[key]) throw fail('Resource limits may only lower positive whole-number hard bounds.', 'RESIN_HOLLOW_AUDIT_LIMIT', 413);
  return { ...value };
}
function requestedDirection(orientation, direction) {
  const [x, y, z] = AXES.map(axis => orientation[axis] * Math.PI / 180), [cx, cy, cz] = [x, y, z].map(Math.cos), [sx, sy, sz] = [x, y, z].map(Math.sin);
  const zx = direction.x * cz - direction.y * sz, zy = direction.x * sz + direction.y * cz, xy = zy * cx - direction.z * sx, xz = zy * sx + direction.z * cx;
  const n = [zx * cy + xz * sy, xy, -zx * sy + xz * cy], length = Math.hypot(...n);
  return Object.fromEntries(AXES.map((axis, index) => [axis, n[index] / length]));
}
function reference(value) {
  keys(value, ['filePath', 'sha256', 'input3mf', 'effectivePreset'], ['filePath', 'sha256', 'input3mf', 'effectivePreset'], 'native reference');
  if (typeof value.filePath !== 'string' || !value.filePath || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) throw fail('Native references require a path and frozen GOO SHA-256.');
  const input3mf = snapshot(value.input3mf, MAX_INPUT, 'Native 3MF'), effectivePreset = snapshot(value.effectivePreset, 1024 * 1024, 'Effective native preset');
  return { filePath: value.filePath, sha256: value.sha256, input3mf, effectivePreset, ini: parseIni(new TextDecoder('utf-8', { fatal: true }).decode(effectivePreset)) };
}
function payloads(bytes) {
  const archive = inspectZip(bytes, ZIP_LIMITS);
  return new Map(archive.entries.map(entry => [entry.name, readZipEntry(bytes, entry, ZIP_LIMITS)]));
}
function assertInput(actual, expected, omitDrains) {
  const wanted = payloads(expected); if (omitDrains) wanted.delete('Metadata/Slic3r_PE_sla_drain_holes.txt');
  const supplied = payloads(actual);
  if (supplied.size !== wanted.size || [...wanted].some(([name, bytes]) => !supplied.get(name)?.equals(bytes))) throw fail('Native 3MF content differs from the complete source, placement or drain request.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
}
function presets(solid, hollow, plan, referenceMode, elevationMm) {
  for (const ini of [solid, hollow]) {
    if (ini.printer_technology !== 'SLA' || ini.display_orientation !== 'landscape' || ini.pad_enable !== '0') throw fail('Paired body references require SLA landscape output without a pad.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
    if (referenceMode === 'suppressed-support-elevation' ? ini.supports_enable !== '1' || ini.support_enforcers_only !== '1' || Number(ini.support_object_elevation) !== elevationMm : ini.supports_enable !== '0') throw fail('The body reference must retain its explicit support suppression and elevation policy.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
    for (const key of ['relative_correction_x', 'relative_correction_y', 'relative_correction_z', 'material_correction_x', 'material_correction_y', 'material_correction_z']) if (Number(ini[key]) !== 1) throw fail('Native geometry corrections must be explicitly one.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
    for (const [key, count] of [['relative_correction', 2], ['material_correction', 3]]) if (typeof ini[key] !== 'string' || !isDeepStrictEqual(ini[key].split(',').map(Number), Array(count).fill(1))) throw fail('Native vector corrections must be explicitly one.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
    if (Number(ini.zcorrection_layers) !== 0) throw fail('Native Z correction must be explicitly disabled.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
  }
  if (solid.hollowing_enable !== '0' || HOLLOW_KEYS.some(key => hollow[key] === undefined || Number(hollow[key]) !== Number(plan.native.presetOverrides[key]))) throw fail('Native effective hollow settings differ from the frozen plan.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
  const relevant = ini => Object.fromEntries(Object.entries(ini).filter(([key]) => !HOLLOW_KEYS.includes(key)));
  if (!isDeepStrictEqual(relevant(solid), relevant(hollow))) throw fail('Paired references changed settings beyond the explicit hollow request.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
}
function checkMetadata(metadata, ini) {
  if (metadata.perLayerSettings) throw fail('An explicit qualified per-layer physical schedule is required before auditing per-layer settings.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
  for (const [field, key] of Object.entries({ resolutionX: 'display_pixels_x', resolutionY: 'display_pixels_y', displayWidthMm: 'display_width', displayHeightMm: 'display_height', machineZMm: 'max_print_height', layerHeightMm: 'layer_height', exposureTimeSeconds: 'exposure_time', bottomExposureTimeSeconds: 'initial_exposure_time' })) {
    const expected = Number(ini[key]);
    if (!Number.isFinite(expected) || Math.abs(metadata[field] - expected) > (field.startsWith('resolution') ? 0 : Math.max(1e-7, Math.abs(expected) * 2 ** -22))) throw fail(`GOO ${field} differs from its native preset.`, 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
  }
  if (!['0', '1'].includes(ini.display_mirror_x) || !['0', '1'].includes(ini.display_mirror_y) || metadata.mirrorX !== (ini.display_mirror_x === '1') || metadata.mirrorY !== (ini.display_mirror_y === '1')) throw fail('GOO image handedness differs from its native preset.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
}
async function implementationManifest() {
  const modules = [];
  for (const item of SOURCE_PIN) {
    const bytes = await fs.readFile(item.filePath);
    if (!bytes.length || bytes.length > 512 * 1024 || hash(bytes) !== item.sha256) throw fail('Audit sources changed after initialization; restart from an unchanged installation.', 'RESIN_HOLLOW_AUDIT_TOOL_CHANGED', 409);
    modules.push({ name: item.name, sha256: item.sha256 });
  }
  return { modules, sourceCachePolicy: 'unchanged installation at initialization; restart after source updates', nodeVersion: process.versions.node, v8Version: process.versions.v8, platform: process.platform, arch: process.arch };
}
function semanticRecord(record) {
  const copy = { ...record, gridAudit: { ...record.gridAudit }, sourceMeshAudit: { ...record.sourceMeshAudit, limits: { ...record.sourceMeshAudit?.limits } }, canonicalMeshAudit: { ...record.canonicalMeshAudit, limits: { ...record.canonicalMeshAudit?.limits } } };
  delete copy.resources; delete copy.sha256; delete copy.gridAudit.resources;
  // The declared limits are recorded separately; remaining-time budgets vary
  // with I/O duration and do not change the independently checked outcome.
  delete copy.gridAudit.limits;
  delete copy.sourceMeshAudit.limits.maxTimeMs;
  delete copy.canonicalMeshAudit.limits.maxTimeMs;
  return copy;
}
function sameSchedule(left, right) {
  const fields = ['layerCount', 'resolutionX', 'resolutionY', 'displayWidthMm', 'displayHeightMm', 'machineZMm', 'layerHeightMm', 'mirrorX', 'mirrorY', 'antiAliasingLevel', 'greyLevel', 'blurLevel', 'grayscaleBits', 'exposureTimeSeconds', 'bottomExposureTimeSeconds', 'bottomLayerCount', 'transitionLayerCount', 'delayMode', 'timing', 'motion', 'bottomLightPwm', 'lightPwm', 'perLayerSettings'];
  if (left.definitionsSha256 !== right.definitionsSha256 || fields.some(key => !isDeepStrictEqual(left.metadata[key], right.metadata[key]))) throw fail('Paired reference layer positions, physical settings or raster geometry differ.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
}

async function auditImplementation(options) {
  keys(options, ['source', 'plan', 'expectedBinding', 'solid', 'hollow', 'provider', 'targetProperties', 'placement', 'policy', 'supports', 'limits', 'signal'], ['source', 'plan', 'expectedBinding', 'solid', 'hollow', 'provider', 'targetProperties', 'placement', 'policy'], 'hollow reference audit');
  const started = performance.now();
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('Use a native AbortSignal.');
  const limits = options.limits ?? {};
  keys(limits, ['scan', 'grid', 'timeoutMs'], [], 'audit limits');
  const scanLimits = sublimits(limits.scan, RESIN_HOLLOW_RASTER_LIMITS), gridLimits = sublimits(limits.grid, RESIN_HOLLOW_GRID_LIMITS);
  const timeoutMs = limits.timeoutMs === undefined ? 180000 : finite(limits.timeoutMs, 1, 180000, 'audit timeout');
  if (!Number.isSafeInteger(timeoutMs)) throw fail('Audit timeout must be a positive whole number.');
  const check = () => { if (signal?.aborted) throw fail('Hollow audit cancelled.', 'PREPARATION_CANCELLED', 409); if (performance.now() - started > timeoutMs) throw fail('Hollow audit exceeded its total time budget.', 'RESIN_HOLLOW_AUDIT_LIMIT', 413); };
  check();
  const source = snapshot(options.source, MAX_SOURCE, 'Sized source STL');
  if (source.length < 134 || source.length !== 84 + source.readUInt32LE(80) * 50) throw fail('Audit input must be the reviewed normalized binary millimetre STL.', 'RESIN_HOLLOW_SOURCE_UNSUPPORTED');
  const plan = structuredClone(options.plan), binding = structuredClone(options.expectedBinding);
  const prepared = verifyResinHollowPlan(source, plan, binding); check();
  const meshAudit = auditResinMesh(source, { format: 'stl', units: 'mm', limits: { maxTimeMs: Math.min(20000, Math.max(1, Math.floor(timeoutMs - (performance.now() - started)))) } }); check();
  if (meshAudit.components.some(component => component.winding !== 'positive')) throw fail('Hollow reference auditing requires outward-oriented source components.', 'RESIN_HOLLOW_SOURCE_UNSUPPORTED');
  const canonicalMeshAudit = auditResinMesh(prepared.stl, { format: 'stl', units: 'mm', limits: { maxTimeMs: Math.min(20000, Math.max(1, Math.floor(timeoutMs - (performance.now() - started)))) } }); check();
  if (canonicalMeshAudit.vertexCount !== meshAudit.vertexCount || canonicalMeshAudit.triangleCount !== meshAudit.triangleCount || canonicalMeshAudit.componentCount !== meshAudit.componentCount || canonicalMeshAudit.components.some(component => component.winding !== 'positive')) throw fail('Canonical orientation changed the source mesh topology.', 'RESIN_HOLLOW_SOURCE_UNSUPPORTED');
  const placement = vector(options.placement, 0, 10000, 'reference placement');
  if (placement.z !== 0) throw fail('The current paired body audit requires zero model Z placement.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
  keys(options.provider, ['name', 'version', 'sha256'], ['name', 'version', 'sha256'], 'native provider binding');
  if (options.provider.name !== 'PrusaSlicer' || options.provider.version !== '2.9.7' || typeof options.provider.sha256 !== 'string' || !HASH.test(options.provider.sha256)) throw fail('Pin the inspected PrusaSlicer 2.9.7 provider fingerprint.');
  const provider = { ...options.provider }, solid = reference(options.solid), hollow = reference(options.hollow);
  keys(options.policy, ['reduction', 'maximumUncertaintyMm', 'boundaryPolicy', 'referenceMode'], ['reduction', 'maximumUncertaintyMm'], 'declared raster policy');
  const referenceMode = options.policy.referenceMode ?? 'zero-elevation';
  if (!['zero-elevation', 'suppressed-support-elevation'].includes(referenceMode) || (referenceMode === 'suppressed-support-elevation' && options.supports === undefined)) throw fail('Elevated body references require an explicit frozen support plan.');
  let modelElevationMm = 0;
  let supportBinding = null;
  if (options.supports !== undefined) {
    keys(options.supports, ['plan', 'preset'], ['plan', 'preset'], 'inactive reference support authority');
    const supportPreset = snapshot(options.supports.preset, 1024 * 1024, 'Frozen support preset'), supportPlan = structuredClone(options.supports.plan);
    verifyResinHollowSupports(source, plan, binding, supportPreset, supportPlan);
    if (referenceMode === 'suppressed-support-elevation') modelElevationMm = supportPlan.geometry.modelElevationMm;
    const expected = createSupportedHollow3mf(source, plan, binding, supportPreset, supportPlan, placement).threeMf;
    assertSupportedHollowInput(solid.input3mf, expected, 'solid-reference'); assertSupportedHollowInput(hollow.input3mf, expected, 'hollow-reference');
    if (referenceMode === 'suppressed-support-elevation' && [solid, hollow].some(item => inspectZip(item.input3mf, { ...ZIP_LIMITS, maxEntries: 5 }).entries.some(entry => entry.name === supportPlan.native.supportMetadataPath))) throw fail('Suppressed references must omit every authored support contact; manual contacts bypass native enforcer filtering.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
    const ini = parseIni(new TextDecoder('utf-8', { fatal: true }).decode(supportPreset));
    const exempt = [...HOLLOW_KEYS, 'supports_enable', 'pad_enable', ...(referenceMode === 'suppressed-support-elevation' ? ['support_object_elevation', 'support_enforcers_only'] : [])];
    const relevant = value => Object.fromEntries(Object.entries(value).filter(([key]) => !exempt.includes(key)));
    if (!isDeepStrictEqual(relevant(ini), relevant(hollow.ini))) throw fail('The inactive body reference changed the frozen support profile beyond its disabled selectors.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
    supportBinding = { supportPlanSha256: supportPlan.sha256, presetSha256: hash(supportPreset), inactiveInReferences: true };
  } else {
    const expected3mf = createResinHollow3mf(source, plan, binding, placement).threeMf;
    assertInput(solid.input3mf, expected3mf, true); assertInput(hollow.input3mf, expected3mf, false);
  }
  check();
  presets(solid.ini, hollow.ini, plan, referenceMode, modelElevationMm);
  const requiredProperties = ['MachineName', 'LayerHeight', 'ExposureTime', 'BottomExposureTime', 'BottomLayerCount', 'BottomLiftHeight', 'LiftHeight', 'BottomLiftSpeed', 'LiftSpeed', 'RetractSpeed', 'LightPWM', 'BottomLightPWM'];
  keys(options.targetProperties, UV_PROPERTIES, requiredProperties, 'frozen target properties');
  const targetProperties = { ...options.targetProperties };
  if (typeof targetProperties.MachineName !== 'string' || !targetProperties.MachineName || Buffer.byteLength(targetProperties.MachineName) > 32 || /[\r\n\0]/.test(targetProperties.MachineName)) throw fail('Use a bounded printer machine identity.');
  validateUVtoolsProperties(targetProperties, { printerModel: targetProperties.MachineName, layerHeightMm: Number(solid.ini.layer_height), maxZMm: Number(solid.ini.max_print_height), code: 'RESIN_HOLLOW_AUDIT_INVALID' });
  if (targetProperties.ExposureTime !== Number(solid.ini.exposure_time) || targetProperties.BottomExposureTime !== Number(solid.ini.initial_exposure_time)) throw fail('Effective native exposure differs from the frozen target conversion.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
  const reduction = vector(options.policy.reduction, 1, 512, 'grid reduction');
  if (AXES.some(axis => !Number.isSafeInteger(reduction[axis]))) throw fail('Grid reduction factors must be explicit whole numbers.');
  const maximumUncertaintyMm = finite(options.policy.maximumUncertaintyMm, Number.MIN_VALUE, plan.request.wallThicknessMm / 3, 'maximum declared uncertainty');
  const boundaryPolicy = options.policy.boundaryPolicy ?? 'exact-raster';
  if (!['exact-raster', 'voxel-enclosure'].includes(boundaryPolicy)) throw fail('Choose a declared supported body boundary policy.');
  const policy = { reduction, maximumUncertaintyMm, boundaryPolicy, referenceMode };
  const tool = await implementationManifest();
  check();
  const scanOptions = () => ({ limits: { ...scanLimits, timeoutMs: Math.min(scanLimits.timeoutMs ?? 60000, Math.max(1, Math.floor(timeoutMs - (performance.now() - started)))) }, signal });
  const solidScan = await scanResinGooFile(solid.filePath, scanOptions()); check();
  const hollowScan = await scanResinGooFile(hollow.filePath, scanOptions()); check();
  if (solidScan.sha256 !== solid.sha256 || hollowScan.sha256 !== hollow.sha256) throw fail('A native reference changed from its frozen artifact digest.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
  checkMetadata(solidScan.metadata, solid.ini); checkMetadata(hollowScan.metadata, hollow.ini); sameSchedule(solidScan, hollowScan);
  assertTargetProperties(solidScan.metadata, targetProperties); assertTargetProperties(hollowScan.metadata, targetProperties);
  if (!solidScan.boundsPx) throw fail('The solid reference contains no exposed source.', 'RESIN_HOLLOW_REFERENCE_EMPTY');
  const metadata = solidScan.metadata, nominalZ = Number(solid.ini.layer_height);
  if (!Number.isFinite(nominalZ) || nominalZ <= 0 || Number(solid.ini.initial_layer_height) !== nominalZ) throw fail('Body auditing requires equal explicit initial and ordinary layer heights.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
  let maximumLayerZDeviationMm = 0;
  for (let index = 0; index < solidScan.layerPositionsMm.length; index++) {
    const expected = (index + 1) * nominalZ, difference = Math.abs(solidScan.layerPositionsMm[index] - expected);
    if (difference > Math.max(1e-6, expected * 2 ** -21)) throw fail('Body references do not follow the declared zero-origin uniform layer sequence.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
    maximumLayerZDeviationMm = Math.max(maximumLayerZDeviationMm, difference);
  }
  const pitch = { x: metadata.displayWidthMm / metadata.resolutionX * reduction.x, y: metadata.displayHeightMm / metadata.resolutionY * reduction.y, z: nominalZ * reduction.z };
  const voxelAllowanceMm = Math.hypot(...AXES.map(axis => pitch[axis]));
  const displayRoundingAllowanceMm = Math.abs(metadata.displayWidthMm - Number(solid.ini.display_width)) + Math.abs(metadata.displayHeightMm - Number(solid.ini.display_height));
  const uncertaintyMm = voxelAllowanceMm + maximumLayerZDeviationMm + displayRoundingAllowanceMm;
  if (uncertaintyMm > maximumUncertaintyMm) throw fail('The chosen raster grid cannot meet the declared uncertainty policy.', 'RESIN_HOLLOW_RESOLUTION_INCONCLUSIVE', 409);
  // Declared terminal Z alone cannot establish occupied source height: a
  // truncated object may retain arbitrarily many blank layer definitions.
  const occupiedRange = solidScan.occupiedLayerRange;
  const occupiedSourceBoundsZMm = { min: occupiedRange.firstPositionMm - nominalZ / 2 - modelElevationMm, max: occupiedRange.lastPositionMm - nominalZ / 2 - modelElevationMm };
  if (Math.abs(occupiedSourceBoundsZMm.min) > uncertaintyMm || Math.abs(occupiedSourceBoundsZMm.max - plan.canonical.dimensionsMm.z) > uncertaintyMm) throw fail('The occupied source material does not reach the reviewed canonical Z bounds within the declared uncertainty.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
  const sourceCrop = { ...solidScan.boundsPx }, crop = { ...sourceCrop };
  if (boundaryPolicy === 'voxel-enclosure' && hollowScan.boundsPx) {
    const bounds = hollowScan.boundsPx, right = Math.max(crop.x + crop.width, bounds.x + bounds.width), bottom = Math.max(crop.y + crop.height, bounds.y + bounds.height);
    crop.x = Math.min(crop.x, bounds.x); crop.y = Math.min(crop.y, bounds.y); crop.width = right - crop.x; crop.height = bottom - crop.y;
  }
  if (crop.x < 1 || crop.y < 1 || crop.x + crop.width >= metadata.resolutionX || crop.y + crop.height >= metadata.resolutionY) throw fail('The solid reference touches the native image boundary.', 'RESIN_HOLLOW_REFERENCE_CLIPPED', 409);
  const dimensions = { x: Math.ceil(crop.width / reduction.x) + 2, y: Math.ceil(crop.height / reduction.y) + 2, z: Math.ceil(metadata.layerCount / reduction.z) + 2 };
  const cells = dimensions.x * dimensions.y * dimensions.z;
  if (!Number.isSafeInteger(cells) || cells > Math.min(scanLimits.maxCells ?? RESIN_HOLLOW_RASTER_LIMITS.maxCells, gridLimits.maxVoxels ?? RESIN_HOLLOW_GRID_LIMITS.maxVoxels) || AXES.some(axis => dimensions[axis] > (gridLimits.maxAxisLength ?? RESIN_HOLLOW_GRID_LIMITS.maxAxisLength))) throw fail('Declared grid exceeds the combined reader/auditor bounds.', 'RESIN_HOLLOW_AUDIT_LIMIT', 413);
  const solidGrid = await buildResinHollowGrid(solid.filePath, { expectedSha256: solid.sha256, crop, reduction, ...scanOptions() }); check();
  const hollowGrid = await buildResinHollowGrid(hollow.filePath, { expectedSha256: hollow.sha256, crop, reduction, ...scanOptions() }); check();
  if (solidGrid.sha256 !== solidScan.sha256 || hollowGrid.sha256 !== hollowScan.sha256 || solidGrid.definitionsSha256 !== solidScan.definitionsSha256 || hollowGrid.definitionsSha256 !== hollowScan.definitionsSha256) throw fail('A reference changed between inspection and interval aggregation.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
  if (solidGrid.foregroundOutsideCropPixels !== 0) throw fail('The source reference changed outside its measured raster bounds.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
  const direction = { x: metadata.mirrorX ? -1 : 1, y: metadata.mirrorY ? 1 : -1, z: 1 };
  const pixelX = metadata.displayWidthMm / metadata.resolutionX, pixelY = metadata.displayHeightMm / metadata.resolutionY;
  const physicalBounds = {
    x: metadata.mirrorX ? [(metadata.resolutionX - sourceCrop.x - sourceCrop.width) * pixelX - placement.x, (metadata.resolutionX - sourceCrop.x) * pixelX - placement.x] : [sourceCrop.x * pixelX - placement.x, (sourceCrop.x + sourceCrop.width) * pixelX - placement.x],
    y: metadata.mirrorY ? [sourceCrop.y * pixelY - placement.y, (sourceCrop.y + sourceCrop.height) * pixelY - placement.y] : [(metadata.resolutionY - sourceCrop.y - sourceCrop.height) * pixelY - placement.y, (metadata.resolutionY - sourceCrop.y) * pixelY - placement.y],
  };
  for (const [axis, pitchMm] of [['x', pixelX], ['y', pixelY]]) if (Math.abs(physicalBounds[axis][0]) > 2 * pitchMm + displayRoundingAllowanceMm || Math.abs(physicalBounds[axis][1] - plan.canonical.dimensionsMm[axis]) > 2 * pitchMm + displayRoundingAllowanceMm) throw fail('The native source footprint does not match the reviewed canonical geometry and placement.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
  if (Math.abs(metadata.totalHeightMm - modelElevationMm - plan.canonical.dimensionsMm.z) > nominalZ + maximumLayerZDeviationMm) throw fail('The native source height does not match the reviewed canonical geometry and model elevation.', 'RESIN_HOLLOW_REFERENCE_CHANGED', 409);
  const originMm = {
    x: (metadata.mirrorX ? metadata.resolutionX - crop.x + reduction.x : crop.x - reduction.x) * pixelX - placement.x,
    y: (metadata.mirrorY ? crop.y - reduction.y : metadata.resolutionY - crop.y + reduction.y) * pixelY - placement.y,
    z: -modelElevationMm - pitch.z,
  };
  const frame = { nx: solidGrid.frame.dimensions.x, ny: solidGrid.frame.dimensions.y, nz: solidGrid.frame.dimensions.z, pitchMm: pitch, originMm, direction };
  // Check actual black channels against the intended canonical cylinders. Native
  // float32 displacement receives no inferred exemption: it must fit this band.
  const drains = plan.native.drains.map((native, index) => {
    const unit = requestedDirection(plan.request.orientation, plan.request.drains[index].direction);
    return { id: native.id, startMm: Object.fromEntries(AXES.map(axis => [axis, native.requestedCanonicalStartMm[axis] - unit[axis]])), direction: unit, radiusMm: plan.request.drains[index].radiusMm, lengthMm: plan.request.drains[index].lengthMm + 1 };
  });
  const result = await auditResinHollowGridAsync({ solid: { lower: solidGrid.lower, upper: solidGrid.upper }, hollow: { lower: hollowGrid.lower, upper: hollowGrid.upper }, frame, wallThicknessMm: plan.request.wallThicknessMm, uncertaintyMm, drains, boundaryPolicy, exteriorSeedPolicy: 'processed-source-exterior',
    limits: { ...gridLimits, maxTimeMs: Math.min(gridLimits.maxTimeMs ?? 60000, Math.max(1, Math.floor(timeoutMs - (performance.now() - started)))) }, signal }); check();
  if (!isDeepStrictEqual(tool, await implementationManifest())) throw fail('The audit implementation changed while checking its native artifacts.', 'RESIN_HOLLOW_AUDIT_TOOL_CHANGED', 409);
  check();
  const outside = hollowGrid.foregroundOutsideCropPixels;
  const wallPolicyResolved = result.wallResolutionIntervalMm?.lower !== null && result.wallResolutionIntervalMm?.lower >= plan.request.wallThicknessMm - maximumUncertaintyMm;
  const disposition = outside > 0 ? 'nonconforming' : result.disposition === 'conforming' && !wallPolicyResolved ? 'inconclusive' : result.disposition;
  const record = { schemaVersion: 1, method: 'source-bound-hollow-reference-raster-v1', sourceBinding: binding, planSha256: plan.sha256, canonicalGeometrySha256: prepared.plan.canonical.sha256, tool,
    native: { provider, solid: { sha256: solid.sha256, input3mfSha256: hash(solid.input3mf), effectivePresetSha256: hash(solid.effectivePreset) }, hollow: { sha256: hollow.sha256, input3mfSha256: hash(hollow.input3mf), effectivePresetSha256: hash(hollow.effectivePreset) }, definitionsSha256: solidScan.definitionsSha256 },
    targetProperties, supportBinding, alignment: { placement, supportsEnabled: referenceMode === 'suppressed-support-elevation', supportsGenerated: false, padEnabled: false, modelElevationMm, frame, crop, sourceCrop, occupiedLayerRange: occupiedRange, occupiedSourceBoundsZMm, drains }, policy, limits: { scan: { ...RESIN_HOLLOW_RASTER_LIMITS, ...scanLimits }, grid: { ...RESIN_HOLLOW_GRID_LIMITS, ...gridLimits }, timeoutMs },
    uncertainty: { voxelAllowanceMm, maximumLayerZDeviationMm, displayRoundingAllowanceMm, totalMm: uncertaintyMm, drainEnvelope: 'requested canonical cylinder plus documented 1 mm exterior extension; no inferred native displacement exemption' },
    disposition, foregroundOutsideCropPixels: outside, wallPolicyResolved, gridAudit: result, sourceMeshAudit: meshAudit, canonicalMeshAudit,
    nativeInvocationAttested: false, geometricWallCertification: false, physicalDrainageCertification: false, productionEligible: false,
    resources: { elapsedMs: Math.ceil(performance.now() - started), solidScan: solidScan.stats, hollowScan: hollowScan.stats, solidGrid: solidGrid.stats, hollowGrid: hollowGrid.stats },
  };
  record.sha256 = digest(semanticRecord(record));
  return freeze(record);
}

async function auditResinHollowReferences(options) {
  const signal = plain(options) ? options.signal : undefined;
  try { return await auditImplementation(options); }
  catch (error) {
    // Readers and the isolated worker have their own cancellation errors. The
    // public preparation boundary retains one stable cancellation contract.
    if (signal instanceof AbortSignal && signal.aborted) throw fail('Hollow audit cancelled.', 'PREPARATION_CANCELLED', 409);
    throw error;
  }
}

async function verifyResinHollowReferenceAudit(options, record) {
  if (!plain(record) || typeof record.sha256 !== 'string' || !HASH.test(record.sha256) || digest(semanticRecord(record)) !== record.sha256) throw fail('Stored hollow audit evidence changed.', 'RESIN_HOLLOW_AUDIT_CHANGED', 409);
  const actual = await auditResinHollowReferences(options);
  if (actual.sha256 !== record.sha256) throw fail('Hollow reference inputs, implementation or checked outcome changed.', 'RESIN_HOLLOW_AUDIT_CHANGED', 409);
  return actual;
}

module.exports = { auditResinHollowReferences, verifyResinHollowReferenceAudit };
