'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Zip = require('adm-zip');
const { createHash } = require('node:crypto');
const { fixture: bodyFixture, raster, hash } = require('./helpers/resin-hollow-reference');
const { prepareResinHollowSupports, createSupportedHollow3mf } = require('../src/slicing/resin-hollow-supports');
const { auditResinHollowFinal, verifyResinHollowFinalAudit } = require('../src/slicing/resin-hollow-final-audit');

let verifiedRecord;
async function fixture(t, kind = 'hollow') {
  const f = await bodyFixture(t, kind), preset = Buffer.from(f.hollow.effectivePreset.toString() + 'support_tree_type=default\npad_around_object=0\npad_around_object_everywhere=0\nsupport_object_elevation=5\npad_wall_thickness=2\npad_wall_height=0\nsupport_head_penetration=0.4\nsupport_head_front_diameter=0.8\n');
  const support = prepareResinHollowSupports(f.source, f.plan, f.expectedBinding, preset, { mode: 'none', clearanceMm: 0, points: [], regions: [] });
  const input = createSupportedHollow3mf(f.source, f.plan, f.expectedBinding, preset, support.plan, f.placement).threeMf, solidInput = new Zip(input); solidInput.deleteFile(f.plan.native.drainMetadataPath);
  const finalPath = path.join(f.directory, 'complete-final.goo'), bytes = await fs.readFile(f.hollow.filePath); await fs.writeFile(finalPath, bytes);
  const { directory, ...options } = f;
  return { ...options, solid: { ...f.solid, input3mf: solidInput.toBuffer(), effectivePreset: Buffer.from(preset.toString().replace('hollowing_enable = 1', 'hollowing_enable = 0')) }, hollow: { ...f.hollow, input3mf: input, effectivePreset: Buffer.from(preset) }, final: { filePath: finalPath, sha256: hash(bytes), input3mf: Buffer.from(input), effectivePreset: Buffer.from(preset) }, supports: { plan: support.plan, preset } };
}
function tokens(color, count) { const high = []; let remaining = Math.floor(count / 16); while (remaining) { high.unshift(remaining & 255); remaining = Math.floor(remaining / 256); } return [(color === 0 ? 0 : color === 255 ? 0xc0 : 0x40) | high.length << 4 | count & 15, ...(color !== 0 && color !== 255 ? [color] : []), ...high]; }
function encode(plane) { const values = []; for (let at = 0; at < plane.length;) { let end = at + 1; while (end < plane.length && plane[end] === plane[at]) end++; values.push(...tokens(plane[at], end - at)); at = end; } return Buffer.from([0x55, ...values, values.reduce((n, value) => (n + value) & 255, 0) ^ 255]); }
function decode(image, count) { const plane = new Uint8Array(count); let at = 1, target = 0; while (at < image.length - 1) { const token = image[at++], kind = token >>> 6, extra = token >>> 4 & 3; let length = token & 15, color = kind === 3 ? 255 : 0; if (kind === 1) color = image[at++]; assert.notEqual(kind, 2, 'owned fixture encoder does not emit color deltas'); for (let i = 0; i < extra; i++) length += image[at++] * 2 ** ((extra - i - 1) * 8 + 4); plane.fill(color, target, target + length); target += length; } assert.equal(target, count); return plane; }
async function mutateFinal(input, changes, { updateSha = true, definition } = {}) {
  const bytes = await fs.readFile(input.final.filePath), width = bytes.readUInt16BE(195314), height = bytes.readUInt16BE(195316), count = bytes.readUInt32BE(195310), parts = [Buffer.from(bytes.subarray(0, 195477))]; let at = 195477;
  for (let z = 0; z < count; z++) {
    const record = Buffer.from(bytes.subarray(at, at + 70)), length = record.readUInt32BE(66); let image = bytes.subarray(at + 70, at + 70 + length); at += 70 + length + 2;
    const items = changes.filter(item => item.z === z);
    if (items.length) { const plane = decode(image, width * height); for (const item of items) plane[item.y * width + item.x] = item.color; image = encode(plane); }
    definition?.(record, z); record.writeUInt32BE(image.length, 66); parts.push(record, image, Buffer.from([13, 10]));
  }
  parts.push(bytes.subarray(at)); const changed = Buffer.concat(parts); await fs.writeFile(input.final.filePath, changed); if (updateSha) input.final.sha256 = hash(changed); return changed;
}
function reseal(record) {
  const semantic = { ...record, gridAudit: { ...record.gridAudit, finalMaterialAudit: { ...record.gridAudit.finalMaterialAudit } } };
  delete semantic.sha256; delete semantic.resources; delete semantic.gridAudit.resources; delete semantic.gridAudit.limits; delete semantic.gridAudit.finalMaterialAudit.resources; delete semantic.gridAudit.finalMaterialAudit.limits;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(semantic))).digest('hex');
}

test('complete off-support audit binds all three artifacts, preserves the original source and replays after JSON storage', async t => {
  const input = await fixture(t); input.limits = { timeoutMs: 120000 }; const sourceBefore = Buffer.from(input.source), result = await auditResinHollowFinal(input);
  assert.equal(result.disposition, 'conforming'); assert.equal(result.bodyReferenceAudit.disposition, 'conforming'); assert.equal(result.bodyReferenceAudit.wallPolicyResolved, true);
  assert.equal(result.alignment.completeFinalMaterial, true); assert.equal(result.alignment.maskedFinalMaterial, false); assert.equal(result.alignment.modelElevationMm, 0);
  assert.equal(result.native.final.sha256, input.final.sha256); assert.equal(result.supportPlanSha256, input.supports.plan.sha256); assert.equal(result.gridAudit.counts.unapprovedOriginalAirFill, 0);
  assert.ok(result.gridAudit.finalMaterialAudit.drains.every(d => d.disposition === 'conforming')); assert.equal(result.gridAudit.removalRequired, false);
  for (const field of ['nativeInvocationAttested', 'functionalVoidClearanceCertified', 'geometricWallCertification', 'physicalDrainageCertification', 'productionEligible']) assert.equal(result[field], false, field);
  assert.deepEqual(input.source, sourceBefore); assert.equal(Object.isFrozen(result.gridAudit.finalMaterialAudit.drains[0]), true);
  verifiedRecord = JSON.parse(JSON.stringify(result)); const replayed = await verifyResinHollowFinalAudit(input, verifiedRecord); assert.equal(replayed.sha256, result.sha256);
});

test('changed original geometry, source/sizing binding and complete final native input cannot reuse support authority', async t => {
  const input = await fixture(t), changedSource = Buffer.from(input.source); changedSource[100] ^= 1;
  await assert.rejects(auditResinHollowFinal({ ...input, source: changedSource }), { code: 'RESIN_HOLLOW_SOURCE_CHANGED' });
  await assert.rejects(auditResinHollowFinal({ ...input, expectedBinding: { ...input.expectedBinding, sizingSha256: '0'.repeat(64) } }), { code: 'RESIN_HOLLOW_SOURCE_CHANGED' });
  const zip = new Zip(input.final.input3mf); zip.deleteFile(input.plan.native.drainMetadataPath);
  await assert.rejects(auditResinHollowFinal({ ...input, final: { ...input.final, input3mf: zip.toBuffer() } }), { code: 'RESIN_HOLLOW_SUPPORT_CHANGED' });
  const plan = structuredClone(input.supports.plan); plan.geometry.supportRegions.push({ id: 'unreviewed', minMm: { x: -1, y: -1, z: -1 }, maxMm: { x: 21, y: 21, z: 21 } });
  await assert.rejects(auditResinHollowFinal({ ...input, supports: { ...input.supports, plan } }), { code: 'RESIN_HOLLOW_SUPPORT_CHANGED' });
});

test('final full preset and target physics remain bound, and a nonconforming body reference cannot proceed to final approval', async t => {
  const input = await fixture(t), preset = Buffer.from(input.final.effectivePreset.toString().replace('support_head_penetration=0.4', 'support_head_penetration=0.5'));
  await assert.rejects(auditResinHollowFinal({ ...input, final: { ...input.final, effectivePreset: preset } }), { code: 'RESIN_HOLLOW_SUPPORT_CHANGED' });
  await assert.rejects(auditResinHollowFinal({ ...input, targetProperties: { ...input.targetProperties, LiftSpeed: 90 } }), { code: 'RESIN_CONVERSION_MISMATCH' });
  const sealed = await fixture(t, 'sealed'); await assert.rejects(auditResinHollowFinal(sealed), { code: 'RESIN_HOLLOW_FINAL_BODY_UNQUALIFIED' });
});

test('the actual complete final file can obstruct one drain despite a good source-bound body and another open drain', async t => {
  const input = await fixture(t); await mutateFinal(input, [{ x: 80, y: 100, z: 5, color: 255 }]); const result = await auditResinHollowFinal(input);
  assert.equal(result.bodyReferenceAudit.disposition, 'conforming'); assert.equal(result.disposition, 'nonconforming'); assert.ok(result.gridAudit.counts.filledRequiredVoidCells > 0);
  const [blocked, other] = result.gridAudit.finalMaterialAudit.drains; assert.ok(blocked.retainedLowerCylinderCells > 0); assert.equal(blocked.disposition, 'nonconforming'); assert.equal(other.disposition, 'conforming');
  assert.equal(result.gridAudit.finalMaterialAudit.counts.cavityUnreachableLower, 0);
  const gray = await fixture(t); await mutateFinal(gray, [{ x: 80, y: 100, z: 5, color: 128 }]); assert.equal((await auditResinHollowFinal(gray)).disposition, 'inconclusive');
});

test('unapproved complete-final foreground is counted over its expanded ROI and changed physical definitions are refused', async t => {
  const added = await fixture(t); await mutateFinal(added, [{ x: 49, y: 50, z: 50, color: 255 }]); const result = await auditResinHollowFinal(added);
  assert.equal(result.disposition, 'nonconforming'); assert.equal(result.gridAudit.counts.unapprovedOriginalAirFill, 1); assert.equal(result.gridAudit.counts.outsideAuthorizedSupportRegions, 1); assert.equal(result.alignment.crop.x, 49);
  const timing = await fixture(t); await mutateFinal(timing, [], { definition(record, z) { if (z === 50) record.writeFloatBE(0, 10); } });
  await assert.rejects(auditResinHollowFinal(timing), { code: 'RESIN_HOLLOW_FINAL_ALIGNMENT_UNSUPPORTED' });
  const identity = await fixture(t), bytes = await fs.readFile(identity.final.filePath); bytes.fill(0, 92, 124); bytes.write('Unmatched printer', 92, 'utf8'); await fs.writeFile(identity.final.filePath, bytes); identity.final.sha256 = hash(bytes);
  await assert.rejects(auditResinHollowFinal(identity), error => ['RESIN_HOLLOW_FINAL_ALIGNMENT_UNSUPPORTED', 'RESIN_CONVERSION_MISMATCH'].includes(error.code));
});

test('frozen artifact digests and independently rederived report semantics reject stale files and resealed claims', async t => {
  const stale = await fixture(t); await mutateFinal(stale, [{ x: 80, y: 100, z: 5, color: 255 }], { updateSha: false });
  await assert.rejects(auditResinHollowFinal(stale), { code: 'RESIN_HOLLOW_FINAL_ARTIFACT_CHANGED' });
  const input = await fixture(t); input.limits = { timeoutMs: 120000 }; assert.ok(verifiedRecord);
  for (const mutate of [r => r.productionEligible = true, r => r.gridAudit.counts.unapprovedOriginalAirFill++, r => r.native.final.sha256 = '0'.repeat(64)]) { const changed = structuredClone(verifiedRecord); mutate(changed); await assert.rejects(verifyResinHollowFinalAudit(input, changed), { code: 'RESIN_HOLLOW_FINAL_AUDIT_CHANGED' }); }
  const resealed = structuredClone(verifiedRecord); resealed.productionEligible = true; resealed.sha256 = reseal(resealed);
  await assert.rejects(verifyResinHollowFinalAudit(input, resealed), { code: 'RESIN_HOLLOW_FINAL_AUDIT_CHANGED' });
});

test('caller-owned source, profiles and request objects are snapshotted before the first await', async t => {
  const input = await fixture(t), originalSourceSha = hash(input.source), originalSupportSha = input.supports.plan.sha256, originalFinalPresetSha = hash(input.final.effectivePreset), pending = auditResinHollowFinal(input);
  input.source.fill(0); input.final.effectivePreset.fill(0); input.supports.preset.fill(0); input.supports.plan = {}; input.plan = {}; input.expectedBinding.sizingSha256 = '0'.repeat(64); input.targetProperties.LiftSpeed = 90; input.placement.x = 999; input.policy.maximumUncertaintyMm = .01;
  const result = await pending; assert.equal(result.disposition, 'conforming'); assert.notEqual(originalSourceSha, hash(input.source)); assert.equal(result.sourceBinding.geometrySha256, originalSourceSha); assert.equal(result.supportPlanSha256, originalSupportSha); assert.equal(result.native.final.effectivePresetSha256, originalFinalPresetSha);
});

test('strict limits, already requested shutdown and an external timer cancel the real isolated pipeline without qualification', async t => {
  const input = await fixture(t), before = new AbortController(); before.abort();
  await assert.rejects(auditResinHollowFinal({ ...input, signal: before.signal }), { code: 'PREPARATION_CANCELLED' });
  await assert.rejects(auditResinHollowFinal({ ...input, limits: { grid: { maxSupportRegions: 513 } } }), { code: 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT' });
  await assert.rejects(auditResinHollowFinal({ ...input, limits: { grid: { maxVoxels: 1000 } } }), { code: 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT' });
  for (const timeoutMs of [180001, '60000', 0]) await assert.rejects(auditResinHollowFinal({ ...input, limits: { reference: { timeoutMs } } }), { code: 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT' });
  await assert.rejects(auditResinHollowFinal({ ...input, limits: { timeoutMs: 1 } }), { code: 'RESIN_HOLLOW_FINAL_AUDIT_LIMIT', status: 413 });
  const active = new AbortController(), timer = setTimeout(() => active.abort(), 40);
  try { await assert.rejects(auditResinHollowFinal({ ...input, signal: active.signal }), { code: 'PREPARATION_CANCELLED' }); } finally { clearTimeout(timer); }
});

test('the final-artifact CLI path creates and revalidates complete evidence using relative support and native input paths', async t => {
  const input = await fixture(t), directory = path.dirname(input.final.filePath), { spawnSync } = require('node:child_process');
  await fs.writeFile(path.join(directory, 'source.stl'), input.source); await fs.writeFile(path.join(directory, 'hollow-plan.json'), JSON.stringify(input.plan)); await fs.writeFile(path.join(directory, 'support-plan.json'), JSON.stringify(input.supports.plan)); await fs.writeFile(path.join(directory, 'support.ini'), input.supports.preset);
  const descriptor = async (value, name) => { await fs.writeFile(path.join(directory, name + '.3mf'), value.input3mf); await fs.writeFile(path.join(directory, name + '.ini'), value.effectivePreset); return { filePath: path.basename(value.filePath), sha256: value.sha256, input3mfPath: name + '.3mf', effectivePresetPath: name + '.ini' }; };
  const request = { schemaVersion: 1, sourcePath: 'source.stl', planPath: 'hollow-plan.json', expectedBinding: input.expectedBinding, solid: await descriptor(input.solid, 'solid'), hollow: await descriptor(input.hollow, 'hollow'), final: await descriptor(input.final, 'final'), supports: { planPath: 'support-plan.json', presetPath: 'support.ini' }, provider: input.provider, targetProperties: input.targetProperties, placement: input.placement, policy: input.policy };
  const requestPath = path.join(directory, 'request.json'), reportPath = path.join(directory, 'complete-audit.json'); await fs.writeFile(requestPath, JSON.stringify(request));
  const execute = flag => spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/audit-resin-hollow.js'), '--request', requestPath, flag, reportPath], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  const created = execute('--output'); assert.equal(created.status, 0, created.stderr); const bytes = await fs.readFile(reportPath), report = JSON.parse(bytes); assert.equal(report.method, 'source-bound-final-supported-hollow-raster-v1'); assert.equal(report.nativeInvocationAttested, false); assert.equal(report.productionEligible, false); assert.equal(JSON.parse(created.stdout).sha256, report.sha256);
  const verified = execute('--verify'); assert.equal(verified.status, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).sha256, report.sha256);
  const overwrite = execute('--output'); assert.equal(overwrite.status, 1); assert.match(overwrite.stderr, /EEXIST/); assert.deepEqual(await fs.readFile(reportPath), bytes);
});
