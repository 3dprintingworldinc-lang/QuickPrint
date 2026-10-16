'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { randomBytes } = require('node:crypto');
const { tlsOptions } = require('./tls');

function adapterError(message, status = 502, code = 'PRINTER_REQUEST_FAILED') {
  return Object.assign(new Error(message), { status, code });
}

function endpoint(printer) {
  const host = String(printer.host || '').trim();
  if (!host) throw adapterError('Enter a printer hostname or IP address.', 400, 'PRINTER_HOST_REQUIRED');
  let url;
  try { url = new URL(host.includes('://') ? host : `http://${host}`); }
  catch { throw adapterError('Printer address is not valid.', 400, 'INVALID_PRINTER_HOST'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw adapterError('Use an HTTP or HTTPS printer address without credentials, query, or fragment.', 400, 'INVALID_PRINTER_HOST');
  }
  if (printer.port) url.port = String(printer.port);
  return url;
}

async function request(printer, { path, method = 'GET', headers = {}, body, timeoutMs = 10000, expectJson = true }) {
  const base = endpoint(printer);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) {
    throw adapterError('Invalid printer API path.', 400);
  }
  const url = new URL(base.href);
  const [pathname, ...query] = path.split('?');
  url.pathname = base.pathname.replace(/\/$/, '') + pathname;
  url.search = query.length ? '?' + query.join('?') : '';
  const trust = url.protocol === 'https:' ? await tlsOptions({ ...printer, host: url.hostname }, Number(url.port) || 443) : {};
  const deadline = Math.min(300000, Math.max(100, Number(printer.timeoutMs || timeoutMs) || 10000));
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) { if (body && typeof body.destroy === 'function') body.destroy(); reject(error); }
      else resolve(value);
    };
    const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers, ...trust }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        finish(adapterError('Printer redirected the request. Configure its final address; credentials were not forwarded.', 502, 'PRINTER_REDIRECT_REFUSED'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          res.destroy();
          finish(adapterError('Printer API response exceeded the limit.', 502));
        } else chunks.push(chunk);
      });
      res.on('error', () => finish(adapterError('Printer response was interrupted.')));
      res.on('end', () => {
        if (finished) return;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(adapterError(`Printer returned HTTP ${res.statusCode}${[401, 403].includes(res.statusCode) ? '; check its API credentials' : ''}.`, res.statusCode, 'PRINTER_HTTP_ERROR'));
          return;
        }
        let value = Buffer.concat(chunks).toString('utf8');
        if (expectJson && value.trim()) {
          try { value = JSON.parse(value); }
          catch { finish(adapterError('Printer returned invalid JSON.', 502, 'INVALID_PRINTER_RESPONSE')); return; }
        } else if (expectJson) value = null;
        finish(null, { status: res.statusCode, body: value, headers: res.headers });
      });
    });
    timer = setTimeout(() => {
      finish(adapterError('Printer request timed out. Check the printer before retrying a start command.', 504, 'PRINTER_TIMEOUT'));
      req.destroy();
    }, deadline);
    req.on('error', () => finish(adapterError('Cannot reach the printer. Check its address, network, and TLS trust.')));
    if (body && typeof body.pipe === 'function') {
      body.on('error', () => { finish(adapterError('Could not read the print file.', 400)); req.destroy(); });
      body.pipe(req);
    } else req.end(body);
  });
}

function safeFileName(name) {
  const value = String(name || '').normalize('NFKC');
  if (!value || value.length > 200 || /[\\/\r\n\0]/.test(value) || value === '.' || value === '..') {
    throw adapterError('Use a filename without directory separators (maximum 200 characters).', 400, 'INVALID_FILE_NAME');
  }
  return value.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^\.+/, '_');
}

async function multipartFile(filePath, { field = 'file', fileName, fields = {} } = {}) {
  const name = safeFileName(fileName || require('node:path').basename(filePath));
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw adapterError('Print artifact is not a file.', 400);
  const boundary = 'quickprint-' + randomBytes(18).toString('hex');
  const chunks = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[a-zA-Z0-9_]+$/.test(key)) throw adapterError('Invalid multipart field.', 400);
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  if (!/^[a-zA-Z0-9_]+$/.test(field)) throw adapterError('Invalid multipart file field.', 400);
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  async function* content() { for (const chunk of chunks) yield chunk; yield* fs.createReadStream(filePath); yield tail; }
  return { body: Readable.from(content()), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': chunks.reduce((n, chunk) => n + chunk.length, 0) + stat.size + tail.length } };
}

module.exports = { request, endpoint, multipartFile, safeFileName, adapterError };
