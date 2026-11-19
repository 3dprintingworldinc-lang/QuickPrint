'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { MODEL } = require('./helpers/resin-slice');
const { createPlateSliceFixture, gooForInstances } = require('./helpers/resin-plate-slice');
const { prepareResin, loadProfile, parseIni } = require('../src/slicing/resin-engine');
const { prepareResinGeometry, forEachResinTriangle } = require('../src/slicing/resin-geometry');
const { prepareResinPlateSource } = require('../src/slicing/resin-plate');
const { normalizeResinPlateOptions, createResinPlate3mf, resinPlateHeightPolicy, prepareResinPlatePreset, assertPackedEffectiveSettings, verifyResinPlatePreparation } = require('../src/slicing/resin-plate-engine');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function reseal(record) { const { preparationSha256, ...body } = record; record.preparationSha256 = hash(JSON.stringify(canonical(body))); }
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-packed-engine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const native = await createPlateSliceFixture(root), inputPath = path.join(root, 'owned-source.stl'), outputDir = path.join(root, 'slices');
  await fs.writeFile(inputPath, MODEL);
  const input = { ...native.settings, inputPath, outputDir, unitScale: 1, plate: { copies: 3, gapMm: 1, marginMm: 1 } };
  return { ...native, root, input, async verify(result, record = result.platePreparation, artifactBytes) { const loaded = await loadProfile(input.profilePath); return verifyResinPlatePreparation(await fs.readFile(result.inputGeometry.filePath), record, { profile: loaded.profile, ini: loaded.ini, preset: loaded.preset, artifactBytes: artifactBytes || await fs.readFile(result.filePath), directory: outputDir }); } };
}

test('packed options reject missing fields, unbounded quantities, nonnumeric spacing and job-supplied commands before providers', async () => {
  for (const plate of [null, [], {}, { copies: 0, gapMm: 1, marginMm: 1 }, { copies: 501, gapMm: 1, marginMm: 1 }, { copies: 1.5, gapMm: 1, marginMm: 1 }, { copies: '3', gapMm: 1, marginMm: 1 }, { copies: 3, gapMm: -1, marginMm: 1 }, { copies: 3, gapMm: Infinity, marginMm: 1 }, { copies: 3, gapMm: 1, marginMm: 0.5 }, { copies: 3, gapMm: 1, marginMm: '1' }, { copies: 3, gapMm: 1, marginMm: 1, executable: 'anything' }]) {
    let calls = 0;
    await assert.rejects(prepareResin({ plate }, { run: async () => { calls++; } }), { code: 'RESIN_PLATE_INVALID_REQUEST' });
    assert.equal(calls, 0);
  }
  assert.deepEqual(normalizeResinPlateOptions({ copies: 500, gapMm: 0, marginMm: 1 }), { copies: 500, gapMm: 0, marginMm: 1 });
  assert.equal(Object.is(normalizeResinPlateOptions({ copies: 3, gapMm: -0, marginMm: 1 }).gapMm,-0),false);
});

test('generated 3MF is byte-deterministic, has one shared mesh and exact bounded instance transforms', () => {
  const input = prepareResinGeometry(MODEL, { format: 'stl', units: 'mm', sizing: { mode: 'original' } }).stl;
  const source = prepareResinPlateSource(input, { orientation: { x: 30, y: 15, z: 0 } });
  const positions = [{ x: 1.5625, y: 2.34375, z: 0 }, { x: 10.9375, y: 2.34375, z: 0 }];
  const first = createResinPlate3mf(source.stl, positions), second = createResinPlate3mf(source.stl, positions);
  assert.deepEqual(first, second);
  const zip = new AdmZip(first), names = zip.getEntries().map(entry => entry.entryName).sort();
  assert.deepEqual(names, ['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
  const xml = zip.readAsText('3D/3dmodel.model');
  assert.equal((xml.match(/<object /g) || []).length, 1); assert.equal((xml.match(/<item /g) || []).length, 2); assert.equal((xml.match(/<triangle /g) || []).length, 12);
  assert.equal((xml.match(/<vertex /g) || []).length, 8, 'a closed cube shares its exact coordinate vertices across triangle faces');
  const vertices = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map(match => match.slice(1).map(Number));
  const faces = [...xml.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)].map(match => match.slice(1).map(Number));
  const sourceTriangles = []; forEachResinTriangle(source.stl,{format:'stl',units:'mm'},points=>sourceTriangles.push(points));
  assert.deepEqual(faces.map(face=>face.map(index=>vertices[index])),sourceTriangles,'index sharing changes neither a coordinate nor triangle winding/order');
  const edges = new Map(); for (const face of faces) for (let at=0;at<3;at++) { const key=[face[at],face[(at+1)%3]].sort((a,b)=>a-b).join(','); edges.set(key,(edges.get(key)||0)+1); }
  assert.ok([...edges.values()].every(count=>count===2),'every cube edge remains shared by two indexed faces');
  assert.match(xml, /transform="1 0 0 0 1 0 0 0 1 1\.5625 2\.34375 0"/);
  assert.match(xml, /unit="millimeter"/); assert.doesNotMatch(xml, /https?:\/\/[^" ]+\.(stl|obj|step)|script|external/i);
  for (const bad of [[], Array(501).fill(positions[0]), [{ x: NaN, y: 0, z: 0 }], [{ x: -1, y: 0, z: 0 }]]) assert.throws(() => createResinPlate3mf(source.stl, bad));
});

test('height policy reserves support, full pad height, rounding and tower hop and rejects unknown scaling/pad modes', async t => {
  const f = await fixture(t), loaded = await loadProfile(f.input.profilePath), source = prepareResinPlateSource(prepareResinGeometry(MODEL, { format: 'stl', units: 'mm', sizing: { mode: 'original' } }).stl, { orientation: { x: 0, y: 0, z: 0 } });
  const policy = resinPlateHeightPolicy(source, loaded.profile, loaded.ini);
  assert.equal(policy.expectedModelTopMm, 10); assert.equal(policy.upperHeightMm, 10.05);
  const zeroHeight = resinPlateHeightPolicy(source, loaded.profile, { ...loaded.ini, support_object_elevation:'-0',pad_wall_thickness:'-0',pad_wall_height:'-0',tower_hop_height:'-0,-0' });
  for (const key of ['supportElevationMm','padWallThicknessMm','padWallHeightMm','towerHopMm']) assert.equal(Object.is(zeroHeight[key],-0),false);
  assert.equal(resinPlateHeightPolicy(source, loaded.profile, { ...loaded.ini, pad_wall_height: '1', tower_hop_height: '2,3' }).upperHeightMm, 14.05);
  for (const change of [{ pad_around_object: '1' }, { pad_around_object_everywhere: '1' }, { relative_correction_z: '2' }, { relative_correction_x: '0.9' }, { material_correction: '1,1,2' }, { zcorrection_layers: '1' }, { tower_hop_height: 'NaN,0' }, { pad_wall_thickness: '-1' }]) assert.throws(() => resinPlateHeightPolicy(source, loaded.profile, { ...loaded.ini, ...change }), { code: 'RESIN_PLATE_HEIGHT_POLICY' });
  assert.throws(() => resinPlateHeightPolicy(source, loaded.profile, { ...loaded.ini, max_print_height: '10' }), { code: 'RESIN_PLATE_NO_CAPACITY' });
});

test('packed preset normalization appends only a missing faded-layer override and binds original raw bytes', () => {
  const original = Buffer.from('# preserve source comment\nfaded_layers = 5\nsupports_enable = 1');
  const ini = parseIni(original.toString()), prepared = prepareResinPlatePreset(original, ini);
  assert.deepEqual(prepared.original, original); assert.equal(prepared.effective.toString(), original + '\nmaterial_ow_faded_layers = 5\n');
  assert.deepEqual(prepared.normalization, { rule: 'material_ow_faded_layers_from_faded_layers', value: 5 });
  const explicit = Buffer.from('faded_layers=5\nmaterial_ow_faded_layers=5\n');
  assert.deepEqual(prepareResinPlatePreset(explicit, parseIni(explicit.toString())).effective, explicit);
  const conflicting = Buffer.from('faded_layers=5\nmaterial_ow_faded_layers=10\n');
  assert.throws(() => prepareResinPlatePreset(conflicting, parseIni(conflicting.toString())), { code: 'RESIN_PLATE_PROFILE_CONFLICT' });
  assert.throws(() => prepareResinPlatePreset(original, { ...ini, faded_layers: '10' }), { code: 'RESIN_PLATE_CHANGED' });
});

test('packed captures independently verified counts, one-instance reference and source-bound canonical layout', async t => {
  const f = await fixture(t), result = await f.prepareResin(f.input), proof = await f.verify(result);
  assert.equal(result.modelCopiesPerRun, 3); assert.equal(proof.modelCopiesPerRun, 3); assert.equal(proof.layout.copiesPlaced, 3); assert.equal(proof.rasterProof.copiesPerRun, 3);
  assert.equal(f.renderCalls.length, 2); assert.equal(f.renderCalls[0].placements.length, 1); assert.equal(f.renderCalls[1].placements.length, 3);
  assert.equal(proof.rasterProof.totalForegroundPixels, proof.rasterProof.referenceForegroundPixels * 3); assert.equal(proof.rasterProof.imageEquivalent, true);
  assert.ok(Object.isFrozen(proof.layout.placements)); assert.deepEqual(await fs.readFile(f.input.inputPath), MODEL);
  assert.equal(result.printReady, false); assert.equal(result.platePreparation.sourceSha256, result.inputGeometry.sha256);
});

test('persisted plate proofs round-trip mirrored zero translations across all four mirror policies', async t => {
  for (const [mirrorX, mirrorY] of [[false,false],[true,false],[false,true],[true,true]]) await t.test(`${mirrorX}/${mirrorY}`, async child => {
    const f = await fixture(child), profile = JSON.parse(await fs.readFile(f.input.profilePath));
    profile.expected.mirrorX = mirrorX; profile.expected.mirrorY = mirrorY;
    await fs.writeFile(f.input.profilePath, JSON.stringify(profile));
    const presetPath = profile.presetPath, preset = (await fs.readFile(presetPath,'utf8')).replace(/display_mirror_x=[01]/,`display_mirror_x=${Number(mirrorX)}`).replace(/display_mirror_y=[01]/,`display_mirror_y=${Number(mirrorY)}`);
    await fs.writeFile(presetPath, preset);
    const result = await f.prepareResin(f.input), persisted = JSON.parse(JSON.stringify(result.platePreparation));
    assert.equal((await f.verify(result,persisted)).modelCopiesPerRun, 3);
    for (const placement of result.platePreparation.rasterProof.placements) { assert.equal(Object.is(placement.x,-0),false); assert.equal(Object.is(placement.y,-0),false); }
  });
});

test('a raw profile negative-zero orientation is canonicalized without changing its source bytes or restart proof', async t => {
  const f = await fixture(t), raw = (await fs.readFile(f.input.profilePath,'utf8')).replace('"x":0','"x":-0');
  assert.ok(raw.includes('"x":-0')); await fs.writeFile(f.input.profilePath,raw);
  const loaded = await loadProfile(f.input.profilePath); assert.equal(Object.is(loaded.profile.orientationCandidates[0].x,-0),false);
  const result = await f.prepareResin({ ...f.input, plate:{copies:3,gapMm:-0,marginMm:1} });
  assert.equal((await f.verify(result,JSON.parse(JSON.stringify(result.platePreparation)))).modelCopiesPerRun,3);
  assert.equal(await fs.readFile(f.input.profilePath,'utf8'),raw);
});

test('an upper bound exceeding bed capacity records the smaller proved count and never fabricates requested copies', async t => {
  const f = await fixture(t), result = await f.prepareResin({ ...f.input, plate: { copies: 500, gapMm: 6, marginMm: 2 } }), proof = await f.verify(result);
  assert.equal(result.modelCopiesPerRun, 6); assert.equal(proof.layout.copiesRequested, 500); assert.equal(proof.layout.copiesPlaced, 6); assert.equal(proof.layout.remainingCopies, 494); assert.equal(proof.layout.complete, false);
});

test('actual missing instances are rejected by full raster proof even when native structure and declared file count are valid', async t => {
  const f = await fixture(t); f.faults.omitLastCopy = true;
  await assert.rejects(f.prepareResin(f.input), { code: 'GOO_PLATE_IMAGE_MISMATCH' });
});

test('all six issue checks remain part of a truthful captured plate that needs review', async t => {
  const f = await fixture(t); f.faults.issues = 2;
  const result = await f.prepareResin(f.input);
  assert.equal(result.analysis.passed, false); assert.equal(result.analysis.count, 2); assert.equal(result.analysis.checks.length, 6); assert.equal(result.modelCopiesPerRun, 3);
  assert.equal((await f.verify(result)).modelCopiesPerRun, 3);
});

test('each saved native input/reference/preset is verified by content and canonical derivation after restart', async t => {
  for (const kind of ['oriented', 'reference-input', 'plate-input', 'reference-goo', 'original-preset', 'effective-preset']) await t.test(kind, async child => {
    const f = await fixture(child), result = await f.prepareResin(f.input), record = structuredClone(result.platePreparation);
    const descriptor = { oriented: record.orientedSource, 'reference-input': record.reference.input3mf, 'plate-input': record.plateInput, 'reference-goo': record.reference, 'original-preset': record.presetPreparation.original, 'effective-preset': record.presetPreparation.effective }[kind];
    const bytes = await fs.readFile(descriptor.filePath); bytes[0] ^= 1; await fs.writeFile(descriptor.filePath, bytes);
    descriptor.sha256 = hash(bytes); reseal(record);
    await assert.rejects(f.verify(result, record));
  });
});

test('resealed forged layout, proof, orientation and normalization claims cannot replace independently derived evidence', async t => {
  const f = await fixture(t), result = await f.prepareResin(f.input);
  for (const change of [record => { record.layout.copiesPlaced++; }, record => { record.rasterProof.copiesPerRun++; }, record => { record.orientation.x = 90; }, record => { record.reference.placement.x++; }, record => { record.supportEnvelopeMm++; }, record => { record.heightPolicy.expectedModelTopMm++; }, record => { record.presetPreparation.normalization = { rule: 'arbitrary', value: 5 }; }]) {
    const record = structuredClone(result.platePreparation); change(record); reseal(record);
    await assert.rejects(f.verify(result, record), { code: 'RESIN_PLATE_CHANGED' });
  }
});

test('a valid but incomplete GOO cannot be substituted even after rehashing the saved artifact descriptor', async t => {
  const f = await fixture(t), result = await f.prepareResin(f.input), record = structuredClone(result.platePreparation), loaded = await loadProfile(f.input.profilePath);
  const incomplete = gooForInstances({ placements: record.layout.placements.map(item => item.offsetMm).slice(0,-1), dimensions: record.layout.instanceDimensionsMm, profile: loaded.profile, ini: loaded.ini });
  record.artifactSha256 = hash(incomplete); reseal(record);
  await assert.rejects(f.verify(result, record, incomplete), { code: 'GOO_PLATE_IMAGE_MISMATCH' });
});

test('evidence paths outside the job and links inside it are rejected even for identical bytes', async t => {
  for (const linked of [false, true]) await t.test(linked ? 'junction' : 'outside', async child => {
    const f = await fixture(child), result = await f.prepareResin(f.input), record = structuredClone(result.platePreparation), outside = path.join(f.root, 'external');
    await fs.mkdir(outside); const copied = path.join(outside, 'oriented-source.stl'); await fs.copyFile(record.orientedSource.filePath, copied);
    if (linked) { const link = path.join(f.input.outputDir, 'linked'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); record.orientedSource.filePath = path.join(link, 'oriented-source.stl'); }
    else record.orientedSource.filePath = copied;
    reseal(record); await assert.rejects(f.verify(result, record), { code: 'RESIN_PLATE_CHANGED' });
  });
});

test('the real engine packed command omits rotations and centering, uses an isolated datadir and generated preset clone', async t => {
  const f = await fixture(t), iniPath = JSON.parse(await fs.readFile(f.input.profilePath)).presetPath;
  await fs.appendFile(iniPath, 'faded_layers=5\n'); const before = await fs.readFile(iniPath);
  for (const [filename, content] of [[f.input.prusaExecutable,'console'], [f.input.uvtoolsExecutable,'console'], [path.join(f.root,'PrusaSlicer.dll'),'core'], [path.join(f.root,'UVtoolsCmd.dll'),'command'], [path.join(f.root,'UVtools.Core.dll'),'core']]) await fs.writeFile(filename, content);
  const calls = [];
  const run = async (exe, args, options) => { calls.push({ exe, args, options }); if (args[0] === '--help') return 'PrusaSlicer-2.9.7\n --export-sla'; if (args[0] === '--core-version') return '7.1.2'; throw Object.assign(new Error('Captured native boundary.'), { code: 'STOP_NATIVE_BOUNDARY' }); };
  await assert.rejects(prepareResin(f.input, { run }), { code: 'STOP_NATIVE_BOUNDARY' });
  const args = calls.at(-1).args;
  for (const flag of ['--dont-arrange','--no-ensure-on-bed','--threads','--datadir']) assert.ok(args.includes(flag));
  for (const flag of ['--rotate','--rotate-x','--rotate-y','--center','--duplicate','--duplicate-grid']) assert.ok(!args.includes(flag));
  assert.equal(path.extname(args.at(-1)), '.3mf'); assert.equal(new AdmZip(await fs.readFile(args.at(-1))).readAsText('3D/3dmodel.model').match(/<item /g).length, 1);
  const cloned = await fs.readFile(args[args.indexOf('--load')+1]); assert.equal(cloned.toString(), before.toString()+'material_ow_faded_layers = 5\n'); assert.deepEqual(await fs.readFile(iniPath), before);
});

test('packed mode pins the native placement version while default legacy mode keeps its version recognition', async t => {
  const f = await fixture(t), calls = [];
  await assert.rejects(prepareResin(f.input, { run: async (exe,args) => { calls.push(args); return 'PrusaSlicer-2.9.8\n --export-sla'; } }), { code: 'RESIN_PLATE_PROVIDER_UNSUPPORTED' });
  assert.equal(calls.length, 1);
});

test('a mismatching later orientation is rejected while a prior proved but issue-bearing plate remains held for review', async t => {
  const f = await fixture(t), profile = JSON.parse(await fs.readFile(f.input.profilePath));
  profile.orientationCandidates.push({ x: 30, y: 15, z: 0 }); await fs.writeFile(f.input.profilePath, JSON.stringify(profile));
  for (const filename of [f.input.prusaExecutable,f.input.uvtoolsExecutable,path.join(f.root,'PrusaSlicer.dll'),path.join(f.root,'UVtoolsCmd.dll'),path.join(f.root,'UVtools.Core.dll')]) await fs.writeFile(filename, 'Owned native-boundary fixture');
  f.faults.issues = 1; let attempts = 0;
  const run = async (exe,args) => { if (args[0] === '--help') return 'PrusaSlicer-2.9.7\n --export-sla'; if (args[0] === '--core-version') return '7.1.2'; throw new Error('Injected native calls must stay at the trusted packed boundary.'); };
  const preparePackedAttempt = async options => {
    attempts++;
    if (options.orientation.x !== 0) throw Object.assign(new Error('A real raster mismatch rejects this candidate.'), { code: 'GOO_PLATE_IMAGE_MISMATCH' });
    return f.prepareResin({ ...f.input, outputDir: options.directory });
  };
  const result = await prepareResin(f.input, { run, preparePackedAttempt });
  assert.equal(attempts, 2); assert.equal(result.modelCopiesPerRun, 3); assert.equal(result.analysis.passed, false); assert.equal(result.status, 'analysis_failed'); assert.equal(result.printReady, false);
  assert.deepEqual(result.orientation, { x: 0, y: 0, z: 0 }); assert.equal(result.rejectedOrientations[0].reason, 'GOO_PLATE_IMAGE_MISMATCH');
  assert.equal((await f.verify(result)).modelCopiesPerRun, 3);
  await assert.rejects(prepareResin(f.input, { run, preparePackedAttempt: async () => { throw Object.assign(new Error('Mismatching pixels.'), { code: 'GOO_PLATE_IMAGE_MISMATCH' }); } }), { code: 'RESIN_PLATE_NO_VERIFIED_CANDIDATE' });
});
