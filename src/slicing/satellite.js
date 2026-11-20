'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runProcess } = require('./index');

const DEFAULT_INSTALL = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ELEGOO SatelLite', 'ELEGOO SatelLite');
const EXECUTABLE = 'ELEGOO SatelLite.exe';
const MAX_BYTES = 100 * 1024 * 1024;
const FLAGS = ['--add-model', '--output', '--hide', '--evaluate', '--fix', '--hollow'];

function failure(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function capabilitiesFromHelp(help) {
  const flags = Object.fromEntries(FLAGS.map(flag => [flag, help.includes(flag)]));
  return {
    importModel: flags['--add-model'],
    evaluate: flags['--evaluate'],
    repair: flags['--fix'],
    hollow: flags['--hollow'],
    hidden: flags['--hide'],
    outputDirectory: flags['--output'],
    // No slicing/support/export CLI is documented by the inspected build.
    generateSupports: false,
    slice: false,
    exportGoo: false,
    dispatch: false,
    endToEndQualified: false,
  };
}

async function inspectInstallation(installDir = DEFAULT_INSTALL, { run = runProcess, signal } = {}) {
  if (typeof installDir !== 'string' || !installDir || !path.isAbsolute(installDir) || installDir.includes('\0')) {
    throw failure('SatelLite installation must be an absolute directory path.', 'INVALID_SATELLITE_INSTALLATION');
  }
  const executable = path.join(installDir, EXECUTABLE);
  try {
    if (!(await fs.stat(executable)).isFile()) throw new Error('not a file');
  } catch {
    return { installed: false, executable, code: 'SATELLITE_NOT_FOUND', capabilities: capabilitiesFromHelp('') };
  }
  const help = await run(executable, ['--help'], { timeoutMs: 15000, signal });
  if (!/ELEGOO SatelLite/i.test(help) || !FLAGS.every(flag => help.includes(flag))) {
    throw failure('This executable does not expose the inspected SatelLite preparation interface.', 'SATELLITE_INTERFACE_MISMATCH');
  }
  const versionOutput = await run(executable, ['--version'], { timeoutMs: 15000, signal });
  const version = /ELEGOO SatelLite\s+(\d+(?:\.\d+){2,3})/i.exec(versionOutput)?.[1];
  if (!version) throw failure('SatelLite did not report a recognizable version.', 'SATELLITE_VERSION_UNKNOWN');
  const executableSha256 = crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex');
  return { installed: true, executable, version, executableSha256, help, capabilities: capabilitiesFromHelp(help) };
}

function buildPreprocessArguments({ inputPath, outputDir, fix, hollowThicknessMm, evaluate = true }) {
  if (![inputPath, outputDir].every(value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'))) {
    throw failure('Preparation input and output must be absolute paths.', 'INVALID_SATELLITE_PATH');
  }
  if (fix !== undefined && !['simple', 'standard'].includes(fix)) {
    throw failure('SatelLite repair must be simple or standard.', 'INVALID_SATELLITE_REPAIR');
  }
  if (typeof evaluate !== 'boolean') throw failure('Model evaluation must be true or false.', 'INVALID_SATELLITE_EVALUATION');
  if (hollowThicknessMm !== undefined && (typeof hollowThicknessMm !== 'number' || !Number.isFinite(hollowThicknessMm) || hollowThicknessMm <= 0 || hollowThicknessMm > 50)) {
    throw failure('Hollow wall thickness must be greater than zero and at most 50 mm.', 'INVALID_SATELLITE_THICKNESS');
  }
  if (!evaluate && !fix && hollowThicknessMm === undefined) throw failure('Select a preparation operation.', 'SATELLITE_OPERATION_REQUIRED');
  const args = ['--hide', '--add-model', inputPath, '--output', outputDir];
  if (evaluate) args.push('--evaluate');
  if (fix) args.push('--fix', fix);
  if (hollowThicknessMm !== undefined) args.push('--hollow', String(hollowThicknessMm));
  return args;
}

async function inspectOutput(outputDir) {
  const files = [];
  let bytes = 0, entryCount = 0;
  async function visit(directory, depth) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++entryCount > 100 || depth > 3) throw failure('SatelLite output exceeds the file-count or depth limit.', 'SATELLITE_OUTPUT_LIMIT');
      const filePath = path.join(directory, entry.name);
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) throw failure('SatelLite output contains a symbolic link.', 'INVALID_SATELLITE_OUTPUT');
      if (stat.isDirectory()) { await visit(filePath, depth + 1); continue; }
      if (!stat.isFile()) throw failure('SatelLite output is not a regular file.', 'INVALID_SATELLITE_OUTPUT');
      bytes += stat.size;
      if (bytes > MAX_BYTES) throw failure('SatelLite output exceeds 100 MiB.', 'SATELLITE_OUTPUT_LIMIT');
      if (!stat.size) continue;
      const contents = await fs.readFile(filePath);
      const item = { filePath, fileName: path.relative(outputDir, filePath), bytes: stat.size, sha256: crypto.createHash('sha256').update(contents).digest('hex'), kind: 'other' };
      if (/\.(stl|obj|3mf)$/i.test(entry.name)) item.kind = 'model';
      if (/\.json$/i.test(entry.name) && stat.size <= 1024 * 1024) {
        try { item.report = JSON.parse(contents.toString('utf8')); item.kind = 'report'; } catch { /* Do not interpret malformed JSON as an evaluation report. */ }
      }
      files.push(item);
    }
  }
  await visit(outputDir, 0);
  return files;
}

async function preprocess({ inputPath, outputDir, executable = path.join(DEFAULT_INSTALL, EXECUTABLE), fix, hollowThicknessMm, evaluate = true, signal, timeoutMs = 2 * 60 * 1000 }, { run = runProcess } = {}) {
  // Validate arguments before creating files or starting a native process.
  buildPreprocessArguments({ inputPath, outputDir, fix, hollowThicknessMm, evaluate });
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')) throw failure('Select an absolute SatelLite executable path.', 'INVALID_SATELLITE_EXECUTABLE');
  if (path.basename(executable).toLowerCase() !== EXECUTABLE.toLowerCase()) throw failure('Select ELEGOO SatelLite.exe.', 'INVALID_SATELLITE_EXECUTABLE');
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 15 * 60 * 1000) throw failure('Preparation timeout must be between 100 ms and 15 minutes.', 'INVALID_SATELLITE_TIMEOUT');
  if (!/\.stl$/i.test(inputPath)) throw failure('This preparation probe currently accepts STL models only.', 'UNSUPPORTED_SATELLITE_INPUT');
  const inputStat = await fs.stat(inputPath);
  if (!inputStat.isFile() || inputStat.size < 1 || inputStat.size > MAX_BYTES) throw failure('Model must be a nonempty file no larger than 100 MiB.', 'INVALID_SATELLITE_INPUT');
  try {
    if (!(await fs.stat(executable)).isFile()) throw new Error('not a file');
  } catch {
    throw failure('SatelLite executable was not found.', 'SATELLITE_NOT_FOUND');
  }
  const installation = await inspectInstallation(path.dirname(executable), { run, signal });
  await fs.mkdir(outputDir, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(outputDir, 'satellite-'));
  const sourceDir = path.join(workDir, 'source');
  const resultDir = path.join(workDir, 'result');
  await fs.mkdir(sourceDir); await fs.mkdir(resultDir);
  const source = await fs.readFile(inputPath);
  const sourceCopy = path.join(sourceDir, 'model.stl');
  await fs.writeFile(sourceCopy, source, { flag: 'wx' });
  const args = buildPreprocessArguments({ inputPath: sourceCopy, outputDir: resultDir, fix, hollowThicknessMm, evaluate });
  const processOutput = await run(executable, args, { timeoutMs, signal });
  const files = await inspectOutput(resultDir);
  if (!files.some(file => file.kind === 'model' || file.kind === 'report')) {
    throw failure('SatelLite exited without a model or machine-readable evaluation report. The requested operations are not verified; no print-ready artifact was produced.', 'SATELLITE_NO_OUTPUT');
  }
  return {
    stage: 'preprocessed', printReady: false, slicingPerformed: false, evaluationPassed: null,
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    executableSha256: installation.executableSha256, version: installation.version,
    requestedOperations: { evaluate, fix: fix || null, hollowThicknessMm: hollowThicknessMm ?? null },
    files, processOutput, createdAt: new Date().toISOString(),
    qualification: 'Generated files were captured. Geometry quality and printer compatibility require separate validation.',
  };
}

module.exports = { inspectInstallation, preprocess, buildPreprocessArguments, capabilitiesFromHelp };
