'use strict';

const { createHash } = require('node:crypto');
const { adapterError } = require('./http');

function canonicalSDCPDevice(printer, attributes) {
  const invalid = () => adapterError('SDCP printer identity or reported geometry is incomplete.', 409, 'RESIN_DEVICE_IDENTITY_INVALID');
  if (printer?.type !== 'sdcp' || !/^[a-f0-9]{16}$/i.test(printer.mainboardId || '') || !/^[a-z0-9_-]{1,64}$/i.test(printer.brandId || '') || attributes?.MainboardID !== printer.mainboardId) throw invalid();
  for (const field of ['BrandName', 'MachineName', 'ProtocolVersion', 'FirmwareVersion', 'Resolution', 'XYZsize']) {
    if (typeof attributes[field] !== 'string' || !attributes[field] || attributes[field].length > 200 || /[\u0000-\u001f\u007f]/.test(attributes[field])) throw invalid();
  }
  if (attributes.ProtocolVersion !== 'V3.0.0' || !/^\d+x\d+$/.test(attributes.Resolution) || !/^\d+(?:\.\d+)?x\d+(?:\.\d+)?x\d+(?:\.\d+)?$/.test(attributes.XYZsize) || attributes.Resolution.split('x').some(value => Number(value) < 1 || Number(value) > 65535) || attributes.XYZsize.split('x').some(value => Number(value) <= 0 || Number(value) > 10000)) throw invalid();
  // Preserve both reported resolution and XYZsize exactly. They are separate
  // from the reviewed slicer profile's geometry, including known mismatches.
  return {
    mainboardId: printer.mainboardId, brandId: printer.brandId,
    brandName: attributes.BrandName, machineName: attributes.MachineName,
    protocolVersion: attributes.ProtocolVersion, firmwareVersion: attributes.FirmwareVersion,
    resolution: attributes.Resolution, xyzSize: attributes.XYZsize,
  };
}

function fingerprintSDCPDevice(printer, attributes) {
  return createHash('sha256').update(JSON.stringify(canonicalSDCPDevice(printer, attributes))).digest('hex');
}

module.exports = { canonicalSDCPDevice, fingerprintSDCPDevice };
