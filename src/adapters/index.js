'use strict';

const { adapterError, endpoint } = require('./http');

// Deliberately explicit: installed printer plugins are reviewed source modules,
// never JavaScript loaded from a printer, imported job, or user-supplied path.
const REGISTRY = {
  octoprint: {
    name: 'OctoPrint', module: './octoprint', constructor: 'OctoPrintAdapter',
    description: 'OctoPrint REST API for printers connected to an OctoPrint host.',
    requirements: 'OctoPrint host address and application API key with file, job, and printer permissions. The printer must be connected and operational. REST telemetry cannot prove completion; operator sign-off is required.',
    defaultPort: 80, fields: ['host', 'port', 'apiKey', 'caCertificate', 'tlsFingerprint'],
    formats: ['gcode', 'gco', 'g'],
  },
  moonraker: {
    name: 'Klipper / Moonraker', module: './moonraker', constructor: 'MoonrakerAdapter',
    description: 'Moonraker HTTP API for Klipper printers.',
    requirements: 'Moonraker endpoint (usually port 7125), API key if authentication is enabled, and configured virtual_sdcard/pause_resume. Use the Moonraker server address, not only its Mainsail/Fluidd web page.',
    defaultPort: 7125, fields: ['host', 'port', 'apiKey', 'caCertificate', 'tlsFingerprint'],
    formats: ['gcode'],
  },
  bambu: {
    name: 'Bambu LAN', module: './bambu', constructor: 'BambuAdapter',
    description: 'Bambu MQTT and encrypted FTP for X1/X1C/X1E/P1P/P1S single-plate, single-filament jobs.',
    requirements: 'Enable LAN/Developer mode as required by firmware. Enter serial number, LAN access code, model (X1/X1C/X1E/P1P/P1S), and trusted CA or SHA-256 device certificate fingerprint. MQTT uses 8883; implicit FTPS uses 990. Uses external spool, not AMS. Other models and dual-nozzle routing are unsupported. Firmware requiring unencrypted FTP data is unsupported. No physical-model certification is implied by mock protocol tests.',
    defaultPort: 8883, fields: ['host', 'port', 'serial', 'accessCode', 'model', 'caCertificate', 'tlsFingerprint'],
    formats: ['gcode.3mf'],
  },
  duet: {
    name: 'Duet / RepRapFirmware', module: './duet', constructor: 'DuetAdapter',
    description: 'RepRapFirmware standalone HTTP API, with modern object-model and legacy status support.',
    requirements: 'Duet running standalone RepRapFirmware HTTP API, printer password if configured, and SD storage. Duet Software Framework SBC mode uses a different API and is not supported. Idle telemetry alone does not establish a completed print.',
    defaultPort: 80, fields: ['host', 'port', 'password', 'caCertificate', 'tlsFingerprint'],
    formats: ['gcode', 'gco', 'g'],
  },
};

function adapterCatalog() {
  return Object.entries(REGISTRY).map(([type, entry]) => ({
    type, id: type, name: entry.name, label: entry.name,
    description: entry.description, requirements: entry.requirements,
    defaultPort: entry.defaultPort, fields: [...entry.fields],
    capabilities: { upload: true, start: true, pause: true, resume: true, cancel: true, formats: [...entry.formats], discovery: false },
  }));
}

function createAdapter(printer) {
  if (!printer || typeof printer !== 'object') throw adapterError('Printer settings are required.', 400, 'INVALID_PRINTER');
  const entry = Object.hasOwn(REGISTRY, printer.type) ? REGISTRY[printer.type] : null;
  if (!entry) throw adapterError('Choose a supported printer adapter.', 400, 'UNSUPPORTED_ADAPTER');
  if (printer.type !== 'bambu') endpoint(printer);
  const Adapter = require(entry.module)[entry.constructor];
  return new Adapter({ ...printer });
}

module.exports = { createAdapter, adapterCatalog };
