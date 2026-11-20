'use strict';

const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

let mainWindow;
let backend;
let stopping = false;
const smokeTest = process.argv.includes('--smoke-test');
const option = (name) => process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
let smokeDataDir;

app.setName('QuickPrint');
if (process.platform === 'win32') app.setAppUserModelId('com.3dprintingworld.quickprint');

const requestedDataDir = option('--data-dir') || process.env.QUICKPRINT_DATA_DIR;
if (requestedDataDir) {
  if (!path.isAbsolute(requestedDataDir)) throw new Error('QuickPrint data directory must be an absolute path.');
  app.setPath('userData', requestedDataDir);
} else {
  app.setPath('userData', path.join(app.getPath('appData'), 'QuickPrint'));
}

function trustedSender(event) {
  if (!backend || !mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('This action is only available in the QuickPrint desktop window.');
  }
  if (new URL(event.senderFrame.url).origin !== new URL(backend.url).origin) {
    throw new Error('The calling page is not a QuickPrint page.');
  }
}

function installNativeBridge() {
  ipcMain.handle('quickprint:open-layr-authorization', async (event, url) => {
    trustedSender(event);
    if (typeof url !== 'string' || !backend.isLayrAuthorizationUrl(url)) throw new Error('Start PrintByLayr sign-in from Inputs first.');
    await shell.openExternal(url);
  });
  ipcMain.handle('quickprint:version', (event) => { trustedSender(event); return app.getVersion(); });
  ipcMain.handle('quickprint:select-folder', async (event) => {
    trustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose a QuickPrint input folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('quickprint:select-file', async (event, options = {}) => {
    trustedSender(event);
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid file selection options.');
    const filters = {
      slicer: [{ name: 'Slicer executable', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }],
      profile: [{ name: 'Slicer profiles', extensions: ['json', 'ini', 'config'] }],
      model: [{ name: 'Print files', extensions: ['stl', '3mf', 'obj', 'step', 'stp', 'gcode', 'gco'] }],
    };
    const kind = options.kind || 'model';
    if (!Object.hasOwn(filters, kind)) throw new Error('Unknown file selection type.');
    const multiple = options.multiple === true;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'slicer' ? 'Choose your installed slicer' : 'Choose files',
      filters: filters[kind],
      properties: ['openFile', ...(multiple ? ['multiSelections'] : [])],
    });
    return result.canceled ? null : (multiple ? result.filePaths : result.filePaths[0]);
  });
  ipcMain.handle('quickprint:open-data-folder', async (event) => {
    trustedSender(event);
    const error = await shell.openPath(app.getPath('userData'));
    if (error) throw new Error(error);
  });
}

function credentialFunctions() {
  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('Secure credential storage is unavailable. Sign in to your Windows account normally and restart QuickPrint. Credentials have not been saved.');
    }
  }
  return {
    seal(secret) {
      requireEncryption();
      return `electron-safe-storage:v1:${safeStorage.encryptString(String(secret)).toString('base64')}`;
    },
    unseal(encoded) {
      requireEncryption();
      const prefix = 'electron-safe-storage:v1:';
      if (typeof encoded !== 'string' || !encoded.startsWith(prefix)) throw new Error('Unsupported credential encoding. Re-enter this credential in Settings.');
      try { return safeStorage.decryptString(Buffer.from(encoded.slice(prefix.length), 'base64')); }
      catch { throw new Error('This credential cannot be decrypted by this Windows account. Re-enter it in QuickPrint.'); }
    },
  };
}

async function stopBackend() {
  if (!backend) return;
  const instance = backend;
  backend = null;
  await instance.close();
}

async function writeSmokeReport(report) {
  const destination = option('--smoke-report') || (smokeDataDir ? path.join(os.tmpdir(), `quickprint-smoke-${process.pid}.json`) : path.join(app.getPath('userData'), 'smoke-test.json'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
}

async function smokeCadWorkers() {
  const root = path.resolve(app.getPath('userData'));
  const directory = await fs.mkdtemp(path.join(root, '.cad-workers-smoke-'));
  try {
    const { materializeCadWorkers } = require('../slicing/resin-cad');
    const scripts = await materializeCadWorkers(directory);
    if (!scripts || Object.keys(scripts).sort().join(',') !== 'auditor,worker') throw new Error('CAD worker extraction did not produce both resources.');
    const files = [];
    for (const [key, name] of [['worker', 'resin-cad-worker.py'], ['auditor', 'resin-cad-transfer-audit.py']]) {
      const item = scripts[key], destination = path.join(directory, name);
      if (!item || item.filePath !== destination) throw new Error('CAD worker extraction returned an unexpected path.');
      const stat = await fs.lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CAD worker extraction did not create an ordinary private file.');
      const source = await fs.readFile(path.join(__dirname, '..', 'slicing', name));
      const copied = await fs.readFile(destination);
      const sha256 = createHash('sha256').update(copied).digest('hex');
      if (!source.length || copied.length !== item.bytes || item.sha256 !== sha256 || !source.equals(copied)) throw new Error('Extracted CAD worker bytes do not match the packaged resource.');
      files.push({ name, bytes: copied.length, sha256 });
    }
    return { extracted: true, count: files.length, files };
  } finally {
    // Remove only this fresh smoke directory, never a caller-supplied data
    // directory. Confirm its resolved location before recursive cleanup.
    const actual = await fs.realpath(directory), actualRoot = await fs.realpath(root);
    if (path.dirname(actual) !== actualRoot || !path.basename(actual).startsWith('.cad-workers-smoke-')) throw new Error('CAD smoke cleanup path is outside its private directory.');
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function smokeHollowGridWorker() {
  const { auditResinHollowGridAsync, resolveHollowGridWorkerPath } = require('../slicing/resin-hollow-grid-async');
  const workerPath = resolveHollowGridWorkerPath(), files = [];
  for (const name of ['resin-hollow-grid-worker.js', 'resin-hollow-grid.js']) {
    const filename = path.join(path.dirname(workerPath), name), stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Hollow raster worker resource is not an ordinary file.');
    const bytes = await fs.readFile(filename), packaged = await fs.readFile(path.join(__dirname, '..', 'slicing', name));
    if (!bytes.length || !bytes.equals(packaged)) throw new Error('Hollow raster worker bytes differ from the packaged source.');
    files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const solid = new Uint8Array(125), hollow = new Uint8Array(125);
  for (let z = 1; z < 4; z++) for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) solid[(z * 5 + y) * 5 + x] = hollow[(z * 5 + y) * 5 + x] = 255;
  const result = await auditResinHollowGridAsync({ solid: { lower: solid, upper: solid }, hollow: { lower: hollow, upper: hollow }, frame: { nx: 5, ny: 5, nz: 5, pitchMm: { x: 1, y: 1, z: 1 }, originMm: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 1, z: 1 } }, wallThicknessMm: 1, uncertaintyMm: 0.2,
    drains: [{ id: 'owned-smoke-drain', startMm: { x: 2.5, y: 2.5, z: -1 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: 2, lengthMm: 7 }], limits: { maxTimeMs: 10000 } });
  if (result.disposition !== 'nonconforming' || !result.counts.definitelyRetainedExpectedCavity) throw new Error('Packaged hollow raster worker did not reject the owned solid control.');
  return { executed: true, count: files.length, disposition: result.disposition, files };
}

async function smokeHollowFinalGridWorker() {
  const { auditResinHollowFinalGridAsync, resolveHollowFinalGridWorkerPath } = require('../slicing/resin-hollow-final-grid-async');
  const workerPath = resolveHollowFinalGridWorkerPath(), files = [];
  for (const name of ['resin-hollow-final-grid-async.js', 'resin-hollow-final-grid-worker.js', 'resin-hollow-final-grid.js', 'resin-hollow-grid.js']) {
    const filename = path.join(path.dirname(workerPath), name), stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Final hollow worker resource is not an ordinary file.');
    const bytes = await fs.readFile(filename), packaged = await fs.readFile(path.join(__dirname, '..', 'slicing', name));
    if (!bytes.length || !bytes.equals(packaged)) throw new Error('Final hollow worker resource differs from the packaged source.');
    files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const arrays = Array.from({ length: 6 }, () => new Uint8Array(125));
  for (let z = 1; z < 4; z++) for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) for (const array of arrays) array[(z * 5 + y) * 5 + x] = 255;
  const result = await auditResinHollowFinalGridAsync({ solidBody: { lower: arrays[0], upper: arrays[1] }, hollowBody: { lower: arrays[2], upper: arrays[3] }, final: { lower: arrays[4], upper: arrays[5] }, frame: { nx: 5, ny: 5, nz: 5, pitchMm: { x: 1, y: 1, z: 1 }, originMm: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 1, z: 1 } }, wallThicknessMm: 1, uncertaintyMm: 0.2,
    drains: [{ id: 'owned-final-smoke-drain', startMm: { x: 2.5, y: 2.5, z: -1 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: 2, lengthMm: 7 }], supportEnvelope: { minMm: { x: 0, y: 0, z: 0 }, maxMm: { x: 5, y: 5, z: 5 } }, supportRegions: [], limits: { maxTimeMs: 10000 } });
  if (result.disposition !== 'nonconforming' || !result.finalMaterialAudit.counts.definitelyRetainedExpectedCavity || arrays.some(array => array.byteLength !== 0)) throw new Error('Packaged final hollow worker failed its six-buffer solid control.');
  return { executed: true, count: files.length, disposition: result.disposition, inputBuffersTransferred: 6, files };
}

async function smokeWindowsNativeJob() {
  const root = path.resolve(app.getPath('userData')), files = [];
  for (const name of ['windows-native-job.js', 'windows-native-job.ps1', 'windows-native-job.cs']) {
    const source = path.join(__dirname, '..', 'slicing', name);
    const physical = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'slicing', name) : source;
    const stat = await fs.lstat(physical), bytes = await fs.readFile(physical), packaged = await fs.readFile(source);
    if (!stat.isFile() || stat.isSymbolicLink() || !bytes.length || !bytes.equals(packaged)) throw new Error('Native job supervisor resource differs from the packaged source.');
    files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (process.platform !== 'win32') return { executed: false, reason: 'requires-windows', count: files.length, files };
  const { runWindowsNative } = require('../slicing/windows-native-job');
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await runWindowsNative(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::Write('quickprint-native-job-smoke'); exit 7"], { cwd: root, processCommitLimitBytes: 1024 * 1024 * 1024, jobCommitLimitBytes: 1024 * 1024 * 1024, timeoutMs: 10000, maxOutputBytes: 4096 });
  const receipt = result.resourceReceipt;
  if (result.code !== 7 || result.stdout !== 'quickprint-native-job-smoke' || !receipt.assignedAtCreation || !receipt.killOnJobClose || receipt.memoryAccounting !== 'committed-virtual-memory-not-rss') throw new Error('Packaged native job supervisor did not preserve its guarded native exit.');
  for (const file of files) if (receipt.supervisorManifest.files.filter(item => item.name === file.name && item.sha256 === file.sha256 && item.bytes === file.bytes).length !== 1) throw new Error('Executed native job resource differs from its packaged hash.');
  return { executed: true, count: files.length, nativeExitCode: result.code, resourceReceipt: receipt, files };
}

async function smokeControlledHollow() {
  // Exercise the shipped controller's asynchronous source pins and the plate
  // adapter's rejection boundary without installing or launching a provider.
  const controller = require('../slicing/resin-hollow-engine');
  const adapter = require('../slicing/resin-hollow-plate');
  const root = await fs.realpath(app.getPath('userData'));
  const directory = await fs.realpath(await fs.mkdtemp(path.join(root, '.hollow-controller-smoke-')));
  try {
    const names = [
      'resin-hollow-engine.js', 'resin-controlled-capture.js', 'windows-native-job.js', 'windows-native-job.ps1', 'windows-native-job.cs',
      'resin-hollow-inputs.js', 'resin-hollow-preset.js', 'resin-hollow-resolution.js', 'resin-hollow-plan.js', 'resin-hollow-supports.js',
      'resin-hollow-audit.js', 'resin-hollow-final-audit.js', 'resin-hollow-raster.js', 'resin-hollow-grid-async.js', 'resin-hollow-final-grid-async.js',
      'resin-geometry.js', 'resin-mesh.js', 'resin-plate.js', 'resin-plate-engine.js', 'resin-engine.js', 'resin-profiles.js', 'psam/zip-inspection.js',
      'resin-hollow-grid-worker.js', 'resin-hollow-grid.js', 'resin-hollow-final-grid-worker.js', 'resin-hollow-final-grid.js',
      'resin-hollow-plate.js', 'goo-replication.js', 'goo-plate.js', 'goo.js',
    ];
    const files = [];
    for (const name of names) {
      const bytes = await fs.readFile(path.join(__dirname, '..', 'slicing', name));
      if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('Controlled hollow smoke source is missing or exceeds its bound.');
      files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    // Owned twelve-triangle outward cube; no test/private fixture dependency.
    const vertices = [[0,0,0],[3,0,0],[3,3,0],[0,3,0],[0,0,3],[3,0,3],[3,3,3],[0,3,3]];
    const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
    const source = Buffer.alloc(84 + faces.length * 50); source.writeUInt32LE(faces.length, 80);
    faces.forEach((face, index) => face.forEach((vertex, corner) => vertices[vertex].forEach((coordinate, axis) => source.writeFloatLE(coordinate, 84 + index * 50 + 12 + corner * 12 + axis * 4))));
    let adapterRejected = false;
    try { await adapter.verifyResinHollowPlateReference({}, { source, directory, timeoutMs: 10000 }); }
    catch (error) { if (error.code !== 'RESIN_HOLLOW_PREPARATION_CHANGED' || error.message !== 'A complete unchanged controlled hollow receipt is required.') throw error; adapterRejected = true; }
    if (!adapterRejected) throw new Error('The packaged hollow adapter accepted an untrusted receipt.');
    if (process.platform !== 'win32') return { executed: false, reason: 'requires-windows', adapterRejectedUntrustedRecord: true, count: files.length, files };
    const inputPath = path.join(directory, 'owned-cube.stl'), profilePath = path.join(directory, 'profile.json');
    const missingPrusa = path.join(directory, 'absent-prusa.exe'), missingUvtools = path.join(directory, 'absent-uvtools.exe');
    const expected = { resolutionX: 32, resolutionY: 32, displayWidthMm: 40, displayHeightMm: 40, machineZMm: 30, layerHeightMm: .05, mirrorX: false, mirrorY: false };
    const profile = { schemaVersion: 1, printerId: 'smoke-no-printer', printerModel: 'Owned smoke fixture', material: 'Synthetic digital fixture', presetPath: 'profile.ini', expected,
      orientationCandidates: [{ x: 0, y: 0, z: 0 }], uvtoolsProperties: { MachineName: 'Owned smoke fixture', LayerHeight: .05, ExposureTime: 2, BottomExposureTime: 20, BottomLayerCount: 1, BottomLiftHeight: 5, LiftHeight: 5, BottomLiftSpeed: 100, LiftSpeed: 100, RetractSpeed: 100, LightPWM: 255, BottomLightPWM: 255 } };
    await fs.writeFile(inputPath, source, { flag: 'wx' });
    await fs.writeFile(profilePath, JSON.stringify(profile), { flag: 'wx' });
    await fs.writeFile(path.join(directory, 'profile.ini'), 'printer_technology=SLA\nsla_archive_format=SL1\nhollowing_enable=0\ndisplay_pixels_x=32\ndisplay_pixels_y=32\ndisplay_width=40\ndisplay_height=40\nbed_shape=0x0,40x0,40x40,0x40\ndisplay_mirror_x=0\ndisplay_mirror_y=0\ndisplay_orientation=landscape\nsupports_enable=0\npad_enable=0\nlayer_height=0.05\ninitial_layer_height=0.05\nexposure_time=2\ninitial_exposure_time=20\nmax_print_height=30\n', { flag: 'wx' });
    const outputDir = path.join(directory, 'captures');
    let missingProviderRejected = false;
    try {
      await controller.prepareControlledResinHollow({ inputPath, profilePath, outputDir, prusaExecutable: missingPrusa, uvtoolsExecutable: missingUvtools, timeoutMs: 10000,
        hollowRequest: { orientation: { x: 0, y: 0, z: 0 }, wallThicknessMm: 1, quality: .5, closingDistanceMm: 0, drains: [{ id: 'smoke-drain', startMm: { x: 1.5, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: 1 }, radiusMm: .2, lengthMm: 3 }] },
        supportRequest: { mode: 'none', clearanceMm: 0, points: [], regions: [] }, resolutionRequest: { maximumUncertaintyMm: .2 }, boundaryPolicy: 'voxel-enclosure' });
    } catch (error) { if (error.code !== 'ENOENT' || error.path !== missingPrusa) throw error; missingProviderRejected = true; }
    if (!missingProviderRejected) throw new Error('The packaged hollow controller did not stop at the missing owned provider.');
    const captures = await fs.readdir(outputDir, { withFileTypes: true });
    if (captures.length !== 1 || !captures[0].isDirectory() || !/^hollow-/.test(captures[0].name)) throw new Error('The hollow smoke did not create one private capture.');
    const captureDirectory = path.join(outputDir, captures[0].name);
    const progress = (await fs.readFile(path.join(captureDirectory, 'native-progress.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const failure = JSON.parse(await fs.readFile(path.join(captureDirectory, 'failure.json'), 'utf8'));
    if (progress.length !== 2 || progress[0].stage !== 'provider-probes' || progress[0].status !== 'started' || progress[1].stage !== 'preparation' || progress[1].status !== 'failed' || progress[1].code !== 'ENOENT' || failure.error?.code !== 'ENOENT' || !Array.isArray(failure.invocations) || failure.invocations.length !== 0 || failure.nativeInvocationAttested !== false || failure.productionEligible !== false) throw new Error('The packaged hollow smoke advanced beyond the missing-provider boundary.');
    return { executed: true, controllerInitialized: true, adapterRejectedUntrustedRecord: true, asyncSourceVerification: true, missingProviderRejected: true, failureCode: 'ENOENT', nativeCalls: 0, count: files.length, files };
  } finally {
    const actual = await fs.realpath(directory);
    if (path.dirname(actual) !== root || !path.basename(actual).startsWith('.hollow-controller-smoke-')) throw new Error('Hollow smoke cleanup is outside its private directory.');
    await fs.rm(actual, { recursive: true, force: true });
  }
}

async function smokeCheck(credentials) {
  const response = await fetch(new URL('/api/health', backend.url), { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Health check failed: HTTP ${response.status}`);
  const health = await response.json();
  const uiReady = await mainWindow.webContents.executeJavaScript(`new Promise(resolve => {
    const deadline = Date.now() + 10000;
    function check() {
      if (document.querySelector('#main h1') && document.querySelector('#connection-error')?.hidden && !document.querySelector('#main .loading-state')) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 50);
    }
    check();
  })`);
  if (!uiReady) throw new Error('The desktop interface did not finish loading.');
  const renderer = await mainWindow.webContents.executeJavaScript(`({ title: document.title, bridge: !!window.quickprint, nodeDisabled: typeof process === 'undefined' && typeof require === 'undefined', bodyReady: document.body.children.length > 0 })`);
  if (!renderer.bridge || !renderer.nodeDisabled || !renderer.bodyReady) throw new Error('Desktop renderer isolation validation failed.');
  const nativeVersion = await mainWindow.webContents.executeJavaScript('window.quickprint.version()');
  if (nativeVersion !== app.getVersion()) throw new Error('The native desktop bridge did not respond correctly.');
  const apiReady = await mainWindow.webContents.executeJavaScript(`(async () => {
    const token = document.querySelector('meta[name="quickprint-token"]')?.content;
    const response = await fetch('/api/state', { headers: { Authorization: 'Bearer ' + token } });
    if (!response.ok) return false;
    const state = await response.json();
    return Array.isArray(state.jobs) && Array.isArray(state.printers);
  })()`);
  if (!apiReady) throw new Error('The desktop could not read its authenticated local API.');
  const cadWorkers = await smokeCadWorkers();
  const hollowGridWorker = await smokeHollowGridWorker();
  const hollowFinalGridWorker = await smokeHollowFinalGridWorker();
  const windowsNativeJob = await smokeWindowsNativeJob();
  const controlledHollow = await smokeControlledHollow();
  let credentialRoundTrip = 'unavailable-on-this-platform';
  if (process.platform === 'win32' || safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text') {
    const probe = 'quickprint-smoke-test-not-a-secret';
    if (credentials.unseal(credentials.seal(probe)) !== probe) throw new Error('Credential storage validation failed.');
    credentialRoundTrip = 'passed';
  }
  await writeSmokeReport({ ok: true, version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, health, renderer, uiReady, apiReady, nativeVersion, credentialRoundTrip, cadWorkers, hollowGridWorker, hollowFinalGridWorker, windowsNativeJob, controlledHollow, checkedAt: new Date().toISOString() });
  stopping = true;
  await stopBackend();
  mainWindow.destroy();
  if (smokeDataDir) await fs.rm(smokeDataDir, { recursive: true, force: true });
  app.exit(0);
}

async function start() {
  if (smokeTest && !requestedDataDir) {
    smokeDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-smoke-'));
    app.setPath('userData', smokeDataDir);
  }
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  // Windows uses the account's DPAPI key. A Linux developer session without a
  // desktop keyring uses the core's authenticated local-key storage instead;
  // Electron's insecure basic_text backend is never used to save credentials.
  const linuxWithoutKeyring = process.platform === 'linux' && (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend() === 'basic_text');
  const credentials = linuxWithoutKeyring ? {} : credentialFunctions();
  const { startServer } = require('../server');
  backend = await startServer({ dataDir: app.getPath('userData'), port: 0, host: '127.0.0.1', ...credentials });
  const localOrigin = new URL(backend.url).origin;
  const ownWindow = (contents) => mainWindow && contents === mainWindow.webContents;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    let localRequest = false;
    try { localRequest = new URL(details.requestingUrl).origin === localOrigin; } catch { /* Refuse unknown origins. */ }
    callback(Boolean(ownWindow(contents) && localRequest && details.isMainFrame && permission === 'clipboard-sanitized-write'));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    Boolean(ownWindow(contents) && requestingOrigin === localOrigin && permission === 'clipboard-sanitized-write'));
  // A compromised renderer cannot send orders or saved secrets to remote sites.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url);
      callback({ cancel: url.origin !== localOrigin && !['data:', 'blob:', 'devtools:'].includes(url.protocol) });
    } catch { callback({ cancel: true }); }
  });
  installNativeBridge();
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1000, minHeight: 680,
    show: false, title: 'QuickPrint', backgroundColor: '#101d2b',
    icon: path.join(__dirname, '../../assets/quickprint.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).origin !== localOrigin) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => { if (!smokeTest) mainWindow.show(); });
  await mainWindow.loadURL(backend.url);
  if (smokeTest) await smokeCheck(credentials);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!backend || stopping) return;
    event.preventDefault();
    stopping = true;
    const timeout = setTimeout(() => app.exit(1), 15000);
    stopBackend().then(() => { clearTimeout(timeout); app.quit(); }).catch(() => { clearTimeout(timeout); app.exit(1); });
  });
  app.whenReady().then(start).catch(async (error) => {
    stopping = true;
    // Error messages only; never dump settings, process environment or credentials.
    const message = error?.message || 'An unknown startup error occurred.';
    if (smokeTest) {
      try { await writeSmokeReport({ ok: false, error: message, checkedAt: new Date().toISOString() }); } catch { /* Exit code still reports failure. */ }
    } else {
      dialog.showErrorBox('QuickPrint could not start', `${message}\n\nYour QuickPrint data is stored in:\n${app.getPath('userData')}`);
    }
    try { await stopBackend(); } catch { /* Startup failure has already been reported. */ }
    app.exit(1);
  });
}
