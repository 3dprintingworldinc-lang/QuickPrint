#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepareResinHollowPlan, createResinHollow3mf } = require('../src/slicing/resin-hollow-plan');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const USAGE = `Build a source-bound hollow/drain request for native provider verification.

node scripts/prepare-resin-hollow.js --model SIZED_NORMALIZED_MM.stl \\
  --request REQUEST.json --output NEW_DIRECTORY

REQUEST.json contains exactly schemaVersion: 1, request and placement.
The request pins original source, sized geometry and sizing-review SHA-256 hashes,
Z/X/Y orientation, hollow settings and explicit drain cylinders in sized mm.
Placement contains x, y and z millimetres for one native reference instance.

Writes input.3mf, hollow-overrides.ini, plan.json and manifest.json into a new
directory. This creates an unverified request; it does not slice, qualify an
order or operate a printer. Production hollowing remains unavailable.
`;
async function boundedRead(filename, maximum) {
  const file = await fs.open(path.resolve(filename), 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error('Input must be a nonempty regular file within its byte limit.');
    const bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < bytes.length) { const { bytesRead } = await file.read(bytes, position, bytes.length - position, position); if (!bytesRead) throw new Error('Input was truncated while reading.'); position += bytesRead; }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Input changed while reading.');
    return bytes;
  } finally { await file.close(); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(USAGE); return; }
  const options = {}, allowed = ['--model', '--request', '--output'];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.includes(key) || Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new Error('Use exactly --model, --request and --output. See --help.');
    options[key] = value;
  }
  if (allowed.some(key => !options[key])) throw new Error('Use --model, --request and --output. See --help.');
  const [source, json] = await Promise.all([boundedRead(options['--model'], 100 * 1024 * 1024), boundedRead(options['--request'], 128 * 1024)]);
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1 || Object.keys(input).sort().join(',') !== 'placement,request,schemaVersion') throw new Error('Request JSON must contain exactly schemaVersion: 1, request and placement.');
  const prepared = prepareResinHollowPlan(source, input.request), native = createResinHollow3mf(source, prepared.plan, input.request.binding, input.placement);
  const files = new Map([
    ['input.3mf', native.threeMf],
    ['hollow-overrides.ini', Buffer.from(Object.entries(prepared.plan.native.presetOverrides).map(([key, value]) => `${key} = ${value}\n`).join(''))],
    ['plan.json', Buffer.from(JSON.stringify(prepared.plan, null, 2) + '\n')],
  ]);
  const manifest = { schemaVersion: 1, method: prepared.plan.method, sourceBinding: prepared.plan.request.binding, planSha256: native.planSha256, placement: native.placement, files: Object.fromEntries([...files].map(([filename, bytes]) => [filename, { sha256: hash(bytes), sizeBytes: bytes.length }])), verification: prepared.plan.verification };
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  const directory = path.resolve(options['--output']);
  // A fresh directory prevents overwriting either source/review input or an
  // earlier request. No provider or hardware command is executed here.
  await fs.mkdir(directory);
  for (const [filename, bytes] of files) await fs.writeFile(path.join(directory, filename), bytes, { flag: 'wx' });
  process.stdout.write(JSON.stringify({ outputDirectory: directory, manifestPath: path.join(directory, 'manifest.json'), planSha256: native.planSha256, threeMfSha256: native.sha256, productionEligible: false }, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(`${error.code || 'RESIN_HOLLOW_REQUEST_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
