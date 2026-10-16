'use strict';

const tls = require('node:tls');
const net = require('node:net');
const { createHash, timingSafeEqual } = require('node:crypto');

function trustError(message, code = 'PRINTER_TLS_TRUST_REQUIRED') {
  return Object.assign(new Error(message), { status: 400, code });
}
function normalizeFingerprint(value) {
  const fingerprint = String(value || '').replace(/:/g, '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw trustError('TLS fingerprint must be a SHA-256 certificate fingerprint (64 hexadecimal characters).', 'INVALID_TLS_FINGERPRINT');
  return fingerprint;
}
function fingerprintMatches(certificate, expected) {
  if (!certificate?.raw) return false;
  const actual = createHash('sha256').update(certificate.raw).digest();
  return timingSafeEqual(actual, Buffer.from(normalizeFingerprint(expected), 'hex'));
}

// The bootstrap handshake sends no application data or credentials. A self-signed
// device certificate is accepted ONLY after matching the operator's explicit pin.
// Actual MQTT/FTP/HTTP connections then use certificate validation with that leaf
// as a trust anchor, and recheck the pin (including FTP data connections).
async function pinnedCertificate(host, port, fingerprint, timeoutMs) {
  normalizeFingerprint(fingerprint);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const timer = setTimeout(() => { socket.destroy(); reject(trustError('Timed out checking the pinned printer certificate.', 'PRINTER_TLS_TIMEOUT')); }, timeoutMs);
    const done = (error, value) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.once('error', () => done(trustError('Could not verify the printer certificate.', 'PRINTER_TLS_FAILED')));
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate();
      if (!fingerprintMatches(certificate, fingerprint)) return done(trustError('Printer certificate does not match the trusted fingerprint. No credentials were sent.', 'PRINTER_TLS_PIN_MISMATCH'));
      const base64 = certificate.raw.toString('base64').match(/.{1,64}/g).join('\n');
      done(null, `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`);
    });
  });
}

async function tlsOptions(printer, port, { requireExplicitTrust = false } = {}) {
  const host = String(printer.host).replace(/^\[|\]$/g, '');
  const fingerprint = printer.tlsFingerprint ? normalizeFingerprint(printer.tlsFingerprint) : null;
  if (requireExplicitTrust && !printer.caCertificate && !fingerprint) {
    throw trustError('Bambu requires a trusted device CA certificate or SHA-256 TLS fingerprint. Obtain it from the device over a trusted connection and enter it in printer settings.');
  }
  const ca = printer.caCertificate || (fingerprint ? await pinnedCertificate(host, port, fingerprint, Math.min(Number(printer.timeoutMs) || 10000, 30000)) : undefined);
  const options = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  if (ca) { options.ca = ca; options.allowPartialTrustChain = true; }
  if (!net.isIP(host)) options.servername = host;
  if (fingerprint) options.checkServerIdentity = (_hostname, certificate) => fingerprintMatches(certificate, fingerprint) ? undefined : trustError('Printer certificate fingerprint changed.', 'PRINTER_TLS_PIN_MISMATCH');
  return options;
}

module.exports = { tlsOptions, pinnedCertificate, normalizeFingerprint, fingerprintMatches };
