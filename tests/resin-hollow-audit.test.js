'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Zip = require('adm-zip');
const { auditResinHollowReferences, verifyResinHollowReferenceAudit } = require('../src/slicing/resin-hollow-audit');
const { prepareResinHollowSupports, createSupportedHollow3mf } = require('../src/slicing/resin-hollow-supports');
const { fixture, hash } = require('./helpers/resin-hollow-reference');
function options(f) { const { directory, ...input } = f; return input; }

test('source-bound paired audit verifies requested cavity/drains and records separate unqualified raster-wall evidence', async t => {
  const f = await fixture(t), input = options(f), before = Buffer.from(input.source), result = await auditResinHollowReferences(input);
  assert.equal(result.disposition, 'conforming'); assert.equal(result.gridAudit.disposition, 'conforming');
  assert.equal(result.native.solid.sha256, input.solid.sha256); assert.equal(result.native.hollow.sha256, input.hollow.sha256);
  assert.equal(result.planSha256, f.plan.sha256); assert.deepEqual(result.sourceBinding, f.expectedBinding);
  assert.equal(result.gridAudit.drains.length, 2); assert.ok(result.gridAudit.drains.every(drain => drain.disposition === 'conforming' && drain.distinctDefinitelyRemovedWallCells > 0));
  assert.equal(result.foregroundOutsideCropPixels, 0); assert.equal(result.wallPolicyResolved, true);
  assert.ok(result.uncertainty.totalMm <= 0.5); assert.ok(result.gridAudit.wallResolutionIntervalMm.lower >= 1.5);
  assert.equal(result.productionEligible, false); assert.equal(result.nativeInvocationAttested, false); assert.equal(result.geometricWallCertification, false); assert.equal(result.physicalDrainageCertification, false);
  assert.match(result.sha256, /^[a-f0-9]{64}$/); assert.equal(Object.isFrozen(result.gridAudit.drains[0]), true); assert.deepEqual(input.source, before);
  const repeated = await verifyResinHollowReferenceAudit(input, result); assert.equal(repeated.sha256, result.sha256);
  for (const mutate of [r => r.productionEligible = true, r => r.gridAudit.counts.expectedDeepCavity--, r => r.native.solid.sha256 = '0'.repeat(64), r => r.tool.modules[0].sha256 = '0'.repeat(64)]) {
    const changed = structuredClone(result); mutate(changed); await assert.rejects(verifyResinHollowReferenceAudit(input, changed), { code: 'RESIN_HOLLOW_AUDIT_CHANGED' });
  }
});

for (const [kind, disposition] of [['sealed', 'nonconforming'], ['half-cavity', 'nonconforming'], ['outside', 'nonconforming'], ['gray', 'inconclusive']]) test(`actual ${kind} rasters cannot gain a conforming result from valid input metadata`, async t => {
  const f = await fixture(t, kind), result = await auditResinHollowReferences(options(f));
  assert.equal(result.disposition, disposition); assert.equal(result.productionEligible, false);
  if (kind === 'outside') assert.equal(result.foregroundOutsideCropPixels, 1);
  if (kind === 'sealed') assert.ok(result.gridAudit.drains.every(drain => drain.disposition !== 'conforming'));
});

test('stale source/sizing review and changed full 3MF payloads stop before interpreting native rasters', async t => {
  const f = await fixture(t);
  for (const key of ['sourceSha256', 'geometrySha256', 'sizingSha256']) await assert.rejects(auditResinHollowReferences({ ...options(f), expectedBinding: { ...f.expectedBinding, [key]: '0'.repeat(64) } }), { code: 'RESIN_HOLLOW_SOURCE_CHANGED' });
  const archive = new Zip(f.hollow.input3mf), model = archive.readAsText('3D/3dmodel.model'); archive.updateFile('3D/3dmodel.model', Buffer.from(model.replace('x="20"', 'x="19"')));
  await assert.rejects(auditResinHollowReferences({ ...options(f), hollow: { ...f.hollow, input3mf: archive.toBuffer() } }), { code: 'RESIN_HOLLOW_REFERENCE_CHANGED' });
  const extra = new Zip(f.hollow.input3mf); extra.addFile('extra.dat', Buffer.from('Extra unreviewed metadata'));
  await assert.rejects(auditResinHollowReferences({ ...options(f), hollow: { ...f.hollow, input3mf: extra.toBuffer() } }));
});

test('inactive authored support metadata requires the independently frozen support authority and unchanged profile', async t => {
  const f = await fixture(t), preset = Buffer.from(f.hollow.effectivePreset.toString().replace('supports_enable = 0', 'supports_enable = 1').replace('pad_enable = 0', 'pad_enable = 1') + 'support_tree_type = default\npad_around_object = 0\npad_around_object_everywhere = 0\nsupport_object_elevation = 5\npad_wall_thickness = 2\npad_wall_height = 0\nsupport_head_penetration = 0.4\nsupport_head_front_diameter = 0.8\n');
  const support = prepareResinHollowSupports(f.source, f.plan, f.expectedBinding, preset, { mode: 'points', clearanceMm: 4, regions: [], points: [{ id: 'contact-0', sourceFaceIndex: 0, positionMm: { x: 0, y: 0, z: 0 }, headRadiusMm: 0.4, allowedRadiusMm: 3 }] });
  const hollowInput = createSupportedHollow3mf(f.source, f.plan, f.expectedBinding, preset, support.plan, f.placement).threeMf, solidInput = new Zip(hollowInput);
  solidInput.deleteFile(f.plan.native.drainMetadataPath);
  const inactivePreset = Buffer.from(preset.toString().replace('supports_enable = 1', 'supports_enable = 0').replace('pad_enable = 1', 'pad_enable = 0'));
  const input = { ...options(f), solid: { ...f.solid, input3mf: solidInput.toBuffer(), effectivePreset: Buffer.from(inactivePreset.toString().replace('hollowing_enable = 1', 'hollowing_enable = 0')) }, hollow: { ...f.hollow, input3mf: hollowInput, effectivePreset: inactivePreset }, supports: { plan: support.plan, preset } };
  const result = await auditResinHollowReferences(input);
  assert.equal(result.disposition, 'conforming'); assert.deepEqual(result.supportBinding, { supportPlanSha256: support.plan.sha256, presetSha256: hash(preset), inactiveInReferences: true });
  await assert.rejects(auditResinHollowReferences({ ...input, policy: { ...input.policy, referenceMode: 'suppressed-support-elevation' } }), { code: 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED' });
  const without = { ...input }; delete without.supports; await assert.rejects(auditResinHollowReferences(without));
  await assert.rejects(auditResinHollowReferences({ ...input, hollow: { ...input.hollow, effectivePreset: Buffer.from(inactivePreset.toString().replace('support_head_penetration = 0.4', 'support_head_penetration = 0.5')) } }), { code: 'RESIN_HOLLOW_REFERENCE_CHANGED' });
  const changed = new Zip(hollowInput), metadataPath = support.plan.native.supportMetadataPath;
  changed.updateFile(metadataPath, Buffer.from(changed.readAsText(metadataPath).replace('0.4000000059604645', '0.5')));
  await assert.rejects(auditResinHollowReferences({ ...input, hollow: { ...input.hollow, input3mf: changed.toBuffer() } }), { code: 'RESIN_HOLLOW_SUPPORT_CHANGED' });
});

test('enclosure boundary policy is explicit and preserves its unchanged uncertainty and full foreground accounting', async t => {
  const f = await fixture(t), result = await auditResinHollowReferences({ ...options(f), policy: { ...f.policy, boundaryPolicy: 'voxel-enclosure' } });
  assert.equal(result.disposition, 'conforming'); assert.equal(result.policy.boundaryPolicy, 'voxel-enclosure'); assert.equal(result.gridAudit.boundaryPolicy, 'voxel-enclosure'); assert.equal(result.foregroundOutsideCropPixels, 0);
  await assert.rejects(auditResinHollowReferences({ ...options(f), policy: { ...f.policy, boundaryPolicy: 'adaptive' } }));
  await assert.rejects(auditResinHollowReferences({ ...options(f), policy: { ...f.policy, referenceMode: 'suppressed-support-elevation' } }));
});

test('effective profile, support/elevation, correction and physical layer mismatches cannot be hidden by matching model hashes', async t => {
  const f = await fixture(t), mutate = (from, to) => ({ ...f.hollow, effectivePreset: Buffer.from(f.hollow.effectivePreset.toString().replace(from, to)) });
  await assert.rejects(auditResinHollowReferences({ ...options(f), hollow: mutate('hollowing_quality = 0.75', 'hollowing_quality = 1') }), { code: 'RESIN_HOLLOW_REFERENCE_CHANGED' });
  await assert.rejects(auditResinHollowReferences({ ...options(f), hollow: mutate('supports_enable = 0', 'supports_enable = 1') }), { code: 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED' });
  await assert.rejects(auditResinHollowReferences({ ...options(f), hollow: mutate('relative_correction_x = 1', 'relative_correction_x = 2') }), { code: 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED' });
  await assert.rejects(auditResinHollowReferences({ ...options(f), placement: { ...f.placement, z: 1 } }), { code: 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED' });
  const bytes = await fs.readFile(f.hollow.filePath); bytes.writeFloatBE(0.21, 195477 + 6); await fs.writeFile(f.hollow.filePath, bytes);
  await assert.rejects(auditResinHollowReferences({ ...options(f), hollow: { ...f.hollow, sha256: hash(bytes) } }), { code: 'RESIN_HOLLOW_REFERENCE_CHANGED' });
});

test('artifact identity and declared grid/resource limits fail closed without adaptive coarsening', async t => {
  const f = await fixture(t);
  await assert.rejects(auditResinHollowReferences({ ...options(f), hollow: { ...f.hollow, sha256: '0'.repeat(64) } }), { code: 'RESIN_HOLLOW_REFERENCE_CHANGED' });
  await assert.rejects(auditResinHollowReferences({ ...options(f), policy: { ...f.policy, reduction: { x: 32, y: 32, z: 32 } } }), { code: 'RESIN_HOLLOW_RESOLUTION_INCONCLUSIVE' });
  await assert.rejects(auditResinHollowReferences({ ...options(f), limits: { grid: { maxVoxels: 1000 } } }), { code: 'RESIN_HOLLOW_AUDIT_LIMIT' });
  await assert.rejects(auditResinHollowReferences({ ...options(f), limits: { scan: { timeoutMs: 60001 } } }), { code: 'RESIN_HOLLOW_AUDIT_LIMIT' });
  await assert.rejects(auditResinHollowReferences({ ...options(f), limits: { scan: 5 } }));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(auditResinHollowReferences({ ...options(f), signal: aborted.signal }), { code: 'PREPARATION_CANCELLED' });
});

test('paired artifact agreement cannot conceal exposure and conversion settings that disagree with their frozen profile', async t => {
  const f = await fixture(t);
  const solid = { ...f.solid, effectivePreset: Buffer.from(f.solid.effectivePreset.toString().replace('exposure_time = 2\n', 'exposure_time = 9\n')) };
  const hollow = { ...f.hollow, effectivePreset: Buffer.from(f.hollow.effectivePreset.toString().replace('exposure_time = 2\n', 'exposure_time = 9\n')) };
  await assert.rejects(auditResinHollowReferences({ ...options(f), solid, hollow }), { code: 'RESIN_HOLLOW_REFERENCE_CHANGED' });
  await assert.rejects(auditResinHollowReferences({ ...options(f), targetProperties: { ...f.targetProperties, LiftSpeed: 90 } }), { code: 'RESIN_CONVERSION_MISMATCH' });
  await assert.rejects(auditResinHollowReferences({ ...options(f), targetProperties: { ...f.targetProperties, LiftSpeed: NaN } }));
});

test('already requested cancellation is honored before source canonicalization or filesystem access', async () => {
  const controller = new AbortController(); controller.abort();
  // These otherwise invalid placeholders show the abort is checked first.
  await assert.rejects(auditResinHollowReferences({ source: null, plan: null, expectedBinding: null, solid: null, hollow: null, provider: null, targetProperties: null, placement: null, policy: null, signal: controller.signal }), { code: 'PREPARATION_CANCELLED' });
});

test('matching global properties cannot qualify an enabled arbitrary per-layer physical schedule', async t => {
  const f = await fixture(t);
  for (const reference of [f.solid, f.hollow]) {
    const bytes = await fs.readFile(reference.filePath); bytes[195445] = 1;
    let at = 195477;
    for (let layer = 0; layer < bytes.readUInt32BE(195310); layer++) { bytes.writeFloatBE(0, at + 10); at += 72 + bytes.readUInt32BE(at + 66); }
    await fs.writeFile(reference.filePath, bytes); reference.sha256 = hash(bytes);
  }
  await assert.rejects(auditResinHollowReferences(options(f)), { code: 'RESIN_HOLLOW_ALIGNMENT_UNSUPPORTED' });
});

test('blank terminal definitions cannot hide a shortened source with otherwise coherent cavity and top wall', async t => {
  const f = await fixture(t), solid = await fs.readFile(f.solid.filePath), hollow = await fs.readFile(f.hollow.filePath);
  function layers(bytes) { const result = []; let at = 195477; for (let index = 0; index < 100; index++) { const length = bytes.readUInt32BE(at + 66); result.push({ definition: Buffer.from(bytes.subarray(at, at + 70)), image: bytes.subarray(at + 70, at + 72 + length) }); at += 72 + length; } return result; }
  const solidLayers = layers(solid), hollowLayers = layers(hollow), blackImage = Buffer.from([0x55, 0x20, 0x09, 0xc4, 0x12, 13, 10]);
  for (const [reference, original, values, isHollow] of [[f.solid, solid, solidLayers, false], [f.hollow, hollow, hollowLayers, true]]) {
    const parts = [original.subarray(0, 195477)];
    for (let index = 0; index < 100; index++) { const definition = values[index].definition, image = index >= 50 ? blackImage : isHollow && index >= 40 ? solidLayers[index].image : values[index].image; definition.writeUInt32BE(image.length - 2, 66); parts.push(definition, image); }
    parts.push(original.subarray(original.length - 11)); const bytes = Buffer.concat(parts); await fs.writeFile(reference.filePath, bytes); reference.sha256 = hash(bytes);
  }
  await assert.rejects(auditResinHollowReferences(options(f)), { code: 'RESIN_HOLLOW_REFERENCE_CHANGED' });
});

test('audit CLI creates and revalidates a source-bound report without overwriting earlier evidence', async t => {
  const f = await fixture(t), path = require('node:path'), { spawnSync } = require('node:child_process');
  const sourcePath = path.join(f.directory, 'source.stl'), planPath = path.join(f.directory, 'plan.json');
  await fs.writeFile(sourcePath, f.source); await fs.writeFile(planPath, JSON.stringify(f.plan));
  async function save(reference, name) { const input3mfPath = path.join(f.directory, `${name}.3mf`), effectivePresetPath = path.join(f.directory, `${name}.ini`); await fs.writeFile(input3mfPath, reference.input3mf); await fs.writeFile(effectivePresetPath, reference.effectivePreset); return { filePath: path.basename(reference.filePath), sha256: reference.sha256, input3mfPath: path.basename(input3mfPath), effectivePresetPath: path.basename(effectivePresetPath) }; }
  const request = { schemaVersion: 1, sourcePath: 'source.stl', planPath: 'plan.json', expectedBinding: f.expectedBinding, solid: await save(f.solid, 'solid'), hollow: await save(f.hollow, 'hollow'), provider: f.provider, targetProperties: f.targetProperties, placement: f.placement, policy: f.policy };
  const requestPath = path.join(f.directory, 'request.json'), reportPath = path.join(f.directory, 'audit.json'); await fs.writeFile(requestPath, JSON.stringify(request));
  const execute = flag => spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/audit-resin-hollow.js'), '--request', requestPath, flag, reportPath], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const created = execute('--output'); assert.equal(created.status, 0, created.stderr);
  const initial = await fs.readFile(reportPath), result = JSON.parse(initial); assert.equal(result.productionEligible, false); assert.equal(JSON.parse(created.stdout).sha256, result.sha256);
  const verified = execute('--verify'); assert.equal(verified.status, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).sha256, result.sha256);
  const repeated = execute('--output'); assert.equal(repeated.status, 1); assert.match(repeated.stderr, /EEXIST/); assert.deepEqual(await fs.readFile(reportPath), initial);
});

test('a long-lived caller rejects changed implementation bytes instead of labeling cached helpers with a new disk hash', async t => {
  const f = await fixture(t), original = fs.readFile, changedPath = require('node:path').resolve(__dirname, '../src/slicing/resin-hollow-raster.js');
  // Change the source observation, without touching repository files or the
  // already loaded implementation. Other fixture reads retain their bytes.
  fs.readFile = async function (filename, ...args) { const bytes = await original.call(this, filename, ...args); return filename === changedPath ? Buffer.concat([bytes, Buffer.from('\n// simulated source update\n')]) : bytes; };
  t.after(() => { fs.readFile = original; });
  await assert.rejects(auditResinHollowReferences(options(f)), { code: 'RESIN_HOLLOW_AUDIT_TOOL_CHANGED' });
});

test('private snapshots keep a started audit bound to its source and native inputs across asynchronous reads', async t => {
  const f = await fixture(t), input = { ...options(f), plan: structuredClone(f.plan) };
  const expectedInput = hash(input.hollow.input3mf), expectedSource = input.expectedBinding.geometrySha256;
  const pending = auditResinHollowReferences(input);
  input.source[0] ^= 1; input.hollow.input3mf[0] ^= 1; input.hollow.effectivePreset[0] ^= 1;
  input.plan.request.wallThicknessMm = 9; input.policy.maximumUncertaintyMm = 0.01;
  const result = await pending;
  assert.equal(result.disposition, 'conforming'); assert.equal(result.native.hollow.input3mfSha256, expectedInput); assert.equal(result.sourceBinding.geometrySha256, expectedSource); assert.equal(result.policy.maximumUncertaintyMm, 0.5);
});

test('external cancellation through the public audit boundary retains one preparation error contract', async t => {
  const f = await fixture(t), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20);
  try { await assert.rejects(auditResinHollowReferences({ ...options(f), signal: controller.signal }), { code: 'PREPARATION_CANCELLED', status: 409 }); }
  finally { clearTimeout(timer); }
});
