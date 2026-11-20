#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { provisionResinCadRuntime } = require('../src/slicing/resin-cad-runtime');

const HELP = `Set up the pinned, isolated STEP transfer-audit runtime.

Usage:
  node scripts/setup-resin-cad.js --output-dir <new-directory> [--offline-dir <wheel-directory>]

Requires a separate compatible CPython 3.11 Windows x64 interpreter (for
example the verified FreeCAD bundled interpreter). This command only extracts
verified wheel files; it does not run Python, pip, or modify system/user Python.
The two pinned official PyPI wheels download automatically unless --offline-dir
contains their exact filenames and checksums. Existing unrecognized directories
are refused. A managed installation is reused only after every file is verified.

Use the printed absolute cadAuditPath in the QuickPrint CAD provider settings.
Run the Python workers with -I -B and keep this managed directory unchanged.
`;

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); return; }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--output-dir', '--offline-dir'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || options[key]) throw new Error('Use --output-dir <new-directory> and optionally --offline-dir <wheel-directory>. See --help.');
    options[key] = args[++i];
  }
  if (!options['--output-dir']) throw new Error('An explicit --output-dir is required. See --help.');
  const result = await provisionResinCadRuntime({ outputDir: path.resolve(options['--output-dir']), offlineDir: options['--offline-dir'] ? path.resolve(options['--offline-dir']) : undefined });
  process.stdout.write(JSON.stringify({ cadAuditPath: result.cadAuditPath, distributionVersion: result.distributionVersion, receiptPath: result.receiptPath, reused: result.reused }, null, 2) + '\n');
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write('CAD runtime setup failed: ' + error.message + '\n'); process.exitCode = 1; });
module.exports = { main };
