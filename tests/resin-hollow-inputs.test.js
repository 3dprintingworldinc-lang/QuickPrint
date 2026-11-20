'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Zip = require('adm-zip');
const { source, binding, request, preset: bodyPreset, hash } = require('./helpers/resin-hollow-reference');
const { parseIni } = require('../src/slicing/resin-engine');
const { prepareResinHollowPlan } = require('../src/slicing/resin-hollow-plan');
const { PRUSA_SLA_TILT_KEYS } = require('../src/slicing/resin-hollow-preset');
const { expandedSlaPreset } = require('./helpers/resin-hollow-preset');
const { prepareResinHollowInputs, verifyResinHollowInputs } = require('../src/slicing/resin-hollow-inputs');
function expandedPreset(patch = {}) {
  return expandedSlaPreset({ ...parseIni(bodyPreset().toString()), sla_archive_format: 'SL1', bed_shape: '0x0,40x0,40x40,0x40', support_tree_type: 'default', support_enforcers_only: '0', supports_enable: '1', pad_enable: '1', pad_around_object: '0', pad_around_object_everywhere: '0', support_object_elevation: '5.037', pad_wall_thickness: '2', pad_wall_height: '0', support_head_penetration: '.4', support_head_front_diameter: '.8', printing_temperature: 'nil', ...patch });
}
function options() {
  const plan = prepareResinHollowPlan(source, request()).plan;
  return { source: Buffer.from(source), plan, expectedBinding: { ...binding }, preset: expandedPreset(), profileSha256: hash('Original managed profile fixture'),
    supportRequest: { mode: 'points', clearanceMm: 4, regions: [], points: [[20, 0, 0], [0, 0, 0], [20, 20, 0], [0, 20, 0]].map((point, index) => ({ id: `corner-${index}`, sourceFaceIndex: index === 3 ? 1 : 0, positionMm: { x: point[0], y: point[1], z: point[2] }, headRadiusMm: .4, allowedRadiusMm: 3 })) },
    targetProperties: { MachineName: 'QuickPrint Test', LayerHeight: .2, ExposureTime: 2, BottomExposureTime: 20, BottomLayerCount: 1, BottomLiftHeight: 5, LiftHeight: 5, BottomLiftSpeed: 100, LiftSpeed: 100, RetractSpeed: 100, LightPWM: 255, BottomLightPWM: 255 },
    policy: { reduction: { x: 1, y: 1, z: 1 }, maximumUncertaintyMm: .5, boundaryPolicy: 'voxel-enclosure' } };
}

test('all native role inputs freeze exact phase, contacts, source, complete command settings and predicted effective settings', () => {
  const input = options(), before = Buffer.from(input.source), result = prepareResinHollowInputs(input), { record, artifacts } = result;
  assert.equal(record.supportPlan.geometry.modelElevationMm, 7.037); assert.equal(record.policy.referenceMode, 'suppressed-support-elevation'); assert.equal(record.profileSha256, input.profileSha256);
  const expectedSupport = 'Metadata/Slic3r_PE_sla_support_points.txt', expectedDrains = input.plan.native.drainMetadataPath;
  for (const [role, artifact] of Object.entries(artifacts)) {
    const archive = new Zip(artifact.input3mf), command = parseIni(artifact.preset.toString()), effective = parseIni(artifact.effectivePreset.toString());
    assert.equal(Boolean(archive.getEntry(expectedSupport)), role === 'final'); assert.equal(Boolean(archive.getEntry(expectedDrains)), role !== 'solid');
    assert.equal(command.hollowing_enable, role === 'solid' ? '0' : '1'); assert.equal(command.supports_enable, '1'); assert.equal(command.pad_enable, role === 'final' ? '1' : '0');
    assert.equal(command.support_object_elevation, role === 'final' ? '5.037' : '7.037'); assert.equal(command.support_enforcers_only, role === 'final' ? '0' : '1');
    assert.equal(hash(artifact.input3mf), record.roles[role].input3mf.sha256); assert.equal(hash(artifact.preset), record.roles[role].preset.sha256); assert.equal(hash(artifact.effectivePreset), record.roles[role].effectivePreset.sha256);
    assert.ok(Object.hasOwn(command, PRUSA_SLA_TILT_KEYS[0])); assert.equal(Object.hasOwn(effective, PRUSA_SLA_TILT_KEYS[0]), false);
  }
  assert.equal(record.supportPlan.preset.sha256, hash(artifacts.final.effectivePreset)); assert.deepEqual(input.source, before);
  assert.equal(record.geometryVerified, false); assert.equal(record.nativeInvocationAttested, false); assert.equal(record.productionEligible, false); assert.equal(Object.isFrozen(record.roles.final), true);
  const replay = verifyResinHollowInputs(input, JSON.parse(JSON.stringify(record))); assert.deepEqual(replay.record, record); assert.deepEqual(replay.artifacts, artifacts);
});

test('native command controls survive projection and selected material override authority is reflected before support planning', () => {
  const input = options(); input.preset = expandedPreset({ delay_before_exposure: '1.25,2.5', support_head_penetration: '.2', material_ow_support_head_penetration: '.6' });
  const result = prepareResinHollowInputs(input), command = parseIni(result.artifacts.final.preset.toString()), effective = parseIni(result.artifacts.final.effectivePreset.toString());
  assert.equal(command.delay_before_exposure, '1.25,2.5'); assert.equal(command.support_head_penetration, '.2'); assert.equal(effective.support_head_penetration, '.6'); assert.equal(result.record.supportPlan.preset.headPenetrationMm, .6);
  assert.ok(result.record.derivation.projections.final.materialOverrides.some(item => item.key === 'support_head_penetration' && item.changed));
});

test('zero model elevation disables reference supports while retaining the same native zero-origin sampling and inactive settings', () => {
  for (const pad of ['0', '1']) {
    const input = options(); input.preset = expandedPreset({ supports_enable: '0', pad_enable: pad, pad_around_object: '1' }); input.supportRequest = { mode: 'none', clearanceMm: 4, points: [], regions: [] };
    const result = prepareResinHollowInputs(input); assert.equal(result.record.supportPlan.geometry.modelElevationMm, 0); assert.equal(result.record.policy.referenceMode, 'zero-elevation');
    for (const role of ['hollow', 'solid']) { const command = parseIni(result.artifacts[role].preset.toString()); assert.equal(command.supports_enable, '0'); assert.equal(command.pad_enable, '0'); assert.equal(command.support_object_elevation, '5.037'); assert.equal(command.support_enforcers_only, '0'); }
  }
});

test('request source and every authority fingerprint are rederived instead of trusting a stored role hash', () => {
  const input = options(), original = prepareResinHollowInputs(input);
  for (const mutate of [r => r.placement.x++, r => r.supportPlan.geometry.modelElevationMm++, r => r.roles.final.preset.sha256 = '0'.repeat(64), r => r.policy.maximumUncertaintyMm = .6, r => r.productionEligible = true]) {
    const changed = structuredClone(original.record); mutate(changed); assert.throws(() => verifyResinHollowInputs(input, changed), { code: 'RESIN_HOLLOW_INPUTS_CHANGED' });
  }
  assert.throws(() => prepareResinHollowInputs({ ...input, expectedBinding: { ...input.expectedBinding, sizingSha256: '0'.repeat(64) } }), { code: 'RESIN_HOLLOW_SOURCE_CHANGED' });
  const changed = { ...input, source: Buffer.from(input.source) }; changed.source[100] ^= 1; assert.throws(() => prepareResinHollowInputs(changed), { code: 'RESIN_HOLLOW_SOURCE_CHANGED' });
});

test('prior envelopes and conservative height must fit before native capture, independent of observed output', () => {
  const input = options();
  for (const placement of [{ x: 0, y: 10, z: 0 }, { x: 10, y: 39, z: 0 }, { x: 10, y: 10, z: 1 }]) assert.throws(() => prepareResinHollowInputs({ ...input, placement }));
  assert.throws(() => prepareResinHollowInputs({ ...input, preset: expandedPreset({ max_print_height: '27' }) }), { code: 'RESIN_HOLLOW_NO_CAPACITY' });
  assert.throws(() => prepareResinHollowInputs({ ...input, policy: { ...input.policy, reduction: { x: 2, y: 2, z: 2 } } }), { code: 'RESIN_HOLLOW_RESOLUTION_INCONCLUSIVE' });
  const exact = prepareResinHollowInputs({ ...input, placement: { x: 9, y: 10, z: 0 } }); assert.deepEqual(exact.record.placement, { x: 9, y: 10, z: 0 });
});

test('profile identity, scalar flags, target exposure and strict schema cannot be silently normalized into different geometry', () => {
  const input = options();
  for (const patch of [{ initial_layer_height: '.1' }, { relative_correction_x: '1.01' }, { zcorrection_layers: '1' }, { display_mirror_y: 'maybe' }, { display_pixels_x: '200.1' }, { printer_technology: 'FFF' }, { hollowing_enable: '1' }]) assert.throws(() => prepareResinHollowInputs({ ...input, preset: expandedPreset(patch) }));
  assert.throws(() => prepareResinHollowInputs({ ...input, targetProperties: { ...input.targetProperties, ExposureTime: 3 } }));
  assert.throws(() => prepareResinHollowInputs({ ...input, policy: { ...input.policy, referenceMode: 'zero-elevation' } }));
  assert.throws(() => prepareResinHollowInputs({ ...input, profileSha256: 'invalid' })); assert.throws(() => prepareResinHollowInputs({ ...input, unexpected: true }));
  assert.throws(() => prepareResinHollowInputs({ ...input, source: Buffer.from(new SharedArrayBuffer(input.source.length)) }), { code: 'RESIN_HOLLOW_INPUTS_LIMIT' });
});
