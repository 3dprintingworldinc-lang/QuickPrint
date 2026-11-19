#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { prepareResinCad, verifyResinCadGeometry } = require('../src/slicing/resin-cad');

const HELP = `Verify STEP transfer, CAD inventory and tessellation with installed providers.

node scripts/verify-resin-cad.js --model MODEL.step --freecad FREECADCMD.exe \\
  --audit-runtime ISOLATED_SITE_PACKAGES --output DIRECTORY

Optional: --linear-deflection-mm 0.005 --angular-deflection-rad 0.1
          --timeout-ms 900000

The source is preserved. Embedded STEP units become millimetres exactly once.
Two isolated Python processes inspect STEP transfer and tessellate all solids;
the Node verifier checks native diagnostics, CAD inventory and mesh evidence.
This command has no printer dispatch operation.
`;

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(HELP); return; }
  const values = {}, allowed = new Set(['--model', '--freecad', '--audit-runtime', '--output', '--linear-deflection-mm', '--angular-deflection-rad', '--timeout-ms']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || Object.hasOwn(values, key) || !value || value.startsWith('--')) throw new Error('Use the documented arguments; see --help.');
    values[key] = value;
  }
  for (const key of ['--model', '--freecad', '--audit-runtime', '--output']) if (!values[key]) throw new Error(`Required argument ${key} is missing; see --help.`);
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const inputPath = path.resolve(values['--model']), outputDir = path.resolve(values['--output']);
    const record = await prepareResinCad({ inputPath, outputDir, freecadExecutable: path.resolve(values['--freecad']), cadAuditPath: path.resolve(values['--audit-runtime']), signal: controller.signal,
      ...(values['--linear-deflection-mm'] ? { linearDeflectionMm: Number(values['--linear-deflection-mm']) } : {}),
      ...(values['--angular-deflection-rad'] ? { angularDeflectionRad: Number(values['--angular-deflection-rad']) } : {}),
      ...(values['--timeout-ms'] ? { timeoutMs: Number(values['--timeout-ms']) } : {}) });
    await verifyResinCadGeometry(record, { source: await fs.readFile(inputPath), directory: outputDir });
    process.stdout.write(JSON.stringify({ status: 'verified_cad_mesh', filePath: record.filePath, sourceSha256: record.sourceSha256, meshSha256: record.sha256, bytes: record.bytes,
      dimensionsMm: record.measurement.sourceDimensionsMm, originMm: record.originMm, solids: record.cad.solidCount, triangles: record.measurement.triangleCount,
      tolerance: record.tolerance, tool: record.tool.version, diagnostics: record.transferAudit.diagnostics, reportPath: path.join(path.dirname(record.filePath), 'conversion.json') }, null, 2) + '\n');
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.code || 'CAD_VERIFICATION_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
