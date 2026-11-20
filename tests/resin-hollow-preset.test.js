'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIni } = require('../src/slicing/resin-engine');
const { projectPrusaSlaPreset, PRUSA_SLA_TILT_KEYS, PRUSA_SLA_MATERIAL_OVERRIDES } = require('../src/slicing/resin-hollow-preset');

const { expandedSlaPreset, DEFAULT_SAVED_SLA_PRESET: DEFAULT_SAVED } = require('./helpers/resin-hollow-preset');

const text = bytes => bytes.toString('utf8');
const fixture = expandedSlaPreset;

test('actual native default fixture predicts the exact independently observed 130-key SL1 bytes', () => {
  const input = Buffer.from('# generated timestamp is not recipe identity\r\n' + DEFAULT_SAVED.replaceAll('\n', '\r\n'));
  const before = Buffer.from(input), projected = projectPrusaSlaPreset(input);
  assert.equal(projected.derivation.provider.version, '2.9.7');
  assert.equal(projected.derivation.source.keyCount, 153);
  assert.equal(projected.derivation.commandPreset.keyCount, 153);
  assert.equal(projected.derivation.effectivePreset.keyCount, 130);
  assert.equal(projected.derivation.effectivePreset.sha256, 'eef133e982a4d3d9ec6f51e61b05766f40b59dd92e313f1aefcb64da8d059f03');
  assert.equal(projected.derivation.exportOmissions.length, 27);
  assert.equal(projected.derivation.insertedPresetIds.length, 4);
  assert.equal(projected.derivation.nativeInvocationAttested, false);
  assert.equal(projected.derivation.productionEligible, false);
  assert.ok(projected.commandPreset.equals(Buffer.from(DEFAULT_SAVED)));
  assert.deepEqual(input, before);
  assert.ok(!text(projected.commandPreset).includes('\r'));
  assert.ok(!text(projected.effectivePreset).includes('#'));
  assert.equal(parseIni(text(projected.effectivePreset)).physical_printer_settings_id, '');
});

test('all 26 real tilt controls remain in the command while native SL1 export omits them', () => {
  const patch = { delay_before_exposure: '1.25,2.75', tower_hop_height: '0.125,0.25', tilt_down_cycles: '2,3', use_tilt: '0,1' };
  const value = projectPrusaSlaPreset(fixture(patch)), command = parseIni(text(value.commandPreset)), effective = parseIni(text(value.effectivePreset));
  assert.equal(PRUSA_SLA_TILT_KEYS.length, 26);
  for (const key of PRUSA_SLA_TILT_KEYS) { assert.ok(Object.hasOwn(command, key)); assert.ok(!Object.hasOwn(effective, key)); }
  for (const [key, expected] of Object.entries(patch)) assert.equal(command[key], expected);
  assert.deepEqual(value.derivation.exportOmissions.filter(item => item.reason === 'SL1-tilt-export-omission').map(item => item.key).sort(), [...PRUSA_SLA_TILT_KEYS].sort());
});

test('material scalar, integer and percent overrides change the predicted echo without changing the command request', () => {
  const patch = { support_head_front_diameter: '1.2', material_ow_support_head_front_diameter: '0.8', faded_layers: '9', material_ow_faded_layers: '5', support_small_pillar_diameter_percent: '25%', material_ow_support_small_pillar_diameter_percent: '50%', absolute_correction: '0.03', material_ow_absolute_correction: '0' };
  const value = projectPrusaSlaPreset(fixture(patch)), command = parseIni(text(value.commandPreset)), effective = parseIni(text(value.effectivePreset));
  assert.equal(Object.keys(PRUSA_SLA_MATERIAL_OVERRIDES).length, 23);
  assert.equal(command.support_head_front_diameter, '1.2'); assert.equal(effective.support_head_front_diameter, '0.8');
  assert.equal(command.faded_layers, '9'); assert.equal(effective.faded_layers, '5');
  assert.equal(command.support_small_pillar_diameter_percent, '25%'); assert.equal(effective.support_small_pillar_diameter_percent, '50%');
  assert.equal(effective.absolute_correction, '0');
  const changed = value.derivation.materialOverrides.filter(item => item.changed);
  assert.deepEqual(changed.map(item => item.key).sort(), ['absolute_correction', 'faded_layers', 'support_head_front_diameter', 'support_small_pillar_diameter_percent']);
  assert.equal(effective.material_ow_faded_layers, '5');
});

test('nil material controls preserve base values, and only native nullable nil values are omitted', () => {
  const value = projectPrusaSlaPreset(fixture({ support_head_front_diameter: '1.2', material_ow_support_head_front_diameter: 'nil', printing_temperature: 'nil', material_notes: 'nil' }));
  const command = parseIni(text(value.commandPreset)), effective = parseIni(text(value.effectivePreset));
  assert.equal(command.material_ow_support_head_front_diameter, 'nil');
  assert.equal(effective.support_head_front_diameter, '1.2');
  assert.equal(effective.material_ow_support_head_front_diameter, undefined);
  assert.equal(effective.printing_temperature, undefined);
  assert.equal(effective.material_notes, 'nil');
  const nonnil = projectPrusaSlaPreset(fixture({ printing_temperature: '25' }));
  assert.equal(parseIni(text(nonnil.effectivePreset)).printing_temperature, '25');
});

test('existing preset IDs, compatibility omission and native-formatted quoted strings remain bound', () => {
  const value = projectPrusaSlaPreset(fixture({ printer_settings_id: 'owned profile', physical_printer_settings_id: 'local', compatible_printers: '"one";"two"', material_notes: 'line1\\nline2' }));
  const command = parseIni(text(value.commandPreset)), effective = parseIni(text(value.effectivePreset));
  assert.equal(command.compatible_printers, '"one";"two"'); assert.equal(effective.compatible_printers, undefined);
  assert.equal(effective.printer_settings_id, 'owned profile'); assert.equal(effective.physical_printer_settings_id, 'local');
  assert.equal(effective.material_notes, 'line1\\nline2');
  assert.equal(value.derivation.insertedPresetIds.length, 2);
});

test('known empty host fields are retained in the command and explicitly omitted from native SL1 scope', () => {
  const value = projectPrusaSlaPreset(fixture({ print_host: '', printhost_apikey: '', printhost_cafile: '' }));
  const command = parseIni(text(value.commandPreset)), effective = parseIni(text(value.effectivePreset));
  for (const key of ['print_host', 'printhost_apikey', 'printhost_cafile']) {
    assert.equal(command[key], ''); assert.equal(effective[key], undefined);
    assert.equal(value.derivation.exportOmissions.find(item => item.key === key).reason, 'SL1-banned-export-key');
    assert.throws(() => projectPrusaSlaPreset(fixture({ [key]: 'nonempty' })));
  }
  for (const patch of [{ accesscode: '123' }, { post_process: '' }]) assert.throws(() => projectPrusaSlaPreset(fixture(patch)));
});

test('numerically equal signed-zero scalar overrides preserve native base serialization', () => {
  const value = projectPrusaSlaPreset(fixture({ absolute_correction: '-0', material_ow_absolute_correction: '0' }));
  assert.equal(parseIni(text(value.effectivePreset)).absolute_correction, '-0');
  const record = value.derivation.materialOverrides.find(item => item.key === 'absolute_correction');
  assert.equal(record.changed, false); assert.equal(record.baseValue, '-0'); assert.equal(record.overrideValue, '0');
});

test('reordering/comments/CRLF do not alter command/effective identity and derivation is immutable and JSON-stable', () => {
  const reversed = Object.entries(parseIni(DEFAULT_SAVED)).reverse().map(([key, value]) => key + ' = ' + value).join('\r\n');
  const a = projectPrusaSlaPreset(Buffer.from(DEFAULT_SAVED)), b = projectPrusaSlaPreset(Buffer.from('# other header\r\n' + reversed + '\r\n'));
  assert.deepEqual(a.commandPreset, b.commandPreset); assert.deepEqual(a.effectivePreset, b.effectivePreset);
  assert.notEqual(a.derivation.source.sha256, b.derivation.source.sha256);
  assert.ok(Object.isFrozen(a.derivation.materialOverrides[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(a.derivation)), a.derivation);
  const input = fixture({ support_head_width: '2' }), value = projectPrusaSlaPreset(input); input.fill(0);
  assert.equal(parseIni(text(value.commandPreset)).support_head_width, '2');
});

test('invalid and unexpanded inputs, credentials, malformed scalar types and resources fail closed', () => {
  for (const input of [Buffer.alloc(0), Buffer.from('printer_technology = SLA\nsla_archive_format = SL1\n'), Buffer.from([0xff]), Buffer.from(DEFAULT_SAVED + '\n[section]\na=1\n'), Buffer.from(DEFAULT_SAVED + '\nlayer_height=0.2\n'), Buffer.from(DEFAULT_SAVED + '\n__proto__=bad\n'), fixture({ printer_technology: 'FFF' }), fixture({ sla_archive_format: 'SLX' }), fixture({ material_ow_support_object_elevation: '2' }), fixture({ material_ow_support_head_width: 'NaN' }), fixture({ material_ow_faded_layers: '1.5' }), fixture({ material_ow_support_small_pillar_diameter_percent: '50' }), fixture({ printing_temperature: 'Infinity' }), fixture({ printhost_apikey: 'nonempty' }), fixture({ post_process: 'anything' }), fixture({ material_notes: '\0' })]) assert.throws(() => projectPrusaSlaPreset(input));
  assert.throws(() => projectPrusaSlaPreset('not owned bytes'));
  assert.throws(() => projectPrusaSlaPreset(Buffer.alloc(1024 * 1024 + 1)), { code: 'RESIN_HOLLOW_PRESET_LIMIT' });
  assert.throws(() => projectPrusaSlaPreset(Buffer.from(DEFAULT_SAVED + 'material_notes = ' + 'a'.repeat(16385))), { code: 'RESIN_HOLLOW_PRESET_LIMIT' });
  if (typeof SharedArrayBuffer !== 'undefined') assert.throws(() => projectPrusaSlaPreset(Buffer.from(new SharedArrayBuffer(100))), { code: 'RESIN_HOLLOW_PRESET_LIMIT' });
});
