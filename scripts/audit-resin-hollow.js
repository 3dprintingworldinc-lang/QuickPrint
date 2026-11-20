#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { auditResinHollowReferences, verifyResinHollowReferenceAudit } = require('../src/slicing/resin-hollow-audit');
const { auditResinHollowFinal, verifyResinHollowFinalAudit } = require('../src/slicing/resin-hollow-final-audit');
const USAGE = `Audit paired native hollow reference rasters against their reviewed source.

node scripts/audit-resin-hollow.js --request REQUEST.json --output NEW_REPORT.json
node scripts/audit-resin-hollow.js --request REQUEST.json --verify SAVED_REPORT.json

Request paths resolve relative to REQUEST.json. Pin the source/plan/sizing,
native GOO hashes, complete native 3MF inputs, effective presets, target properties,
provider fingerprint, placement and an explicit fixed grid/uncertainty policy.

An optional supports:{planPath,presetPath} binds authored contacts and prior
regions. An optional final native artifact selects complete supported-output
verification. Elevated references use the explicit suppressed-support-elevation
policy without authored points or enforcer volumes; pad geometry is disabled.
This command never slices, accepts an order or operates a printer. A conforming raster band
is not native-invocation attestation, geometric/physical wall certification or
production qualification. Exit 0=conforming, 2=nonconforming, 3=inconclusive.
`;
async function read(filename, maximum) {
  const handle = await fs.open(filename, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) throw new Error('Input must be a nonempty bounded regular file.');
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw new Error('Input was truncated during reading.'); offset += result.bytesRead; }
    const after = await handle.stat({ bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('Input changed during reading.');
    return bytes;
  } finally { await handle.close(); }
}
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(USAGE); return; }
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const [key, value] = args.slice(index, index + 2);
    if (!['--request', '--output', '--verify'].includes(key) || Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new Error('Use --request and exactly one of --output or --verify. See --help.');
    options[key] = value;
  }
  if (!options['--request'] || Boolean(options['--output']) === Boolean(options['--verify'])) throw new Error('Use --request and exactly one of --output or --verify. See --help.');
  if (options['--output']) {
    try { await fs.lstat(path.resolve(options['--output'])); throw Object.assign(new Error('Output report already exists.'), { code: 'EEXIST' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const requestPath = path.resolve(options['--request']), directory = path.dirname(requestPath), request = json(await read(requestPath, 256 * 1024));
  const required = ['schemaVersion', 'sourcePath', 'planPath', 'expectedBinding', 'solid', 'hollow', 'provider', 'targetProperties', 'placement', 'policy'];
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.schemaVersion !== 1 || required.some(key => !Object.hasOwn(request, key)) || Object.keys(request).some(key => ![...required, 'supports', 'final', 'limits'].includes(key))) throw new Error('Unsupported hollow audit request schema.');
  const resolve = value => { if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Request file paths must be nonempty strings.'); return path.resolve(directory, value); };
  async function reference(value) {
    const fields = ['filePath', 'sha256', 'input3mfPath', 'effectivePresetPath'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new Error('Each native reference requires filePath, sha256, input3mfPath and effectivePresetPath.');
    return { filePath: resolve(value.filePath), sha256: value.sha256, input3mf: await read(resolve(value.input3mfPath), 32 * 1024 * 1024), effectivePreset: await read(resolve(value.effectivePresetPath), 1024 * 1024) };
  }
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const input = { source: await read(resolve(request.sourcePath), 84 + 250000 * 50), plan: json(await read(resolve(request.planPath), 256 * 1024)), expectedBinding: request.expectedBinding,
      solid: await reference(request.solid), hollow: await reference(request.hollow), provider: request.provider, targetProperties: request.targetProperties, placement: request.placement, policy: request.policy, ...(request.limits === undefined ? {} : { limits: request.limits }), signal: controller.signal };
    if (request.supports !== undefined) {
      const value = request.supports;
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'planPath') || !Object.hasOwn(value, 'presetPath')) throw new Error('Support authority requires exactly planPath and presetPath.');
      input.supports = { plan: json(await read(resolve(value.planPath), 2 * 1024 * 1024)), preset: await read(resolve(value.presetPath), 1024 * 1024) };
    }
    if (request.final !== undefined) input.final = await reference(request.final);
    const audit = request.final === undefined ? auditResinHollowReferences : auditResinHollowFinal, verify = request.final === undefined ? verifyResinHollowReferenceAudit : verifyResinHollowFinalAudit;
    const result = options['--verify'] ? await verify(input, json(await read(path.resolve(options['--verify']), 8 * 1024 * 1024))) : await audit(input);
    if (options['--output']) await fs.writeFile(path.resolve(options['--output']), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ disposition: result.disposition, sha256: result.sha256, reportPath: path.resolve(options['--output'] || options['--verify']), productionEligible: false }, null, 2) + '\n');
    process.exitCode = result.disposition === 'conforming' ? 0 : result.disposition === 'nonconforming' ? 2 : 3;
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
main().catch(error => { process.stderr.write(`${error.code || 'RESIN_HOLLOW_AUDIT_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
