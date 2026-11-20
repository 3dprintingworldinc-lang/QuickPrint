'use strict';

// Controlled local preparation only. Native execution, source-bound raster
// conformance and physical printer qualification are separate claims.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { performance } = require('node:perf_hooks');
const { prepareResinGeometry } = require('./resin-geometry');
const { auditResinMesh } = require('./resin-mesh');
const { loadProfile, parseIni, inspectSl1, parameterScript, parseIssueReport, assertTargetProperties } = require('./resin-engine');
const { assertPackedEffectiveSettings } = require('./resin-plate-engine');
const { projectPrusaSlaPreset } = require('./resin-hollow-preset');
const { prepareResinHollowPlan } = require('./resin-hollow-plan');
const { prepareResinHollowSupports } = require('./resin-hollow-supports');
const { prepareResinHollowInputs } = require('./resin-hollow-inputs');
const { planResinHollowResolution } = require('./resin-hollow-resolution');
const { createControlledNativeCapture } = require('./resin-controlled-capture');
const { auditResinHollowFinal, verifyResinHollowFinalAudit } = require('./resin-hollow-final-audit');
const { scanResinGooFile } = require('./resin-hollow-raster');
const { inspectZip, readZipEntry } = require('./psam/zip-inspection');
const { resolveHollowGridWorkerPath } = require('./resin-hollow-grid-async');
const { resolveHollowFinalGridWorkerPath } = require('./resin-hollow-final-grid-async');

const MiB = 1024 * 1024, HASH = /^[a-f0-9]{64}$/, ROLES = ['final', 'hollow', 'solid'];
const MAX_SOURCE = 100 * MiB, MAX_MESH = 84 + 250000 * 50, MAX_GOO = 512 * MiB, MAX_RECORD = 8 * MiB;
const METHOD = 'controlled-source-bound-resin-hollow-v1';
const VERIFIED = new WeakMap();
const CHECKS = ['--islands', '--resin-traps', '--suction-cups', '--touching-bounds', '--print-height', '--empty-layers'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const zeros = value => typeof value === 'number' && value === 0 ? 0 : Array.isArray(value) ? value.map(zeros) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, zeros(item)])) : value;
const fail = (message, code = 'RESIN_HOLLOW_ENGINE_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const withoutSha = value => { const result = { ...value }; delete result.sha256; return result; };
const serializeIni = map => Buffer.from(Object.keys(map).sort().map(key => `${key} = ${map[key]}\n`).join(''));
const sameStat = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
function keys(value, allowed, required, label) { if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail(`Invalid ${label}.`); }
function absolute(value, label) { if (typeof value !== 'string' || !value.length || value.length > 4000 || /[\0\r\n]/.test(value) || !path.isAbsolute(value)) throw fail(`Use an absolute ${label}.`); return path.resolve(value); }
function contained(root, file) { const relative = path.relative(root, file); if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fail('Hollow artifacts must stay below their managed directory.', 'RESIN_HOLLOW_PATH', 409); }
async function local(file, directory) {
  const input = path.resolve(file), root = path.parse(input).root;
  const chain = async value => {
    let at = path.parse(value).root; const paths = [at];
    for (const part of path.relative(at, value).split(path.sep).filter(Boolean)) { at = path.join(at, part); paths.push(at); }
    for (let i = 0; i < paths.length; i++) { const info = await fs.lstat(paths[i], { bigint: true }); if (info.isSymbolicLink() || (i < paths.length - 1 || directory ? !info.isDirectory() : !info.isFile()) || info.ino <= 0n) throw fail('Hollow files require ordinary nonlinked paths.', 'RESIN_HOLLOW_PATH', 409); }
  };
  await chain(input); const resolved = await fs.realpath(input); await chain(resolved);
  const a = await fs.lstat(input, { bigint: true }), b = await fs.lstat(resolved, { bigint: true });
  if (!root || a.dev !== b.dev || a.ino !== b.ino) throw fail('A hollow path changed canonical identity.', 'RESIN_HOLLOW_PATH', 409);
  return resolved;
}
async function directory(value) {
  const requested = absolute(value, 'output directory'); let existing = requested;
  for (;;) { try { await fs.lstat(existing); break; } catch (error) { if (error.code !== 'ENOENT' || path.dirname(existing) === existing) throw error; existing = path.dirname(existing); } }
  await local(existing, true); await fs.mkdir(requested, { recursive: true }); return local(requested, true);
}
async function readFile(filePath, maximum, { root, expected, bytes = false, empty = false, signal } = {}) {
  if (signal?.aborted) throw fail('Hollow preparation cancelled.', 'ABORTED', 409);
  filePath = absolute(filePath, 'artifact file'); if (root) contained(root, filePath);
  const actualPath = await local(filePath, false); if (root) contained(root, actualPath);
  const before = await fs.lstat(filePath, { bigint: true });
  if (before.size < BigInt(empty ? 0 : 1) || before.size > BigInt(maximum)) throw fail('A hollow artifact exceeds its file bound.', 'RESIN_HOLLOW_FILE_LIMIT', 413);
  const file = await fs.open(filePath, 'r'), sha = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(MiB, Math.max(1, Number(before.size)))), chunks = bytes ? [] : null; let count = 0;
  try {
    if (!sameStat(before, await file.stat({ bigint: true }))) throw fail('A hollow artifact changed while opening.', 'RESIN_HOLLOW_CHANGED', 409);
    while (count < Number(before.size)) { if (signal?.aborted) throw fail('Hollow preparation cancelled.', 'ABORTED', 409); const read = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) - count), count); if (!read.bytesRead) throw fail('A hollow artifact was truncated.', 'RESIN_HOLLOW_CHANGED', 409); sha.update(buffer.subarray(0, read.bytesRead)); if (chunks) chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead))); count += read.bytesRead; }
    if ((await file.read(buffer, 0, 1, count)).bytesRead || !sameStat(before, await file.stat({ bigint: true })) || !sameStat(before, await fs.lstat(filePath, { bigint: true }))) throw fail('A hollow artifact changed during reading.', 'RESIN_HOLLOW_CHANGED', 409);
    const descriptor = { filePath: actualPath, bytes: count, sha256: sha.digest('hex') };
    if (expected && (expected.bytes !== descriptor.bytes || expected.sha256 !== descriptor.sha256 || path.resolve(expected.filePath).toLowerCase() !== actualPath.toLowerCase())) throw fail('A hollow artifact differs from its frozen descriptor.', 'RESIN_HOLLOW_CHANGED', 409);
    await local(filePath, false); return { descriptor, ...(chunks ? { bytes: Buffer.concat(chunks, count) } : {}) };
  } finally { await file.close(); }
}
async function put(filePath, bytes) { await fs.writeFile(filePath, bytes, { flag: 'wx' }); return { filePath, bytes: bytes.length, sha256: hash(bytes) }; }
const json = value => Buffer.from(JSON.stringify(value, null, 2));
const ZIP_LIMITS = { maxArchiveBytes: MAX_GOO, maxEntryBytes: 128 * MiB, maxTotalUncompressedBytes: 1024 * MiB, maxEntries: 25010, maxCompressionRatio: 10000 };
function effectiveFromSl1(bytes) { const archive = inspectZip(bytes, ZIP_LIMITS), entry = archive.entries.find(item => item.name === 'prusaslicer.ini'); if (!entry || entry.uncompressedSize > MiB) throw fail('Missing bounded native effective SLA preset.', 'RESIN_HOLLOW_EFFECTIVE_MISMATCH', 502); return readZipEntry(bytes, entry, ZIP_LIMITS); }

const workerSources = () => [
  ...['resin-hollow-grid-worker.js', 'resin-hollow-grid.js'].map(name => ({ name, filePath: path.join(path.dirname(resolveHollowGridWorkerPath()), name) })),
  ...['resin-hollow-final-grid-worker.js', 'resin-hollow-final-grid.js'].map(name => ({ name, filePath: path.join(path.dirname(resolveHollowFinalGridWorkerPath()), name) }))
];
const SOURCE_PIN = [
  ...['resin-hollow-engine.js', 'resin-controlled-capture.js', 'windows-native-job.js', 'windows-native-job.ps1', 'windows-native-job.cs',
    'resin-hollow-inputs.js', 'resin-hollow-preset.js', 'resin-hollow-resolution.js', 'resin-hollow-plan.js', 'resin-hollow-supports.js',
    'resin-hollow-audit.js', 'resin-hollow-final-audit.js', 'resin-hollow-raster.js', 'resin-hollow-grid-async.js', 'resin-hollow-final-grid-async.js',
    'resin-geometry.js', 'resin-mesh.js', 'resin-plate.js', 'resin-plate-engine.js', 'resin-engine.js', 'resin-profiles.js', 'psam/zip-inspection.js']
    .map(name => ({ name, filePath: path.join(__dirname, name) })), ...workerSources()
].map(item => { const bytes = syncFs.readFileSync(item.filePath); if (!bytes.length || bytes.length > MiB) throw fail('Hollow implementation exceeds its source bound.'); return Object.freeze({ ...item, bytes: bytes.length, sha256: hash(bytes) }); });
async function implementationManifest() {
  const files = [];
  for (const pin of SOURCE_PIN) { const bytes = await fs.readFile(pin.filePath); if (bytes.length !== pin.bytes || hash(bytes) !== pin.sha256) throw fail('Hollow implementation changed after initialization; restart.', 'RESIN_HOLLOW_TOOL_CHANGED', 409); files.push({ name: pin.name, bytes: pin.bytes, sha256: pin.sha256 }); }
  return { files, nodeVersion: process.versions.node, v8Version: process.versions.v8, platform: process.platform, arch: process.arch, sha256: digest(files) };
}
function toolFor(providerManifest, implementation, supervisorFiles) {
  const binaryManifest = [
    ...Object.entries(providerManifest.providers).flatMap(([id, provider]) => provider.files.map(item => ({ name: id + '/' + item.name, bytes: item.bytes, sha256: item.sha256 }))),
    ...implementation.files.map(item => ({ ...item, name: 'policy/' + item.name })),
    ...supervisorFiles.filter(item => item.name === 'windows-powershell.exe').map(item => ({ ...item, name: 'supervisor/' + item.name }))
  ].sort((a, b) => a.name.localeCompare(b.name));
  return { name: 'Controlled PrusaSlicer hollow SLA + UVtools', version: '2.9.7 / 7.1.2 / hollow-v1', executableSha256: digest({ binaryManifest, runtime: { node: implementation.nodeVersion, v8: implementation.v8Version, platform: implementation.platform, arch: implementation.arch } }), binaryManifest };
}
function configuration(options) {
  const required = ['inputPath', 'outputDir', 'profilePath', 'prusaExecutable', 'uvtoolsExecutable', 'hollowRequest', 'supportRequest', 'resolutionRequest'];
  keys(options, [...required, 'unitScale', 'sizing', 'boundaryPolicy', 'placement', 'signal', 'timeoutMs'], required, 'controlled hollow request');
  const result = { ...options };
  for (const key of ['inputPath', 'outputDir', 'profilePath', 'prusaExecutable', 'uvtoolsExecutable']) result[key] = absolute(result[key], key);
  if (!/\.(stl|obj)$/i.test(result.inputPath)) throw fail('Controlled hollow preparation accepts sized STL/OBJ source inputs.', 'RESIN_MODEL_FORMAT');
  result.unitScale ??= 1; if (![1, 25.4, 1000].includes(result.unitScale)) throw fail('Declare model units as mm, inches or metres.', 'RESIN_MODEL_UNITS');
  result.timeoutMs ??= 900000; if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1000 || result.timeoutMs > 3600000) throw fail('Use a bounded one-second to one-hour preparation deadline.');
  if (result.signal !== undefined && !(result.signal instanceof AbortSignal)) throw fail('Use an AbortSignal for cancellation.');
  if (result.signal?.aborted) throw fail('Hollow preparation cancelled.', 'ABORTED', 409);
  result.boundaryPolicy ??= 'voxel-enclosure'; if (!['exact-raster', 'voxel-enclosure'].includes(result.boundaryPolicy)) throw fail('Declare a supported outer boundary policy.');
  keys(result.hollowRequest, ['orientation', 'wallThicknessMm', 'quality', 'closingDistanceMm', 'drains'], ['orientation', 'wallThicknessMm', 'quality', 'closingDistanceMm', 'drains'], 'hollow request');
  keys(result.supportRequest, ['mode', 'clearanceMm', 'points', 'regions'], ['mode', 'clearanceMm', 'points', 'regions'], 'support request');
  keys(result.resolutionRequest, ['maximumUncertaintyMm', 'minimumPitchMm', 'reduction', 'maxCells', 'maxWorkingBytes'], ['maximumUncertaintyMm'], 'resolution request');
  if (!['none', 'automatic', 'points'].includes(result.supportRequest.mode) || typeof result.supportRequest.clearanceMm !== 'number' || !Number.isFinite(result.supportRequest.clearanceMm) || result.supportRequest.clearanceMm < 0 || result.supportRequest.clearanceMm > 100 || !Array.isArray(result.supportRequest.points) || result.supportRequest.points.length > 512 || !Array.isArray(result.supportRequest.regions) || result.supportRequest.regions.length > 512 || !Array.isArray(result.hollowRequest.drains) || result.hollowRequest.drains.length < 1 || result.hollowRequest.drains.length > 64) throw fail('Declare a bounded support and drain request.');
  if ((result.supportRequest.mode === 'points') !== Boolean(result.supportRequest.points.length) || (result.supportRequest.mode === 'automatic' && !result.supportRequest.regions.length) || (result.supportRequest.mode === 'none' && result.supportRequest.regions.length)) throw fail('Support contacts and regions must match the declared mode.');
  const resolution = result.resolutionRequest;
  if (typeof resolution.maximumUncertaintyMm !== 'number' || !Number.isFinite(resolution.maximumUncertaintyMm) || resolution.maximumUncertaintyMm <= 0 || (resolution.maxCells !== undefined && (!Number.isSafeInteger(resolution.maxCells) || resolution.maxCells < 1 || resolution.maxCells > 20000000)) || (resolution.maxWorkingBytes !== undefined && (!Number.isSafeInteger(resolution.maxWorkingBytes) || resolution.maxWorkingBytes < 1 || resolution.maxWorkingBytes > 768 * MiB))) throw fail('Declare bounded prior resolution limits.');
  if (resolution.minimumPitchMm !== undefined) { keys(resolution.minimumPitchMm, ['x', 'y', 'z'], ['x', 'y', 'z'], 'minimum pitch'); if (Object.values(resolution.minimumPitchMm).some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10000)) throw fail('Declare positive finite minimum pitches.'); }
  if (resolution.reduction !== undefined) { keys(resolution.reduction, ['x', 'y', 'z'], ['x', 'y', 'z'], 'fixed reduction'); if (resolution.minimumPitchMm !== undefined || Object.values(resolution.reduction).some(value => !Number.isSafeInteger(value) || value < 1 || value > 512)) throw fail('Declare one fixed integer reduction without a minimum-pitch search.'); }
  result.sizing = zeros(structuredClone(result.sizing ?? { mode: 'original' }));
  result.hollowRequest = zeros(structuredClone(result.hollowRequest)); result.supportRequest = zeros(structuredClone(result.supportRequest)); result.resolutionRequest = zeros(structuredClone(result.resolutionRequest));
  if (result.placement !== undefined) result.placement = zeros(structuredClone(result.placement));
  return result;
}
function resolveInputs(source, plan, binding, savedPreset, profileSha256, request, targetProperties) {
  const command = { ...parseIni(savedPreset.toString('utf8')), ...plan.native.presetOverrides };
  const finalPreset = projectPrusaSlaPreset(serializeIni(command)).effectivePreset;
  const support = prepareResinHollowSupports(source, plan, binding, finalPreset, request.supportRequest).plan;
  const ini = parseIni(finalPreset.toString('utf8'));
  const geometry = { resolutionX: Number(ini.display_pixels_x), resolutionY: Number(ini.display_pixels_y), displayWidthMm: Number(ini.display_width), displayHeightMm: Number(ini.display_height), machineZMm: Number(ini.max_print_height), layerHeightMm: Number(ini.layer_height) };
  const effectiveResolutionRequest = { maxCells: 12000000, ...request.resolutionRequest };
  const resolution = planResinHollowResolution({ geometry, sourceBoundsMm: { minMm: { x: 0, y: 0, z: 0 }, maxMm: plan.canonical.dimensionsMm }, supportEnvelope: support.geometry.supportEnvelope, modelElevationMm: support.geometry.modelElevationMm, wallThicknessMm: plan.request.wallThicknessMm, drains: plan.request.drains, request: effectiveResolutionRequest });
  const prepared = prepareResinHollowInputs({ source, plan, expectedBinding: binding, preset: savedPreset, profileSha256, supportRequest: request.supportRequest, targetProperties, policy: { ...resolution.policy, boundaryPolicy: request.boundaryPolicy }, ...(request.placement === undefined ? {} : { placement: request.placement }) });
  return { ...prepared, resolution, effectiveResolutionRequest };
}
function commandsFor(root, roles, planSha256, initialInputs, timeoutMs) {
  const commands = [];
  for (const role of ROLES) {
    const item = roles[role], input = (id, descriptor, maximum, expected = true) => ({ id: role + '-' + id, filePath: descriptor.filePath, maxBytes: maximum, ...(expected && descriptor.sha256 ? { expectedSha256: descriptor.sha256 } : {}) });
    commands.push({ id: role + '-slice', provider: 'prusa', argv: ['--load', item.commandPreset.filePath, '--config-compatibility', 'disable', '--dont-arrange', '--no-ensure-on-bed', '--scale', '1', '--threads', '1', '--datadir', path.join(root, role, 'data'), '--export-sla', '--output', item.sl1.filePath, item.input3mf.filePath],
      inputs: role === 'final' ? [...initialInputs, { id: 'frozen-command-plan', filePath: path.join(root, 'command-plan.json'), maxBytes: MAX_RECORD }] : [input('input', item.input3mf, 32 * MiB), input('preset', item.commandPreset, MiB)], outputs: [input('sl1', item.sl1, MAX_GOO, false)] });
    commands.push({ id: role + '-convert', provider: 'uvtools', argv: ['--quiet', 'convert', item.sl1.filePath, 'GooFile', item.artifact.filePath, '--no-overwrite'], inputs: [input('sl1', item.sl1, MAX_GOO, false)], outputs: [input('goo', item.artifact, MAX_GOO, false)] });
    commands.push({ id: role + '-parameters', provider: 'uvtools', argv: ['--quiet', 'run', item.artifact.filePath, item.parameterScript.filePath], inputs: [input('script', item.parameterScript, MiB)], mutations: [input('goo', item.artifact, MAX_GOO, false)], outputs: [{ ...input('receipt', item.parameterReceipt, 1024, false), expectedSha256: hash(planSha256) }] });
    commands.push({ id: role + '-issues', provider: 'uvtools', argv: ['--quiet', 'print-issues', item.artifact.filePath, ...CHECKS], inputs: [input('goo', item.artifact, MAX_GOO, false)], outputs: [] });
  }
  return commands.map(command => ({ ...command, timeoutMs }));
}
function auditOptions(record, source, buffers, signal) {
  const reference = role => ({ filePath: record.roles[role].artifact.filePath, sha256: record.roles[role].artifact.sha256, input3mf: buffers[role].input3mf, effectivePreset: buffers[role].effectivePreset });
  const actualCropLimits = record.resolution.actualCropLimits ?? record.resolution.request;
  const scan = { maxCells: actualCropLimits.maxCells }, grid = { maxVoxels: actualCropLimits.maxCells, maxWorkingBytes: actualCropLimits.maxWorkingBytes, maxTimeMs: record.nativeBounds.auditGridTimeoutMs };
  return { source, plan: record.inputs.hollowPlan, expectedBinding: record.inputs.sourceBinding, solid: reference('solid'), hollow: reference('hollow'), final: reference('final'), supports: { plan: record.inputs.supportPlan, preset: buffers.final.effectivePreset },
    provider: { name: 'PrusaSlicer', version: '2.9.7', sha256: record.providerManifest.providers.prusa.files[0].sha256 }, targetProperties: record.inputs.targetProperties, placement: record.inputs.placement, policy: record.inputs.policy, signal,
    // The semantic child budget is stable across capture/restart/replay. The
    // caller's shorter overall deadline is enforced independently by signal.
    limits: { timeoutMs: 300000, reference: { scan: { ...scan }, grid: { ...grid } }, scan, grid } };
}

async function prepareControlledResinHollow(options) {
  const config = configuration(options), started = performance.now(), deadline = new AbortController();
  let timedOut = false, capture, root, progressHandle, progress;
  const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, config.timeoutMs); timer.unref?.();
  const signal = config.signal ? AbortSignal.any([config.signal, deadline.signal]) : deadline.signal;
  const remaining = () => { const left = Math.floor(config.timeoutMs - (performance.now() - started)); if (left < 100) { timedOut = true; deadline.abort(); } if (signal.aborted) throw fail(timedOut ? 'Controlled hollow preparation exceeded its deadline.' : 'Hollow preparation cancelled.', timedOut ? 'RESIN_HOLLOW_TIMEOUT' : 'ABORTED', 409); return left; };
  try {
    const original = await readFile(config.inputPath, MAX_SOURCE, { bytes: true, signal });
    const profilePin = await readFile(config.profilePath, MiB, { bytes: true, signal }), loaded = await loadProfile(config.profilePath), presetPin = await readFile(loaded.presetPath, MiB, { bytes: true, signal });
    if (!loaded.preset.equals(presetPin.bytes) || hash(Buffer.concat([profilePin.bytes, Buffer.from('\0'), presetPin.bytes])) !== loaded.profileSha256) throw fail('The selected profile changed while loading.', 'RESIN_HOLLOW_CHANGED', 409);
    if (Object.entries(loaded.ini).some(([key, value]) => key === 'post_process' || /print_host|printhost|host_type/i.test(key) && value !== '')) throw fail('Controlled preparation rejects host credentials and post-processing commands.', 'RESIN_PROFILE_CREDENTIALS');
    const units = { 1: 'mm', 25.4: 'in', 1000: 'm' }[config.unitScale], format = path.extname(config.inputPath).slice(1).toLowerCase();
    const prepared = prepareResinGeometry(original.bytes, { format, units, sizing: config.sizing }), meshAudit = auditResinMesh(prepared.stl, { format: 'stl', units: 'mm', limits: { maxTriangles: 250000 } });
    if (meshAudit.components.some(component => component.winding !== 'positive')) throw fail('Controlled hollowing requires outward-oriented closed source components.', 'RESIN_MESH_NEGATIVE_COMPONENT', 422);
    const binding = { sourceSha256: original.descriptor.sha256, geometrySha256: prepared.transformedSha256, sizingSha256: prepared.plan.sizingSha256 }, hollow = prepareResinHollowPlan(prepared.stl, { binding, ...config.hollowRequest });
    remaining(); const implementation = await implementationManifest(), parent = await directory(config.outputDir); root = await fs.mkdtemp(path.join(parent, 'hollow-')); root = await local(root, true);
    const progressPath = path.join(root, 'native-progress.jsonl'); progressHandle = await fs.open(progressPath, 'wx'); let progressEntries = 0;
    progress = async (stage, status, details = {}) => { if (++progressEntries > 64) throw fail('Native progress exceeded its record bound.', 'RESIN_HOLLOW_FILE_LIMIT', 413); await progressHandle.write(Buffer.from(JSON.stringify({ stage, status, at: new Date().toISOString(), elapsedMs: Math.ceil(performance.now() - started), ...details }) + '\n')); };
    const originalSnapshot = await put(path.join(root, 'source-input.' + format), original.bytes), inputGeometry = { ...await put(path.join(root, 'prepared-input.stl'), prepared.stl), bounds: prepared.transformedBounds, meshAudit };
    const originalProfile = await put(path.join(root, 'profile-original.json'), profilePin.bytes), baselinePreset = await put(path.join(root, 'baseline.ini'), presetPin.bytes);
    const reboundProfile = zeros({ ...loaded.profile, presetPath: 'baseline.ini' }), validatedProfile = await put(path.join(root, 'profile.json'), json(reboundProfile));
    const targetProperties = Object.fromEntries(Object.keys(loaded.profile.uvtoolsProperties).sort().map(key => [key, zeros(loaded.profile.uvtoolsProperties[key])]));
    const nativeBounds = { overallTimeoutMs: config.timeoutMs, perCommandMaximumMs: config.timeoutMs, auditGridTimeoutMs: Math.min(180000, config.timeoutMs), processCommitLimitBytes: 1024 * MiB, jobCommitLimitBytes: 1024 * MiB, deadlinePolicy: 'each call receives min(prior maximum, overall remaining); independent overall AbortSignal' };
    const request = { hollowRequest: config.hollowRequest, supportRequest: config.supportRequest, resolutionRequest: config.resolutionRequest, boundaryPolicy: config.boundaryPolicy, ...(config.placement === undefined ? {} : { placement: config.placement }) };
    const nativePolicyFile = await put(path.join(root, 'native-policy.json'), json(nativeBounds));
    const priorRequest = await put(path.join(root, 'prior-request.json'), json({ schemaVersion: 1, request, sourceBinding: binding, profileSha256: loaded.profileSha256, nativeBounds }));
    await progress('provider-probes', 'started', { maximumTimeoutMs: config.timeoutMs });
    capture = await createControlledNativeCapture({ cwd: root, providers: { prusa: { executable: config.prusaExecutable, version: '2.9.7' }, uvtools: { executable: config.uvtoolsExecutable, version: '7.1.2' } }, limits: { timeoutMs: config.timeoutMs }, signal });
    await progress('provider-probes', 'completed', { calls: capture.getInvocations().length });
    const normalizeData = path.join(root, 'normalization-data'); await fs.mkdir(normalizeData);
    const resolvedPath = path.join(root, 'resolved.ini'), normalizationSpec = { id: 'normalize-profile', provider: 'prusa', argv: ['--load', baselinePreset.filePath, '--config-compatibility', 'disable', '--datadir', normalizeData, '--save', resolvedPath],
      inputs: [originalSnapshot, inputGeometry, originalProfile, baselinePreset, validatedProfile, nativePolicyFile, priorRequest].map((item, index) => ({ id: 'initial-' + index, filePath: item.filePath, maxBytes: index === 0 ? MAX_SOURCE : index === 1 ? MAX_MESH : MiB, expectedSha256: item.sha256 })), outputs: [{ id: 'resolved-preset', filePath: resolvedPath, maxBytes: MiB }], timeoutMs: config.timeoutMs };
    await progress('normalize-profile', 'started', { maximumTimeoutMs: config.timeoutMs });
    const normalized = await capture.invoke({ ...normalizationSpec, timeoutMs: Math.min(config.timeoutMs, remaining()) });
    await progress('normalize-profile', 'completed', { peakProcessCommitBytes: normalized.invocation.resourceReceipt.peakProcessCommitBytes, peakJobCommitBytes: normalized.invocation.resourceReceipt.peakJobCommitBytes });
    if (!capture.ownsInvocation(normalized.invocation)) throw fail('The normalization was not produced by this capture session.', 'RESIN_HOLLOW_EXECUTION_INVALID', 409);
    const saved = await readFile(resolvedPath, MiB, { root, bytes: true, signal }); assertPackedEffectiveSettings(parseIni(saved.bytes.toString('utf8')), loaded.ini);
    const inputs = resolveInputs(prepared.stl, hollow.plan, binding, saved.bytes, loaded.profileSha256, request, targetProperties);
    const inputsFile = await put(path.join(root, 'inputs.json'), json(inputs.record)), resolutionFile = await put(path.join(root, 'resolution.json'), json(inputs.resolution));
    const roles = {}, immutable = [originalSnapshot, inputGeometry, originalProfile, baselinePreset, validatedProfile, nativePolicyFile, priorRequest, saved.descriptor, inputsFile, resolutionFile];
    for (const role of ROLES) {
      const dir = path.join(root, role); await fs.mkdir(dir); await fs.mkdir(path.join(dir, 'data'));
      const artifact = inputs.artifacts[role], item = roles[role] = { input3mf: await put(path.join(dir, 'input.3mf'), artifact.input3mf), commandPreset: await put(path.join(dir, 'profile.ini'), artifact.preset), effectivePreset: await put(path.join(dir, 'effective.ini'), artifact.effectivePreset),
        sl1: { filePath: path.join(dir, 'prepared.sl1') }, artifact: { filePath: path.join(dir, 'prepared.goo') }, parameterReceipt: { filePath: path.join(dir, 'receipt.txt') } };
      item.parameterScript = await put(path.join(dir, 'parameters.cs'), Buffer.from(parameterScript(targetProperties, item.parameterReceipt.filePath, inputs.record.sha256)));
      immutable.push(item.input3mf, item.commandPreset, item.effectivePreset, item.parameterScript);
    }
    const initialInputs = immutable.map((item, index) => ({ id: 'frozen-' + index, filePath: item.filePath, maxBytes: item.bytes > 32 * MiB ? MAX_SOURCE : Math.max(1, item.bytes), expectedSha256: item.sha256 }));
    const commandPlan = { schemaVersion: 1, method: METHOD, inputsSha256: inputs.record.sha256, resolutionSha256: inputs.resolution.sha256, commands: commandsFor(root, roles, inputs.record.sha256, initialInputs, config.timeoutMs) };
    const commandPlanFile = await put(path.join(root, 'command-plan.json'), json(commandPlan));
    const providerManifest = capture.getProviderManifest(), supervisorFiles = capture.getInvocations()[0].resourceReceipt.supervisorManifest.files;
    const tool = toolFor(providerManifest, implementation, supervisorFiles);
    const record = { schemaVersion: 1, method: METHOD, captureDirectory: root, recordPath: path.join(root, 'hollow-preparation.json'), source: { ...originalSnapshot, format, units, unitScale: config.unitScale },
      inputGeometry, sizingPlan: prepared.plan, request, profileSha256: loaded.profileSha256, profile: { originalJson: originalProfile, baselinePreset, validatedJson: validatedProfile },
      normalization: { savedPreset: saved.descriptor, invocationId: 'normalize-profile', command: normalizationSpec }, inputs: inputs.record, inputsFile, resolution: inputs.resolution, effectiveResolutionRequest: inputs.effectiveResolutionRequest, resolutionFile, roles,
      commandPlan, commandPlanFile, commandPlanSha256: digest(commandPlan), providerManifest, implementation, tool,
      captureImplementation: capture.getImplementationManifest(),
      nativeBounds, nativePolicyFile, priorRequest,
      nativeInvocationAttested: false, controlledExecution: true, productionEligible: false, createdAt: new Date().toISOString() };
    // No native geometry command occurs before all 12 commands, role input
    // bytes, full presets, echo predictions and scripts have exclusive files.
    for (const spec of commandPlan.commands) {
      await progress(spec.id, 'started', { maximumTimeoutMs: spec.timeoutMs });
      remaining(); const run = await capture.invoke({ ...spec, timeoutMs: Math.min(spec.timeoutMs, remaining()) });
      await progress(spec.id, 'completed', { peakProcessCommitBytes: run.invocation.resourceReceipt.peakProcessCommitBytes, peakJobCommitBytes: run.invocation.resourceReceipt.peakJobCommitBytes });
      if (!capture.ownsInvocation(run.invocation)) throw fail('A native stage lacks this session private execution brand.', 'RESIN_HOLLOW_EXECUTION_INVALID', 409);
      const role = spec.id.split('-')[0], item = roles[role];
      if (spec.id.endsWith('-slice')) {
        const sl1 = await readFile(item.sl1.filePath, MAX_GOO, { root, bytes: true, signal });
        item.sl1 = sl1.descriptor; const inspection = inspectSl1(sl1.bytes, inputs.record.targetGeometry);
        if (!effectiveFromSl1(sl1.bytes).equals(inputs.artifacts[role].effectivePreset)) throw fail('Native SLA effective preset differs from its prediction frozen before export.', 'RESIN_HOLLOW_EFFECTIVE_MISMATCH', 502);
        item.sl1Inspection = { layerCount: inspection.layerCount, sha256: inspection.sha256, effectivePresetSha256: inspection.effectivePresetSha256 };
      }
      if (spec.id.endsWith('-parameters')) { item.parameterReceipt = (await readFile(item.parameterReceipt.filePath, 1024, { root, bytes: true, signal })).descriptor; if (item.parameterReceipt.sha256 !== hash(inputs.record.sha256)) throw fail('Target property receipt differs from the frozen recipe.', 'RESIN_HOLLOW_TARGET_RECEIPT', 502); }
      if (spec.id.endsWith('-issues')) {
        const output = run.stdout + run.stderr; item.issueReport = await put(path.join(root, role, 'issues.txt'), Buffer.from(output)); item.analysis = parseIssueReport(output);
        const scan = await scanResinGooFile(item.artifact.filePath, { signal }); assertTargetProperties(scan.metadata, targetProperties);
        if (scan.metadata.perLayerSettings || scan.metadata.layerCount !== item.sl1Inspection.layerCount) throw fail('Native GOO schedule/count differs from its validated SLA input.', 'RESIN_HOLLOW_CONVERSION_MISMATCH', 502);
        item.artifact = (await readFile(item.artifact.filePath, MAX_GOO, { root, signal })).descriptor;
        if (scan.sha256 !== item.artifact.sha256) throw fail('Native artifact changed during complete structural inspection.', 'RESIN_HOLLOW_CHANGED', 409);
        item.inspection = { ...scan.metadata, sha256: scan.sha256, bytes: item.artifact.bytes, definitionsSha256: scan.definitionsSha256 };
        if (role === 'final' && !item.analysis.passed) throw fail('The complete supported hollow output has native print issues.', 'RESIN_HOLLOW_NATIVE_ISSUES', 409);
      }
    }
    record.invocations = capture.getInvocations();
    if (record.invocations.length !== 15 || record.invocations.some(item => !capture.ownsInvocation(item) || item.status !== 'succeeded')) throw fail('The native execution trace is incomplete.', 'RESIN_HOLLOW_EXECUTION_INVALID', 409);
    remaining(); const args = auditOptions(record, prepared.stl, inputs.artifacts, signal);
    await progress('final-audit', 'started', { auditGridTimeoutMs: nativeBounds.auditGridTimeoutMs });
    record.finalAudit = await auditResinHollowFinal(args);
    await progress('final-audit', 'completed', { disposition: record.finalAudit.disposition, sha256: record.finalAudit.sha256 });
    if (record.finalAudit.disposition !== 'conforming') throw fail('Final supported hollow raster proof is held.', 'RESIN_HOLLOW_FINAL_NONCONFORMING', 409);
    remaining(); await progress('final-replay', 'started', { auditGridTimeoutMs: nativeBounds.auditGridTimeoutMs }); const replay = await verifyResinHollowFinalAudit(args, record.finalAudit);
    await progress('final-replay', 'completed', { sha256: replay.sha256 });
    record.finalAuditReverified = replay.sha256 === record.finalAudit.sha256;
    await capture.close(); capture = null;
    await readFile(config.inputPath, MAX_SOURCE, { expected: original.descriptor, signal }); await readFile(config.profilePath, MiB, { expected: profilePin.descriptor, signal }); await readFile(loaded.presetPath, MiB, { expected: presetPin.descriptor, signal });
    if (!isDeepStrictEqual(implementation, await implementationManifest())) throw fail('Hollow implementation changed during capture.', 'RESIN_HOLLOW_TOOL_CHANGED', 409);
    await progressHandle.close(); progressHandle = null; progress = null; record.progressLog = (await readFile(progressPath, MiB, { root, signal })).descriptor;
    record.sha256 = digest(record); const encoded = json(record); if (encoded.length > MAX_RECORD) throw fail('The complete hollow receipt exceeds its bound.', 'RESIN_HOLLOW_FILE_LIMIT', 413); await put(record.recordPath, encoded); remaining();
    const bound = await inspectControlledResinHollowBindings(record, { source: original.bytes, directory: parent, signal });
    VERIFIED.set(record, bound.bindingHash);
    const selected = roles.final;
    return { filePath: selected.artifact.filePath, sha256: selected.artifact.sha256, bytes: selected.artifact.bytes, inspection: selected.inspection, analysis: selected.analysis, status: 'sliced_pending_qualification', printReady: false, printerCompatible: false, format: 'goo',
      sourceSha256: original.descriptor.sha256, profileSha256: loaded.profileSha256, printerId: loaded.profile.printerId, printerModel: loaded.profile.printerModel, material: loaded.profile.material, tool, inputGeometry, sizingPlan: prepared.plan, orientation: inputs.record.hollowPlan.request.orientation, modelCopiesPerRun: 1, hollowPreparation: freeze(record), createdAt: record.createdAt };
  } catch (error) {
    if (progress) await progress('preparation', 'failed', { code: error.code || 'RESIN_HOLLOW_FAILED' }).catch(() => {});
    if (root) await fs.writeFile(path.join(root, 'failure.json'), json({ method: METHOD, error: { code: error.code || 'RESIN_HOLLOW_FAILED', message: error.message }, nativeInvocationAttested: false, productionEligible: false, invocations: capture?.getInvocations() ?? [] }), { flag: 'wx' }).catch(() => {});
    if (config.signal?.aborted) throw fail('Hollow preparation cancelled.', 'ABORTED', 409);
    if (timedOut) throw fail('Controlled hollow preparation exceeded its deadline.', 'RESIN_HOLLOW_TIMEOUT', 409);
    throw error;
  } finally { clearTimeout(timer); if (progressHandle) await progressHandle.close().catch(() => {}); if (capture) await capture.close().catch(() => {}); }
}

function recordShape(record) {
  if (!plain(record) || !plain(record.source) || !plain(record.profile) || !plain(record.roles) || !plain(record.inputs) || !plain(record.normalization) || !plain(record.commandPlan) || !plain(record.providerManifest) || !plain(record.request) || record.schemaVersion !== 1 || record.method !== METHOD || typeof record.sha256 !== 'string' || !HASH.test(record.sha256) || digest(withoutSha(record)) !== record.sha256 || record.controlledExecution !== true || record.nativeInvocationAttested !== false || record.productionEligible !== false || record.finalAuditReverified !== true || record.finalAudit?.disposition !== 'conforming') throw fail('A complete unchanged controlled hollow receipt is required.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  if (Buffer.byteLength(JSON.stringify(record)) > MAX_RECORD || !Array.isArray(record.invocations) || record.invocations.length !== 15) throw fail('The hollow receipt is incomplete or too large.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  if (!['stl', 'obj'].includes(record.source.format) || !['mm', 'in', 'm'].includes(record.source.units) || record.source.unitScale !== { mm: 1, in: 25.4, m: 1000 }[record.source.units]) throw fail('The source unit/format binding changed.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  if (!plain(record.nativeBounds) || !Number.isSafeInteger(record.nativeBounds.overallTimeoutMs) || record.nativeBounds.overallTimeoutMs < 1000 || record.nativeBounds.overallTimeoutMs > 3600000 || record.nativeBounds.perCommandMaximumMs !== record.nativeBounds.overallTimeoutMs || record.nativeBounds.auditGridTimeoutMs !== Math.min(180000, record.nativeBounds.overallTimeoutMs) || record.nativeBounds.processCommitLimitBytes !== 1024 * MiB || record.nativeBounds.jobCommitLimitBytes !== 1024 * MiB) throw fail('The predeclared native resource bounds changed.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
}
async function inspectState(record, options) {
  recordShape(record); keys(options, ['source', 'directory', 'signal', 'timeoutMs'], ['source', 'directory'], 'hollow verification');
  if (!Buffer.isBuffer(options.source) || !options.source.length || options.source.length > MAX_SOURCE || (typeof SharedArrayBuffer !== 'undefined' && options.source.buffer instanceof SharedArrayBuffer) || hash(options.source) !== record.source.sha256) throw fail('The current source differs from this hollow preparation.', 'RESIN_HOLLOW_SOURCE_CHANGED', 409);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw fail('Use an AbortSignal for verification.');
  const parent = await local(absolute(options.directory, 'managed directory'), true), root = await local(absolute(record.captureDirectory, 'capture directory'), true); contained(parent, root);
  const at = (descriptor, relative) => { if (!plain(descriptor) || descriptor.filePath !== path.join(root, relative)) throw fail('A hollow descriptor no longer names its fixed owned artifact.', 'RESIN_HOLLOW_PATH', 409); };
  if (record.recordPath !== path.join(root, 'hollow-preparation.json')) throw fail('The hollow receipt path changed.', 'RESIN_HOLLOW_PATH', 409);
  for (const [item, relative] of [[record.source, 'source-input.' + record.source.format], [record.inputGeometry, 'prepared-input.stl'], [record.profile.originalJson, 'profile-original.json'], [record.profile.baselinePreset, 'baseline.ini'], [record.profile.validatedJson, 'profile.json'], [record.normalization.savedPreset, 'resolved.ini'], [record.inputsFile, 'inputs.json'], [record.resolutionFile, 'resolution.json'], [record.commandPlanFile, 'command-plan.json']]) at(item, relative);
  at(record.progressLog, 'native-progress.jsonl');
  at(record.nativePolicyFile, 'native-policy.json'); at(record.priorRequest, 'prior-request.json');
  for (const role of ROLES) for (const [name, filename] of Object.entries({ input3mf: 'input.3mf', commandPreset: 'profile.ini', effectivePreset: 'effective.ini', parameterScript: 'parameters.cs', parameterReceipt: 'receipt.txt', sl1: 'prepared.sl1', artifact: 'prepared.goo', issueReport: 'issues.txt' })) at(record.roles[role]?.[name], path.join(role, filename));
  const signal = options.signal, files = [];
  const get = async (item, maximum, bytes = false) => { if (!plain(item) || !HASH.test(item.sha256) || !Number.isSafeInteger(item.bytes)) throw fail('A hollow descriptor is invalid.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409); const value = await readFile(item.filePath, maximum, { root, expected: item, bytes, signal }); files.push(value.descriptor); return value.bytes; };
  const persisted = await readFile(record.recordPath, MAX_RECORD, { root, bytes: true, signal });
  let parsed; try { parsed = JSON.parse(persisted.bytes); } catch { throw fail('The stored hollow receipt is invalid.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409); }
  if (!isDeepStrictEqual(parsed, record)) throw fail('The persisted hollow receipt differs from its current state.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  const source = await get(record.source, MAX_SOURCE, true), normalized = await get(record.inputGeometry, MAX_MESH, true);
  await get(record.progressLog, MiB);
  const policyBytes = await get(record.nativePolicyFile, MiB, true), priorBytes = await get(record.priorRequest, MiB, true);
  if (!isDeepStrictEqual(JSON.parse(policyBytes), record.nativeBounds) || !isDeepStrictEqual(JSON.parse(priorBytes), { schemaVersion: 1, request: record.request, sourceBinding: record.inputs.sourceBinding, profileSha256: record.profileSha256, nativeBounds: record.nativeBounds })) throw fail('The resource/intent snapshot frozen before native probes changed.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  if (!source.equals(options.source)) throw fail('The source snapshot changed.', 'RESIN_HOLLOW_SOURCE_CHANGED', 409);
  const profileJson = await get(record.profile.originalJson, MiB, true), baseline = await get(record.profile.baselinePreset, MiB, true), rebound = await get(record.profile.validatedJson, MiB, true);
  if (hash(Buffer.concat([profileJson, Buffer.from('\0'), baseline])) !== record.profileSha256 || !isDeepStrictEqual(JSON.parse(rebound), zeros({ ...JSON.parse(profileJson), presetPath: 'baseline.ini' }))) throw fail('The frozen source profile changed.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  const currentProfile = await loadProfile(record.profile.validatedJson.filePath);
  if (!currentProfile.preset.equals(baseline)) throw fail('The managed profile snapshot resolves another preset.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  const targets = Object.fromEntries(Object.keys(currentProfile.profile.uvtoolsProperties).sort().map(key => [key, currentProfile.profile.uvtoolsProperties[key]]));
  if (!isDeepStrictEqual(targets, record.inputs.targetProperties)) throw fail('Native target properties differ from the frozen managed profile.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  const saved = await get(record.normalization.savedPreset, MiB, true); assertPackedEffectiveSettings(parseIni(saved.toString('utf8')), parseIni(baseline.toString('utf8')));
  const inputsJson = await get(record.inputsFile, MAX_RECORD, true), resolutionJson = await get(record.resolutionFile, MiB, true), planJson = await get(record.commandPlanFile, MAX_RECORD, true);
  if (!isDeepStrictEqual(JSON.parse(inputsJson), record.inputs) || !isDeepStrictEqual(JSON.parse(resolutionJson), record.resolution) || !isDeepStrictEqual(JSON.parse(planJson), record.commandPlan) || digest(record.commandPlan) !== record.commandPlanSha256) throw fail('Frozen hollow command/input plans changed.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  const immutable = [record.source, record.inputGeometry, record.profile.originalJson, record.profile.baselinePreset, record.profile.validatedJson, record.nativePolicyFile, record.priorRequest, record.normalization.savedPreset, record.inputsFile, record.resolutionFile];
  for (const role of ROLES) { const item = record.roles[role]; immutable.push(item.input3mf, item.commandPreset, item.effectivePreset, item.parameterScript); }
  const initialInputs = immutable.map((item, index) => ({ id: 'frozen-' + index, filePath: item.filePath, maxBytes: item.bytes > 32 * MiB ? MAX_SOURCE : Math.max(1, item.bytes), expectedSha256: item.sha256 }));
  const expectedPlan = { schemaVersion: 1, method: METHOD, inputsSha256: record.inputs.sha256, resolutionSha256: record.resolution.sha256, commands: commandsFor(root, record.roles, record.inputs.sha256, initialInputs, record.nativeBounds.perCommandMaximumMs) };
  if (!isDeepStrictEqual(expectedPlan, record.commandPlan)) throw fail('The native command recipe differs from the fixed controlled pipeline.', 'RESIN_HOLLOW_EXECUTION_CHANGED', 409);
  const expectedNormalization = { id: 'normalize-profile', provider: 'prusa', argv: ['--load', record.profile.baselinePreset.filePath, '--config-compatibility', 'disable', '--datadir', path.join(root, 'normalization-data'), '--save', record.normalization.savedPreset.filePath],
    inputs: [record.source, record.inputGeometry, record.profile.originalJson, record.profile.baselinePreset, record.profile.validatedJson, record.nativePolicyFile, record.priorRequest].map((item, index) => ({ id: 'initial-' + index, filePath: item.filePath, maxBytes: index === 0 ? MAX_SOURCE : index === 1 ? MAX_MESH : MiB, expectedSha256: item.sha256 })), outputs: [{ id: 'resolved-preset', filePath: record.normalization.savedPreset.filePath, maxBytes: MiB }], timeoutMs: record.nativeBounds.perCommandMaximumMs };
  if (!isDeepStrictEqual(expectedNormalization, record.normalization.command)) throw fail('The profile normalization invocation changed.', 'RESIN_HOLLOW_EXECUTION_CHANGED', 409);
  const buffers = {}, issueBuffers = {};
  for (const role of ROLES) {
    const item = record.roles[role]; buffers[role] = { input3mf: await get(item.input3mf, 32 * MiB, true), preset: await get(item.commandPreset, MiB, true), effectivePreset: await get(item.effectivePreset, MiB, true) };
    const script = await get(item.parameterScript, MiB, true), receipt = await get(item.parameterReceipt, 1024, true), issues = await get(item.issueReport, 2 * MiB, true);
    issueBuffers[role] = issues;
    if (!script.equals(Buffer.from(parameterScript(record.inputs.targetProperties, item.parameterReceipt.filePath, record.inputs.sha256))) || receipt.toString('utf8') !== record.inputs.sha256 || !isDeepStrictEqual(parseIssueReport(issues.toString('utf8')), item.analysis)) throw fail('A native target or quality receipt changed.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
    await get(item.sl1, MAX_GOO); await get(item.artifact, MAX_GOO);
  }
  const implementation = await implementationManifest();
  if (!isDeepStrictEqual(implementation, record.implementation)) throw fail('Hollow preparation uses another implementation.', 'RESIN_HOLLOW_TOOL_CHANGED', 409);
  const captureNames = ['resin-controlled-capture.js', 'windows-native-job.js', 'windows-native-job.ps1', 'windows-native-job.cs'];
  const captureFiles = captureNames.map(name => implementation.files.find(item => item.name === name));
  const expectedCaptureImplementation = { method: 'selected-capture-implementation-v1', files: captureFiles, sha256: digest(captureFiles), nodeVersion: process.versions.node, platform: process.platform, arch: process.arch };
  if (!isDeepStrictEqual(expectedCaptureImplementation, record.captureImplementation)) throw fail('The native capture implementation binding changed.', 'RESIN_HOLLOW_TOOL_CHANGED', 409);
  for (const [id, names] of [['prusa', ['PrusaSlicer.dll']], ['uvtools', ['UVtoolsCmd.dll', 'UVtools.Core.dll']]]) {
    const provider = record.providerManifest.providers[id];
    if (!provider || provider.version !== (id === 'prusa' ? '2.9.7' : '7.1.2') || !/\.exe$/i.test(provider.executable) || provider.files.length !== names.length + 1) throw fail('The selected native provider manifest changed.', 'RESIN_HOLLOW_TOOL_CHANGED', 409);
    for (let index = 0; index < provider.files.length; index++) {
      const item = provider.files[index], expectedPath = index === 0 ? provider.executable : path.join(path.dirname(provider.executable), names[index - 1]);
      if (path.resolve(item.filePath).toLowerCase() !== path.resolve(expectedPath).toLowerCase() || item.name !== (index === 0 ? id + '-executable' : names[index - 1])) throw fail('The selected dependency path changed.', 'RESIN_HOLLOW_TOOL_CHANGED', 409);
      const checked = await readFile(item.filePath, 256 * MiB, { expected: item, signal }); files.push(checked.descriptor);
    }
  }
  const providerFingerprint = digest(Object.fromEntries(Object.entries(record.providerManifest.providers).map(([id, provider]) => [id, { version: provider.version, files: provider.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }])));
  if (providerFingerprint !== record.providerManifest.sha256) throw fail('The native provider fingerprint changed.', 'RESIN_HOLLOW_TOOL_CHANGED', 409);
  const supervisorFiles = record.invocations[0].resourceReceipt?.supervisorManifest?.files;
  if (!Array.isArray(supervisorFiles) || !isDeepStrictEqual(toolFor(record.providerManifest, implementation, supervisorFiles), record.tool)) throw fail('The qualified hollow tool fingerprint changed.', 'RESIN_HOLLOW_TOOL_CHANGED', 409);
  const ps = supervisorFiles.find(item => item.name === 'windows-powershell.exe');
  if (!ps) throw fail('The native supervisor dependency is missing.', 'RESIN_HOLLOW_TOOL_CHANGED', 409);
  await readFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), MiB, { expected: { ...ps, filePath: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }, signal });
  const expectedCalls = [{ id: 'probe-prusa-version', provider: 'prusa', argv: ['--help'] }, { id: 'probe-uvtools-version', provider: 'uvtools', argv: ['--core-version'] }, record.normalization.command, ...record.commandPlan.commands];
  const capturedOwned = new Map(), currentFiles = new Map(files.map(item => [item.filePath, item]));
  for (let i = 0; i < expectedCalls.length; i++) {
    const expected = expectedCalls[i], actual = record.invocations[i], receipt = actual?.resourceReceipt;
    if (!actual || actual.id !== expected.id || actual.provider !== expected.provider || actual.status !== 'succeeded' || actual.controlledExecution !== true || actual.nativeInvocationAttested !== false || actual.sha256 !== digest(withoutSha(actual)) || !isDeepStrictEqual(actual.argv, expected.argv) || actual.cwd !== root || actual.providerManifestSha256 !== record.providerManifest.sha256 || !isDeepStrictEqual(actual.implementation, record.captureImplementation) || receipt?.method !== 'windows-job-object-v1' || receipt.assignedAtCreation !== true || receipt.assignedBeforeResume !== true || receipt.killOnJobClose !== true || receipt.descendantsTerminatedOnCompletion !== true || receipt.stopReason !== null || receipt.outputLimitExceeded !== false || receipt.processCommitLimitBytes !== 1024 * MiB || receipt.jobCommitLimitBytes !== 1024 * MiB || receipt.managedEnvironment?.DOTNET_PROCESSOR_COUNT !== '1' || !isDeepStrictEqual(receipt.supervisorManifest.files, supervisorFiles)) throw fail('The native execution trace does not match its frozen command plan.', 'RESIN_HOLLOW_EXECUTION_CHANGED', 409);
    for (const [name, observed] of [['inputs', actual.inputsBefore], ['mutations', actual.mutationsBefore], ['outputs', actual.outputsAfter]]) {
      const declared = name === 'outputs' ? [...(expected.outputs ?? []), ...(expected.mutations ?? [])] : expected[name] ?? [];
      if (!Array.isArray(observed) || observed.length !== declared.length) throw fail('The native file trace is incomplete.', 'RESIN_HOLLOW_EXECUTION_CHANGED', 409);
      for (let j = 0; j < declared.length; j++) {
        const wanted = declared[j], seen = observed[j], prior = capturedOwned.get(wanted.filePath);
        if (seen.id !== wanted.id || seen.filePath !== wanted.filePath || !HASH.test(seen.sha256) || !Number.isSafeInteger(seen.bytes) || seen.bytes < 1 || seen.bytes > wanted.maxBytes || (name !== 'outputs' && wanted.expectedSha256 && wanted.expectedSha256 !== seen.sha256) || (name === 'mutations' && (!prior || prior.sha256 !== seen.sha256 || prior.bytes !== seen.bytes))) throw fail('A native file trace differs from its declared input/output chain.', 'RESIN_HOLLOW_EXECUTION_CHANGED', 409);
        if (name === 'inputs') { const current = currentFiles.get(wanted.filePath); if (current && (seen.sha256 !== current.sha256 || seen.bytes !== current.bytes)) throw fail('A native immutable input trace changed.', 'RESIN_HOLLOW_EXECUTION_CHANGED', 409); }
      }
    }
    if (actual.inputsAfter !== undefined && !isDeepStrictEqual(actual.inputsAfter, actual.inputsBefore)) throw fail('A native immutable input changed during its call.', 'RESIN_HOLLOW_EXECUTION_CHANGED', 409);
    for (const item of actual.outputsAfter) capturedOwned.set(item.filePath, item);
    if (expected.id.endsWith('-issues')) {
      const body = issueBuffers[expected.id.split('-')[0]], stdout = actual.stdout, stderr = actual.stderr;
      if (!stdout || !stderr || stdout.bytes + stderr.bytes !== body.length || hash(body.subarray(0, stdout.bytes)) !== stdout.sha256 || hash(body.subarray(stdout.bytes)) !== stderr.sha256) throw fail('The six-check text differs from the controlled native output.', 'RESIN_HOLLOW_EXECUTION_CHANGED', 409);
    }
  }
  for (const [filePath, observed] of capturedOwned) { const current = currentFiles.get(filePath); if (!current || current.sha256 !== observed.sha256 || current.bytes !== observed.bytes) throw fail('A captured native output no longer matches its last authorized mutation.', 'RESIN_HOLLOW_EXECUTION_CHANGED', 409); }
  if (!record.roles.final.analysis.passed || record.roles.final.analysis.count !== 0) throw fail('The final native six-check result is held.', 'RESIN_HOLLOW_NATIVE_ISSUES', 409);
  return { root, source, normalized, baseline, saved, buffers, currentProfile, files, bindingHash: digest({ recordSha256: record.sha256, files, implementation, tool: record.tool.executableSha256 }) };
}

async function inspectControlledResinHollowBindings(record, options) {
  if (!plain(options)) throw fail('Supply current source bytes and a managed directory.');
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000 || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw fail('Use a bounded binding-inspection deadline and AbortSignal.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    const state = await inspectState(record, { ...options, signal });
    return freeze({ schemaVersion: 1, method: 'controlled-hollow-current-bindings-v1', bindingHash: state.bindingHash, hollowPreparationSha256: record.sha256, filePath: record.roles.final.artifact.filePath, sha256: record.roles.final.artifact.sha256, bytes: record.roles.final.artifact.bytes, freshConformanceAudit: false, nativeInvocationAttested: false, productionEligible: false });
  } catch (error) { if (options.signal?.aborted) throw fail('Hollow binding inspection cancelled.', 'ABORTED', 409); if (controller.signal.aborted) throw fail('Hollow binding inspection exceeded its deadline.', 'RESIN_HOLLOW_TIMEOUT', 409); throw error; }
  finally { clearTimeout(timer); }
}
async function verifyImplementation(record, options) {
  const state = await inspectState(record, options);
  const prepared = prepareResinGeometry(state.source, { format: record.source.format, units: record.source.units, sizing: record.sizingPlan.requestedSizing });
  const meshAudit = auditResinMesh(prepared.stl, { format: 'stl', units: 'mm', limits: { maxTriangles: 250000 } });
  if (meshAudit.components.some(component => component.winding !== 'positive') || !isDeepStrictEqual(meshAudit, record.inputGeometry.meshAudit) || !prepared.stl.equals(state.normalized) || !isDeepStrictEqual(prepared.plan, record.sizingPlan) || !isDeepStrictEqual(prepared.transformedBounds, record.inputGeometry.bounds)) throw fail('The normalized source/sizing proof changed.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  const binding = { sourceSha256: record.source.sha256, geometrySha256: prepared.transformedSha256, sizingSha256: prepared.plan.sizingSha256 }, plan = prepareResinHollowPlan(prepared.stl, { binding, ...record.request.hollowRequest }).plan;
  const inputs = resolveInputs(prepared.stl, plan, binding, state.saved, record.profileSha256, record.request, record.inputs.targetProperties);
  if (!isDeepStrictEqual(inputs.record, record.inputs) || !isDeepStrictEqual(inputs.resolution, record.resolution) || !isDeepStrictEqual(inputs.effectiveResolutionRequest, record.effectiveResolutionRequest)) throw fail('The hollow source/request/support/resolution proof changed.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  for (const role of ROLES) {
    if (!inputs.artifacts[role].input3mf.equals(state.buffers[role].input3mf) || !inputs.artifacts[role].preset.equals(state.buffers[role].preset) || !inputs.artifacts[role].effectivePreset.equals(state.buffers[role].effectivePreset)) throw fail('Frozen native role inputs differ from independent derivation.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
    const sl1 = await readFile(record.roles[role].sl1.filePath, MAX_GOO, { root: state.root, expected: record.roles[role].sl1, bytes: true, signal: options.signal });
    const inspection = inspectSl1(sl1.bytes, inputs.record.targetGeometry);
    if (!effectiveFromSl1(sl1.bytes).equals(inputs.artifacts[role].effectivePreset) || inspection.layerCount !== record.roles[role].inspection.layerCount) throw fail('A native SL1 role differs from its frozen effective preset.', 'RESIN_HOLLOW_EFFECTIVE_MISMATCH', 409);
    const scan = await scanResinGooFile(record.roles[role].artifact.filePath, { signal: options.signal }); assertTargetProperties(scan.metadata, inputs.record.targetProperties);
    if (scan.sha256 !== record.roles[role].artifact.sha256 || scan.metadata.perLayerSettings || !isDeepStrictEqual({ ...scan.metadata, sha256: scan.sha256, bytes: record.roles[role].artifact.bytes, definitionsSha256: scan.definitionsSha256 }, record.roles[role].inspection)) throw fail('A native GOO role changed its structural/target evidence.', 'RESIN_HOLLOW_PREPARATION_CHANGED', 409);
  }
  const audited = await verifyResinHollowFinalAudit(auditOptions(record, prepared.stl, inputs.artifacts, options.signal), record.finalAudit);
  if (audited.disposition !== 'conforming') throw fail('The final supported hollow audit is held.', 'RESIN_HOLLOW_FINAL_NONCONFORMING', 409);
  const current = await inspectControlledResinHollowBindings(record, options);
  if (current.bindingHash !== state.bindingHash) throw fail('A hollow binding changed during verification.', 'RESIN_HOLLOW_CHANGED', 409);
  VERIFIED.set(record, state.bindingHash);
  return freeze({ filePath: record.roles.final.artifact.filePath, sha256: record.roles.final.artifact.sha256, bytes: record.roles.final.artifact.bytes, inspection: record.roles.final.inspection, analysis: record.roles.final.analysis, inputGeometry: record.inputGeometry, sizingPlan: record.sizingPlan, tool: record.tool, hollowPreparationSha256: record.sha256, bindingHash: state.bindingHash });
}

async function verifyControlledResinHollowPreparation(record, options) {
  if (!plain(options)) throw fail('Supply current source bytes and the managed verification directory.');
  const timeoutMs = options.timeoutMs ?? 900000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000 || options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw fail('Use a bounded hollow verification deadline and AbortSignal.');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try { return await verifyImplementation(record, { ...options, signal }); }
  catch (error) { if (options.signal?.aborted) throw fail('Hollow verification cancelled.', 'ABORTED', 409); if (controller.signal.aborted) throw fail('Hollow verification exceeded its deadline.', 'RESIN_HOLLOW_TIMEOUT', 409); throw error; }
  finally { clearTimeout(timer); }
}

function isVerifiedControlledHollowPreparation(record, bindingHash) { return plain(record) && typeof bindingHash === 'string' && VERIFIED.get(record) === bindingHash; }
module.exports = { prepareControlledResinHollow, verifyControlledResinHollowPreparation, inspectControlledResinHollowBindings, isVerifiedControlledHollowPreparation };
