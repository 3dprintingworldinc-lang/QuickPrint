'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { prepare, inspectArtifact, buildArguments, runProcess } = require('../src/slicing');
const gcode = Buffer.from('; generated for test printer\nG28\nG90\nG1 X10 Y10 E1\nM104 S0\n');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-slicing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function archive(plates = 1) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('Metadata/slice_info.config', Buffer.from('<config><plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="BL-P001"/><filament id="1" type="PLA" used_g="2"/></plate></config>'));
  for (let i = 1; i <= plates; i++) zip.addFile(`Metadata/plate_${i}.gcode`, gcode);
  return zip.toBuffer();
}
test('pre-sliced G-code is copied, hashed and bound to a selected printer', async t => {
  const root = await fixture(t); const inputPath = path.join(root, 'input.gcode');
  await fs.writeFile(inputPath, gcode);
  const result = await prepare({ inputPath, outputDir: path.join(root, 'output'), printer: { id: 'p1', type: 'moonraker' } });
  assert.equal(result.format, 'gcode'); assert.equal(result.metadata.printerId, 'p1');
  assert.match(result.sha256, /^[a-f0-9]{64}$/); assert.deepEqual(await fs.readFile(result.filePath), gcode);
});
test('model file requires a real configured slicer and is never marked ready', async t => {
  const root = await fixture(t); const inputPath = path.join(root, 'part.step');
  await fs.writeFile(inputPath, 'ISO-10303-21;');
  await assert.rejects(prepare({ inputPath, outputDir: path.join(root, 'out'), printer: { id: 'p1', type: 'bambu' } }), { code: 'SLICER_REQUIRED' });
});
test('3MF parsing distinguishes models and sliced single plates', () => {
  assert.equal(inspectArtifact(archive(), 'part.gcode.3mf').kind, 'gcode.3mf');
  const zip = new AdmZip(); zip.addFile('3D/3dmodel.model', Buffer.from('<model/>'));
  assert.equal(inspectArtifact(zip.toBuffer(), 'model.3mf').kind, 'model');
  assert.throws(() => inspectArtifact(archive(2), 'part.3mf'), { code: 'MULTIPLE_PLATES' });
  assert.throws(() => inspectArtifact(Buffer.from('not a zip'), 'part.3mf'), { code: 'INVALID_3MF' });
});
test('Bambu only accepts sliced 3MF; generic printers reject unknown-family 3MF', async t => {
  const root = await fixture(t);
  const plain = path.join(root, 'part.gcode'); await fs.writeFile(plain, gcode);
  await assert.rejects(prepare({ inputPath: plain, outputDir: path.join(root, 'out'), printer: { id: 'b1', type: 'bambu' } }), { code: 'INCOMPATIBLE_ARTIFACT' });
  const zipped = path.join(root, 'part.gcode.3mf'); await fs.writeFile(zipped, archive());
  const result = await prepare({ inputPath: zipped, outputDir: path.join(root, 'out'), printer: { id: 'b1', type: 'bambu', model: 'X1C' } });
  assert.equal(result.format, 'gcode.3mf');
  await assert.rejects(prepare({ inputPath: zipped, outputDir: path.join(root, 'wrong-model'), printer: { id: 'b2', type: 'bambu', model: 'P1S' } }), { code: 'PRINTER_MODEL_MISMATCH' });
  await assert.rejects(prepare({ inputPath: zipped, outputDir: path.join(root, 'out2'), printer: { id: 'm1', type: 'moonraker' } }), { code: 'INCOMPATIBLE_ARTIFACT' });
});
test('Bambu/Orca arguments preserve PS AM machine/process/filament profile roles', () => {
  const args = buildArguments({ kind: 'bambu', inputPath: '/parts/a.stl', outputDir: '/out', outputName: 'a.gcode.3mf', profiles: ['/a.json', '/b.json', '/c.json'] });
  assert.deepEqual(args.slice(0, 4), ['--load-settings', '/a.json;/b.json', '--load-filaments', '/c.json']);
  assert.equal(args.at(-1), '/parts/a.stl');
  assert.throws(() => buildArguments({ kind: 'orca', profiles: [], extraArgs: ['--output=/tmp/unexpected'] }), { code: 'INVALID_SLICER_SETTINGS' });
});
test('invalid and binary G-code are rejected', () => {
  assert.throws(() => inspectArtifact(Buffer.from('plain words'), 'x.gcode'), { code: 'INVALID_GCODE' });
  assert.throws(() => inspectArtifact(Buffer.from([0, 1, 2]), 'x.gcode'), { code: 'INVALID_GCODE' });
});
test('process runner preserves exit status and timeout', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(7)']), { code: 'SLICER_FAILED' });
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), { code: 'SLICER_TIMEOUT' });
  const output = await runProcess(process.execPath, ['-e', 'process.stdout.write("prepared")']);
  assert.equal(output, 'prepared');
});
test('timeout forcibly terminates a slicer which ignores graceful shutdown', { skip: process.platform === 'win32' ? 'POSIX signal fixture' : false }, async () => {
  const started = Date.now();
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeoutMs: 200 }), { code: 'SLICER_TIMEOUT' });
  assert.ok(Date.now() - started < 4000);
});
test('Bambu instructions cannot be prepared for a generic printer', async t => {
  const root = await fixture(t); const inputPath = path.join(root, 'bambu.gcode');
  await fs.writeFile(inputPath, 'G28\nM620 S0A\nG1 X10 E1\n');
  await assert.rejects(prepare({ inputPath, outputDir: path.join(root, 'out'), printer: { id: 'm1', type: 'moonraker' } }), { code: 'INCOMPATIBLE_ARTIFACT' });
});
test('Orca machine profiles are checked before running a slicer for another family', async t => {
  const root = await fixture(t); const inputPath = path.join(root, 'part.stl'); await fs.writeFile(inputPath, 'solid part\nendsolid part');
  const profiles = ['machine', 'process', 'filament'].map(name => path.join(root, name + '.json'));
  for (const file of profiles) await fs.writeFile(file, '{}');
  await fs.writeFile(profiles[0], JSON.stringify({ printer_model: 'Bambu Lab X1 Carbon', gcode_flavor: 'marlin' }));
  await assert.rejects(prepare({ inputPath, outputDir: path.join(root, 'out'), printer: { id: 'm1', type: 'moonraker' }, settings: { slicer: { kind: 'orca', executable: '/not-executed', profilePaths: profiles } } }), { code: 'INCOMPATIBLE_MACHINE_PROFILE' });
  for (const model of ['C11', 'C12']) {
    await fs.writeFile(profiles[0], JSON.stringify({ printer_model: model, gcode_flavor: 'klipper' }));
    await assert.rejects(prepare({ inputPath, outputDir: path.join(root, model), printer: { id: 'm1', type: 'moonraker' }, settings: { slicer: { kind: 'orca', executable: '/not-executed', profilePaths: profiles } } }), { code: 'INCOMPATIBLE_MACHINE_PROFILE' }, `internal Bambu machine ID ${model} must be rejected before execution`);
  }
});
test('Orca output is checked even when the selected machine preset appears compatible', { skip: process.platform === 'win32' ? 'POSIX executable fixture' : false }, async t => {
  const root = await fixture(t);
  const inputPath = path.join(root, 'part.stl');
  await fs.writeFile(inputPath, 'solid part\nendsolid part');
  const profiles = ['machine', 'process', 'filament'].map(name => path.join(root, name + '.json'));
  for (const file of profiles) await fs.writeFile(file, '{}');
  await fs.writeFile(profiles[0], JSON.stringify({ printer_model: 'Generic Klipper', gcode_flavor: 'klipper' }));
  const emitted = path.join(root, 'emitted.3mf');
  const executable = path.join(root, 'fixture-slicer');
  await fs.writeFile(executable, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst args = process.argv.slice(2);\nfs.copyFileSync(${JSON.stringify(emitted)}, path.join(args[args.indexOf('--outputdir') + 1], args[args.indexOf('--export-3mf') + 1]));\n`, { mode: 0o755 });
  const options = { inputPath, printer: { id: 'm1', type: 'moonraker' }, settings: { slicer: { kind: 'orca', executable, profilePaths: profiles } } };
  await fs.writeFile(emitted, archive());
  await assert.rejects(prepare({ ...options, outputDir: path.join(root, 'wrong-output') }), { code: 'INCOMPATIBLE_ARTIFACT' });
  for (const model of ['C11', 'C12']) {
    const internalModel = new AdmZip(archive());
    internalModel.updateFile('Metadata/slice_info.config', Buffer.from(`<config><plate><metadata key="index" value="1"/><metadata key="printer_model_id" value="${model}"/></plate></config>`));
    await fs.writeFile(emitted, internalModel.toBuffer());
    await assert.rejects(prepare({ ...options, outputDir: path.join(root, `wrong-output-${model}`) }), { code: 'INCOMPATIBLE_ARTIFACT' }, `internal Bambu model ID ${model} must not become generic G-code`);
  }
  const compatible = new AdmZip(archive());
  compatible.updateFile('Metadata/slice_info.config', Buffer.from('<config><plate><metadata key="index" value="1"/><metadata key="printer_model" value="Generic Klipper"/></plate></config>'));
  await fs.writeFile(emitted, compatible.toBuffer());
  const result = await prepare({ ...options, outputDir: path.join(root, 'valid-output') });
  assert.equal(result.format, 'gcode');
  assert.deepEqual(await fs.readFile(result.filePath), gcode);
  compatible.updateFile('Metadata/plate_1.gcode', Buffer.from('G28\nM620 S0A\nG1 X10 E1\n'));
  await fs.writeFile(emitted, compatible.toBuffer());
  await assert.rejects(prepare({ ...options, outputDir: path.join(root, 'wrong-commands') }), { code: 'INCOMPATIBLE_ARTIFACT' });
});
test('real child process preparation validates output rather than exit code alone', { skip: process.platform === 'win32' ? 'POSIX fake executable fixture; runtime runner tested cross-platform above' : false }, async t => {
  const root = await fixture(t);
  const inputPath = path.join(root, 'part.stl'); await fs.writeFile(inputPath, 'solid part\nendsolid part');
  const profile = path.join(root, 'profile.ini'); await fs.writeFile(profile, 'layer_height = 0.2');
  const executable = path.join(root, 'fake-slicer');
  await fs.writeFile(executable, `#!/bin/sh\nwhile [ "$1" != "--output" ]; do shift; done\nshift\nprintf 'G28\\nG1 X10 Y10 E1\\n' > "$1"\n`, { mode: 0o755 });
  const result = await prepare({ inputPath, outputDir: path.join(root, 'out'), printer: { id: 'p1', type: 'octoprint' }, settings: { slicer: { kind: 'prusa', executable, profilePaths: [profile] } } });
  assert.equal(result.format, 'gcode'); assert.equal(result.metadata.slicer, 'prusa');
  await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await assert.rejects(prepare({ inputPath, outputDir: path.join(root, 'other'), printer: { id: 'p1', type: 'octoprint' }, settings: { slicer: { kind: 'prusa', executable, profilePaths: [profile] } } }), { code: 'SLICER_OUTPUT_MISSING' });
});
