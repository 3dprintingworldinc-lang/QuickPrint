'use strict';

const path = require('node:path');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.stl', '.step', '.stp', '.3mf', '.gcode', '.gco', '.obj']);

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function validateConnector(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid('A connector configuration is required.');
  if (!['folder', 'email'].includes(config.type)) throw invalid('Choose a folder or email connector.');
  if (config.name !== undefined && (typeof config.name !== 'string' || config.name.length > 120)) throw invalid('Connector names must be at most 120 characters.');
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw invalid('Connector enabled must be true or false.');
  if (config.defaults !== undefined) {
    if (!config.defaults || typeof config.defaults !== 'object' || Array.isArray(config.defaults)) throw invalid('Connector defaults must be an object.');
    const quantity = config.defaults.quantity;
    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000)) throw invalid('Default quantity must be a whole number between 1 and 10000.');
    for (const [field, limit] of [['customer', 500], ['notes', 5000]]) {
      if (config.defaults[field] !== undefined && (typeof config.defaults[field] !== 'string' || config.defaults[field].length > limit)) throw invalid(`Default ${field} must be text of at most ${limit} characters.`);
    }
  }
  if (config.type === 'folder') {
    if (typeof config.path !== 'string' || !config.path.trim() || config.path.includes('\0') || !path.isAbsolute(config.path)) throw invalid('Choose an absolute path to an existing local or network folder.');
    if (config.settleMs !== undefined && (!Number.isInteger(config.settleMs) || config.settleMs < 1000 || config.settleMs > 300000)) throw invalid('File settling time must be between 1000 and 300000 milliseconds.');
  } else {
    if (typeof config.host !== 'string' || !config.host.trim() || /[\s/\\\0]/.test(config.host)) throw invalid('Enter an IMAP hostname without a URL or path.');
    if (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) throw invalid('IMAP port must be between 1 and 65535.');
    if (config.secure !== undefined && typeof config.secure !== 'boolean') throw invalid('IMAP secure must be true or false.');
    if (typeof config.username !== 'string' || !config.username.trim()) throw invalid('Enter the mailbox username.');
    if (typeof config.password !== 'string' || !config.password) throw invalid('Enter the mailbox password or app password.');
    if (config.mailbox !== undefined && (typeof config.mailbox !== 'string' || !config.mailbox.trim() || /[\r\n\0]/.test(config.mailbox))) throw invalid('Enter a valid IMAP mailbox name.');
    if (config.pollIntervalMs !== undefined && (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 5000 || config.pollIntervalMs > 86400000)) throw invalid('Email polling must be between 5 seconds and 24 hours.');
  }
  return config;
}

function supportedFile(name) {
  return typeof name === 'string' && SUPPORTED_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function safeFileName(name) {
  const cleaned = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '');
  const extension = /\.gcode\.3mf$/i.test(cleaned) ? cleaned.slice(-10) : path.extname(cleaned);
  return cleaned.length <= 170 ? cleaned : cleaned.slice(0, Math.max(1, 170 - extension.length)) + extension.slice(-30);
}

module.exports = { validateConnector, MAX_FILE_BYTES, supportedFile, safeFileName };
