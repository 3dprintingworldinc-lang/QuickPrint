#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareResin } = require('../src/slicing/resin-engine');

const USAGE = `Verify a configured resin preparation pipeline with real local providers.

node scripts/verify-resin-engine.js --model MODEL.stl --profile PROFILE.json \\
  --prusa PRUSA_EXECUTABLE --uvtools UVTOOLS_COMMAND_EXECUTABLE --output DIRECTORY

Optional: --unit-scale 1|25.4|1000 --timeout-ms 900000
          --sizing-scale FACTOR or --dimension-x|--dimension-y|--dimension-z MM

Dimensions refer to source axes before orientation and scale the whole model
uniformly. Only one sizing option may be supplied. Original size is the default.

Creates unique preparation attempts and a JSON verification report. Issue-free
output still requires printer/material qualification; this script has no printer
dispatch operation. Exit 2 means the model still has reported print issues.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(USAGE); return; }
  const sizingOptions = ['--sizing-scale', '--dimension-x', '--dimension-y', '--dimension-z'];
  const allowed = new Set(['--model', '--profile', '--prusa', '--uvtools', '--output', '--unit-scale', '--timeout-ms', ...sizingOptions]);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || values[key] !== undefined || !value || value.startsWith('--')) throw new Error(`Invalid argument ${key || ''}. Use --help.`);
    values[key] = value;
  }
  for (const key of ['--model', '--profile', '--prusa', '--uvtools', '--output']) if (!values[key]) throw new Error(`Required argument ${key} is missing. Use --help.`);
  const timeoutMs = values['--timeout-ms'] === undefined ? 900000 : Number(values['--timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('Timeout must be between 1000 and 3600000 whole milliseconds.');
  const selectedSizing = sizingOptions.filter(key => values[key] !== undefined);
  if (selectedSizing.length > 1) throw new Error('Choose only one of --sizing-scale, --dimension-x, --dimension-y or --dimension-z.');
  let sizing = { mode: 'original' };
  if (selectedSizing.length) {
    const key = selectedSizing[0], value = Number(values[key]);
    if (!Number.isFinite(value) || value <= 0 || value > 10000 || (key === '--sizing-scale' && value < 0.0001)) throw new Error('Sizing must be positive and at most 10000; scale must be at least 0.0001.');
    sizing = key === '--sizing-scale' ? { mode: 'scale', factor: value } : { mode: 'dimension', axis: key.at(-1), millimeters: value };
  }
  const outputDir = path.resolve(values['--output']);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let result;
  try {
    result = await prepareResin({
      inputPath: path.resolve(values['--model']), profilePath: path.resolve(values['--profile']),
      prusaExecutable: path.resolve(values['--prusa']), uvtoolsExecutable: path.resolve(values['--uvtools']),
      outputDir, unitScale: values['--unit-scale'] === undefined ? 1 : Number(values['--unit-scale']), sizing, timeoutMs, signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  const reportPath = path.join(outputDir, `verification-${crypto.randomUUID()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  process.stdout.write(JSON.stringify({
    status: result.status, reportPath, artifactPath: result.filePath, sha256: result.sha256,
    sourceSha256: result.sourceSha256, profileSha256: result.profileSha256,
    sizingPlan: result.sizingPlan, inputGeometry: result.inputGeometry,
    tool: result.tool, attempts: result.attempts.length, orientation: result.orientation,
    modelCopiesPerRun: result.modelCopiesPerRun,
    layerCount: result.inspection.layerCount, resolutionX: result.inspection.resolutionX, resolutionY: result.inspection.resolutionY,
    issueCount: result.analysis.count, printReady: result.printReady, printerCompatible: result.printerCompatible,
  }, null, 2) + '\n');
  if (!result.analysis.passed) process.exitCode = 2;
}

main().catch(error => { process.stderr.write(`${error.code || 'VERIFICATION_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
