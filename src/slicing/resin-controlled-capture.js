'use strict';

// Runs configured local provider bytes through the real Windows Job boundary.
// A receipt proves the controlled call and its declared files, not publisher
// authenticity, a complete dependency closure, or production qualification.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runWindowsNative } = require('./windows-native-job');

const MiB = 1024 * 1024, HASH = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CAPS = Object.freeze({ processCommitLimitBytes: 1024 * MiB, jobCommitLimitBytes: 1024 * MiB, timeoutMs: 3600000, maxOutputBytes: MiB, maxFileBytes: 512 * MiB, maxAggregateBytes: 1024 * MiB, maxSessionBytes: 2048 * MiB, maxInvocations: 64 });
const DEFAULTS = Object.freeze({ ...CAPS, timeoutMs: 120000 });
const PROVIDERS = { prusa: { version: '2.9.7', dependencies: ['PrusaSlicer.dll'] }, uvtools: { version: '7.1.2', dependencies: ['UVtoolsCmd.dll', 'UVtools.Core.dll'] } };
const CONTROLLED_SESSIONS = new WeakSet(), SESSION_READY = new WeakMap();
const isControlledNativeCapture = value => value !== null && typeof value === 'object' && CONTROLLED_SESSIONS.has(value) && SESSION_READY.get(value)();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_CAPTURE_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const checkSignal = signal => { if (signal?.aborted) throw fail('Controlled native capture cancelled.', 'ABORTED', 409); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function keys(value, allowed, required, label) { if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail(`Invalid ${label}.`); }
function integer(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) throw fail(`Invalid ${label}.`); return value; }
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const publicIdentity = info => Object.fromEntries(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(info[key])]));
const pathKey = value => path.resolve(value).toLowerCase();
const IMPLEMENTATION = ['resin-controlled-capture.js', 'windows-native-job.js', 'windows-native-job.ps1', 'windows-native-job.cs'].map(name => {
  const filePath = path.join(__dirname, name), bytes = syncFs.readFileSync(filePath);
  if (!bytes.length || bytes.length > 512 * 1024) throw fail('Controlled capture implementation exceeds its bound.', 'RESIN_CAPTURE_TOOL_CHANGED', 409);
  return Object.freeze({ name, filePath, sha256: hash(bytes), bytes: bytes.length });
});
async function implementationManifest() {
  const files = [];
  for (const pin of IMPLEMENTATION) { const bytes = await fs.readFile(pin.filePath); if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256) throw fail('Capture sources changed after initialization; restart.', 'RESIN_CAPTURE_TOOL_CHANGED', 409); files.push({ name: pin.name, bytes: pin.bytes, sha256: pin.sha256 }); }
  return freeze({ method: 'selected-capture-implementation-v1', files, sha256: digest(files), nodeVersion: process.versions.node, platform: process.platform, arch: process.arch });
}
function absolute(value, label) { if (typeof value !== 'string' || value.length < 1 || value.length > 4000 || /[\0\r\n]/.test(value) || !path.isAbsolute(value)) throw fail(`Use an absolute ${label}.`); return path.resolve(value); }
async function pathChain(value, directory) {
  const root = path.parse(value).root, paths = [root]; let at = root;
  for (const part of path.relative(root, value).split(path.sep).filter(Boolean)) { at = path.join(at, part); paths.push(at); }
  const chain = [];
  for (let index = 0; index < paths.length; index++) { const info = await fs.lstat(paths[index], { bigint: true }); if (info.isSymbolicLink() || (index < paths.length - 1 || directory ? !info.isDirectory() : !info.isFile()) || info.ino <= 0n) throw fail('Capture paths require regular objects and stable identities without links.', 'RESIN_CAPTURE_PATH'); chain.push({ filePath: paths[index], dev: String(info.dev), ino: String(info.ino), directory: info.isDirectory() }); }
  return chain;
}
async function verifyPathBinding(binding) {
  const a = await pathChain(binding.input, binding.directory), b = await pathChain(binding.canonical, binding.directory);
  const match = (left, right) => left.length === right.length && left.every((item, index) => item.dev === right[index].dev && item.ino === right[index].ino && item.directory === right[index].directory);
  if (!match(a, binding.inputChain) || !match(b, binding.canonicalChain) || a.at(-1).dev !== b.at(-1).dev || a.at(-1).ino !== b.at(-1).ino) throw fail('A canonical or input capture path changed identity.', 'RESIN_CAPTURE_PATH', 409);
}
async function bindLocalPath(value, directory) {
  if (!/^[a-z]:\\/i.test(value) || value.startsWith('\\\\')) throw fail('Controlled capture requires local Windows drive paths.', 'RESIN_CAPTURE_PATH');
  const input = path.resolve(value), inputChain = await pathChain(input, directory), canonicalPath = await fs.realpath(input);
  if (!/^[a-z]:\\/i.test(canonicalPath) || canonicalPath.startsWith('\\\\')) throw fail('Canonical capture paths must remain local.', 'RESIN_CAPTURE_PATH');
  const canonicalChain = await pathChain(canonicalPath, directory), binding = { input, canonical: canonicalPath, directory, inputChain, canonicalChain };
  await verifyPathBinding(binding); return binding;
}
async function localPath(value, directory) { return (await bindLocalPath(value, directory)).canonical; }
function contained(cwd, value) { const relative = path.relative(cwd, value); if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fail('Captured files must stay below the fixed work directory.', 'RESIN_CAPTURE_PATH'); }
async function readDescriptor(filePath, maximum, signal, exclusive = false) {
  checkSignal(signal); const pathBinding = await bindLocalPath(filePath, false); filePath = pathBinding.canonical;
  const before = await fs.lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > BigInt(maximum) || (exclusive && before.nlink !== 1n)) throw fail('A captured file is empty, linked or exceeds its size bound.', 'RESIN_CAPTURE_FILE', 413);
  const file = await fs.open(filePath, 'r');
  try {
    if (!same(before, await file.stat({ bigint: true }))) throw fail('A captured file changed while opening.', 'RESIN_CAPTURE_CHANGED', 409);
    const sha = createHash('sha256'), buffer = Buffer.alloc(Math.min(MiB, Number(before.size))); let position = 0;
    while (position < Number(before.size)) { checkSignal(signal); const read = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position); if (!read.bytesRead) throw fail('A captured file was truncated.', 'RESIN_CAPTURE_CHANGED', 409); position += read.bytesRead; sha.update(buffer.subarray(0, read.bytesRead)); }
    if ((await file.read(buffer, 0, 1, position)).bytesRead || !same(before, await file.stat({ bigint: true })) || !same(before, await fs.lstat(filePath, { bigint: true }))) throw fail('A captured file changed during hashing.', 'RESIN_CAPTURE_CHANGED', 409);
    await verifyPathBinding(pathBinding); checkSignal(signal);
    return freeze({ filePath, bytes: position, sha256: sha.digest('hex'), identity: publicIdentity(before), pathBinding });
  } finally { await file.close(); }
}
function sameFile(a, b) { return a.filePath === b.filePath && a.bytes === b.bytes && a.sha256 === b.sha256 && JSON.stringify(a.identity) === JSON.stringify(b.identity); }
async function absent(cwd, filePath) {
  const parentBinding = await bindLocalPath(path.dirname(filePath), true), canonicalPath = path.join(parentBinding.canonical, path.basename(filePath)); contained(cwd, canonicalPath);
  try { await fs.lstat(filePath); throw fail('A fresh capture output already exists.', 'RESIN_CAPTURE_OUTPUT_EXISTS', 409); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await verifyPathBinding(parentBinding); return { canonicalPath, parentBinding };
}
function configuration(value) {
  keys(value, ['cwd', 'providers', 'limits', 'signal'], ['cwd', 'providers'], 'capture configuration');
  const cwd = absolute(value.cwd, 'work directory');
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw fail('Use an AbortSignal for capture cancellation.');
  const limits = { ...DEFAULTS };
  if (value.limits !== undefined) { keys(value.limits, Object.keys(CAPS), [], 'capture limits'); for (const [key, item] of Object.entries(value.limits)) limits[key] = integer(item, ['processCommitLimitBytes', 'jobCommitLimitBytes'].includes(key) ? 16 * MiB : key === 'timeoutMs' ? 100 : 1, CAPS[key], key); }
  if (limits.jobCommitLimitBytes < limits.processCommitLimitBytes) throw fail('The job commit bound cannot be lower than its process bound.');
  keys(value.providers, Object.keys(PROVIDERS), Object.keys(PROVIDERS), 'provider pair');
  const providers = {};
  for (const [id, policy] of Object.entries(PROVIDERS)) {
    const item = value.providers[id]; keys(item, ['executable', 'version', 'sha256'], ['executable', 'version'], 'native provider');
    const executable = absolute(item.executable, 'provider executable');
    if (!/\.exe$/i.test(executable) || item.version !== policy.version || (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !HASH.test(item.sha256)))) throw fail('Pin PrusaSlicer 2.9.7 and UVtools 7.1.2 interfaces and valid optional executable digests.');
    providers[id] = { executable, version: item.version, ...(item.sha256 === undefined ? {} : { expectedSha256: item.sha256 }) };
  }
  return { cwd, providers, limits, signal: value.signal };
}

async function createControlledNativeCapture(options) {
  const config = configuration(options), { limits, signal } = config;
  checkSignal(signal);
  if (process.platform !== 'win32') throw fail('Controlled native capture requires the Windows Job boundary.', 'WINDOWS_NATIVE_UNSUPPORTED', 501);
  const cwdBinding = await bindLocalPath(config.cwd, true), cwd = cwdBinding.canonical, cwdIdentity = await fs.lstat(cwd, { bigint: true }), implementation = await implementationManifest(), providerPathBindings = [];
  const providerFiles = [], providerSnapshots = {};
  for (const [id, provider] of Object.entries(config.providers)) {
    const executableBinding = await bindLocalPath(provider.executable, false); providerPathBindings.push(executableBinding); provider.executable = executableBinding.canonical;
    const files = [];
    for (const [index, filename] of [provider.executable, ...PROVIDERS[id].dependencies.map(name => path.join(path.dirname(provider.executable), name))].entries()) {
      const remaining = 512 * MiB - providerFiles.reduce((n, file) => n + file.bytes, 0); if (remaining < 1) throw fail('Selected provider files exceed their aggregate bound.', 'RESIN_CAPTURE_LIMIT', 413);
      const item = await readDescriptor(filename, Math.min(256 * MiB, remaining), signal); files.push({ name: index === 0 ? id + '-executable' : path.basename(filename), ...item }); providerFiles.push(item);
    }
    if (provider.expectedSha256 && files[0].sha256 !== provider.expectedSha256) throw fail('A selected provider does not match its expected digest.', 'RESIN_CAPTURE_PROVIDER_CHANGED', 409);
    providerSnapshots[id] = { executable: provider.executable, version: provider.version, files };
  }
  if (providerFiles.reduce((n, file) => n + file.bytes, 0) > 512 * MiB) throw fail('Selected provider dependencies exceed their combined bound.', 'RESIN_CAPTURE_LIMIT', 413);
  const fingerprint = digest(Object.fromEntries(Object.entries(providerSnapshots).map(([id, provider]) => [id, { version: provider.version, files: provider.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }])));
  const providerManifest = freeze({ schemaVersion: 1, providers: providerSnapshots, sha256: fingerprint, scope: 'configured executable plus selected mandatory DLLs; interface version verified by controlled calls; not publisher authentication or full transitive runtime closure' });
  const invocations = [], branded = new WeakSet(), ids = new Set(), owned = new Map(), immutable = new Map();
  let tail = Promise.resolve(), closePromise, closing = false, closed = false, tainted = false;
  const enqueue = operation => { const result = tail.then(operation); tail = result.catch(() => {}); return result; };
  const check = () => { checkSignal(signal); if (closed) throw fail('The capture session is closed.', 'RESIN_CAPTURE_CLOSED', 409); if (tainted) throw fail('A failed capture cannot be reused.', 'RESIN_CAPTURE_TAINTED', 409); };
  const verifyWorkRoot = async () => { await verifyPathBinding(cwdBinding); const now = await fs.lstat(cwd, { bigint: true }); if (now.dev !== cwdIdentity.dev || now.ino !== cwdIdentity.ino) throw fail('The managed capture work directory changed identity.', 'RESIN_CAPTURE_CHANGED', 409); };
  const physicalContainment = binding => { if (!binding.canonicalChain.some(item => item.directory && item.dev === String(cwdIdentity.dev) && item.ino === String(cwdIdentity.ino))) throw fail('A captured path is not physically below the managed work directory.', 'RESIN_CAPTURE_PATH'); };
  async function verifyProviders() {
    await verifyWorkRoot(); await implementationManifest(); for (const binding of providerPathBindings) await verifyPathBinding(binding);
    for (const item of providerFiles) if (!sameFile(item, await readDescriptor(item.filePath, 256 * MiB, signal))) throw fail('A selected provider executable or dependency changed.', 'RESIN_CAPTURE_PROVIDER_CHANGED', 409);
  }
  function descriptor(item, label) {
    keys(item, ['id', 'filePath', 'maxBytes', 'expectedSha256'], ['id', 'filePath'], label);
    if (typeof item.id !== 'string' || !ID.test(item.id) || (item.expectedSha256 !== undefined && (typeof item.expectedSha256 !== 'string' || !HASH.test(item.expectedSha256)))) throw fail('Use bounded file identities and SHA-256 digests.');
    const filePath = absolute(item.filePath, 'captured file');
    return { id: item.id, filePath, maxBytes: item.maxBytes === undefined ? limits.maxFileBytes : integer(item.maxBytes, 1, limits.maxFileBytes, 'file size bound'), ...(item.expectedSha256 === undefined ? {} : { expectedSha256: item.expectedSha256 }) };
  }
  function invocationSpec(value, internal) {
    if (ids.size >= limits.maxInvocations) throw fail('Capture session exceeds its reserved invocation count.', 'RESIN_CAPTURE_LIMIT', 413);
    keys(value, ['id', 'provider', 'argv', 'inputs', 'outputs', 'mutations', 'timeoutMs'], ['id', 'provider', 'argv', 'inputs', 'outputs'], 'native invocation');
    if (typeof value.id !== 'string' || !ID.test(value.id) || (!internal && value.id.startsWith('probe-')) || ids.has(value.id) || !Object.hasOwn(PROVIDERS, value.provider)) throw fail('Use a unique invocation ID and a selected provider.');
    if (!Array.isArray(value.argv) || value.argv.length > 512 || value.argv.some(arg => typeof arg !== 'string' || arg.length > 16384 || arg.includes('\0'))) throw fail('Use bounded literal native arguments.');
    const paths = new Set(), fileIds = new Set(), lists = {};
    for (const name of ['inputs', 'outputs', 'mutations']) {
      const list = value[name] === undefined && name === 'mutations' ? [] : value[name];
      if (!Array.isArray(list) || list.length > 64) throw fail('Use bounded explicit invocation file lists.');
      lists[name] = Array.from(list, item => { const file = descriptor(item, name); if (paths.has(pathKey(file.filePath)) || fileIds.has(file.id)) throw fail('A native call cannot alias file paths or file IDs.'); paths.add(pathKey(file.filePath)); fileIds.add(file.id); return file; });
    }
    if (lists.inputs.length + lists.outputs.length + lists.mutations.length > 64) throw fail('A native invocation exceeds its file count bound.', 'RESIN_CAPTURE_LIMIT', 413);
    return { id: value.id, provider: value.provider, argv: [...value.argv], ...lists, timeoutMs: value.timeoutMs === undefined ? limits.timeoutMs : integer(value.timeoutMs, 100, limits.timeoutMs, 'invocation timeout') };
  }
  const total = files => { const bytes = files.reduce((n, item) => n + item.bytes, 0); if (!Number.isSafeInteger(bytes) || bytes > limits.maxAggregateBytes) throw fail('Captured invocation files exceed their aggregate bound.', 'RESIN_CAPTURE_LIMIT', 413); return bytes; };
  const maximumRemaining = (maximum, used) => { const remaining = limits.maxAggregateBytes - used; if (remaining < 1) throw fail('Captured invocation files exceed their aggregate bound.', 'RESIN_CAPTURE_LIMIT', 413); return Math.min(maximum, remaining); };
  async function unchanged(files) { for (const item of files) { await verifyPathBinding(item.pathBinding); if (!sameFile(item, await readDescriptor(item.filePath, item.maximum, signal, Boolean(item.owned)))) throw fail('An immutable capture input changed.', 'RESIN_CAPTURE_CHANGED', 409); } }
  const sessionBytes = () => { const files = new Map([...immutable, ...owned]); return [...files.values()].reduce((n, item) => n + item.bytes, 0); };
  async function execute(snapshot) {
    check(); const spec = { ...snapshot, inputs: [], outputs: [], mutations: [] }, canonicalPaths = new Set();
    for (const name of ['inputs', 'outputs', 'mutations']) for (const file of snapshot[name]) {
      const binding = name === 'outputs' ? await absent(cwd, file.filePath) : await bindLocalPath(file.filePath, false), filename = name === 'outputs' ? binding.canonicalPath : binding.canonical;
      physicalContainment(name === 'outputs' ? binding.parentBinding : binding);
      contained(cwd, filename); if (canonicalPaths.has(pathKey(filename))) throw fail('Native file aliases refer to the same captured object.', 'RESIN_CAPTURE_PATH'); canonicalPaths.add(pathKey(filename));
      spec[name].push({ ...file, requestedFilePath: file.filePath, filePath: filename, ...(name === 'outputs' ? { parentBinding: binding.parentBinding } : {}) });
    }
    if (invocations.length >= limits.maxInvocations) throw fail('Capture session exceeds its invocation count.', 'RESIN_CAPTURE_LIMIT', 413);
    await verifyProviders(); await unchanged([...immutable.values(), ...owned.values()]);
    const before = [], mutationBefore = []; let beforeBytes = 0;
    for (const file of spec.inputs) {
      const item = { ...await readDescriptor(file.requestedFilePath, maximumRemaining(file.maxBytes, beforeBytes), signal), id: file.id, maximum: file.maxBytes, owned: owned.has(pathKey(file.filePath)) }; beforeBytes += item.bytes;
      if (file.expectedSha256 && item.sha256 !== file.expectedSha256) throw fail('An invocation input does not match its expected digest.', 'RESIN_CAPTURE_CHANGED', 409);
      before.push(item);
    }
    for (const file of spec.mutations) {
      const previous = owned.get(pathKey(file.filePath));
      if (!previous) throw fail('Only a previous successful output of this session may be mutated.', 'RESIN_CAPTURE_MUTATION', 409);
      const item = { ...await readDescriptor(file.requestedFilePath, maximumRemaining(file.maxBytes, beforeBytes), signal, true), id: file.id, maximum: file.maxBytes, owned: true }; beforeBytes += item.bytes;
      if (!sameFile(previous, item) || (file.expectedSha256 && item.sha256 !== file.expectedSha256)) throw fail('An owned mutation target changed.', 'RESIN_CAPTURE_CHANGED', 409);
      mutationBefore.push(item);
    }
    for (const file of spec.outputs) await absent(cwd, file.filePath);
    const declaredPaths = new Set([...spec.inputs, ...spec.outputs, ...spec.mutations].map(item => pathKey(item.filePath))), argumentDirectories = [];
    for (const argument of spec.argv) {
      if (/(?:^|[=\\/])\.\.(?:[\\/]|$)/.test(argument)) throw fail('Native arguments cannot escape through relative parent paths.', 'RESIN_CAPTURE_PATH');
      if (!path.isAbsolute(argument)) continue;
      const requested = absolute(argument, 'native argument path'); let filename, directory = false, binding;
      try { const info = await fs.lstat(requested); directory = info.isDirectory(); binding = await bindLocalPath(requested, directory); filename = binding.canonical; }
      catch (error) { if (error.code !== 'ENOENT') throw error; const fresh = await absent(cwd, requested); filename = fresh.canonicalPath; binding = fresh.parentBinding; }
      contained(cwd, filename);
      physicalContainment(binding);
      if (!declaredPaths.has(pathKey(filename))) {
        if (!directory) throw fail('Every absolute native file argument must appear in the declared capture files.', 'RESIN_CAPTURE_PATH');
        if ((await fs.readdir(filename)).length) throw fail('Undeclared native directory arguments must be fresh empty managed directories.', 'RESIN_CAPTURE_PATH');
        argumentDirectories.push({ filePath: filename, identity: publicIdentity(await fs.lstat(filename, { bigint: true })), pathBinding: binding });
      }
    }
    total([...before, ...mutationBefore]);
    if (sessionBytes() + before.filter(item => !immutable.has(pathKey(item.filePath)) && !owned.has(pathKey(item.filePath))).reduce((n, item) => n + item.bytes, 0) > limits.maxSessionBytes) throw fail('The capture session exceeds its tracked-file bound.', 'RESIN_CAPTURE_LIMIT', 413);
    const startedAt = new Date().toISOString(); let native, caught, launched = false;
    try {
      check(); launched = true;
      native = await runWindowsNative(config.providers[spec.provider].executable, spec.argv, { cwd, timeoutMs: spec.timeoutMs, maxOutputBytes: limits.maxOutputBytes, processCommitLimitBytes: limits.processCommitLimitBytes, jobCommitLimitBytes: limits.jobCommitLimitBytes, signal, env: { DOTNET_PROCESSOR_COUNT: '1', OPENCV_FOR_THREADS_NUM: '1' } });
      if (Buffer.byteLength(native.stdout) > limits.maxOutputBytes || Buffer.byteLength(native.stderr) > limits.maxOutputBytes) throw fail('Decoded native text exceeds its output bound.', 'RESIN_CAPTURE_OUTPUT_LIMIT', 413);
      if (native.code !== 0) throw Object.assign(fail('The native provider returned a nonzero code.', 'RESIN_CAPTURE_NATIVE_EXIT', 502), { nativeCode: native.code });
      const receipt = native.resourceReceipt;
      if (receipt?.method !== 'windows-job-object-v1' || receipt.assignedAtCreation !== true || receipt.assignedBeforeResume !== true || receipt.killOnJobClose !== true || receipt.descendantsTerminatedOnCompletion !== true || receipt.stopReason !== null || receipt.outputLimitExceeded !== false || receipt.processCommitLimitBytes !== limits.processCommitLimitBytes || receipt.jobCommitLimitBytes !== limits.jobCommitLimitBytes) throw fail('The real native runner returned an invalid resource receipt.', 'RESIN_CAPTURE_RECEIPT', 502);
      for (const pin of IMPLEMENTATION.filter(item => item.name !== 'resin-controlled-capture.js')) if (!receipt.supervisorManifest?.files.some(file => file.name === pin.name && file.sha256 === pin.sha256 && file.bytes === pin.bytes)) throw fail('The native receipt names a different supervisor implementation.', 'RESIN_CAPTURE_RECEIPT', 502);
      await verifyProviders(); await unchanged(before);
      for (const item of argumentDirectories) await verifyPathBinding(item.pathBinding);
      for (const file of spec.outputs) await verifyPathBinding(file.parentBinding);
      const after = []; let afterBytes = before.reduce((n, item) => n + item.bytes, 0);
      for (const file of [...spec.outputs, ...spec.mutations]) { const item = { ...await readDescriptor(file.requestedFilePath, maximumRemaining(file.maxBytes, afterBytes), signal, true), id: file.id, maximum: file.maxBytes, owned: true }; afterBytes += item.bytes; if (spec.outputs.includes(file) && file.expectedSha256 && item.sha256 !== file.expectedSha256) throw fail('A native output does not match its declared digest.', 'RESIN_CAPTURE_CHANGED', 409); after.push(item); }
      total([...before, ...after]);
      const nextOwned = new Map(owned); for (const item of after) nextOwned.set(pathKey(item.filePath), item);
      const nextInputs = new Map(immutable); for (const item of before) if (!item.owned) nextInputs.set(pathKey(item.filePath), item);
      const combined = new Map([...nextInputs, ...nextOwned]); if ([...combined.values()].reduce((n, item) => n + item.bytes, 0) > limits.maxSessionBytes) throw fail('Native outputs exceed the session tracked-file bound.', 'RESIN_CAPTURE_LIMIT', 413);
      for (const item of before) if (!item.owned) immutable.set(pathKey(item.filePath), item); for (const item of after) owned.set(pathKey(item.filePath), item);
      const record = { schemaVersion: 1, method: 'controlled-windows-provider-capture-v1', id: spec.id, status: 'succeeded', controlledExecution: true, nativeInvocationAttested: false, provider: spec.provider, providerManifestSha256: providerManifest.sha256, providerVerification: { before: true, after: true }, implementation, executable: config.providers[spec.provider].executable, version: config.providers[spec.provider].version, cwd, argv: spec.argv, argumentDirectories, startedAt, finishedAt: new Date().toISOString(), inputsBefore: before, inputsAfter: before, mutationsBefore: mutationBefore, outputsAfter: after, stdout: { bytes: Buffer.byteLength(native.stdout), sha256: hash(native.stdout) }, stderr: { bytes: Buffer.byteLength(native.stderr), sha256: hash(native.stderr) }, resourceReceipt: receipt, scope: 'actual controlled call over configured selected provider bytes and declared file list; not publisher authentication, complete dependencies, or production qualification' };
      record.sha256 = digest(record); freeze(record); invocations.push(record); branded.add(record);
      return Object.freeze({ stdout: native.stdout, stderr: native.stderr, invocation: record });
    } catch (error) {
      caught = error; if (launched) tainted = true;
      if (signal?.aborted) caught = fail('Controlled native capture cancelled.', 'ABORTED', 409);
      else { try { await verifyProviders(); } catch (changed) { caught = changed; } }
      const observationBudget = { used: 0 }, observe = async files => {
        if (signal?.aborted) return { status: 'unavailable-after-cancellation', files: [] };
        const observed = [];
        for (const file of files) { try { const item = await readDescriptor(file.requestedFilePath || file.filePath, maximumRemaining(file.maxBytes || file.maximum, observationBudget.used), signal, false); observationBudget.used += item.bytes; observed.push({ id: file.id, ...item }); } catch (failure) { observed.push({ id: file.id, filePath: file.filePath, errorCode: failure.code || 'RESIN_CAPTURE_OBSERVATION_FAILED' }); } }
        return { status: 'bounded-post-call-observation', files: observed };
      };
      const inputsAfter = await observe([...before, ...mutationBefore]), outputsAfter = await observe([...spec.outputs, ...spec.mutations]);
      const record = freeze({ schemaVersion: 1, method: 'controlled-windows-provider-capture-v1', id: spec.id, status: 'failed', controlledExecution: Boolean(native || error.resourceReceipt), nativeInvocationAttested: false, provider: spec.provider, providerManifestSha256: providerManifest.sha256, executable: config.providers[spec.provider].executable, version: config.providers[spec.provider].version, cwd, argv: spec.argv, startedAt, finishedAt: new Date().toISOString(), inputsBefore: before, mutationsBefore: mutationBefore, inputsAfter, outputsAfter, ...(native ? { nativeCode: native.code, stdout: { bytes: Buffer.byteLength(native.stdout), sha256: hash(native.stdout) }, stderr: { bytes: Buffer.byteLength(native.stderr), sha256: hash(native.stderr) } } : {}), error: { code: caught.code || 'RESIN_CAPTURE_FAILED', message: caught.message }, ...(native?.resourceReceipt || error.resourceReceipt ? { resourceReceipt: native?.resourceReceipt || error.resourceReceipt } : {}) });
      invocations.push(record); caught.invocation = record; throw caught;
    }
  }
  const api = Object.freeze({
    invoke(value) { if (closing || closed) return Promise.reject(fail('The capture session is closing.', 'RESIN_CAPTURE_CLOSED', 409)); let spec; try { spec = invocationSpec(value, false); ids.add(spec.id); } catch (error) { return Promise.reject(error); } return enqueue(() => execute(spec)); },
    getInvocations() { return Object.freeze([...invocations]); },
    getProviderManifest() { return providerManifest; },
    getImplementationManifest() { return implementation; },
    ownsInvocation(value) { return value !== null && typeof value === 'object' && branded.has(value); },
    close() { if (closePromise) return closePromise; closing = true; closePromise = enqueue(async () => { try { await verifyProviders(); await unchanged([...immutable.values(), ...owned.values()]); } finally { closed = true; } }); return closePromise; },
  });
  for (const [id, argv] of [['prusa', ['--help']], ['uvtools', ['--core-version']]]) {
    const spec = invocationSpec({ id: 'probe-' + id + '-version', provider: id, argv, inputs: [], outputs: [], timeoutMs: Math.min(15000, limits.timeoutMs) }, true); ids.add(spec.id); const result = await execute(spec);
    if (id === 'prusa' ? !/^PrusaSlicer-2\.9\.7(?:\s|$)/m.test(result.stdout) || !result.stdout.includes('--export-sla') : result.stdout.trim() !== '7.1.2') throw fail('A configured provider did not expose its pinned native interface.', 'RESIN_CAPTURE_PROVIDER_VERSION', 409);
  }
  CONTROLLED_SESSIONS.add(api); SESSION_READY.set(api, () => !closing && !closed && !tainted);
  return api;
}

module.exports = { createControlledNativeCapture, isControlledNativeCapture, RESIN_CONTROLLED_CAPTURE_LIMITS: CAPS };
