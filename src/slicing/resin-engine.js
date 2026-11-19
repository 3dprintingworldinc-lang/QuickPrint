'use strict';

// Callable resin engine: PrusaSlicer SLA -> UVtools GOO -> independent structural
// validation and UVtools issue analysis. This engine does not start printers.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runProcess } = require('./index');
const { inspectZip, readZipEntry } = require('./psam/zip-inspection');

const MAX_BYTES = 512 * 1024 * 1024;
const ZIP_LIMITS = { maxArchiveBytes: MAX_BYTES, maxEntryBytes: 128 * 1024 * 1024, maxTotalUncompressedBytes: 1024 * 1024 * 1024, maxEntries: 25010, maxCompressionRatio: 10000 };
const CHECKS = ['--islands', '--resin-traps', '--suction-cups', '--touching-bounds', '--print-height', '--empty-layers'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'RESIN_ENGINE_FAILED', status = 400) => Object.assign(new Error(message), { code, status });

function parseIni(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const match = /^\s*([A-Za-z_0-9]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) throw fail('Use a standalone Prusa SLA INI without sections or duplicate keys.', 'RESIN_PROFILE_INVALID');
    values[match[1]] = match[2];
  }
  return values;
}

function numeric(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(`Invalid resin profile ${label}.`, 'RESIN_PROFILE_INVALID');
  return value;
}

async function loadProfile(profilePath) {
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) throw fail('Select an absolute resin profile JSON path.', 'RESIN_PROFILE_REQUIRED');
  const data = await fs.readFile(profilePath);
  if (data.length > 1024 * 1024) throw fail('Resin profile is too large.', 'RESIN_PROFILE_INVALID');
  let profile;
  try { profile = JSON.parse(data); } catch { throw fail('Resin profile must be valid JSON.', 'RESIN_PROFILE_INVALID'); }
  if (profile?.schemaVersion !== 1 || !['printerId', 'printerModel', 'material', 'presetPath'].every(key => typeof profile[key] === 'string' && profile[key].trim() && !/[\r\n\0]/.test(profile[key]))) throw fail('Resin profile needs printer, material and standalone preset metadata.', 'RESIN_PROFILE_INVALID');
  const presetPath = path.resolve(path.dirname(profilePath), profile.presetPath);
  const preset = await fs.readFile(presetPath);
  if (preset.length > 1024 * 1024) throw fail('Resin preset is too large.', 'RESIN_PROFILE_INVALID');
  const ini = parseIni(preset.toString('utf8'));
  if (Object.entries(ini).some(([key, value]) => /apikey|password|token|accesscode|secret/i.test(key) && value !== '')) throw fail('Export a resin preset without printer or account credentials. Slicing does not require them.', 'RESIN_PROFILE_CREDENTIALS');
  if (ini.printer_technology !== 'SLA' || ini.sla_archive_format !== 'SL1' || ini.inherits) throw fail('Use a standalone SLA/SL1 preset with no inherited printer settings.', 'RESIN_PROFILE_INVALID');
  // Hollow STL cannot be approved without an established drain-hole contract.
  if (ini.hollowing_enable !== '0') throw fail('This engine currently requires solid models; hollowing needs a validated drain-hole plan.', 'RESIN_DRAIN_PLAN_REQUIRED');
  const expected = profile.expected;
  if (!expected || typeof expected !== 'object') throw fail('Expected printer geometry is required.', 'RESIN_PROFILE_INVALID');
  const mapping = { resolutionX: 'display_pixels_x', resolutionY: 'display_pixels_y', displayWidthMm: 'display_width', displayHeightMm: 'display_height', layerHeightMm: 'layer_height' };
  for (const [key, setting] of Object.entries(mapping)) {
    numeric(expected[key], key, key.startsWith('resolution') ? 1 : 0.001, key.startsWith('resolution') ? 20000 : 2000);
    if (key.startsWith('resolution') && !Number.isInteger(expected[key])) throw fail('Printer pixel dimensions must be whole numbers.', 'RESIN_PROFILE_INVALID');
    if (Number(ini[setting]) !== expected[key]) throw fail(`Printer geometry differs from the standalone preset: ${setting}.`, 'RESIN_PROFILE_INVALID');
  }
  if (expected.resolutionX * expected.resolutionY > 100000000) throw fail('Printer resolution exceeds this engine’s resource limit.', 'RESIN_PROFILE_INVALID');
  for (const [key, setting] of [['mirrorX', 'display_mirror_x'], ['mirrorY', 'display_mirror_y']]) {
    if (typeof expected[key] !== 'boolean' || ini[setting] !== String(Number(expected[key]))) throw fail(`Explicit ${setting} must match the printer geometry.`, 'RESIN_PROFILE_INVALID');
  }
  if (ini.display_orientation !== 'landscape') throw fail('Use a qualified landscape SLA preset for this engine.', 'RESIN_PROFILE_INVALID');
  if (!['0', '1'].includes(ini.supports_enable) || !['0', '1'].includes(ini.pad_enable)) throw fail('Explicit support and pad policies are required.', 'RESIN_PROFILE_INVALID');
  const orientations = profile.orientationCandidates;
  if (!Array.isArray(orientations) || !orientations.length || orientations.length > 4) throw fail('Provide one to four explicit orientation candidates.', 'RESIN_PROFILE_INVALID');
  for (const candidate of orientations) for (const key of ['x', 'y', 'z']) numeric(candidate?.[key], `orientation ${key}`, -360, 360);
  const properties = profile.uvtoolsProperties;
  const required = ['MachineName', 'LayerHeight', 'ExposureTime', 'BottomExposureTime', 'BottomLayerCount', 'BottomLiftHeight', 'LiftHeight', 'BottomLiftSpeed', 'LiftSpeed', 'RetractSpeed', 'LightPWM', 'BottomLightPWM'];
  if (!properties || typeof properties !== 'object' || required.some(key => !Object.hasOwn(properties, key))) throw fail('Explicit target resin exposure and movement properties are required.', 'RESIN_PROFILE_INVALID');
  const allowed = new Set([...required, 'TransitionLayerCount', 'BottomRetractSpeed', 'BottomLiftHeight2', 'LiftHeight2', 'BottomLiftSpeed2', 'LiftSpeed2', 'BottomRetractHeight2', 'RetractHeight2', 'BottomRetractSpeed2', 'RetractSpeed2', 'WaitTimeBeforeCure', 'BottomWaitTimeBeforeCure', 'WaitTimeAfterCure', 'BottomWaitTimeAfterCure', 'WaitTimeAfterLift', 'BottomWaitTimeAfterLift']);
  for (const [key, value] of Object.entries(properties)) {
    if (!allowed.has(key)) throw fail(`Unsupported UVtools target property: ${key}.`, 'RESIN_PROFILE_INVALID');
    if (key === 'MachineName') {
      if (value !== profile.printerModel || Buffer.byteLength(value) > 32 || /[\r\n\0=]/.test(value)) throw fail('The GOO machine name must match the selected printer model and fit 32 bytes.', 'RESIN_PROFILE_INVALID');
    } else numeric(value, key, 0, 100000);
  }
  if (properties.LayerHeight !== expected.layerHeightMm || !properties.ExposureTime || !properties.BottomExposureTime || !Number.isInteger(properties.BottomLayerCount)) throw fail('Explicit exposure and layer properties must match the printer profile.', 'RESIN_PROFILE_INVALID');
  require('./resin-profiles').validateUVtoolsProperties(properties, { printerModel: profile.printerModel, layerHeightMm: expected.layerHeightMm, maxZMm: expected.machineZMm ?? Number(ini.max_print_height) });
  if (Number(ini.exposure_time) !== properties.ExposureTime || Number(ini.initial_exposure_time) !== properties.BottomExposureTime) throw fail('SLA exposure must match the target conversion properties.', 'RESIN_PROFILE_INVALID');
  return { profile: structuredClone(profile), preset, presetPath, ini, profileSha256: hash(Buffer.concat([data, Buffer.from('\0'), preset])) };
}

function parseIssueReport(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  if (!/^Issues: \d+$/.test(lines[0] || '') || lines.filter(line => /^Issues:/.test(line)).length !== 1) throw fail('UVtools did not return a recognizable issue report.', 'RESIN_ANALYSIS_INVALID', 502);
  const count = Number(lines[0].slice(8));
  if (!Number.isSafeInteger(count) || count !== lines.length - 1) throw fail('UVtools issue details are missing or truncated.', 'RESIN_ANALYSIS_INVALID', 502);
  return { count, passed: count === 0, checks: [...CHECKS], issues: lines.slice(1) };
}

function parameterScript(properties, receiptPath, receiptValue) {
  // Only profile values from loadProfile's fixed property allowlist are emitted.
  // The generated script is local application code, never a submitted job script.
  const literal = value => JSON.stringify(String(value)).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `using System;\nusing System.IO;\nusing System.Globalization;\nusing UVtools.Core.FileFormats;\nusing UVtools.Core.Scripting;\npublic class QuickPrintParameters : ScriptGlobals\n{\n public void ScriptInit() { Script.Name = "QuickPrint target parameters"; Script.Author = "QuickPrint"; Script.Version = new Version(1,0); }\n public string ScriptValidate() { return ""; }\n public bool ScriptExecute() {\n${Object.entries(properties).map(([key, value]) => `  Set(${literal(key)}, ${literal(value)});`).join('\n')}\n  File.WriteAllText(${literal(receiptPath)}, ${literal(receiptValue)});\n  return true;\n }\n void Set(string name, string value) {\n  var property = typeof(FileFormat).GetProperty(name);\n  if (property == null || !property.CanWrite) throw new InvalidOperationException("Unsupported target parameter: " + name);\n  property.SetValue(SlicerFile, Convert.ChangeType(value, property.PropertyType, CultureInfo.InvariantCulture));\n }\n}\n`;
}

function assertTargetProperties(inspection, properties) {
  const actual = { MachineName: inspection.machineName, LayerHeight: inspection.layerHeightMm, ExposureTime: inspection.exposureTimeSeconds, BottomExposureTime: inspection.bottomExposureTimeSeconds, BottomLayerCount: inspection.bottomLayerCount, TransitionLayerCount: inspection.transitionLayerCount, LightPWM: inspection.lightPwm, BottomLightPWM: inspection.bottomLightPwm };
  const motion = { BottomLiftHeight: 'bottomLiftDistanceMm', LiftHeight: 'liftDistanceMm', BottomLiftSpeed: 'bottomLiftSpeedMmPerMin', LiftSpeed: 'liftSpeedMmPerMin', BottomRetractSpeed: 'bottomRetractSpeedMmPerMin', RetractSpeed: 'retractSpeedMmPerMin', BottomLiftHeight2: 'bottomLiftDistance2Mm', LiftHeight2: 'liftDistance2Mm', BottomLiftSpeed2: 'bottomLiftSpeed2MmPerMin', LiftSpeed2: 'liftSpeed2MmPerMin', BottomRetractHeight2: 'bottomRetractDistance2Mm', RetractHeight2: 'retractDistance2Mm', BottomRetractSpeed2: 'bottomRetractSpeed2MmPerMin', RetractSpeed2: 'retractSpeed2MmPerMin' };
  const timing = { WaitTimeBeforeCure: 'waitAfterRetractSeconds', BottomWaitTimeBeforeCure: 'bottomWaitAfterRetractSeconds', WaitTimeAfterCure: 'waitBeforeLiftSeconds', BottomWaitTimeAfterCure: 'bottomWaitBeforeLiftSeconds', WaitTimeAfterLift: 'waitAfterLiftSeconds', BottomWaitTimeAfterLift: 'bottomWaitAfterLiftSeconds' };
  for (const [property, field] of Object.entries(motion)) actual[property] = inspection.motion?.[field];
  for (const [property, field] of Object.entries(timing)) actual[property] = inspection.timing?.[field];
  for (const [key, value] of Object.entries(properties)) {
    if (typeof actual[key] !== typeof value || (typeof value === 'number' ? Math.abs(actual[key] - value) > 0.001 : actual[key] !== value)) throw fail(`GOO target parameter was not applied: ${key}.`, 'RESIN_CONVERSION_MISMATCH', 502);
  }
}

function inspectSl1(buffer, expected) {
  const archive = inspectZip(buffer, ZIP_LIMITS);
  const get = name => {
    const entry = archive.entries.find(item => item.name === name);
    if (!entry || entry.uncompressedSize > 1024 * 1024) throw fail(`SLA archive is missing bounded ${name}.`, 'RESIN_ARCHIVE_INVALID', 502);
    return readZipEntry(buffer, entry, ZIP_LIMITS).toString('utf8');
  };
  const ini = parseIni(get('prusaslicer.ini'));
  const config = parseIni(get('config.ini'));
  const layers = archive.entries.filter(entry => /^prepared\d{5}\.png$/.test(entry.name));
  if (!layers.length || layers.length > 25000 || Number(config.numFast) + Number(config.numSlow) !== layers.length) throw fail('SLA archive layer count is inconsistent.', 'RESIN_ARCHIVE_INVALID', 502);
  for (let index = 0; index < layers.length; index++) {
    const entry = archive.entries.find(item => item.name === `prepared${String(index).padStart(5, '0')}.png`);
    if (!entry) throw fail('SLA archive layer sequence has gaps.', 'RESIN_ARCHIVE_INVALID', 502);
    const png = readZipEntry(buffer, entry, ZIP_LIMITS);
    if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.readUInt32BE(16) !== expected.resolutionX || png.readUInt32BE(20) !== expected.resolutionY) throw fail('SLA archive layer dimensions differ from the selected printer.', 'RESIN_ARCHIVE_INVALID', 502);
  }
  if (ini.printer_technology !== 'SLA' || Number(config.layerHeight) !== expected.layerHeightMm) throw fail('SLA archive technology or layer height differs from the selected profile.', 'RESIN_ARCHIVE_INVALID', 502);
  const fields = { resolutionX: 'display_pixels_x', resolutionY: 'display_pixels_y', displayWidthMm: 'display_width', displayHeightMm: 'display_height', layerHeightMm: 'layer_height' };
  for (const [field, key] of Object.entries(fields)) if (Number(ini[key]) !== expected[field]) throw fail(`Effective SLA profile changed ${key}.`, 'RESIN_EFFECTIVE_PROFILE_MISMATCH', 502);
  if (ini.display_orientation !== 'landscape' || ini.display_mirror_x !== String(Number(expected.mirrorX)) || ini.display_mirror_y !== String(Number(expected.mirrorY))) throw fail('Effective SLA profile changed image orientation.', 'RESIN_EFFECTIVE_PROFILE_MISMATCH', 502);
  return { layerCount: layers.length, sha256: hash(buffer), effectivePresetSha256: hash(get('prusaslicer.ini')), effective: ini };
}

async function prepareResin({ inputPath, outputDir, profilePath, prusaExecutable, uvtoolsExecutable, signal, unitScale = 1, timeoutMs = 15 * 60 * 1000 }, { run = runProcess, inspectGoo = require('./goo').inspectGoo } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) throw fail('Resin slicing timeout must be between one second and one hour.', 'RESIN_ENGINE_CONFIGURATION');
  if (![inputPath, outputDir, prusaExecutable, uvtoolsExecutable].every(value => typeof value === 'string' && path.isAbsolute(value))) throw fail('Resin engine file and executable paths must be absolute.', 'RESIN_ENGINE_CONFIGURATION');
  if (!/\.(stl|obj)$/i.test(inputPath)) throw fail('The headless resin engine accepts STL or OBJ.', 'RESIN_MODEL_FORMAT');
  if (![1, 25.4, 1000].includes(unitScale)) throw fail('Model units must be explicitly converted from mm, inches or metres.', 'RESIN_MODEL_UNITS');
  const original = await fs.readFile(inputPath);
  if (!original.length || original.length > 100 * 1024 * 1024) throw fail('Resin models must be nonempty and at most 100 MiB.', 'RESIN_MODEL_SIZE');
  const loaded = await loadProfile(profilePath);
  const { profile, profileSha256 } = loaded;
  const version = await run(prusaExecutable, ['--help'], { signal, timeoutMs: 15000 });
  if (!/^PrusaSlicer-[\d.]+/m.test(version) || !version.includes('--export-sla')) throw fail('PrusaSlicer SLA interface was not recognized.', 'RESIN_ENGINE_CONFIGURATION');
  const coreVersion = (await run(uvtoolsExecutable, ['--core-version'], { signal, timeoutMs: 15000 })).trim();
  if (!/^\d+\.\d+\.\d+$/.test(coreVersion)) throw fail('UVtools core version was not recognized.', 'RESIN_ENGINE_CONFIGURATION');
  // UVtools 4.4.3 Program.Main returns 1 after every invoked command. Output
  // remains mandatory and independently validated; other versions require 0.
  const uvOptions = { signal, timeoutMs, acceptedExitCodes: coreVersion === '4.4.3' ? [0, 1] : [0] };
  const binaryManifest = [];
  for (const [name, filename] of [
    ['prusa-console', prusaExecutable], ['prusa-core', path.join(path.dirname(prusaExecutable), 'PrusaSlicer.dll')],
    ['uvtools-console', uvtoolsExecutable], ['uvtools-command', path.join(path.dirname(uvtoolsExecutable), 'UVtoolsCmd.dll')], ['uvtools-core', path.join(path.dirname(uvtoolsExecutable), 'UVtools.Core.dll')],
    ['quickprint-resin-engine', __filename], ['quickprint-goo-validator', path.join(__dirname, 'goo.js')],
    ['quickprint-resin-profiles', path.join(__dirname, 'resin-profiles.js')],
    ['quickprint-process-runner', path.join(__dirname, 'index.js')],
    ['quickprint-archive-validator', path.join(__dirname, 'psam', 'zip-inspection.js')],
  ]) binaryManifest.push({ name, sha256: hash(await fs.readFile(filename)) });
  const tool = { name: 'PrusaSlicer SLA + UVtools', version: `${/^PrusaSlicer-([^\s]+)/m.exec(version)[1]} / ${coreVersion}`, executableSha256: hash(JSON.stringify(binaryManifest)), binaryManifest };
  await fs.mkdir(outputDir, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(outputDir, 'resin-'));
  const sourceCopy = path.join(workDir, `source${path.extname(inputPath).toLowerCase()}`);
  const presetCopy = path.join(workDir, 'preset.ini');
  await fs.writeFile(sourceCopy, original, { flag: 'wx' });
  await fs.writeFile(presetCopy, loaded.preset, { flag: 'wx' });
  const attempts = [];
  for (let index = 0; index < profile.orientationCandidates.length; index++) {
    signal?.throwIfAborted();
    const directory = path.join(workDir, `attempt-${index + 1}`);
    await fs.mkdir(directory);
    const sl1Path = path.join(directory, 'prepared.sl1'), gooPath = path.join(directory, 'prepared.goo');
    const orientation = profile.orientationCandidates[index];
    const logs = {};
    logs.slicing = await run(prusaExecutable, ['--load', presetCopy, '--config-compatibility', 'disable', '--scale', String(unitScale), '--rotate-x', String(orientation.x), '--rotate-y', String(orientation.y), '--rotate', String(orientation.z), '--export-sla', '--output', sl1Path, sourceCopy], { signal, timeoutMs });
    const sl1Stat = await fs.stat(sl1Path);
    if (sl1Stat.size > MAX_BYTES) throw fail('SLA output exceeds 512 MiB.', 'RESIN_OUTPUT_SIZE');
    const sl1 = inspectSl1(await fs.readFile(sl1Path), profile.expected);
    for (const key of ['supports_enable', 'pad_enable', 'hollowing_enable', 'layer_height', 'initial_layer_height', 'exposure_time', 'initial_exposure_time']) if (Number(sl1.effective[key]) !== Number(loaded.ini[key])) throw fail(`The slicer changed the requested ${key}.`, 'RESIN_EFFECTIVE_PROFILE_MISMATCH', 502);
    logs.conversion = await run(uvtoolsExecutable, ['--quiet', 'convert', sl1Path, 'GooFile', gooPath, '--no-overwrite'], uvOptions);
    const scriptPath = path.join(directory, 'target-parameters.cs'), receiptPath = path.join(directory, 'target-parameters.receipt');
    await fs.writeFile(scriptPath, parameterScript(profile.uvtoolsProperties, receiptPath, profileSha256), { flag: 'wx' });
    logs.properties = await run(uvtoolsExecutable, ['--quiet', 'run', gooPath, scriptPath], uvOptions);
    if ((await fs.readFile(receiptPath, 'utf8')) !== profileSha256) throw fail('Target parameters were not applied by the conversion engine.', 'RESIN_CONVERSION_MISMATCH', 502);
    const gooStat = await fs.stat(gooPath);
    if (gooStat.size > MAX_BYTES) throw fail('GOO output exceeds 512 MiB.', 'RESIN_OUTPUT_SIZE');
    const inspection = inspectGoo(await fs.readFile(gooPath), { limits: { maxFileBytes: MAX_BYTES }, expected: { ...profile.expected, machineName: profile.printerModel, exposureTimeSeconds: profile.uvtoolsProperties.ExposureTime, bottomExposureTimeSeconds: profile.uvtoolsProperties.BottomExposureTime, bottomLayerCount: profile.uvtoolsProperties.BottomLayerCount } });
    if (inspection.perLayerSettings) throw fail('This engine requires a global exposure/movement profile; per-layer parameter changes need separate qualification.', 'RESIN_PER_LAYER_PROFILE_UNSUPPORTED');
    assertTargetProperties(inspection, profile.uvtoolsProperties);
    if (inspection.layerCount !== sl1.layerCount) throw fail('Conversion changed the layer count.', 'RESIN_CONVERSION_MISMATCH', 502);
    const issueOutput = await run(uvtoolsExecutable, ['--quiet', 'print-issues', gooPath, ...CHECKS], uvOptions);
    const analysis = parseIssueReport(issueOutput);
    const finalHash = hash(await fs.readFile(gooPath));
    if (finalHash !== inspection.sha256) throw fail('The resin artifact changed during analysis.', 'RESIN_ARTIFACT_CHANGED', 409);
    // One submitted source instance; this does not count disconnected geometry,
    // physical parts, or accepted production units. No duplication flags are used.
    const attempt = { modelCopiesPerRun: 1, orientation, analysis, inspection, filePath: gooPath, fileName: 'prepared.goo', bytes: gooStat.size, sha256: finalHash, sl1Sha256: sl1.sha256, effectivePresetSha256: sl1.effectivePresetSha256 };
    attempts.push(attempt);
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ ...attempt, tool, profileSha256, logs }, null, 2));
    if (analysis.passed) break;
  }
  const selected = attempts.find(attempt => attempt.analysis.passed) || attempts.reduce((best, attempt) => attempt.analysis.count < best.analysis.count ? attempt : best);
  signal?.throwIfAborted();
  // A later orientation's provider work must not invalidate an earlier winner.
  // Recheck the artifact we actually return, not only the last attempted file.
  const selectedStat = await fs.stat(selected.filePath);
  if (!selectedStat.isFile() || selectedStat.size !== selected.bytes || selectedStat.size > MAX_BYTES || hash(await fs.readFile(selected.filePath)) !== selected.sha256) throw fail('The selected resin artifact changed after analysis.', 'RESIN_ARTIFACT_CHANGED', 409);
  if (hash(await fs.readFile(inputPath)) !== hash(original)) throw fail('The source model changed during resin slicing.', 'ORIGINAL_CHANGED', 409);
  signal?.throwIfAborted();
  return { ...selected, status: selected.analysis.passed ? 'sliced_pending_qualification' : 'analysis_failed', printReady: false, printerCompatible: false, format: 'goo', sourceSha256: hash(original), profileSha256, printerId: profile.printerId, printerModel: profile.printerModel, material: profile.material, tool, attempts: attempts.map(({ filePath, orientation, analysis }) => ({ filePath, orientation, analysis })), createdAt: new Date().toISOString() };
}

module.exports = { prepareResin, loadProfile, parseIni, parseIssueReport, inspectSl1, parameterScript, assertTargetProperties };
