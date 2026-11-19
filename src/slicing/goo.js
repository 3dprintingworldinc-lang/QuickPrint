'use strict';

const crypto = require('node:crypto');

// Independent reader written from ELEGOO's Goo Format Spec V1.2 (field order and
// RLE grammar). Big-endian layout, V3.0 marker, complement checksum and footer
// were cross-checked against public UVtools format documentation/source and a
// separately generated file. No UVtools implementation is incorporated here.
const HEADER_BYTES = 195477;
const LAYER_HEADER_BYTES = 70;
const MAGIC = Buffer.from([7, 0, 0, 0, 0x44, 0x4c, 0x50, 0]);
const FOOTER = Buffer.concat([Buffer.alloc(3), MAGIC]);
const DEFAULT_LIMITS = { maxFileBytes: 100 * 1024 * 1024, maxLayers: 25000, maxPixelsPerLayer: 150000000, maxLayerBytes: 32 * 1024 * 1024 };
const HARD_LIMITS = { maxFileBytes: 512 * 1024 * 1024, maxLayers: 100000, maxPixelsPerLayer: 0x0fffffff, maxLayerBytes: 128 * 1024 * 1024 };

function invalid(message, code = 'INVALID_GOO') {
  return Object.assign(new Error(message), { code, status: 400 });
}

function readLimits(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid('GOO limits must be an object.', 'INVALID_GOO_LIMITS');
  for (const key of Object.keys(options)) {
    if (!(key in DEFAULT_LIMITS) || !Number.isSafeInteger(options[key]) || options[key] <= 0 || options[key] > HARD_LIMITS[key]) throw invalid(`Invalid GOO limit: ${key}.`, 'INVALID_GOO_LIMITS');
  }
  return { ...DEFAULT_LIMITS, ...options };
}

function inspectGoo(buffer, { expected = {}, limits: limitOptions = {} } = {}) {
  const limits = readLimits(limitOptions);
  if (!Buffer.isBuffer(buffer)) throw invalid('GOO input must be a Buffer.');
  if (buffer.length > limits.maxFileBytes) throw invalid('GOO file exceeds the configured byte limit.', 'GOO_LIMIT_EXCEEDED');
  if (buffer.length < HEADER_BYTES + LAYER_HEADER_BYTES + 5 + FOOTER.length) throw invalid('Truncated GOO file.');
  if (buffer.toString('ascii', 0, 4) !== 'V3.0') throw invalid('Only the inspected GOO V3.0 layout is supported.', 'UNSUPPORTED_GOO_VERSION');
  if (!buffer.subarray(4, 12).equals(MAGIC)) throw invalid('GOO header magic is invalid.');
  let offset = 12;
  const need = length => { if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) throw invalid('GOO field extends past the end of the file.'); };
  const text = length => {
    need(length); const bytes = buffer.subarray(offset, offset + length); offset += length;
    const value = bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8');
    if (/[\u0000-\u001f\u007f]/.test(value)) throw invalid('GOO metadata contains control characters.');
    return value.trim();
  };
  const u8 = () => { need(1); return buffer[offset++]; };
  const u16 = () => { need(2); const value = buffer.readUInt16BE(offset); offset += 2; return value; };
  const u32 = () => { need(4); const value = buffer.readUInt32BE(offset); offset += 4; return value; };
  const float = (label, max = 1000000, min = 0) => {
    need(4); const value = buffer.readFloatBE(offset); offset += 4;
    if (!Number.isFinite(value) || value < min || value > max) throw invalid(`GOO ${label} is outside the supported numeric range.`);
    return value;
  };
  const boolean = label => { const value = u8(); if (value > 1) throw invalid(`GOO ${label} flag is invalid.`); return value === 1; };
  const delimiter = label => { need(2); if (buffer[offset] !== 13 || buffer[offset + 1] !== 10) throw invalid(`GOO ${label} delimiter is invalid.`); offset += 2; };
  const software = text(32), softwareVersion = text(24), createdAt = text(24);
  const machineName = text(32), machineType = text(32), profileName = text(32);
  const antiAliasingLevel = u16(), greyLevel = u16(), blurLevel = u16();
  need(116 * 116 * 2); offset += 116 * 116 * 2; delimiter('small preview');
  need(290 * 290 * 2); offset += 290 * 290 * 2; delimiter('large preview');
  const layerCount = u32(), resolutionX = u16(), resolutionY = u16();
  const pixelsPerLayer = resolutionX * resolutionY;
  if (!layerCount || layerCount > limits.maxLayers || !resolutionX || !resolutionY || pixelsPerLayer > limits.maxPixelsPerLayer) throw invalid('GOO layer count or resolution exceeds the configured limit.', 'GOO_LIMIT_EXCEEDED');
  const mirrorX = boolean('X mirror'), mirrorY = boolean('Y mirror');
  const displayWidthMm = float('display width', 10000, 0.001), displayHeightMm = float('display height', 10000, 0.001);
  const machineZMm = float('machine height', 10000, 0.001), layerHeightMm = float('layer height', 10, 0.0001);
  const exposureTimeSeconds = float('exposure time', 3600);
  const delayMode = u8(); if (delayMode > 1) throw invalid('GOO exposure delay mode is invalid.');
  const timing = {};
  for (const key of ['lightOffSeconds', 'bottomWaitBeforeLiftSeconds', 'bottomWaitAfterLiftSeconds', 'bottomWaitAfterRetractSeconds', 'waitBeforeLiftSeconds', 'waitAfterLiftSeconds', 'waitAfterRetractSeconds']) timing[key] = float(key, 3600);
  const bottomExposureTimeSeconds = float('bottom exposure time', 3600), bottomLayerCount = u32();
  if (bottomLayerCount > layerCount) throw invalid('GOO bottom-layer count exceeds its layer count.');
  const motion = {};
  for (const key of ['bottomLiftDistanceMm', 'bottomLiftSpeedMmPerMin', 'liftDistanceMm', 'liftSpeedMmPerMin', 'bottomRetractDistanceMm', 'bottomRetractSpeedMmPerMin', 'retractDistanceMm', 'retractSpeedMmPerMin', 'bottomLiftDistance2Mm', 'bottomLiftSpeed2MmPerMin', 'liftDistance2Mm', 'liftSpeed2MmPerMin', 'bottomRetractDistance2Mm', 'bottomRetractSpeed2MmPerMin', 'retractDistance2Mm', 'retractSpeed2MmPerMin']) motion[key] = float(key, key.includes('Speed') ? 100000 : machineZMm);
  const bottomLightPwm = u16(), lightPwm = u16();
  if (bottomLightPwm > 255 || lightPwm > 255) throw invalid('GOO light PWM exceeds 255.');
  const perLayerSettings = boolean('per-layer settings'), printTimeSeconds = u32();
  const volumeMm3 = float('volume', 1e12), materialGrams = float('weight', 1e10), materialCost = float('material cost', 1e10);
  const priceUnit = text(8), layerContentOffset = u32(), grayscaleLevel = u8(), transitionLayerCount = u16();
  if (offset !== HEADER_BYTES || layerContentOffset !== HEADER_BYTES) throw invalid('GOO layer-content offset does not match the inspected V3.0 header.');
  if (grayscaleLevel > 1) throw invalid('GOO grayscale encoding must be the specified 4-bit or 8-bit mode.', 'UNSUPPORTED_GOO_GRAYSCALE');
  const maximumGray = grayscaleLevel === 0 ? 15 : 255;
  if (transitionLayerCount > layerCount) throw invalid('GOO transition-layer count exceeds its layer count.');
  if (layerCount * (LAYER_HEADER_BYTES + 5) + offset + FOOTER.length > buffer.length) throw invalid('GOO file cannot contain its declared layers.');

  const actual = { resolutionX, resolutionY, displayWidthMm, displayHeightMm, machineZMm, layerHeightMm, mirrorX, mirrorY, machineName, exposureTimeSeconds, bottomExposureTimeSeconds, bottomLayerCount, transitionLayerCount };
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw invalid('GOO expected profile must be an object.', 'INVALID_GOO_EXPECTATION');
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in actual)) throw invalid(`Unknown expected GOO profile field: ${key}.`, 'INVALID_GOO_EXPECTATION');
    if (typeof value !== typeof actual[key] || (typeof value === 'number' && !Number.isFinite(value))) throw invalid(`Invalid expected GOO profile field: ${key}.`, 'INVALID_GOO_EXPECTATION');
    const equal = typeof value === 'number' ? Math.abs(actual[key] - value) <= (key.endsWith('Mm') || key.endsWith('Seconds') ? 0.001 : 0) : actual[key] === value;
    if (!equal) throw invalid(`GOO ${key} does not match the selected profile.`, 'GOO_PROFILE_MISMATCH');
  }

  let previousZ = 0, nonemptyLayerCount = 0, totalExposedPixels = 0, totalRuns = 0;
  let minExposureSeconds = Infinity, maxExposureSeconds = 0;
  for (let layer = 0; layer < layerCount; layer++) {
    need(LAYER_HEADER_BYTES);
    const pauseFlag = u16(); if (pauseFlag > 1) throw invalid(`GOO pause flag is invalid at layer ${layer + 1}.`);
    float('pause height', machineZMm);
    const z = float('layer position', machineZMm + 0.001);
    if (z <= previousZ) throw invalid(`GOO layer positions must increase at layer ${layer + 1}.`);
    previousZ = z;
    const exposure = float('layer exposure', 3600);
    minExposureSeconds = Math.min(minExposureSeconds, exposure); maxExposureSeconds = Math.max(maxExposureSeconds, exposure);
    for (let i = 0; i < 4; i++) float('layer delay', 3600);
    for (let i = 0; i < 8; i++) float('layer motion', i % 2 ? 100000 : machineZMm);
    if (u16() > 255) throw invalid(`GOO layer light PWM exceeds 255 at layer ${layer + 1}.`);
    delimiter('layer definition');
    const length = u32();
    if (length < 3 || length > limits.maxLayerBytes) throw invalid(`GOO encoded-layer length is invalid at layer ${layer + 1}.`, 'GOO_LIMIT_EXCEEDED');
    need(length + 2);
    const begin = offset, checksumAt = begin + length - 1;
    if (buffer[offset++] !== 0x55) throw invalid(`GOO image marker is invalid at layer ${layer + 1}.`);
    let checksum = 0, pixels = 0, color = 0, exposedPixels = 0;
    const encodedByte = () => {
      if (offset >= checksumAt) throw invalid(`GOO image token is truncated at layer ${layer + 1}.`);
      const value = buffer[offset++]; checksum = (checksum + value) & 255; return value;
    };
    while (offset < checksumAt) {
      const token = encodedByte(), type = token >>> 6;
      let count;
      if (type === 2) {
        color += (token & 0x20 ? -1 : 1) * (token & 15);
        count = token & 0x10 ? encodedByte() : 1;
      } else {
        color = type === 0 ? 0 : type === 3 ? maximumGray : encodedByte();
        // Additional length bytes precede the low nibble in significance.
        let upper = 0;
        for (let bytes = (token >>> 4) & 3; bytes > 0; bytes--) upper = upper * 256 + encodedByte();
        count = upper * 16 + (token & 15);
      }
      if (color < 0 || color > maximumGray || !count || count > pixelsPerLayer - pixels) throw invalid(`GOO image run exceeds its color or pixel bounds at layer ${layer + 1}.`);
      pixels += count; totalRuns++;
      if (color > 0) exposedPixels += count;
    }
    if (pixels !== pixelsPerLayer) throw invalid(`GOO image has ${pixels} pixels; expected ${pixelsPerLayer} at layer ${layer + 1}.`);
    if (buffer[offset++] !== (checksum ^ 255)) throw invalid(`GOO image checksum is invalid at layer ${layer + 1}.`);
    delimiter('layer image');
    if (exposedPixels) nonemptyLayerCount++;
    totalExposedPixels += exposedPixels;
  }
  if (buffer.length - offset !== FOOTER.length || !buffer.subarray(offset).equals(FOOTER)) throw invalid('GOO footer or trailing-byte count is invalid.');
  return {
    format: 'goo', version: 'V3.0', layerCount, ...actual,
    software, softwareVersion, createdAt, machineType, profileName, antiAliasingLevel, greyLevel, blurLevel, grayscaleBits: grayscaleLevel === 0 ? 4 : 8,
    delayMode, timing, motion, bottomLightPwm, lightPwm, perLayerSettings, printTimeSeconds, volumeMm3, materialGrams, materialCost, priceUnit,
    totalHeightMm: previousZ, minExposureSeconds, maxExposureSeconds, pixelsPerLayer, nonemptyLayerCount, totalExposedPixels, totalRuns,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'), validatedLayerData: true, printerCompatible: false,
    qualification: 'Structural validation does not establish resin calibration, image orientation, support quality, firmware compatibility, or physical print success.',
  };
}

module.exports = { inspectGoo };
