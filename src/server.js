'use strict';

const express = require('express');
const multer = require('multer');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const { QuickPrintService } = require('./core/service');
const adapterModule = require('./adapters');
const slicerModule = require('./slicing');
const { ConnectorManager, validateConnector } = require('./connectors');
const { version } = require('../package.json');

const RENDERER = path.join(__dirname, 'renderer');
const MAX_REQUEST_BYTES = 110 * 1024 * 1024;
function fail(message, status = 400, code = 'INVALID_REQUEST') { return Object.assign(new Error(message), { status, code }); }
function equalToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function bearer(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); }
function authenticate(token) {
  return (req, res, next) => equalToken(bearer(req), typeof token === 'function' ? token() : token) ? next() : res.status(401).json({ error: 'UNAUTHORIZED', message: 'A valid QuickPrint access token is required.' });
}
function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const uploadError = error instanceof multer.MulterError;
  const status = uploadError ? 413 : (Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500);
  res.status(status).json({ error: error.code || 'REQUEST_FAILED', message: uploadError ? 'Upload limit exceeded: up to 10 files, 100 MiB per file, and 110 MiB total.' : (error.message || 'The request could not be completed.') });
}
function requestLimits(req, res, next) {
  if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) return res.status(413).json({ error: 'UPLOAD_TOO_LARGE', message: 'The whole upload must be smaller than 110 MiB.' });
  let size = 0;
  req.on('data', data => {
    size += data.length;
    if (size > MAX_REQUEST_BYTES && !res.headersSent) {
      res.status(413).json({ error: 'UPLOAD_TOO_LARGE', message: 'The whole upload must be smaller than 110 MiB.' });
      res.on('finish', () => req.destroy());
    }
  });
  next();
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 10, fields: 12, fieldSize: 16384 } });
function submission(req, source) {
  if (!req.files?.length) throw fail('Choose at least one file.');
  return {
    source,
    sourceId: req.headers['idempotency-key'] || req.body.sourceId || undefined,
    name: req.body.name,
    customer: req.body.customer,
    quantity: req.body.quantity === undefined ? 1 : Number(req.body.quantity),
    notes: req.body.notes,
    files: req.files.map(file => ({ name: file.originalname, data: file.buffer }))
  };
}
function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.requestTimeout = 120000;
    server.headersTimeout = 15000;
    server.keepAliveTimeout = 5000;
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(server); });
  });
}
async function closeServer(server) {
  if (!server) return;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
}
function localAddresses(port) {
  return Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:${port}/api/intake`);
}

async function startServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.QUICKPRINT_DATA_DIR || path.join(process.cwd(), 'data'));
  const token = options.token || crypto.randomBytes(32).toString('hex');
  const service = new QuickPrintService({ dataDir, adapters: options.adapters || adapterModule, slicer: options.slicer || slicerModule, seal: options.seal, unseal: options.unseal });
  await service.init();
  const connectors = new ConnectorManager({ service });
  let intakeServer = null, intakeError = null, intakeSignature = '', pollTimer, polling = false, pollOperation = null, maintenance = false, closed = false, backupOperation = null;
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const hostname = req.hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) return res.status(403).json({ error: 'LOCAL_ONLY', message: 'Desktop administration is available on this computer only.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    next();
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, app: 'QuickPrint', version }));
  app.use('/api', authenticate(token));
  const maintenanceGuard = (req, res, next) => maintenance && !['GET', 'HEAD'].includes(req.method)
    ? res.status(503).json({ error: 'BACKUP_IN_PROGRESS', message: 'A workspace backup is in progress. Retry this request shortly.' }) : next();
  app.use('/api', maintenanceGuard);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', maintenanceGuard);
  app.get('/api/state', (req, res) => res.json({ ...service.snapshot(), adapterCatalog: adapterModule.adapterCatalog(), connectorStatus: connectors.status(), intakeStatus: { listening: Boolean(intakeServer), error: intakeError }, version }));
  app.post('/api/jobs', requestLimits, upload.array('files', 10), maintenanceGuard, async (req, res) => res.status(201).json(await service.submit(submission(req, 'desktop'))));
  app.post('/api/printers', async (req, res) => res.json(await service.savePrinter(req.body)));
  app.delete('/api/printers/:id', async (req, res) => { await service.removePrinter(req.params.id); res.json({ ok: true }); });
  app.post('/api/printers/:id/test', async (req, res) => res.json(await service.testPrinter(req.params.id)));
  app.post('/api/jobs/:id/prepare', async (req, res) => res.json(await service.prepareJob(req.params.id, req.body.printerId)));
  app.post('/api/jobs/:id/dispatch', async (req, res) => res.json(await service.dispatchJob(req.params.id, req.body.printerId, { confirmed: req.body.confirmed === true })));
  app.post('/api/jobs/:id/control', async (req, res) => res.json(await service.controlJob(req.params.id, req.body.action)));
  app.post('/api/jobs/:id/reconcile', async (req, res) => res.json(await service.reconcileJob(req.params.id, req.body)));
  app.get('/api/jobs/:id/file', (req, res) => {
    const job = service.getJob(req.params.id);
    const filePath = job.inputPath || job.filePath;
    if (!filePath) throw fail('Original file is unavailable.', 404);
    res.download(filePath, job.fileName);
  });

  async function configureIntake() {
    const config = service.getSettings({ secrets: true }).intake || {};
    const signature = JSON.stringify({ enabled: config.enabled, port: config.port });
    if (signature === intakeSignature && (!config.enabled || intakeServer)) return;
    await closeServer(intakeServer); intakeServer = null; intakeError = null; intakeSignature = signature;
    if (!config.enabled) return;
    if (!config.token) throw fail('Website intake needs an access token.');
    const intake = express();
    intake.disable('x-powered-by');
    intake.use(authenticate(() => service.getSettings({ secrets: true }).intake.token));
    intake.use(maintenanceGuard);
    intake.post('/api/intake', requestLimits, upload.array('files', 10), maintenanceGuard, async (req, res) => {
      const data = submission(req, 'website');
      if (!data.sourceId) throw fail('Send an Idempotency-Key header or sourceId field containing your unique order ID.');
      const result = await service.submit(data);
      res.status(result.duplicate ? 200 : 201).json({ duplicate: result.duplicate, jobs: result.jobs.map(job => ({ id: job.id, status: job.status, fileName: job.fileName })) });
    });
    // Only intake health and submission are exposed. Customer identity cannot read other orders.
    intake.get('/api/health', (req, res) => res.json({ ok: true, app: 'QuickPrint Intake', version }));
    intake.use(errorHandler);
    try { intakeServer = await listen(intake, Number(config.port), '0.0.0.0'); }
    catch (error) {
      intakeError = error.code === 'EADDRINUSE' ? 'The intake port is already in use. Choose another port in Settings.' : 'The intake listener could not start. Check the port and firewall.';
      await service.recordEvent({ level: 'error', type: 'intake', message: intakeError });
      throw fail(intakeError, 409, 'INTAKE_START_FAILED');
    }
  }
  app.put('/api/settings', async (req, res) => {
    const patch = req.body;
    if (patch.intake) {
      const port = Number(patch.intake.port ?? service.getSettings().intake?.port ?? 9732);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw fail('Choose an intake port from 1024 to 65535.');
      patch.intake.port = port;
      // Token lifecycle only through a dedicated endpoint, not general settings edits.
      delete patch.intake.token;
    }
    const result = await service.updateSettings(patch);
    await configureIntake();
    schedulePoll();
    res.json(result);
  });
  app.get('/api/integration', (req, res) => {
    const config = service.getSettings({ secrets: true }).intake;
    res.json({ enabled: Boolean(config.enabled), listening: Boolean(intakeServer), error: intakeError, port: config.port, token: config.token, urls: localAddresses(config.port), endpoint: '/api/intake' });
  });
  app.post('/api/integration/rotate', async (req, res) => {
    const newToken = crypto.randomBytes(32).toString('hex');
    await service.updateSettings({ intake: { token: newToken } });
    res.json({ token: newToken });
  });
  app.post('/api/connectors', async (req, res) => {
    const existing = service.getConnectors({ secrets: true }).find(item => item.id === req.body.id) || {};
    const merged = { ...existing, ...req.body };
    if (!merged.password && existing.password) merged.password = existing.password;
    if (typeof validateConnector === 'function') validateConnector(merged);
    const result = await service.saveConnector(req.body);
    await connectors.reload();
    res.json(result);
  });
  app.delete('/api/connectors/:id', async (req, res) => { await service.removeConnector(req.params.id); await connectors.reload(); res.json({ ok: true }); });
  app.post('/api/connectors/:id/poll', async (req, res) => { await connectors.pollNow(req.params.id); res.json({ ok: true, connectorStatus: connectors.status() }); });
  app.get('/api/backup', async (req, res) => {
    if (maintenance) throw fail('Another workspace backup is already in progress.', 409);
    maintenance = true;
    let backupBuffer, finishBackup;
    backupOperation = new Promise(resolve => { finishBackup = resolve; });
    clearInterval(pollTimer);
    try {
    await connectors.stop();
    await pollOperation;
    if (service.snapshot().jobs.some(job => ['preparing', 'dispatching', 'printing', 'paused'].includes(job.status))) throw fail('Wait until active jobs have stopped before exporting a consistent backup.', 409);
    await service.waitForIdle();
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    let total = 0;
    async function addDirectory(dir, prefix = '') {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || /(?:\.tmp|\.lock)$/.test(entry.name) || entry.name.startsWith('.')) continue;
        const filename = path.join(dir, entry.name), name = prefix + entry.name;
        if (entry.isDirectory()) await addDirectory(filename, name + '/');
        else if (entry.isFile()) {
          const stat = await fs.stat(filename);
          total += stat.size;
          if (total > 512 * 1024 * 1024) throw fail('This data directory is over 512 MiB. Quit QuickPrint and copy the data folder to back it up.', 413);
          zip.addFile(name, await fs.readFile(filename));
        }
      }
    }
    await addDirectory(dataDir);
    zip.addFile('BACKUP-README.txt', Buffer.from('QuickPrint backup. Quit QuickPrint before restoring to its data directory. Credentials encrypted with Windows DPAPI remain bound to the original Windows user; re-enter them on a different computer. Review printer state before resuming jobs. Keep this archive private.\n'));
    backupBuffer = zip.toBuffer();
    } finally {
      maintenance = false;
      try {
        if (!closed) { await connectors.start(); if (!closed) schedulePoll(); }
      } finally { finishBackup(); backupOperation = null; }
    }
    res.setHeader('Content-Disposition', 'attachment; filename="QuickPrint-backup.zip"');
    res.type('application/zip').send(backupBuffer);
  });
  app.get('/', async (req, res) => {
    const html = await fs.readFile(path.join(RENDERER, 'index.html'), 'utf8');
    res.type('html').send(html.replaceAll('__QUICKPRINT_TOKEN__', token));
  });
  app.use(express.static(RENDERER, { index: false, dotfiles: 'deny' }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown API route.' }));
  app.use(errorHandler);
  let server;
  function schedulePoll() {
    clearInterval(pollTimer);
    const interval = Math.max(1000, Math.min(3600000, Number(service.getSettings().pollIntervalMs) || 10000));
    pollTimer = setInterval(async () => {
      if (polling || maintenance) return;
      polling = true;
      try { pollOperation = service.refreshPrinters(); await pollOperation; } catch { /* Per-device errors are reflected in state. */ }
      finally { polling = false; }
    }, interval);
    pollTimer.unref();
  }
  try {
    if (!service.getSettings({ secrets: true }).intake?.token) await service.updateSettings({ intake: { token: crypto.randomBytes(32).toString('hex') } });
    // Administration always remains local regardless of external intake settings.
    server = await listen(app, Number(options.port ?? 0), '127.0.0.1');
    await connectors.start();
    await configureIntake().catch(() => {});
    schedulePoll();
  } catch (error) {
    await closeServer(server); await closeServer(intakeServer); await connectors.stop(); await service.close(); throw error;
  }
  return {
    server, service, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, token,
    async close() {
      if (closed) return; closed = true;
      clearInterval(pollTimer);
      if (backupOperation) await backupOperation;
      await connectors.stop();
      await closeServer(intakeServer); await closeServer(server);
      await service.close();
    }
  };
}

if (require.main === module) {
  startServer({ port: Number(process.env.PORT || 9731) }).then(instance => {
    process.stdout.write(`QuickPrint ${version} listening on ${instance.url}\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await instance.close(); process.exit(0); });
  }).catch(error => { process.stderr.write(`QuickPrint could not start: ${error.message}\n`); process.exitCode = 1; });
}
module.exports = { startServer, equalToken };
