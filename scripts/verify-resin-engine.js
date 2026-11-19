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

Creates unique preparation attempts and a JSON verification report. Issue-free
output still requires printer/material qualification; this script has no printer
dispatch operation. Exit 2 means the model still has reported print issues.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(USAGE); return; }
  const allowed = new Set(['--model', '--profile', '--prusa', '--uvtools', '--output', '--unit-scale', '--timeout-ms']);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || values[key] !== undefined || !value || value.startsWith('--')) throw new Error(`Invalid argument ${key || ''}. Use --help.`);
    values[key] = value;
  }
  for (const key of ['--model', '--profile', '--prusa', '--uvtools', '--output']) if (!values[key]) throw new Error(`Required argument ${key} is missing. Use --help.`);
  const timeoutMs = values['--timeout-ms'] === undefined ? 900000 : Number(values['--timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('Timeout must be between 1000 and 3600000 whole milliseconds.');
  const outputDir = path.resolve(values['--output']);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let result;
  try {
    result = await prepareResin({
      inputPath: path.resolve(values['--model']), profilePath: path.resolve(values['--profile']),
      prusaExecutable: path.resolve(values['--prusa']), uvtoolsExecutable: path.resolve(values['--uvtools']),
      outputDir, unitScale: values['--unit-scale'] === undefined ? 1 : Number(values['--unit-scale']), timeoutMs, signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  const reportPath = path.join(outputDir, `verification-${crypto.randomUUID()}.json`);
  await fs.writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  process.stdout.write(JSON.stringify({
    status: result.status, reportPath, artifactPath: result.filePath, sha256: result.sha256,
    sourceSha256: result.sourceSha256, profileSha256: result.profileSha256,
    tool: result.tool, attempts: result.attempts.length, orientation: result.orientation,
    modelCopiesPerRun: result.modelCopiesPerRun,
    layerCount: result.inspection.layerCount, resolutionX: result.inspection.resolutionX, resolutionY: result.inspection.resolutionY,
    issueCount: result.analysis.count, printReady: result.printReady, printerCompatible: result.printerCompatible,
  }, null, 2) + '\n');
  if (!result.analysis.passed) process.exitCode = 2;
}

main().catch(error => { process.stderr.write(`${error.code || 'VERIFICATION_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
