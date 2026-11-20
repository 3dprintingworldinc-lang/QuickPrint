'use strict';

// Freeze all three native roles before a geometry command is allowed to run.
// This is deterministic request preparation, not an execution certificate.
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const Zip = require('adm-zip');
const { parseIni } = require('./resin-engine');
const { validateUVtoolsProperties, UV_PROPERTIES } = require('./resin-profiles');
const { verifyResinHollowPlan } = require('./resin-hollow-plan');
const { prepareResinHollowSupports, createSupportedHollow3mf, assertSupportedHollowInput } = require('./resin-hollow-supports');
const { auditResinMesh } = require('./resin-mesh');
const { projectPrusaSlaPreset } = require('./resin-hollow-preset');

const AXES = ['x', 'y', 'z'], HASH = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_HOLLOW_INPUTS_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function keys(value, allowed, required, label) { if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail(`Invalid ${label}.`); }
function number(value, min, max, label) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(`Invalid ${label}.`); return value === 0 ? 0 : value; }
function snapshot(value, maximum, label) { if (!Buffer.isBuffer(value) || !value.length || value.length > maximum || (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer)) throw fail(`Use a bounded owned ${label} Buffer.`, 'RESIN_HOLLOW_INPUTS_LIMIT', 413); return Buffer.from(value); }
function serialize(ini) { return Buffer.from(Object.keys(ini).sort().map(key => `${key} = ${ini[key]}\n`).join(''), 'utf8'); }
function zipWithout(bytes, names) { const archive = new Zip(bytes); for (const name of names) archive.deleteFile(name); for (const entry of archive.getEntries()) { entry.header.timeval = 33 << 16; entry.header.method = 0; entry.header.made = 20; entry.header.flags = 0; entry.header.attr = 0; entry.header.inAttr = 0; } return archive.toBuffer(); }
const descriptor = bytes => ({ sha256: hash(bytes), bytes: bytes.length });

function geometry(ini) {
  if (ini.printer_technology !== 'SLA' || ini.sla_archive_format !== 'SL1' || ini.display_orientation !== 'landscape' || ini.inherits) throw fail('Use a standalone landscape SLA/SL1 preset.');
  if (Object.entries(ini).some(([key, value]) => /apikey|password|token|accesscode|secret/i.test(key) && value !== '')) throw fail('Native preparation does not accept account or printer credentials.', 'RESIN_PROFILE_CREDENTIALS');
  const result = {};
  for (const [field, key, min, max] of [['resolutionX', 'display_pixels_x', 1, 20000], ['resolutionY', 'display_pixels_y', 1, 20000], ['displayWidthMm', 'display_width', .001, 2000], ['displayHeightMm', 'display_height', .001, 2000], ['machineZMm', 'max_print_height', .001, 10000], ['layerHeightMm', 'layer_height', .0001, 10]]) result[field] = number(Number(ini[key]), min, max, key);
  if (!Number.isSafeInteger(result.resolutionX) || !Number.isSafeInteger(result.resolutionY) || result.resolutionX * result.resolutionY > 100000000) throw fail('Use bounded whole-number native pixel dimensions.');
  if (Number(ini.initial_layer_height) !== result.layerHeightMm) throw fail('Phase-matched hollowing requires equal initial and ordinary layer heights.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
  for (const key of ['display_mirror_x', 'display_mirror_y', 'supports_enable', 'pad_enable', 'support_enforcers_only']) if (!['0', '1'].includes(ini[key])) throw fail(`Declare an explicit ${key}.`);
  for (const key of ['relative_correction_x', 'relative_correction_y', 'relative_correction_z', 'material_correction_x', 'material_correction_y', 'material_correction_z']) if (Number(ini[key]) !== 1) throw fail('The hollow source frame requires unit geometry corrections.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
  for (const [key, count] of [['relative_correction', 2], ['material_correction', 3]]) if (typeof ini[key] !== 'string' || !isDeepStrictEqual(ini[key].split(',').map(Number), Array(count).fill(1))) throw fail('The hollow source frame requires explicit unit vector corrections.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
  if (Number(ini.zcorrection_layers) !== 0) throw fail('Disable native automatic Z correction for this source frame.', 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED');
  return { ...result, mirrorX: ini.display_mirror_x === '1', mirrorY: ini.display_mirror_y === '1' };
}

function placementFor(requested, support, target) {
  const envelope = support.geometry.supportEnvelope, pitch = { x: target.displayWidthMm / target.resolutionX, y: target.displayHeightMm / target.resolutionY }, placement = {};
  if (requested !== undefined) { keys(requested, AXES, AXES, 'native placement'); for (const axis of AXES) placement[axis] = number(requested[axis], 0, 10000, 'native placement'); if (placement.z !== 0) throw fail('Native placement Z must remain zero.'); }
  else { for (const axis of ['x', 'y']) { const extent = axis === 'x' ? target.displayWidthMm : target.displayHeightMm; placement[axis] = Math.floor(((extent - envelope.maxMm[axis] - envelope.minMm[axis]) / 2) / pitch[axis]) * pitch[axis]; } placement.z = 0; }
  for (const axis of ['x', 'y']) { const extent = axis === 'x' ? target.displayWidthMm : target.displayHeightMm; if (placement[axis] + envelope.minMm[axis] < pitch[axis] || placement[axis] + envelope.maxMm[axis] > extent - pitch[axis]) throw fail('The entire prior support envelope and empty image margin must fit this printer.', 'RESIN_HOLLOW_NO_CAPACITY', 409); }
  if (support.geometry.modelElevationMm + envelope.maxMm.z + target.layerHeightMm >= target.machineZMm) throw fail('The prior body/support height and rounding reserve exceed this printer.', 'RESIN_HOLLOW_NO_CAPACITY', 409);
  return placement;
}

function prepareResinHollowInputs(options) {
  const required = ['source', 'plan', 'expectedBinding', 'preset', 'supportRequest', 'targetProperties', 'policy', 'profileSha256'];
  keys(options, [...required, 'placement'], required, 'hollow job inputs');
  const source = snapshot(options.source, 84 + 250000 * 50, 'sized source'), preset = snapshot(options.preset, 1024 * 1024, 'resolved native preset');
  const plan = structuredClone(options.plan), expectedBinding = structuredClone(options.expectedBinding), supportRequest = structuredClone(options.supportRequest), requestedPolicy = structuredClone(options.policy), targetProperties = structuredClone(options.targetProperties);
  if (typeof options.profileSha256 !== 'string' || !HASH.test(options.profileSha256)) throw fail('Bind the original managed profile fingerprint.');
  const prepared = verifyResinHollowPlan(source, plan, expectedBinding), sourceMeshAudit = auditResinMesh(source, { format: 'stl', units: 'mm', limits: { maxTriangles: 250000 } });
  if (sourceMeshAudit.components.some(component => component.winding !== 'positive')) throw fail('Hollow preparation requires outward-oriented source components.');
  const requestedIni = parseIni(new TextDecoder('utf-8', { fatal: true }).decode(preset));
  if (requestedIni.hollowing_enable !== '0') throw fail('Per-job hollow requests start from the frozen solid managed profile.', 'RESIN_DRAIN_PLAN_REQUIRED');
  const finalCommandIni = { ...requestedIni, ...plan.native.presetOverrides }, projectedFinal = projectPrusaSlaPreset(serialize(finalCommandIni));
  const finalPreset = projectedFinal.effectivePreset, finalIni = parseIni(finalPreset.toString('utf8')), target = geometry(finalIni);
  keys(targetProperties, UV_PROPERTIES, ['MachineName', 'LayerHeight', 'ExposureTime', 'BottomExposureTime', 'BottomLayerCount', 'BottomLiftHeight', 'LiftHeight', 'BottomLiftSpeed', 'LiftSpeed', 'RetractSpeed', 'LightPWM', 'BottomLightPWM'], 'target properties');
  validateUVtoolsProperties(targetProperties, { printerModel: targetProperties.MachineName, layerHeightMm: target.layerHeightMm, maxZMm: target.machineZMm });
  if (targetProperties.LayerHeight !== target.layerHeightMm || targetProperties.ExposureTime !== Number(finalIni.exposure_time) || targetProperties.BottomExposureTime !== Number(finalIni.initial_exposure_time)) throw fail('The frozen native exposure must match its conversion targets.');
  const support = prepareResinHollowSupports(source, plan, expectedBinding, finalPreset, supportRequest).plan;
  const placement = placementFor(options.placement, support, target);
  keys(requestedPolicy, ['reduction', 'maximumUncertaintyMm', 'boundaryPolicy'], ['reduction', 'maximumUncertaintyMm'], 'declared raster policy');
  keys(requestedPolicy.reduction, AXES, AXES, 'raster reduction');
  const reduction = Object.fromEntries(AXES.map(axis => { const value = requestedPolicy.reduction[axis]; if (!Number.isSafeInteger(value) || value < 1 || value > 512) throw fail('Raster reductions must be explicit bounded whole numbers.'); return [axis, value]; }));
  const maximumUncertaintyMm = number(requestedPolicy.maximumUncertaintyMm, Number.MIN_VALUE, plan.request.wallThicknessMm / 3, 'maximum raster uncertainty'), boundaryPolicy = requestedPolicy.boundaryPolicy ?? 'exact-raster';
  if (!['exact-raster', 'voxel-enclosure'].includes(boundaryPolicy)) throw fail('Choose a supported explicit boundary policy.');
  const nominalVoxelUncertaintyMm = Math.hypot(target.displayWidthMm / target.resolutionX * reduction.x, target.displayHeightMm / target.resolutionY * reduction.y, target.layerHeightMm * reduction.z);
  if (nominalVoxelUncertaintyMm > maximumUncertaintyMm) throw fail('The declared native reduction cannot meet its frozen uncertainty band.', 'RESIN_HOLLOW_RESOLUTION_INCONCLUSIVE', 409);
  // Native SLA validates a minimum support elevation even when enforcer-only
  // filtering would generate no points. At E=0, disable support generation;
  // the resulting body-only stack retains the same zero-origin sampling phase.
  const elevated = support.geometry.modelElevationMm !== 0;
  const policy = { reduction, maximumUncertaintyMm, boundaryPolicy, referenceMode: elevated ? 'suppressed-support-elevation' : 'zero-elevation' };
  const supported = createSupportedHollow3mf(source, plan, expectedBinding, finalPreset, support, placement).threeMf;
  const referenceIni = elevated ? { ...finalCommandIni, supports_enable: '1', pad_enable: '0', support_enforcers_only: '1', support_object_elevation: String(support.geometry.modelElevationMm) } : { ...finalCommandIni, supports_enable: '0', pad_enable: '0' };
  const projectedHollow = projectPrusaSlaPreset(serialize(referenceIni)), projectedSolid = projectPrusaSlaPreset(serialize({ ...referenceIni, hollowing_enable: '0' }));
  const hollowInput = zipWithout(supported, [support.native.supportMetadataPath]), solidInput = zipWithout(hollowInput, [plan.native.drainMetadataPath]);
  const projections = { final: projectedFinal, hollow: projectedHollow, solid: projectedSolid };
  const artifacts = Object.fromEntries(Object.entries({ final: supported, hollow: hollowInput, solid: solidInput }).map(([role, input3mf]) => [role, { input3mf, preset: projections[role].commandPreset, effectivePreset: projections[role].effectivePreset }]));
  for (const [role, item] of Object.entries(artifacts)) assertSupportedHollowInput(item.input3mf, supported, role === 'final' ? 'final' : role + '-reference');
  const record = { schemaVersion: 1, method: 'prusa-2.9.7-source-bound-hollow-inputs-v1', sourceBinding: expectedBinding, profileSha256: options.profileSha256, originalResolvedPreset: descriptor(preset), source: descriptor(source), canonicalGeometrySha256: prepared.plan.canonical.sha256,
    hollowPlan: plan, supportPlan: support, targetProperties, targetGeometry: target, placement, policy, nominalVoxelUncertaintyMm, sourceMeshAudit,
    roles: Object.fromEntries(Object.entries(artifacts).map(([role, item]) => [role, { input3mf: descriptor(item.input3mf), preset: descriptor(item.preset), effectivePreset: descriptor(item.effectivePreset), supportsGenerated: role === 'final' && finalIni.supports_enable === '1', padGenerated: role === 'final' && finalIni.pad_enable === '1' }])),
    derivation: { hollowOverrides: { ...plan.native.presetOverrides }, projections: Object.fromEntries(Object.entries(projections).map(([role, item]) => [role, item.derivation])), references: { supports_enable: referenceIni.supports_enable, pad_enable: referenceIni.pad_enable, support_enforcers_only: referenceIni.support_enforcers_only, support_object_elevation: referenceIni.support_object_elevation, authoredContactsOmitted: true, solidDrainsOmitted: true }, transforms: 'canonical Z/X/Y rotation in 3MF; explicit XY placement; no native rotate/center/arrange' },
    geometryVerified: false, nativeInvocationAttested: false, productionEligible: false };
  record.sha256 = digest(record);
  return { record: freeze(record), source, artifacts };
}

function verifyResinHollowInputs(options, record) {
  const actual = prepareResinHollowInputs(options);
  if (!isDeepStrictEqual(actual.record, record)) throw fail('The frozen hollow role inputs, authority or derivation changed.', 'RESIN_HOLLOW_INPUTS_CHANGED', 409);
  return actual;
}
module.exports = { prepareResinHollowInputs, verifyResinHollowInputs };
