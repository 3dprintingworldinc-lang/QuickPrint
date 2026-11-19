'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inspectInstallation, preprocess, buildPreprocessArguments, capabilitiesFromHelp } = require('../src/slicing/satellite');

const help = `ELEGOO SatelLite, Fast and Streamlined Preparation.
--add-model <filename> --output <out-folder> --hide --evaluate --fix <simple/standard> --hollow <thickness>`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-satellite-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'ELEGOO SatelLite.exe');
  const inputPath = path.join(root, 'part with spaces.stl');
  const outputDir = path.join(root, 'output');
  await fs.writeFile(executable, 'fixture only; never executed');
  await fs.writeFile(inputPath, 'solid fixture\nendsolid fixture\n');
  return { root, executable, inputPath, outputDir };
}

function fixtureRunner(prepare) {
  return async (executable, args, options) => {
    assert.equal(path.basename(executable), 'ELEGOO SatelLite.exe');
    assert.ok(options.timeoutMs > 0);
    if (args[0] === '--help') return help;
    if (args[0] === '--version') return 'ELEGOO SatelLite 1.0.2.18\n';
    assert.ok(args.includes('--hide'));
    const input = args[args.indexOf('--add-model') + 1];
    const output = args[args.indexOf('--output') + 1];
    return prepare ? prepare(input, output, args) : '';
  };
}

test('SatelLite capabilities distinguish documented preparation flags from unqualified slicing', () => {
  const capabilities = capabilitiesFromHelp(help);
  assert.equal(capabilities.repair, true);
  assert.equal(capabilities.hollow, true);
  assert.equal(capabilities.slice, false);
  assert.equal(capabilities.generateSupports, false);
  assert.equal(capabilities.exportGoo, false);
  assert.equal(capabilities.dispatch, false);
  assert.equal(capabilities.endToEndQualified, false);
});

test('SatelLite argument builder preserves paths and only uses registered preparation flags', () => {
  const inputPath = path.resolve('source folder', 'model.stl');
  const outputDir = path.resolve('output folder');
  const args = buildPreprocessArguments({ inputPath, outputDir, fix: 'standard', hollowThicknessMm: 2.25 });
  assert.deepEqual(args, ['--hide', '--add-model', inputPath, '--output', outputDir, '--evaluate', '--fix', 'standard', '--hollow', '2.25']);
  assert.throws(() => buildPreprocessArguments({ inputPath, outputDir, fix: '--slice' }), { code: 'INVALID_SATELLITE_REPAIR' });
  for (const hollowThicknessMm of [0, -1, NaN, Infinity, '2', 51]) {
    assert.throws(() => buildPreprocessArguments({ inputPath, outputDir, hollowThicknessMm }), { code: 'INVALID_SATELLITE_THICKNESS' });
  }
  assert.throws(() => buildPreprocessArguments({ inputPath, outputDir, evaluate: false }), { code: 'SATELLITE_OPERATION_REQUIRED' });
});

test('installation inspection captures version/help/hash and reports a missing install', async t => {
  const fixtureData = await fixture(t);
  const result = await inspectInstallation(fixtureData.root, { run: fixtureRunner() });
  assert.equal(result.installed, true);
  assert.equal(result.version, '1.0.2.18');
  assert.match(result.executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.capabilities.slice, false);
  const missing = await inspectInstallation(path.join(fixtureData.root, 'missing'));
  assert.equal(missing.installed, false);
  assert.equal(missing.capabilities.importModel, false);
  await assert.rejects(inspectInstallation(fixtureData.root, { run: async () => 'Other Slicer' }), { code: 'SATELLITE_INTERFACE_MISMATCH' });
});

test('zero exit without output fails; successful process output alone cannot mark preparation complete', async t => {
  const options = await fixture(t);
  await assert.rejects(preprocess(options, { run: fixtureRunner(() => 'Everything is fine') }), { code: 'SATELLITE_NO_OUTPUT' });
});

test('preparation preserves source, captures real output hashes, and never marks it print-ready', async t => {
  const options = await fixture(t);
  const original = await fs.readFile(options.inputPath);
  const result = await preprocess({ ...options, fix: 'simple' }, { run: fixtureRunner(async (input, output) => {
    assert.notEqual(input, options.inputPath);
    assert.deepEqual(await fs.readFile(input), original);
    await fs.writeFile(path.join(output, 'repaired.stl'), 'solid repaired\nendsolid repaired\n');
    await fs.writeFile(path.join(output, 'evaluation.json'), JSON.stringify({ fixture: true, issues: 4 }));
    return 'captured output';
  }) });
  assert.equal(result.printReady, false);
  assert.equal(result.slicingPerformed, false);
  assert.equal(result.evaluationPassed, null);
  assert.equal(result.files.length, 2);
  assert.match(result.files.find(file => file.kind === 'model').sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.files.find(file => file.kind === 'report').report, { fixture: true, issues: 4 });
  assert.deepEqual(await fs.readFile(options.inputPath), original);
});

test('unrecognized or empty outputs do not count as a model or evaluation report', async t => {
  const options = await fixture(t);
  await assert.rejects(preprocess(options, { run: fixtureRunner(async (input, output) => {
    await fs.writeFile(path.join(output, 'report.json'), 'not json');
    await fs.writeFile(path.join(output, 'model.stl'), '');
    return '';
  }) }), { code: 'SATELLITE_NO_OUTPUT' });
});

test('abort/error from the process runner propagates without a fabricated result', async t => {
  const options = await fixture(t);
  const error = Object.assign(new Error('Cancelled'), { code: 'ABORTED' });
  await assert.rejects(preprocess(options, { run: fixtureRunner(async () => { throw error; }) }), { code: 'ABORTED' });
});

test('unsupported inputs and invalid values are rejected before launching SatelLite', async t => {
  const options = await fixture(t);
  let runs = 0;
  const run = async () => { runs++; };
  await assert.rejects(preprocess({ ...options, inputPath: path.join(options.root, 'file.goo') }, { run }), { code: 'UNSUPPORTED_SATELLITE_INPUT' });
  await assert.rejects(preprocess({ ...options, timeoutMs: Infinity }, { run }), { code: 'INVALID_SATELLITE_TIMEOUT' });
  await assert.rejects(preprocess({ ...options, evaluate: 'yes' }, { run }), { code: 'INVALID_SATELLITE_EVALUATION' });
  assert.equal(runs, 0);
});
