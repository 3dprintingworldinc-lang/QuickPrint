'use strict';

// Pure profile views and customization. Filesystem ownership and slot CAS live
// in the service; this module never modifies the operator's source files.
const UV_PROPERTIES = Object.freeze([
  'MachineName', 'LayerHeight', 'ExposureTime', 'BottomExposureTime', 'BottomLayerCount',
  'BottomLiftHeight', 'LiftHeight', 'BottomLiftSpeed', 'LiftSpeed', 'RetractSpeed', 'LightPWM', 'BottomLightPWM',
  'TransitionLayerCount', 'BottomRetractSpeed', 'BottomLiftHeight2', 'LiftHeight2', 'BottomLiftSpeed2', 'LiftSpeed2',
  'BottomRetractHeight2', 'RetractHeight2', 'BottomRetractSpeed2', 'RetractSpeed2', 'WaitTimeBeforeCure',
  'BottomWaitTimeBeforeCure', 'WaitTimeAfterCure', 'BottomWaitTimeAfterCure', 'WaitTimeAfterLift', 'BottomWaitTimeAfterLift',
]);
const EXPECTED_FIELDS = ['resolutionX', 'resolutionY', 'displayWidthMm', 'displayHeightMm', 'machineZMm', 'layerHeightMm', 'mirrorX', 'mirrorY'];
const EDIT_FIELDS = new Set(['printerId', 'material', 'layerHeightMm', 'uvtoolsProperties', 'supportsEnabled', 'padEnabled', 'orientationCandidates']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_PROFILE_CUSTOMIZATION_INVALID') => Object.assign(new Error(message), { status: 400, code });

function number(value, label, minimum, maximum, integer, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) throw fail(`Invalid resin profile ${label}; use ${integer ? 'a whole number' : 'a number'} from ${minimum} to ${maximum}.`, code);
}

function validateUVtoolsProperties(properties, { printerModel, layerHeightMm, maxZMm = 10000, code = 'RESIN_PROFILE_INVALID' } = {}) {
  if (!plain(properties)) throw fail('Resin target properties must be an object.', code);
  const maxHeight = typeof maxZMm === 'number' && Number.isFinite(maxZMm) && maxZMm > 0 && maxZMm <= 10000 ? maxZMm : 10000;
  for (const [key, value] of Object.entries(properties)) {
    if (!UV_PROPERTIES.includes(key)) throw fail(`Unsupported UVtools target property: ${key}.`, code);
    if (key === 'MachineName') {
      if (value !== printerModel) throw fail('Printer machine identity cannot be customized in a resin slot.', code);
    } else if (key === 'LayerHeight') {
      number(value, key, 0.001, 10, false, code);
      if (value !== layerHeightMm) throw fail('LayerHeight must match the selected layer height.', code);
    } else if (key.endsWith('LightPWM')) number(value, key, 0, 255, true, code);
    else if (key.endsWith('LayerCount')) number(value, key, 0, 25000, true, code);
    else if (key.endsWith('ExposureTime')) {
      number(value, key, 0, 3600, false, code);
      if (value === 0) throw fail(`${key} must be positive.`, code);
    }
    else if (key.includes('WaitTime')) number(value, key, 0, 3600, false, code);
    else if (key.includes('Speed')) number(value, key, 0, 100000, false, code);
    else number(value, key, 0, maxHeight, false, code);
  }
  for (const [height, speed] of [['BottomLiftHeight', 'BottomLiftSpeed'], ['LiftHeight', 'LiftSpeed'], ['BottomLiftHeight2', 'BottomLiftSpeed2'], ['LiftHeight2', 'LiftSpeed2'], ['BottomRetractHeight2', 'BottomRetractSpeed2'], ['RetractHeight2', 'RetractSpeed2']]) {
    if (properties[height] > 0 && !(properties[speed] > 0)) throw fail(`${speed} must be supplied and positive when ${height} is positive.`, code);
  }
  if (properties.LiftHeight > 0 && properties.RetractSpeed === 0) throw fail('RetractSpeed must be positive for a nonzero lift.', code);
  if (properties.BottomLiftHeight > 0 && properties.BottomRetractSpeed === 0) throw fail('BottomRetractSpeed must be positive for a nonzero bottom lift.', code);
}

function profileView(loaded) {
  const profile = loaded.profile;
  return {
    printerId: profile.printerId, printerModel: profile.printerModel, material: profile.material,
    expected: Object.fromEntries(EXPECTED_FIELDS.filter(key => Object.hasOwn(profile.expected, key)).map(key => [key, structuredClone(profile.expected[key])])),
    uvtoolsProperties: structuredClone(profile.uvtoolsProperties), orientationCandidates: structuredClone(profile.orientationCandidates),
    supportsEnabled: loaded.ini.supports_enable === '1', padEnabled: loaded.ini.pad_enable === '1',
  };
}

function customizeProfile(loaded, patch) {
  if (!plain(patch) || !Object.keys(patch).length || Object.keys(patch).some(key => !EDIT_FIELDS.has(key))) throw fail('Supply at least one supported resin profile customization field.');
  const profile = structuredClone(loaded.profile);
  const ini = { ...loaded.ini };
  if (Object.hasOwn(patch, 'printerId')) {
    if (typeof patch.printerId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(patch.printerId)) throw fail('Choose an existing local SDCP printer identity.');
    profile.printerId = patch.printerId;
  }
  if (Object.hasOwn(patch, 'material')) {
    if (typeof patch.material !== 'string' || !patch.material.trim() || patch.material.length > 200 || /[\u0000-\u001f\u007f]/.test(patch.material)) throw fail('Material must be a nonempty name of at most 200 characters without control characters.');
    profile.material = patch.material.trim();
  }
  if (Object.hasOwn(patch, 'layerHeightMm')) {
    number(patch.layerHeightMm, 'layerHeightMm', 0.001, 10, false);
    profile.expected.layerHeightMm = patch.layerHeightMm;
  }
  if (Object.hasOwn(patch, 'uvtoolsProperties')) {
    if (!plain(patch.uvtoolsProperties) || !Object.keys(patch.uvtoolsProperties).length) throw fail('UVtools properties must be a nonempty object.');
    for (const [key, value] of Object.entries(patch.uvtoolsProperties)) {
      if (!UV_PROPERTIES.includes(key)) throw fail(`Unsupported UVtools target property: ${key}.`);
      if (key === 'MachineName' && value !== profile.printerModel) throw fail('Printer machine identity cannot be customized in a resin slot.');
      if (key === 'LayerHeight' && value !== profile.expected.layerHeightMm) throw fail('Use layerHeightMm to change layer height; target LayerHeight must match it.');
      profile.uvtoolsProperties[key] = value;
    }
  }
  profile.uvtoolsProperties.MachineName = profile.printerModel;
  profile.uvtoolsProperties.LayerHeight = profile.expected.layerHeightMm;
  validateUVtoolsProperties(profile.uvtoolsProperties, { printerModel: profile.printerModel, layerHeightMm: profile.expected.layerHeightMm, maxZMm: profile.expected.machineZMm ?? Number(ini.max_print_height), code: 'RESIN_PROFILE_CUSTOMIZATION_INVALID' });
  for (const [field, key] of [['supportsEnabled', 'supports_enable'], ['padEnabled', 'pad_enable']]) {
    if (!Object.hasOwn(patch, field)) continue;
    if (typeof patch[field] !== 'boolean') throw fail(`${field} must be true or false.`);
    ini[key] = patch[field] ? '1' : '0';
  }
  if (Object.hasOwn(patch, 'orientationCandidates')) {
    if (!Array.isArray(patch.orientationCandidates) || patch.orientationCandidates.length < 1 || patch.orientationCandidates.length > 4) throw fail('Provide one to four orientation candidates.');
    for (const orientation of patch.orientationCandidates) {
      if (!plain(orientation) || Object.keys(orientation).length !== 3 || Object.keys(orientation).some(key => !['x', 'y', 'z'].includes(key))) throw fail('Each orientation must contain only x, y and z.');
      for (const axis of ['x', 'y', 'z']) number(orientation[axis], `orientation ${axis}`, -360, 360, false);
    }
    profile.orientationCandidates = structuredClone(patch.orientationCandidates);
  }
  ini.hollowing_enable = '0';
  ini.layer_height = ini.initial_layer_height = String(profile.expected.layerHeightMm);
  ini.exposure_time = String(profile.uvtoolsProperties.ExposureTime);
  ini.initial_exposure_time = String(profile.uvtoolsProperties.BottomExposureTime);
  const snapshot = {
    schemaVersion: 1, printerId: profile.printerId, printerModel: profile.printerModel, material: profile.material,
    presetPath: 'preset.ini', expected: profile.expected, uvtoolsProperties: profile.uvtoolsProperties, orientationCandidates: profile.orientationCandidates,
  };
  return { profile: snapshot, preset: Buffer.from(Object.entries(ini).map(([key, value]) => `${key} = ${value}`).join('\n') + '\n') };
}

module.exports = { customizeProfile, profileView, validateUVtoolsProperties, UV_PROPERTIES };
