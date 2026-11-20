'use strict';

// This runner is deliberately separate from the existing slicer runner. It never
// falls back to an unguarded process when Windows Job setup is unavailable.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

const LIMITS = Object.freeze({ maxCommitBytes: 1024 * 1024 * 1024, minCommitBytes: 16 * 1024 * 1024, maxOutputBytes: 1024 * 1024, maxTimeoutMs: 3600000, maxRequestBytes: 32768 });
const RESOURCES = ['windows-native-job.ps1', 'windows-native-job.cs'];
const FLAGS = 0x2300;
const plain = value => value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (message, code = 'WINDOWS_NATIVE_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const abortError = () => fail('Native preparation cancelled.', 'ABORTED', 409);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => keys.includes(key));
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
// Pin at module initialization: hashing a later on-disk edit would otherwise
// attribute new bytes to the old runner still executing in require.cache.
const SOURCE_PINS = [...RESOURCES, path.basename(__filename)].map(name => {
  const source = path.join(__dirname, name), info = syncFs.lstatSync(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 256 * 1024) throw fail('Bundled native resource is invalid.', 'WINDOWS_NATIVE_RESOURCE');
  const bytes = syncFs.readFileSync(source);
  if (bytes.length !== info.size) throw fail('Bundled native resource changed during initialization.', 'WINDOWS_NATIVE_RESOURCE_CHANGED', 409);
  return Object.freeze({ name, source, bytes: bytes.length, sha256: hash(bytes) });
});

function configuration(executable, args, options) {
  const allowed = ['cwd', 'processCommitLimitBytes', 'jobCommitLimitBytes', 'timeoutMs', 'maxOutputBytes', 'signal', 'env'];
  if (!plain(options) || Reflect.ownKeys(options).some(key => !allowed.includes(key))) throw fail('Unsupported native supervisor options.');
  if (typeof executable !== 'string' || !executable || executable.length > 4000 || /[\0\r\n]/.test(executable) || !path.isAbsolute(executable) || !/\.exe$/i.test(executable)) throw fail('Choose an absolute local provider executable.');
  if (!Array.isArray(args) || args.length > 512 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 16384)) throw fail('Native arguments must be bounded strings.');
  if (typeof options.cwd !== 'string' || options.cwd.length > 4000 || /[\0\r\n]/.test(options.cwd) || !path.isAbsolute(options.cwd)) throw fail('Choose an absolute managed native work directory.');
  const processCommitLimitBytes = options.processCommitLimitBytes ?? LIMITS.maxCommitBytes;
  const jobCommitLimitBytes = options.jobCommitLimitBytes ?? LIMITS.maxCommitBytes;
  const timeoutMs = options.timeoutMs ?? 900000, maxOutputBytes = options.maxOutputBytes ?? LIMITS.maxOutputBytes;
  if (!integer(processCommitLimitBytes, LIMITS.minCommitBytes, LIMITS.maxCommitBytes) || !integer(jobCommitLimitBytes, processCommitLimitBytes, LIMITS.maxCommitBytes) || !integer(timeoutMs, 100, LIMITS.maxTimeoutMs) || !integer(maxOutputBytes, 1, LIMITS.maxOutputBytes)) throw fail('Native time, output or commit bounds are invalid.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw fail('Use an AbortSignal for native cancellation.');
  const environment = { DOTNET_PROCESSOR_COUNT: '1' };
  if (options.env !== undefined) {
    if (!plain(options.env) || Reflect.ownKeys(options.env).some(key => !['DOTNET_PROCESSOR_COUNT', 'OPENCV_FOR_THREADS_NUM'].includes(key))) throw fail('Only managed native environment controls are allowed.');
    for (const [key, value] of Object.entries(options.env)) { if (value !== '1') throw fail('Managed native environment controls must be the string 1.'); environment[key] = value; }
  }
  return { executable, args: [...args], cwd: options.cwd, processCommitLimitBytes, jobCommitLimitBytes, timeoutMs, maxOutputBytes, signal: options.signal, environment };
}

// Check every ancestor; a leaf-only realpath check would miss a linked job root.
async function localPath(filePath, directory) {
  if (!/^[a-z]:\\/i.test(filePath) || filePath.startsWith('\\\\')) throw fail('Native work and executables must use local Windows drive paths.', 'WINDOWS_NATIVE_PATH');
  const absolute = path.resolve(filePath), root = path.parse(absolute).root;
  let at = root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    at = path.join(at, parts[index]);
    const info = await fs.lstat(at);
    if (info.isSymbolicLink() || (index < parts.length - 1 || directory ? !info.isDirectory() : !info.isFile())) throw fail('Native paths cannot contain links or unexpected file types.', 'WINDOWS_NATIVE_PATH');
  }
  const actual = await fs.realpath(absolute);
  if (actual.toLowerCase() !== absolute.toLowerCase()) throw fail('Native path resolves to a different location.', 'WINDOWS_NATIVE_PATH');
  return actual;
}
async function readPinned(filePath, maximum) {
  const before = await fs.lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(maximum)) throw fail('Native helper resource exceeds its file bounds.', 'WINDOWS_NATIVE_RESOURCE');
  const handle = await fs.open(filePath, 'r');
  try {
    const same = info => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => info[key] === before[key]);
    if (!same(await handle.stat({ bigint: true }))) throw fail('Native helper resource changed while opening.', 'WINDOWS_NATIVE_RESOURCE_CHANGED', 409);
    const bytes = await handle.readFile();
    if (bytes.length !== Number(before.size) || !same(await handle.stat({ bigint: true })) || !same(await fs.lstat(filePath, { bigint: true }))) throw fail('Native helper resource changed while reading.', 'WINDOWS_NATIVE_RESOURCE_CHANGED', 409);
    return bytes;
  } finally { await handle.close(); }
}
async function readBundled(pin) {
  // Electron ASAR stats are virtual. An open() descriptor may describe a real
  // extracted file, so comparing its inode with an ASAR stat is inappropriate.
  const before = await fs.lstat(pin.source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || Number(before.size) !== pin.bytes) throw fail('Bundled native resource changed.', 'WINDOWS_NATIVE_RESOURCE_CHANGED', 409);
  const bytes = await fs.readFile(pin.source), after = await fs.lstat(pin.source, { bigint: true });
  // ASAR synthesizes stat identity fields; even two unchanged virtual stats can
  // have different inodes. Startup-pinned bytes, not those identities, bind code.
  if (!after.isFile() || after.isSymbolicLink() || Number(after.size) !== pin.bytes || bytes.length !== pin.bytes || hash(bytes) !== pin.sha256) throw fail('Bundled native resource changed after initialization.', 'WINDOWS_NATIVE_RESOURCE_CHANGED', 409);
  return bytes;
}
async function materialize(cwd, signal) {
  const sources = [];
  for (const pin of SOURCE_PINS) {
    signal?.throwIfAborted();
    const bytes = await readBundled(pin);
    sources.push({ ...pin, bytes });
  }
  const directory = await fs.mkdtemp(path.join(cwd, '.windows-native-job-'));
  await localPath(directory, true);
  const owned = [];
  try {
    for (const source of sources.filter(source => RESOURCES.includes(source.name))) {
      const target = path.join(directory, source.name);
      await fs.writeFile(target, source.bytes, { flag: 'wx', mode: 0o600 }); owned.push(target);
      if (hash(await readPinned(target, 256 * 1024)) !== source.sha256) throw fail('Native helper extraction changed bytes.', 'WINDOWS_NATIVE_RESOURCE_CHANGED', 409);
    }
    return { directory, owned, sources };
  } catch (error) { await cleanup({ directory, owned }, cwd); throw error; }
}
async function verifyResources(resources, cwd) {
  await localPath(cwd, true); await localPath(resources.directory, true);
  if (path.dirname(resources.directory).toLowerCase() !== cwd.toLowerCase()) throw fail('Native helper directory moved.', 'WINDOWS_NATIVE_RESOURCE_CHANGED', 409);
  for (const source of resources.sources) {
    await readBundled(SOURCE_PINS.find(pin => pin.name === source.name));
    if (RESOURCES.includes(source.name) && hash(await readPinned(path.join(resources.directory, source.name), 256 * 1024)) !== source.sha256) throw fail('Extracted native helper changed.', 'WINDOWS_NATIVE_RESOURCE_CHANGED', 409);
  }
}
async function cleanup(resources, cwd) {
  // Never recursively delete a computed path. Delete only the two exclusive
  // files in our verified fresh direct-child directory, then its empty folder.
  if (path.dirname(resources.directory).toLowerCase() !== cwd.toLowerCase() || !path.basename(resources.directory).startsWith('.windows-native-job-')) throw fail('Refusing unexpected native helper cleanup.', 'WINDOWS_NATIVE_RESOURCE_CHANGED');
  await localPath(cwd, true); await localPath(resources.directory, true);
  for (const filePath of resources.owned) {
    if (path.dirname(filePath) !== resources.directory || !RESOURCES.includes(path.basename(filePath))) throw fail('Refusing unexpected native helper file cleanup.', 'WINDOWS_NATIVE_RESOURCE_CHANGED');
    const info = await fs.lstat(filePath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink() || (info && !info.isFile())) throw fail('Native helper cleanup found a link.', 'WINDOWS_NATIVE_RESOURCE_CHANGED');
    if (info) await fs.unlink(filePath);
  }
  await fs.rmdir(resources.directory);
}

function decodeOutput(value, bytes, maximum) {
  if (typeof value !== 'string' || !integer(bytes, 0, maximum) || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail('Invalid native output framing.', 'WINDOWS_NATIVE_PROTOCOL', 502);
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== bytes || buffer.toString('base64') !== value) throw fail('Native output length is inconsistent.', 'WINDOWS_NATIVE_PROTOCOL', 502);
  return buffer.toString('utf8');
}
function parseResult(value, config, started, manifest) {
  const keys = ['processId', 'exitCode', 'stopReason', 'assignedBeforeResume', 'assignedAtCreation', 'parentWasInJob', 'limitFlags', 'processCommitLimitBytes', 'jobCommitLimitBytes', 'peakProcessCommitBytes', 'peakJobCommitBytes', 'memoryLimitHit', 'memoryLimitMessages', 'stdoutBase64', 'stderrBase64', 'stdoutBytes', 'stderrBytes', 'outputLimitExceeded', 'elapsedMs', 'descendantsTerminatedOnCompletion'];
  if (!exact(value, keys) || value.processId !== started.processId || !integer(value.exitCode, 0, 0xffffffff) || ![null, 'cancelled', 'timeout', 'memory-limit', 'output-limit', 'parent-disconnected', 'invalid-control', 'control-error'].includes(value.stopReason) || value.assignedBeforeResume !== true || value.assignedAtCreation !== true || typeof value.parentWasInJob !== 'boolean' || value.limitFlags !== FLAGS || value.processCommitLimitBytes !== config.processCommitLimitBytes || value.jobCommitLimitBytes !== config.jobCommitLimitBytes || !integer(value.peakProcessCommitBytes, 0, Number.MAX_SAFE_INTEGER) || !integer(value.peakJobCommitBytes, 0, Number.MAX_SAFE_INTEGER) || typeof value.memoryLimitHit !== 'boolean' || !Array.isArray(value.memoryLimitMessages) || value.memoryLimitMessages.length > 2 || new Set(value.memoryLimitMessages).size !== value.memoryLimitMessages.length || value.memoryLimitMessages.some(message => ![9, 10].includes(message)) || value.memoryLimitHit !== (value.memoryLimitMessages.length > 0) || typeof value.outputLimitExceeded !== 'boolean' || !integer(value.elapsedMs, 0, config.timeoutMs + 15000) || value.descendantsTerminatedOnCompletion !== true) throw fail('Native supervisor receipt is inconsistent.', 'WINDOWS_NATIVE_PROTOCOL', 502);
  const stdout = decodeOutput(value.stdoutBase64, value.stdoutBytes, config.maxOutputBytes), stderr = decodeOutput(value.stderrBase64, value.stderrBytes, config.maxOutputBytes);
  const resourceReceipt = freeze({ schemaVersion: 1, method: 'windows-job-object-v1', processId: value.processId, assignedAtCreation: true, assignedBeforeResume: true, parentWasInJob: value.parentWasInJob, killOnJobClose: true, descendantsTerminatedOnCompletion: true, limitFlags: FLAGS, memoryAccounting: 'committed-virtual-memory-not-rss', processCommitLimitBytes: value.processCommitLimitBytes, jobCommitLimitBytes: value.jobCommitLimitBytes, peakProcessCommitBytes: value.peakProcessCommitBytes, peakJobCommitBytes: value.peakJobCommitBytes, peakCommitObservation: 'after-root-exit-before-job-close', peakJobAccounting: 'high-water-may-include-denied-commit-attempts', memoryLimitObserved: value.memoryLimitHit, memoryLimitMessages: [...value.memoryLimitMessages], memoryNotificationsGuaranteed: false, outputLimitExceeded: value.outputLimitExceeded, stopReason: value.stopReason, elapsedMs: value.elapsedMs, managedEnvironment: { ...config.environment }, supervisorManifest: manifest });
  return freeze({ code: value.exitCode, stdout, stderr, resourceReceipt });
}

function supervise(powershell, resourceFile, request, config, manifest) {
  return new Promise((resolve, reject) => {
    if (config.signal?.aborted) return reject(abortError());
    let child, pending = '', count = 0, stderr = '', started = null, result = null, protocolError = null, terminalError = null, settled = false;
    let startupTimer, watchdogTimer, forceTimer, settleTimer;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const maximum = 2 * Math.ceil(config.maxOutputBytes / 3) * 4 + 65536;
    const stop = error => {
      if (!terminalError) terminalError = error;
      if (settled) return;
      try { child.stdin.write('cancel\n'); } catch {}
      if (!forceTimer) forceTimer = setTimeout(() => { try { child.kill(); } catch {} }, 2000);
      if (!settleTimer) settleTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref(); finish(terminalError); }, 7000);
    };
    const onAbort = () => stop(abortError());
    const finish = (error, value) => {
      if (settled) return;
      settled = true; for (const timer of [startupTimer, watchdogTimer, forceTimer, settleTimer]) clearTimeout(timer);
      config.signal?.removeEventListener('abort', onAbort); child?.stdin.destroy();
      if (error) { if (result) { error.resourceReceipt = result.resourceReceipt; error.nativeCode = result.code; error.stdout = result.stdout; error.stderr = result.stderr; } reject(error); } else resolve(value);
    };
    const line = text => {
      let message; try { message = JSON.parse(text); } catch { throw fail('Native supervisor returned invalid JSON.', 'WINDOWS_NATIVE_PROTOCOL', 502); }
      if (!plain(message) || message.schemaVersion !== 1) throw fail('Native supervisor response does not match its request.', 'WINDOWS_NATIVE_PROTOCOL', 502);
      // Add-Type can be blocked before the request is read. Its bounded error is
      // still an unavailable guarded runner, never permission to spawn normally.
      if (message.event === 'error' && message.requestId === null && !started && !result && exact(message, ['event', 'schemaVersion', 'requestId', 'message']) && typeof message.message === 'string' && message.message.length <= 4096) { protocolError = fail(`Windows native supervision is unavailable: ${message.message}`, 'WINDOWS_NATIVE_UNAVAILABLE', 502); return; }
      if (message.requestId !== request.requestId) throw fail('Native supervisor response does not match its request.', 'WINDOWS_NATIVE_PROTOCOL', 502);
      if (message.event === 'started') {
        if (started || result || !exact(message, ['event', 'schemaVersion', 'requestId', 'processId', 'assignedBeforeResume', 'assignedAtCreation']) || !integer(message.processId, 1, 0xffffffff) || message.assignedBeforeResume !== true || message.assignedAtCreation !== true) throw fail('Native supervisor startup was not guarded.', 'WINDOWS_NATIVE_PROTOCOL', 502);
        started = message; clearTimeout(startupTimer);
        watchdogTimer = setTimeout(() => stop(fail('Native supervisor exceeded its settlement deadline.', 'WINDOWS_NATIVE_TIMEOUT', 502)), config.timeoutMs + 10000);
      } else if (message.event === 'result') {
        if (!started || result || !exact(message, ['event', 'schemaVersion', 'requestId', 'result'])) throw fail('Unexpected native result.', 'WINDOWS_NATIVE_PROTOCOL', 502);
        result = parseResult(message.result, config, started, manifest);
      } else if (message.event === 'error') {
        if (result || !exact(message, ['event', 'schemaVersion', 'requestId', 'message']) || typeof message.message !== 'string' || message.message.length > 4096) throw fail('Invalid native supervisor error.', 'WINDOWS_NATIVE_PROTOCOL', 502);
        protocolError = fail(`Windows native supervision failed: ${message.message}`, 'WINDOWS_NATIVE_UNAVAILABLE', 502);
      } else throw fail('Unknown native supervisor event.', 'WINDOWS_NATIVE_PROTOCOL', 502);
    };
    try { child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resourceFile], { shell: false, windowsHide: true, cwd: config.cwd, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { return finish(fail(`Could not start Windows native supervision: ${error.code || 'spawn error'}.`, 'WINDOWS_NATIVE_UNAVAILABLE', 502)); }
    child.stdin.on('error', () => {});
    child.stdout.on('data', bytes => {
      count += bytes.length;
      if (count > maximum) return stop(fail('Native supervisor exceeded its protocol output bound.', 'WINDOWS_NATIVE_PROTOCOL', 502));
      try { pending += decoder.decode(bytes, { stream: true }); let at; while ((at = pending.indexOf('\n')) >= 0) { const text = pending.slice(0, at).replace(/\r$/, ''); pending = pending.slice(at + 1); if (text) line(text); } }
      catch (error) { stop(error.code ? error : fail('Native supervisor output is not UTF-8.', 'WINDOWS_NATIVE_PROTOCOL', 502)); }
    });
    child.stderr.on('data', bytes => { if (Buffer.byteLength(stderr) + bytes.length > 8192) stop(fail('Native supervisor stderr exceeded its bound.', 'WINDOWS_NATIVE_PROTOCOL', 502)); else stderr += bytes.toString('utf8'); });
    child.on('error', error => finish(fail(`Could not start Windows native supervision: ${error.code || 'spawn error'}.`, 'WINDOWS_NATIVE_UNAVAILABLE', 502)));
    child.on('close', code => {
      try { pending += decoder.decode(); if (pending.trim()) line(pending.trim()); } catch (error) { protocolError ||= error.code ? error : fail('Invalid native protocol ending.', 'WINDOWS_NATIVE_PROTOCOL', 502); }
      if (terminalError) return finish(terminalError);
      if (protocolError) return finish(protocolError);
      if (code !== 0 || !result) return finish(fail(`Windows native supervisor did not complete (${code}). ${stderr.slice(-2000)}`, 'WINDOWS_NATIVE_UNAVAILABLE', 502));
      const receipt = result.resourceReceipt;
      if (receipt.memoryLimitObserved || receipt.stopReason === 'memory-limit') return finish(fail('Native provider exceeded its commit budget.', 'WINDOWS_NATIVE_MEMORY_LIMIT', 413));
      if (receipt.stopReason === 'timeout') return finish(fail('Native provider exceeded its time limit.', 'WINDOWS_NATIVE_TIMEOUT', 408));
      if (receipt.outputLimitExceeded || receipt.stopReason === 'output-limit') return finish(fail('Native provider exceeded its output limit.', 'WINDOWS_NATIVE_OUTPUT_LIMIT', 413));
      if (receipt.stopReason) return finish(fail('Native provider was cancelled or lost its controller.', receipt.stopReason === 'cancelled' ? 'ABORTED' : 'WINDOWS_NATIVE_CONTROL', 409));
      finish(null, result);
    });
    startupTimer = setTimeout(() => stop(fail('Windows native supervisor could not initialize in time.', 'WINDOWS_NATIVE_UNAVAILABLE', 502)), 15000);
    config.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.write(JSON.stringify(request) + '\n');
    if (config.signal?.aborted) onAbort();
  });
}

// The caller supplies trusted provider code and application-built argv. Orders
// must never supply scripts, a supervisor resource, or a replacement executable.
// Ordinary native exit codes are returned; supervision failures reject.
async function runWindowsNative(executable, args, options = {}) {
  const config = configuration(executable, args, options);
  if (config.signal?.aborted) throw abortError();
  if (process.platform !== 'win32') throw fail('Hard native job supervision requires Windows 10 or later.', 'WINDOWS_NATIVE_UNSUPPORTED', 501);
  let resources, outcome, error;
  const cwd = await localPath(config.cwd, true); config.cwd = cwd;
  await localPath(executable, false);
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== 'string' || !/^[a-z]:\\/i.test(systemRoot)) throw fail('The Windows system directory is unavailable.', 'WINDOWS_NATIVE_UNAVAILABLE', 502);
  const powershell = await localPath(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), false);
  const powershellBytes = await readPinned(powershell, 16 * 1024 * 1024);
  try {
    resources = await materialize(cwd, config.signal);
    const entries = resources.sources.map(source => ({ name: source.name, bytes: source.bytes.length, sha256: source.sha256 }));
    entries.push({ name: 'windows-powershell.exe', bytes: powershellBytes.length, sha256: hash(powershellBytes) });
    const manifest = freeze({ sha256: hash(JSON.stringify(entries)), files: entries });
    const request = { schemaVersion: 1, requestId: randomBytes(16).toString('hex'), executable, arguments: config.args, directory: cwd, environment: config.environment, processCommitLimitBytes: config.processCommitLimitBytes, jobCommitLimitBytes: config.jobCommitLimitBytes, maxOutputBytes: config.maxOutputBytes, timeoutMs: config.timeoutMs };
    if (Buffer.byteLength(JSON.stringify(request)) > LIMITS.maxRequestBytes) throw fail('Native arguments exceed the request bound.');
    await verifyResources(resources, cwd);
    if (config.signal?.aborted) throw abortError();
    outcome = await supervise(powershell, path.join(resources.directory, RESOURCES[0]), request, config, manifest);
  } catch (caught) { error = caught; }
  finally {
    if (resources) {
      try { await verifyResources(resources, cwd); if (hash(await readPinned(powershell, 16 * 1024 * 1024)) !== hash(powershellBytes)) throw fail('Windows supervisor binary changed.', 'WINDOWS_NATIVE_RESOURCE_CHANGED', 409); }
      catch (caught) { error = caught; }
      try { await cleanup(resources, cwd); } catch (caught) { error ||= caught; }
    }
  }
  if (error) { if (error.name === 'AbortError') error = abortError(); throw error; }
  return outcome;
}

module.exports = { runWindowsNative, WINDOWS_NATIVE_JOB_LIMITS: LIMITS };
