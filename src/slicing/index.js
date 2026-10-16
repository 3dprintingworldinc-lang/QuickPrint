'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { inspectZip, readZipEntry, parseSliceInfo, canonicalPrinterModel } = require('./psam/zip-inspection');

const MAX_BYTES = 100 * 1024 * 1024;
const ZIP_LIMITS = { maxArchiveBytes: MAX_BYTES, maxEntryBytes: MAX_BYTES, maxTotalUncompressedBytes: 512 * 1024 * 1024, maxEntries: 4096, maxCompressionRatio: 250 };
const BAMBU_MODEL = /bambu|bl[-_]?p00[12]|\b(?:c11|c12|x1c?|x1e|x1\s*carbon|p1p|p1s|p2s|h2[sdce]|x2d|a1(?:\s*mini)?)\b/i;
const BAMBU_COMMAND = /^\s*(?:N\d+\s+)?M(?:620|621|1002|1006|981)\b/im;
function failure(message, code = 'PREPARATION_FAILED', status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function checkGcode(buffer) {
  if (!buffer.length || buffer.includes(0)) throw failure('The file is not text G-code.', 'INVALID_GCODE');
  const text = buffer.toString('utf8');
  if (!/^(?:N\d+\s+)?G(?:0?0|0?1|28|29|90|91)\b/im.test(text)) throw failure('No motion commands were found in this G-code.', 'INVALID_GCODE');
  return buffer;
}
function inspectArtifact(buffer, filename) {
  if (buffer.length > MAX_BYTES) throw failure('Print files are limited to 100 MiB.', 'FILE_TOO_LARGE', 413);
  if (/\.(gcode|gco)$/i.test(filename)) {
    checkGcode(buffer);
    return { kind: 'gcode', gcode: buffer };
  }
  if (/\.3mf$/i.test(filename)) {
    let archive;
    try { archive = inspectZip(buffer, ZIP_LIMITS); } catch (error) { throw failure(`Invalid 3MF: ${error.message}`, 'INVALID_3MF'); }
    const plates = archive.entries.filter(entry => /^metadata\/plate_\d+\.gcode$/i.test(entry.name));
    if (plates.length > 1) throw failure('Export a single sliced plate per file before importing. Multi-plate files need separate jobs.', 'MULTIPLE_PLATES');
    if (plates.length) {
      if (plates[0].lookupName !== 'metadata/plate_1.gcode') throw failure('Export the selected plate as plate 1 in a single-plate file.', 'UNSUPPORTED_PLATE');
      const gcode = readZipEntry(buffer, plates[0], ZIP_LIMITS);
      checkGcode(gcode);
      const infoEntry = archive.entries.find(entry => entry.lookupName === 'metadata/slice_info.config');
      let sliceInfo = null;
      if (infoEntry) {
        try { sliceInfo = parseSliceInfo(readZipEntry(buffer, infoEntry, ZIP_LIMITS).toString('utf8'), 1); }
        catch { throw failure('The sliced plate metadata is invalid.', 'INVALID_SLICE_METADATA'); }
      }
      return { kind: 'gcode.3mf', gcode, plate: 1, sliceInfo };
    }
    if (!archive.entries.some(entry => /\.model$/i.test(entry.name))) throw failure('The 3MF contains neither a model nor a sliced plate.', 'INVALID_3MF');
    return { kind: 'model' };
  }
  if (/\.(stl|step|stp|obj)$/i.test(filename)) return { kind: 'model' };
  throw failure('Supported inputs: STEP, STP, STL, OBJ, 3MF, G-code.', 'UNSUPPORTED_FORMAT');
}

function runProcess(executable, args, { timeoutMs = 15 * 60 * 1000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('Preparation cancelled.', 'ABORTED'));
    const child = spawn(executable, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false, stopReason = null, timer, forceTimer, deadline;
    const capture = data => { output = (output + data.toString()).slice(-16384); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(output);
    };
    const killTree = force => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
        killer.unref();
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
      }
    };
    const terminate = reason => {
      if (settled || stopReason) return;
      stopReason = reason;
      killTree(false);
      forceTimer = setTimeout(() => killTree(true), 500);
      deadline = setTimeout(() => {
        killTree(true); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(stopReason);
      }, 3000);
    };
    const abort = () => terminate(failure('Preparation cancelled.', 'ABORTED'));
    timer = setTimeout(() => terminate(failure('The slicer exceeded its time limit.', 'SLICER_TIMEOUT')), Math.max(100, Math.min(timeoutMs, 60 * 60 * 1000)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', error => finish(failure(`Could not start the slicer: ${error.code || error.message}. Check the executable path in Settings.`, 'SLICER_START_FAILED')));
    child.on('close', code => {
      if (stopReason) return finish(stopReason);
      if (code !== 0) return finish(failure(`Slicer exited with code ${code}. ${output.slice(-2000)}`, 'SLICER_FAILED'));
      finish();
    });
  });
}

function buildArguments({ kind, inputPath, outputDir, outputName, profiles, extraArgs = [] }) {
  if (!Array.isArray(extraArgs) || extraArgs.some(arg => typeof arg !== 'string' || arg.includes('\0')) || extraArgs.length > 30) throw failure('Extra slicer arguments must be an array of up to 30 strings.', 'INVALID_SLICER_SETTINGS');
  if (extraArgs.some(arg => /^--(?:output|outputdir|export|load|slice|datadir|config)/i.test(arg))) throw failure('Output, profile, and slicing arguments are managed by QuickPrint.', 'INVALID_SLICER_SETTINGS');
  if (kind === 'prusa') {
    if (/\.(step|stp)$/i.test(inputPath)) throw failure('This integration requires STEP models to be exported to STL before PrusaSlicer preparation. Use a STEP-capable Orca/Bambu build or supply STL.', 'STEP_CONVERSION_REQUIRED');
    return [...profiles.flatMap(file => ['--load', file]), ...extraArgs, '--export-gcode', '--output', path.join(outputDir, outputName), inputPath];
  }
  if (!['bambu', 'orca'].includes(kind)) throw failure('Choose OrcaSlicer, Bambu Studio, or PrusaSlicer in Settings.', 'INVALID_SLICER_SETTINGS');
  if (profiles.length !== 3) throw failure('Select three exported preset files in this order: machine, process, filament.', 'PROFILES_REQUIRED');
  return ['--load-settings', `${profiles[0]};${profiles[1]}`, '--load-filaments', profiles[2], ...extraArgs, '--arrange', '1', '--ensure-on-bed', '--slice', '0', '--export-3mf', outputName, '--outputdir', outputDir, inputPath];
}

async function prepare({ inputPath, outputDir, printer, settings = {}, signal }) {
  if (!printer?.id || !printer.type) throw failure('Select a configured printer before preparing a job.', 'PRINTER_REQUIRED');
  const inputStat = await fs.stat(inputPath);
  if (!inputStat.isFile() || inputStat.size > MAX_BYTES) throw failure('Input must be a file no larger than 100 MiB.', 'FILE_TOO_LARGE', 413);
  let buffer = await fs.readFile(inputPath);
  let inspected = inspectArtifact(buffer, path.basename(inputPath));
  const config = { ...(settings.slicer || {}), ...(printer.slicer || {}) };
  const profileHash = crypto.createHash('sha256');
  profileHash.update(JSON.stringify({ printerId: printer.id, type: printer.type, model: printer.model || '', kind: config.kind || '', executable: config.executable || '' }));
  await fs.mkdir(outputDir, { recursive: true });
  const metadata = { source: path.basename(inputPath), printerId: printer.id, printerType: printer.type, sourceSha256: crypto.createHash('sha256').update(buffer).digest('hex'), preparedAt: new Date().toISOString() };
  if (inspected.kind === 'model') {
    if (!config.executable) throw failure('Install a supported slicer, then select its executable and printer-specific exported profiles in Settings. You can also import an already sliced file.', 'SLICER_REQUIRED');
    const profiles = Array.isArray(config.profilePaths) ? config.profilePaths.map(file => path.resolve(file)) : [];
    if (!profiles.length) throw failure('Export profiles for the selected printer and add their paths in Settings.', 'PROFILES_REQUIRED');
    for (const profile of profiles) {
      let contents;
      try { contents = await fs.readFile(profile); } catch { throw failure(`Profile not found: ${path.basename(profile)}.`, 'PROFILE_NOT_FOUND'); }
      profileHash.update(contents);
    }
    const kind = config.kind || 'orca';
    if (printer.type !== 'bambu' && ['bambu', 'orca'].includes(kind)) {
      if (kind === 'bambu') throw failure('Use a slicer and profiles for this printer family. Bambu Studio output is not accepted for generic firmware.', 'INCOMPATIBLE_SLICER');
      let machine;
      try { machine = JSON.parse(await fs.readFile(profiles[0], 'utf8')); } catch { throw failure('The machine preset must be an exported JSON profile.', 'INVALID_MACHINE_PROFILE'); }
      const identity = ['printer_model', 'printer_settings_id', 'name', 'inherits', 'gcode_flavor'].map(key => machine[key] || '').join(' ');
      if (BAMBU_MODEL.test(identity)) throw failure('This machine profile is for Bambu. Export an Orca machine profile for the selected printer.', 'INCOMPATIBLE_MACHINE_PROFILE');
      const flavor = String(machine.gcode_flavor || '').toLowerCase();
      if (printer.type === 'moonraker' && flavor && flavor !== 'klipper') throw failure('Moonraker preparation requires a Klipper machine profile.', 'INCOMPATIBLE_MACHINE_PROFILE');
      if (printer.type === 'duet' && flavor && !['reprap', 'reprapfirmware'].includes(flavor)) throw failure('Duet preparation requires a RepRapFirmware machine profile.', 'INCOMPATIBLE_MACHINE_PROFILE');
    }
    if (kind === 'prusa' && printer.type === 'bambu') throw failure('Bambu LAN printing requires a Bambu/Orca sliced 3MF. Select that slicer for this printer.', 'INCOMPATIBLE_SLICER');
    const tempDir = await fs.mkdtemp(path.join(outputDir, 'slice-'));
    const outputName = kind === 'prusa' ? 'prepared.gcode' : 'prepared.gcode.3mf';
    try {
      const args = buildArguments({ kind, inputPath: path.resolve(inputPath), outputDir: tempDir, outputName, profiles, extraArgs: config.extraArgs || [] });
      await runProcess(config.executable, args, { signal, timeoutMs: config.timeoutMs });
      const produced = path.join(tempDir, outputName);
      const stat = await fs.stat(produced).catch(() => null);
      if (!stat?.isFile() || stat.size > MAX_BYTES) throw failure('The slicer did not create the expected print artifact. Check its version, input support, and exported profiles.', 'SLICER_OUTPUT_MISSING');
      buffer = await fs.readFile(produced);
      inspected = inspectArtifact(buffer, outputName);
      if (inspected.kind === 'model') throw failure('The slicer exported a model without printer instructions.', 'UNSLICED_OUTPUT');
      metadata.slicer = kind;
    } finally { await fs.rm(tempDir, { recursive: true, force: true }); }
  }
  if (printer.type === 'bambu' && inspected.kind !== 'gcode.3mf') throw failure('Bambu LAN printing needs a sliced, single-plate .gcode.3mf exported for this printer.', 'INCOMPATIBLE_ARTIFACT');
  if (printer.type !== 'bambu') {
    const model = inspected.sliceInfo?.metadata?.printer_model_id || inspected.sliceInfo?.metadata?.printer_model || '';
    if (BAMBU_MODEL.test(model) || BAMBU_COMMAND.test((inspected.gcode || buffer).toString('utf8'))) throw failure('The prepared file contains Bambu-specific model metadata or commands. Slice it using profiles for the selected printer.', 'INCOMPATIBLE_ARTIFACT');
  }
  if (printer.type === 'bambu') {
    const filaments = inspected.sliceInfo?.filaments || [];
    const used = filaments.filter(item => Number(item.used_g || item.used_m || 0) > 0);
    if ((used.length ? used : filaments).length !== 1) throw failure('This Bambu adapter requires single-filament slice metadata and uses the external spool. Export a single-material plate; AMS routing is not supported.', 'MULTI_FILAMENT_UNSUPPORTED');
    const normalizeModel = value => {
      const normalized = canonicalPrinterModel(String(value || '').replace(/bambu\s*lab/ig, ''));
      return ({ C11: 'P1P', C12: 'P1S' })[normalized] || normalized;
    };
    const encodedModel = normalizeModel(inspected.sliceInfo.metadata.printer_model_id || inspected.sliceInfo.metadata.printer_model);
    const configuredModel = normalizeModel(printer.model);
    if (!encodedModel || !configuredModel || encodedModel !== configuredModel) throw failure('The sliced plate model does not match the selected Bambu printer. Export it with the correct machine profile and set the printer model.', 'PRINTER_MODEL_MISMATCH');
    metadata.slicePrinterModel = encodedModel;
  }
  let format = inspected.kind;
  if (printer.type !== 'bambu' && inspected.kind === 'gcode.3mf') {
    // Bambu-specific instructions must never be forwarded to generic firmware.
    if (!metadata.slicer || metadata.slicer !== 'orca') throw failure('Import plain G-code sliced for this printer. A Bambu sliced 3MF cannot be reused on another printer family.', 'INCOMPATIBLE_ARTIFACT');
    buffer = inspected.gcode; format = 'gcode';
  }
  const fileName = `prepared.${format}`;
  const filePath = path.join(outputDir, fileName);
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, buffer, { flag: 'wx' });
  await fs.rename(temporary, filePath);
  return { filePath, fileName, format, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), profileFingerprint: profileHash.digest('hex'), metadata };
}

module.exports = { prepare, inspectArtifact, buildArguments, runProcess };
