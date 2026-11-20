'use strict';

// PrusaSlicer version_2.9.7: CLI --save expands SLA defaults, while SL1.cpp
// fill_slicerconf excludes tilt options/nil values. SLAPrint::apply creates
// preset IDs and applies these scalar material overrides before SL1 export.
// This pure projection does not attest that --save was actually executed.
const { createHash } = require('node:crypto');

const MAX_BYTES = 1024 * 1024, MAX_KEYS = 1024, MAX_LINE = 16384;
const TILT_KEYS = Object.freeze([
  'delay_before_exposure', 'delay_after_exposure', 'delay_to_reflood',
  'tower_hop_height', 'tower_speed', 'use_tilt',
  'tilt_down_initial_speed', 'tilt_down_initial_speed_slx',
  'tilt_down_offset_steps', 'tilt_down_offset_delay',
  'tilt_down_finish_speed', 'tilt_down_finish_speed_slx',
  'tilt_down_cycles', 'tilt_down_delay',
  'tilt_up_initial_speed', 'tilt_up_initial_speed_slx',
  'tilt_up_offset_steps', 'tilt_up_offset_delay',
  'tilt_up_finish_speed', 'tilt_up_finish_speed_slx',
  'tilt_up_cycles', 'tilt_up_delay',
  'dynamic_delay_before_profile', 'dynamic_delay_before_timeout',
  'dynamic_tilt_down_profile', 'dynamic_tilt_up_profile'
]);
const FLOAT_OVERRIDES = [
  'support_head_front_diameter', 'branchingsupport_head_front_diameter',
  'support_head_penetration', 'branchingsupport_head_penetration',
  'support_head_width', 'branchingsupport_head_width',
  'support_pillar_diameter', 'branchingsupport_pillar_diameter',
  'support_critical_angle', 'branchingsupport_critical_angle',
  'support_max_bridge_length', 'branchingsupport_max_bridge_length',
  'support_max_pillar_link_distance', 'branchingsupport_max_pillar_link_distance',
  'elefant_foot_compensation', 'absolute_correction', 'pad_wall_slope'
];
const INT_OVERRIDES = ['faded_layers', 'support_points_density_relative', 'support_max_bridges_on_pillar', 'branchingsupport_max_bridges_on_pillar'];
const PERCENT_OVERRIDES = ['support_small_pillar_diameter_percent', 'branchingsupport_small_pillar_diameter_percent'];
const OVERRIDES = Object.freeze(Object.fromEntries([
  ...FLOAT_OVERRIDES.map(key => [key, 'float']),
  ...INT_OVERRIDES.map(key => [key, 'integer']),
  ...PERCENT_OVERRIDES.map(key => [key, 'percent'])
]));
const PRESET_IDS = Object.freeze(['physical_printer_settings_id', 'printer_settings_id', 'sla_material_settings_id', 'sla_print_settings_id']);
const BANNED_EXPORT_KEYS = new Set(['compatible_printers', 'compatible_prints', 'print_host', 'printhost_apikey', 'printhost_cafile']);
const EMPTY_HOST_KEYS = new Set(['print_host', 'printhost_apikey', 'printhost_cafile']);
const CREDENTIAL_KEY = /(?:apikey|api_key|password|passwd|token|accesscode|secret|print_host|printhost|host_type)/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, code = 'RESIN_HOLLOW_PRESET_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function serialize(map) { return Buffer.from(Object.keys(map).sort().map(key => `${key} = ${map[key]}\n`).join(''), 'utf8'); }
function scalar(value, type, key) {
  const numeric = type === 'percent' ? value.endsWith('%') ? value.slice(0, -1) : '' : value;
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(numeric) || !Number.isFinite(Number(numeric)) || (type === 'integer' && (!Number.isSafeInteger(Number(numeric)) || Math.abs(Number(numeric)) > 2147483647))) throw fail(`Unsupported native scalar ${key}.`);
}

function projectPrusaSlaPreset(savedPreset) {
  if (!Buffer.isBuffer(savedPreset) || !savedPreset.length || savedPreset.length > MAX_BYTES || (typeof SharedArrayBuffer !== 'undefined' && savedPreset.buffer instanceof SharedArrayBuffer)) throw fail('Use bounded owned Prusa SLA --save bytes.', 'RESIN_HOLLOW_PRESET_LIMIT', 413);
  const source = Buffer.from(savedPreset);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(source); } catch { throw fail('The saved SLA preset must be UTF-8.'); }
  if (text.includes('\0')) throw fail('The saved SLA preset contains a NUL.');
  const command = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    if (line.length > MAX_LINE) throw fail('A saved SLA preset line is too long.', 'RESIN_HOLLOW_PRESET_LIMIT', 413);
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const match = /^\s*([A-Za-z_0-9]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || ['__proto__', 'prototype', 'constructor'].includes(match[1]) || Object.hasOwn(command, match[1])) throw fail('Use a standalone saved SLA INI without duplicate keys or sections.');
    if ((CREDENTIAL_KEY.test(match[1]) && !(EMPTY_HOST_KEYS.has(match[1]) && match[2] === '')) || match[1] === 'post_process') throw fail('Provider credentials and post-processing commands are not supported.');
    command[match[1]] = match[2];
    if (Object.keys(command).length > MAX_KEYS) throw fail('The saved SLA preset has too many options.', 'RESIN_HOLLOW_PRESET_LIMIT', 413);
  }
  if (command.printer_technology !== 'SLA' || command.sla_archive_format !== 'SL1') throw fail('Use a saved SLA/SL1 preset.');
  // A partial user INI is not the expanded output of the pinned --save path.
  for (const key of [...TILT_KEYS, 'printing_temperature', ...Object.keys(OVERRIDES).flatMap(key => [key, `material_ow_${key}`])]) if (!Object.hasOwn(command, key)) throw fail(`The saved SLA preset is missing expanded ${key}.`);
  for (const key of Object.keys(command)) if (key.startsWith('material_ow_') && !Object.hasOwn(OVERRIDES, key.slice(12))) throw fail(`Unsupported native material override ${key}.`);
  const effective = { ...command }, materialOverrides = [];
  for (const [key, type] of Object.entries(OVERRIDES)) {
    const overrideKey = `material_ow_${key}`, baseValue = command[key], overrideValue = command[overrideKey];
    scalar(baseValue, type, key);
    if (overrideValue !== 'nil') {
      scalar(overrideValue, type, overrideKey);
      // Native equality is numeric. Preserve the original serialization when
      // equal values (including signed zero) need no material override.
      const value = raw => Number(type === 'percent' ? raw.slice(0, -1) : raw);
      if (value(overrideValue) !== value(baseValue)) effective[key] = overrideValue;
    }
    materialOverrides.push({ key, overrideKey, type, baseValue, overrideValue, effectiveValue: effective[key], changed: effective[key] !== baseValue });
  }
  if (command.printing_temperature !== 'nil') scalar(command.printing_temperature, 'integer', 'printing_temperature');
  const omissions = [];
  for (const key of Object.keys(effective).sort()) {
    const reason = TILT_KEYS.includes(key) ? 'SL1-tilt-export-omission' : BANNED_EXPORT_KEYS.has(key) ? 'SL1-banned-export-key' : (key === 'printing_temperature' || key.startsWith('material_ow_')) && effective[key] === 'nil' ? 'SL1-native-nil-option' : null;
    if (reason) { omissions.push({ key, commandValue: command[key], reason }); delete effective[key]; }
  }
  const insertedPresetIds = [];
  for (const key of PRESET_IDS) if (!Object.hasOwn(effective, key)) { effective[key] = ''; insertedPresetIds.push({ key, value: '' }); }
  const commandPreset = serialize(command), effectivePreset = serialize(effective);
  const derivation = {
    schemaVersion: 1, method: 'prusa-sla-config-projection-v1', provider: { name: 'PrusaSlicer', version: '2.9.7' },
    source: { sha256: hash(source), bytes: source.length, keyCount: Object.keys(command).length },
    commandPreset: { sha256: hash(commandPreset), bytes: commandPreset.length, keyCount: Object.keys(command).length },
    effectivePreset: { sha256: hash(effectivePreset), bytes: effectivePreset.length, keyCount: Object.keys(effective).length },
    exportOmissions: omissions, insertedPresetIds, materialOverrides,
    sourceRules: ['CLI/LoadPrintData.cpp:177', 'libslic3r/SLAPrint.cpp:210-303', 'libslic3r/Format/SL1.cpp:464-493', 'libslic3r/Preset.cpp:693-721'],
    nativeInvocationAttested: false, productionEligible: false
  };
  derivation.sha256 = hash(Buffer.from(JSON.stringify(canonical(derivation))));
  return Object.freeze({ commandPreset, effectivePreset, derivation: freeze(derivation) });
}

module.exports = { projectPrusaSlaPreset, PRUSA_SLA_TILT_KEYS: TILT_KEYS, PRUSA_SLA_MATERIAL_OVERRIDES: OVERRIDES };
