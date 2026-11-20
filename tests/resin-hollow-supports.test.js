'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Zip = require('adm-zip');
const { source, binding, request: hollowRequest, preset: bodyPreset, hash } = require('./helpers/resin-hollow-reference');
const { prepareResinHollowPlan } = require('../src/slicing/resin-hollow-plan');
const { parseIni } = require('../src/slicing/resin-engine');
const { prepareResinHollowSupports, verifyResinHollowSupports, createSupportedHollow3mf, assertSupportedHollowInput } = require('../src/slicing/resin-hollow-supports');
function preset(patch = {}) {
  return Buffer.from(Object.entries({ ...parseIni(bodyPreset(true).toString()), supports_enable: '1', pad_enable: '1', pad_around_object: '0', pad_around_object_everywhere: '0', support_object_elevation: '5', pad_wall_thickness: '2', pad_wall_height: '0', support_head_penetration: '0.4', support_head_front_diameter: '0.8', support_tree_type: 'default', support_max_pillar_link_distance: '0', ...patch }).map(([key, value]) => `${key} = ${value}\n`).join(''));
}
function request() {
  return { mode: 'points', clearanceMm: 4, regions: [], points: [[20, 0, 0], [0, 0, 0], [20, 20, 0], [0, 20, 0]].map((position, index) => ({ id: `contact-${index}`, sourceFaceIndex: index === 3 ? 1 : 0, positionMm: { x: position[0], y: position[1], z: position[2] }, headRadiusMm: 0.4, allowedRadiusMm: 3 })) };
}
const hollowPlan = orientation => prepareResinHollowPlan(source, { ...hollowRequest(), ...(orientation ? { orientation } : {}) }).plan;

test('authored support contacts bind source faces, centered native coordinates, profile and prior material regions', () => {
  const hollow = hollowPlan(), data = preset(), value = request(), before = Buffer.from(source), actual = prepareResinHollowSupports(source, hollow, binding, data, value);
  assert.equal(actual.plan.hollowPlanSha256, hollow.sha256); assert.equal(actual.plan.preset.sha256, hash(data)); assert.equal(actual.plan.geometry.modelElevationMm, 7);
  const tokens = actual.metadata.toString().split('|')[1].trim().split(/\s+/).map(Number);
  assert.deepEqual(tokens.slice(0, 5), [10, -10, -10, Math.fround(0.4), 2]); assert.equal(tokens.length, 20);
  assert.equal(actual.plan.geometry.supportRegions.length, 5); assert.equal(actual.plan.geometry.supportRegions.at(-1).id, 'native-pad');
  assert.deepEqual(actual.plan.geometry.supportRegions.at(-1).minMm, { x: -4, y: -4, z: -7 }); assert.equal(actual.plan.geometry.supportRegions.at(-1).maxMm.z, -5);
  assert.equal(actual.plan.temporarySupportRemovalRequired, true); assert.equal(actual.plan.functionalVoidClearanceCertified, false); assert.equal(actual.plan.productionEligible, false);
  assert.deepEqual(source, before); assert.deepEqual(verifyResinHollowSupports(source, hollow, binding, data, actual.plan), actual);
  value.points[0].positionMm.x = 1; assert.equal(actual.plan.request.points[0].positionMm.x, 20); assert.equal(Object.isFrozen(actual.plan.geometry.supportRegions[0].minMm), true);
});

test('canonical Z/X/Y rotation travels with the contacts and native placement does not alter their sidecar', () => {
  const hollow = hollowPlan({ x: 30, y: 15, z: 27 }), data = preset(), actual = prepareResinHollowSupports(source, hollow, binding, data, request());
  const a = createSupportedHollow3mf(source, hollow, binding, data, actual.plan, { x: 1, y: 2, z: 0 }), b = createSupportedHollow3mf(source, hollow, binding, data, actual.plan, { x: 3, y: 4, z: 0 });
  const za = new Zip(a.threeMf), zb = new Zip(b.threeMf), name = actual.plan.native.supportMetadataPath;
  assert.deepEqual(za.readFile(name), zb.readFile(name)); assert.equal(za.getEntries().length, 5); assert.notEqual(a.sha256, b.sha256);
  assert.equal(a.supportPlanSha256, actual.plan.sha256); assert.equal(a.hollowPlanSha256, hollow.sha256); assert.equal(a.productionEligible, false);
  assert.deepEqual(createSupportedHollow3mf(source, hollow, binding, data, actual.plan, { x: 1, y: 2, z: 0 }), a);
  for (const point of actual.plan.native.points) for (const value of Object.values(point.objectLocalMm)) assert.equal(value, Math.fround(value));
});

test('off and automatic modes have explicit distinct authorization without inventing contact points', () => {
  const hollow = hollowPlan(), off = prepareResinHollowSupports(source, hollow, binding, preset({ supports_enable: '0', pad_enable: '0' }), { mode: 'none', clearanceMm: 0, points: [], regions: [] });
  assert.equal(off.metadata, null); assert.equal(off.plan.geometry.modelElevationMm, 0); assert.equal(off.plan.geometry.supportRegions.length, 0); assert.equal(off.plan.temporarySupportRemovalRequired, false);
  assert.deepEqual(verifyResinHollowSupports(source, hollow, binding, preset({ supports_enable: '0', pad_enable: '0' }), JSON.parse(JSON.stringify(off.plan))).plan, off.plan);
  const automatic = { mode: 'automatic', clearanceMm: 4, points: [], regions: [{ id: 'approved-under-part', minMm: { x: -3, y: -3, z: -7 }, maxMm: { x: 23, y: 23, z: 0.4 } }] };
  const actual = prepareResinHollowSupports(source, hollow, binding, preset(), automatic);
  assert.equal(actual.metadata, null); assert.equal(actual.plan.geometry.supportRegions[0].id, 'region-approved-under-part');
  assert.throws(() => prepareResinHollowSupports(source, hollow, binding, preset(), { ...automatic, regions: [] }), { code: 'RESIN_HOLLOW_SUPPORT_INVALID' });
});

test('selected branching heads honor only native material overrides and total prior region capacity is bounded', () => {
  const hollow = hollowPlan(), data = preset({ support_tree_type: 'branching', branchingsupport_head_penetration: '3', branchingsupport_head_front_diameter: '2', material_ow_branchingsupport_head_penetration: '2.5', material_ow_support_object_elevation: '99', material_ow_pad_wall_thickness: '19' });
  const actual = prepareResinHollowSupports(source, hollow, binding, data, request()).plan;
  assert.equal(actual.preset.treeType, 'branching'); assert.equal(actual.preset.headPenetrationMm, 2.5); assert.equal(actual.preset.headRadiusMm, 1); assert.equal(actual.geometry.modelElevationMm, 7);
  assert.equal(actual.geometry.supportRegions[0].maxMm.z, 2.9);
  assert.throws(() => prepareResinHollowSupports(source, hollow, binding, preset({ support_tree_type: 'organic' }), request()));
  const region = index => ({ id: `approved-${index}`, minMm: { x: -3, y: -3, z: -7 }, maxMm: { x: 23, y: 23, z: 0.4 } });
  const value = { mode: 'automatic', clearanceMm: 4, points: [], regions: Array.from({ length: 511 }, (_, index) => region(index)) };
  assert.equal(prepareResinHollowSupports(source, hollow, binding, preset(), value).plan.geometry.supportRegions.length, 512);
  value.regions.push(region(511)); assert.throws(() => prepareResinHollowSupports(source, hollow, binding, preset(), value), { code: 'RESIN_HOLLOW_SUPPORT_LIMIT' });
});

test('contact validation rejects wrong surfaces, collapsed native positions, invalid modes, fields and regions', () => {
  const hollow = hollowPlan(), data = preset();
  for (const mutate of [v => v.points[0].positionMm.z = 5, v => v.points[0].sourceFaceIndex = 2, v => v.points[0].sourceFaceIndex = -1, v => v.points[0].headRadiusMm = 0, v => v.points[0].allowedRadiusMm = 0.1, v => v.points[0].id = '../bad', v => v.points[0].extra = true, v => v.clearanceMm = 1, v => v.mode = 'automatic']) {
    const value = request(); mutate(value); assert.throws(() => prepareResinHollowSupports(source, hollow, binding, data, value));
  }
  const duplicate = request(); duplicate.points[1].positionMm = { ...duplicate.points[0].positionMm };
  assert.throws(() => prepareResinHollowSupports(source, hollow, binding, data, duplicate), { code: 'RESIN_HOLLOW_SUPPORT_PRECISION' });
  const value = request(); value.regions.push({ id: 'far', minMm: { x: 100, y: 100, z: 100 }, maxMm: { x: 101, y: 101, z: 101 } });
  assert.throws(() => prepareResinHollowSupports(source, hollow, binding, data, value), { code: 'RESIN_HOLLOW_SUPPORT_INVALID' });
  assert.throws(() => prepareResinHollowSupports(source, hollow, binding, preset({ supports_enable: '0' }), request()));
  assert.throws(() => prepareResinHollowSupports(source, hollow, binding, preset({ support_object_elevation: 'NaN' }), request()));
});

test('rederivation rejects altered source, profile, plan, contact or support-region authority', () => {
  const hollow = hollowPlan(), data = preset(), actual = prepareResinHollowSupports(source, hollow, binding, data, request());
  for (const mutate of [p => p.request.points[0].allowedRadiusMm++, p => p.geometry.supportRegions[0].minMm.x--, p => p.geometry.modelElevationMm++, p => p.native.points[0].objectLocalMm.z++, p => p.productionEligible = true, p => p.sha256 = '0'.repeat(64)]) {
    const changed = structuredClone(actual.plan); mutate(changed); assert.throws(() => verifyResinHollowSupports(source, hollow, binding, data, changed));
  }
  assert.throws(() => verifyResinHollowSupports(source, hollow, binding, preset({ support_head_penetration: '0.5' }), actual.plan), { code: 'RESIN_HOLLOW_SUPPORT_CHANGED' });
  assert.throws(() => verifyResinHollowSupports(source, hollow, { ...binding, sizingSha256: '0'.repeat(64) }, data, actual.plan));
  if (typeof SharedArrayBuffer !== 'undefined') assert.throws(() => prepareResinHollowSupports(Buffer.from(new SharedArrayBuffer(source.length)), hollow, binding, data, request()), { code: 'RESIN_HOLLOW_SUPPORT_LIMIT' });
});

test('native contact decimal aliases preserve exact float32 semantics while extra content and separator ambiguity are rejected', () => {
  const hollow = hollowPlan(), data = preset(), actual = prepareResinHollowSupports(source, hollow, binding, data, request()), native = createSupportedHollow3mf(source, hollow, binding, data, actual.plan, { x: 1, y: 2, z: 0 });
  const archive = new Zip(native.threeMf), name = actual.plan.native.supportMetadataPath;
  archive.updateFile(name, Buffer.from(archive.readAsText(name).replaceAll(String(Math.fround(0.4)), '0.4')));
  assert.equal(assertSupportedHollowInput(archive.toBuffer(), native.threeMf).entries, 5);
  const reference = new Zip(native.threeMf); reference.deleteFile(name);
  assert.equal(assertSupportedHollowInput(reference.toBuffer(), native.threeMf, 'hollow-reference').entries, 4);
  reference.deleteFile(hollow.native.drainMetadataPath); assert.equal(assertSupportedHollowInput(reference.toBuffer(), native.threeMf, 'solid-reference').entries, 3);
  assert.throws(() => assertSupportedHollowInput(reference.toBuffer(), native.threeMf, 'final'), { code: 'RESIN_HOLLOW_SUPPORT_CHANGED' });
  for (const change of [text => text.replace('|', '| '), text => text.replace(' 0.4 ', '  0.4 '), text => text.replace(' 0.4 ', ' 0.5 '), text => text.replace(' 2 ', ' 2.00000001 ')]) {
    const bad = new Zip(archive.toBuffer()); bad.updateFile(name, Buffer.from(change(bad.readAsText(name)))); assert.throws(() => assertSupportedHollowInput(bad.toBuffer(), native.threeMf), { code: 'RESIN_HOLLOW_SUPPORT_CHANGED' });
  }
});
