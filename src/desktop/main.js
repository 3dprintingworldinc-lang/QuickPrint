'use strict';

const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

let mainWindow;
let backend;
let stopping = false;
const smokeTest = process.argv.includes('--smoke-test');
const option = (name) => process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
let smokeDataDir;

if (smokeTest) {
  // Native CI runners need a real WebGL context without a physical GPU.
  // These switches apply only to the isolated smoke process, never normal use.
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

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

async function simulationSmokeCheck() {
  const requireWebgl = process.platform === 'win32' || process.argv.includes('--smoke-require-webgl');
  const result = await mainWindow.webContents.executeJavaScript(`(async () => {
    const token = document.querySelector('meta[name="quickprint-token"]')?.content;
    async function read(endpoint) {
      const response = await fetch(endpoint, { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) throw new Error('Simulation smoke API failed: ' + endpoint + ' HTTP ' + response.status);
      return response.json();
    }
    async function waitFor(check, description) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Simulation smoke timed out: ' + description);
    }
    const productionBefore = await read('/api/state');
    if (productionBefore.jobs.length || productionBefore.printers.length || productionBefore.connectors.length) {
      throw new Error('Simulation smoke requires an isolated workspace without production jobs, printers, or inputs.');
    }
    const before = await read('/api/simulation');
    if (before.running || !Number.isFinite(before.timeMinutes) || !before.printers.length || !Array.isArray(before.jobs)) {
      throw new Error('The packaged simulation API did not provide a paused virtual farm.');
    }
    if (typeof window.QuickPrintSimulation?.mount !== 'function' || typeof window.QuickPrintScene?.createFarmScene !== 'function') {
      throw new Error('The packaged simulation UI or local Three.js bundle is missing.');
    }
    const sceneModule = window.QuickPrintScene;
    let scene;
    // Observe the production scene instance; do not replace its rendering.
    window.QuickPrintScene = { ...sceneModule, createFarmScene(...args) {
      scene = sceneModule.createFarmScene(...args);
      return scene;
    } };
    location.hash = '#simulation';
    await waitFor(() => {
      const button = document.querySelector('[data-sim-action="step"]');
      return document.querySelector('[data-sim-name]')?.textContent === before.scenario.name
        && document.querySelector('[data-sim-error]')?.hidden && button && !button.disabled;
    }, 'simulation controls and authenticated snapshot');
    await waitFor(() => {
      const diagnostics = scene?.getDiagnostics?.();
      const fallback = document.querySelector('[data-sim-webgl]');
      return diagnostics?.available && diagnostics.frames > 0 && diagnostics.drawCalls > 0
        && diagnostics.triangles > 0 && diagnostics.printers === before.printers.length
        || fallback && !fallback.hidden;
    }, 'a rendered 3D farm or usable WebGL fallback');
    const diagnostics = scene?.getDiagnostics?.() || { available: false };
    const canvas = document.querySelector('[data-sim-scene] canvas');
    const sceneRendered = Boolean(diagnostics.available && diagnostics.frames > 0 && diagnostics.drawCalls > 0
      && diagnostics.triangles > 0 && diagnostics.printers === before.printers.length
      && canvas?.width > 0 && canvas?.height > 0);
    if (${JSON.stringify(requireWebgl)} && !sceneRendered) {
      throw new Error('Packaged simulation failed to render a real WebGL scene: ' + (diagnostics.reason || 'no rendered farm geometry'));
    }
    if (!sceneRendered && (!document.querySelector('[data-sim-webgl]') || document.querySelector('[data-sim-webgl]').hidden)) {
      throw new Error('The simulation did not provide its usable non-WebGL fallback.');
    }
    // Exercise the actual visible control and its authenticated HTTP request.
    const afterMinutes = before.timeMinutes + 5;
    const wholeMinutes = Math.floor(afterMinutes);
    const expectedClock = String(Math.floor(wholeMinutes / 60)).padStart(2, '0') + ':' + String(wholeMinutes % 60).padStart(2, '0');
    document.querySelector('[data-sim-action="step"]').click();
    await waitFor(() => document.querySelector('[data-sim-time]')?.textContent === expectedClock
      && !document.querySelector('[data-sim-action="step"]')?.disabled, 'five-minute simulation step');
    const after = await read('/api/simulation');
    if (after.running || after.timeMinutes !== afterMinutes || after.metrics.elapsedMinutes !== afterMinutes) {
      throw new Error('The simulator control did not advance exactly five paused minutes.');
    }
    const productionAfter = await read('/api/state');
    const productionKeys = ['jobs', 'printers', 'settings', 'connectors', 'events'];
    if (productionKeys.some(key => JSON.stringify(productionBefore[key]) !== JSON.stringify(productionAfter[key]))) {
      throw new Error('Virtual farm operation changed production workspace state.');
    }
    // The accessible equipment list must work in both WebGL and fallback mode.
    document.querySelector('[data-sim-tab="fleet"]').click();
    if (!document.querySelector('[data-sim-detail]')?.textContent.includes(before.printers[0].name)) {
      throw new Error('The simulator equipment list is unavailable.');
    }
    return { apiReady: true, bundleLoaded: true, uiReady: true,
      renderMode: sceneRendered ? 'webgl' : 'fallback', sceneRendered,
      diagnostics: scene?.getDiagnostics?.() || diagnostics,
      controlStepPassed: true, stepMinutes: 5, beforeMinutes: before.timeMinutes, afterMinutes,
      productionUnchanged: true };
  })()`);
  const checkpoint = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'simulation', 'state.json'), 'utf8'));
  if (checkpoint.engine?.timeMinutes !== result.afterMinutes) throw new Error('The simulator did not persist its isolated five-minute step.');
  return { ...result, persisted: true };
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
  let credentialRoundTrip = 'unavailable-on-this-platform';
  if (process.platform === 'win32' || safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text') {
    const probe = 'quickprint-smoke-test-not-a-secret';
    if (credentials.unseal(credentials.seal(probe)) !== probe) throw new Error('Credential storage validation failed.');
    credentialRoundTrip = 'passed';
  }
  const simulation = await simulationSmokeCheck();
  await writeSmokeReport({ ok: true, version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged, health, renderer, uiReady, apiReady, nativeVersion, credentialRoundTrip, simulation, checkedAt: new Date().toISOString() });
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
