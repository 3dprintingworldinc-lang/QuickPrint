'use strict';

// Support contacts/regions are part of the reviewed request. They authorize
// temporary added material, not a claim that every original airspace stays open.
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const Zip = require('adm-zip');
const { parseIni } = require('./resin-engine');
const { inspectZip, readZipEntry } = require('./psam/zip-inspection');
const { forEachResinTriangle, measureResinGeometry, measureResinOrientation, float32Tolerance } = require('./resin-geometry');
const { verifyResinHollowPlan, createResinHollow3mf } = require('./resin-hollow-plan');

const AXES = ['x', 'y', 'z'], PATH = 'Metadata/Slic3r_PE_sla_support_points.txt';
const MAX_POINTS = 512, MAX_REGIONS = 512, ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_HOLLOW_SUPPORT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function exact(value, keys, label) { if (!plain(value) || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => !keys.includes(key))) throw fail(`Invalid ${label}.`); }
function number(value, min, max, label) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(`Invalid ${label}.`); return value === 0 ? 0 : value; }
function vector(value, min, max, label) { exact(value, AXES, label); return Object.fromEntries(AXES.map(axis => [axis, number(value[axis], min, max, label)])); }
const object = values => Object.fromEntries(AXES.map((axis, index) => [axis, values[index] === 0 ? 0 : values[index]]));
function rotate(orientation) {
  const [x, y, z] = AXES.map(axis => orientation[axis] * Math.PI / 180), [cx, cy, cz] = [x, y, z].map(Math.cos), [sx, sy, sz] = [x, y, z].map(Math.sin);
  return ([x, y, z]) => { const zx = x * cz - y * sz, zy = x * sz + y * cz, xy = zy * cx - z * sx, xz = zy * sx + z * cx; return [zx * cy + xz * sy, xy, -zx * sy + xz * cy]; };
}
function profile(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024 || (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)) throw fail('Use a bounded owned standalone preset.');
  const copy = Buffer.from(bytes), ini = parseIni(new TextDecoder('utf-8', { fatal: true }).decode(copy));
  for (const key of ['supports_enable', 'pad_enable', 'pad_around_object', 'pad_around_object_everywhere']) if (!['0', '1'].includes(ini[key])) throw fail(`Declare an explicit ${key}.`);
  if (ini.printer_technology !== 'SLA') throw fail('Support planning requires an SLA preset.');
  if (!['default', 'branching'].includes(ini.support_tree_type)) throw fail('Declare the native default or branching support tree.');
  const active = (key, min, max, materialOverride = false) => {
    const override = materialOverride ? ini[`material_ow_${key}`] : undefined, raw = override !== undefined && override !== 'nil' ? override : ini[key];
    if (typeof raw !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) throw fail(`Declare a finite scalar ${key}.`);
    return number(Number(raw), min, max, key);
  };
  const supportElevationMm = active('support_object_elevation', 0, 100), padThicknessMm = active('pad_wall_thickness', 0, 20), padWallHeightMm = active('pad_wall_height', 0, 20);
  const prefix = ini.support_tree_type === 'branching' ? 'branchingsupport_' : 'support_';
  const headPenetrationMm = active(`${prefix}head_penetration`, 0, 10, true), headRadiusMm = active(`${prefix}head_front_diameter`, 0.001, 20, true) / 2;
  const elevationMm = ini.pad_enable === '1' && ini.pad_around_object === '1' ? 0 : (ini.supports_enable === '1' ? supportElevationMm : 0) + (ini.pad_enable === '1' ? padThicknessMm : 0);
  const settings = Object.fromEntries(Object.entries(ini).filter(([key]) => /^(?:supports_enable$|support_|branchingsupport_|pad_|material_ow_(?:support_|branchingsupport_))/.test(key)));
  return { sha256: hash(copy), settings, treeType: ini.support_tree_type, supportElevationMm, padThicknessMm, padWallHeightMm, headPenetrationMm, headRadiusMm, elevationMm, supportsEnabled: ini.supports_enable === '1', padEnabled: ini.pad_enable === '1' };
}
function onTriangle(point, triangle, tolerance) {
  const subtract = (a, b) => a.map((value, index) => value - b[index]), cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const [a, b, c] = triangle, u = subtract(b, a), v = subtract(c, a), scale = Math.max(...u.map(Math.abs), ...v.map(Math.abs));
  const normal = cross(u.map(value => value / scale), v.map(value => value / scale)), length = Math.hypot(...normal), unit = normal.map(value => value / length);
  if (!Number.isFinite(length) || length === 0 || Math.abs(dot(subtract(point, a), unit)) > tolerance) return false;
  for (let index = 0; index < 3; index++) { const edge = subtract(triangle[(index + 1) % 3], triangle[index]); if (dot(cross(edge, subtract(point, triangle[index])), unit) < -tolerance * Math.hypot(...edge)) return false; }
  return true;
}

function prepareResinHollowSupports(sourceBytes, hollowRecord, bindingRecord, preset, request) {
  const started = performance.now(), check = () => { if (performance.now() - started > 30000) throw fail('Support planning exceeded its time bound.', 'RESIN_HOLLOW_SUPPORT_LIMIT', 413); };
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 134 || sourceBytes.length > 84 + 250000 * 50 || sourceBytes.length !== 84 + sourceBytes.readUInt32LE(80) * 50 || (typeof SharedArrayBuffer !== 'undefined' && sourceBytes.buffer instanceof SharedArrayBuffer)) throw fail('Use the reviewed bounded normalized binary millimetre STL.', 'RESIN_HOLLOW_SUPPORT_LIMIT', 413);
  const source = Buffer.from(sourceBytes), hollowPlan = structuredClone(hollowRecord), expectedBinding = structuredClone(bindingRecord);
  const prepared = verifyResinHollowPlan(source, hollowPlan, expectedBinding), settings = profile(preset);
  exact(request, ['mode', 'clearanceMm', 'points', 'regions'], 'support request');
  if (!['none', 'automatic', 'points'].includes(request.mode) || (request.mode === 'none') !== !settings.supportsEnabled) throw fail('Support mode must agree with the frozen preset.');
  const clearanceMm = number(request.clearanceMm, 0, 100, 'support clearance');
  if (!Array.isArray(request.points) || request.points.length > MAX_POINTS || (request.mode === 'points' ? !request.points.length : request.points.length)) throw fail('Authored support mode requires 1..512 points; other modes require none.');
  if (!Array.isArray(request.regions) || request.regions.length > MAX_REGIONS || (request.mode === 'automatic' && !request.regions.length)) throw fail('Automatic supports need explicit prior authorized regions.');
  if (request.mode === 'none' && request.regions.length) throw fail('Disabled supports cannot authorize additional contact regions.');
  const measured = measureResinGeometry(source, { format: 'stl', units: 'mm' }), ids = new Set();
  const points = request.points.map(value => {
    exact(value, ['id', 'sourceFaceIndex', 'positionMm', 'headRadiusMm', 'allowedRadiusMm'], 'support contact');
    if (typeof value.id !== 'string' || !ID.test(value.id) || ids.has(value.id)) throw fail('Support contact identifiers must be unique bounded ASCII strings.'); ids.add(value.id);
    if (!Number.isSafeInteger(value.sourceFaceIndex) || value.sourceFaceIndex < 0 || value.sourceFaceIndex >= measured.triangleCount) throw fail('Support contacts require an original normalized source face index.');
    const positionMm = vector(value.positionMm, 0, 10000, 'support position'), headRadiusMm = number(value.headRadiusMm, 0.001, 10, 'support head radius'), allowedRadiusMm = number(value.allowedRadiusMm, headRadiusMm, 100, 'support authorization radius');
    if (AXES.some(axis => positionMm[axis] > measured.sourceDimensionsMm[axis])) throw fail('A contact is outside the reviewed source bounds.');
    return { id: value.id, sourceFaceIndex: value.sourceFaceIndex === 0 ? 0 : value.sourceFaceIndex, positionMm, headRadiusMm, allowedRadiusMm };
  });
  const byFace = new Map(); for (const point of points) { if (!byFace.has(point.sourceFaceIndex)) byFace.set(point.sourceFaceIndex, []); byFace.get(point.sourceFaceIndex).push(point); }
  const toleranceMm = Math.max(...Object.values(measured.sourceDimensionsMm).map(float32Tolerance)) * 2;
  forEachResinTriangle(source, { format: 'stl', units: 'mm', limits: { maxTriangles: 250000 } }, (triangle, index) => {
    if ((index & 255) === 0) check();
    for (const point of byFace.get(index) ?? []) if (!onTriangle(AXES.map(axis => point.positionMm[axis]), triangle, toleranceMm)) throw fail('An authored contact does not lie on its declared source face.', 'RESIN_HOLLOW_SUPPORT_CONTACT');
  }); check();
  const oriented = measureResinOrientation(source, { format: 'stl', units: 'mm', orientation: hollowPlan.request.orientation }), rotation = rotate(hollowPlan.request.orientation), center = hollowPlan.canonical.nativeObjectCenterMm, signatures = new Set();
  const nativePoints = points.map(point => {
    const exactPoint = rotation(AXES.map(axis => point.positionMm[axis])).map((value, index) => value - oriented.boundsMm.min[AXES[index]]), canonicalMm = exactPoint.map(Math.fround);
    const localMm = canonicalMm.map((value, index) => Math.fround(value - center[AXES[index]])), radiusMm = Math.fround(point.headRadiusMm), signature = localMm.join(' ');
    if (signatures.has(signature)) throw fail('Two support contacts collapse to the same native position.', 'RESIN_HOLLOW_SUPPORT_PRECISION'); signatures.add(signature);
    return { id: point.id, requestedCanonicalMm: object(exactPoint), canonicalMm: object(canonicalMm), objectLocalMm: object(localMm), headRadiusMm: radiusMm, type: 2 };
  });
  const regions = [], normalizedRegions = [], regionIds = new Set(), clean = value => object(AXES.map(axis => value[axis]));
  const addRegion = (id, minMm, maxMm) => { if (regionIds.has(id) || AXES.some(axis => minMm[axis] >= maxMm[axis])) throw fail('Support regions must have unique identifiers and positive volume.'); if (regions.length >= MAX_REGIONS) throw fail('Contacts, prior regions and pad may authorize at most 512 regions in total.', 'RESIN_HOLLOW_SUPPORT_LIMIT', 413); regionIds.add(id); regions.push({ id, minMm: clean(minMm), maxMm: clean(maxMm) }); };
  for (const value of request.regions) {
    exact(value, ['id', 'minMm', 'maxMm'], 'authorized support region');
    if (typeof value.id !== 'string' || !ID.test(value.id)) throw fail('Support region identifiers must be bounded ASCII strings.');
    const minMm = vector(value.minMm, -10000, 10000, 'region minimum'), maxMm = vector(value.maxMm, -10000, 10000, 'region maximum');
    normalizedRegions.push({ id: value.id, minMm, maxMm }); addRegion(`region-${value.id}`, minMm, maxMm);
  }
  for (let index = 0; index < points.length; index++) {
    const point = points[index], at = nativePoints[index].canonicalMm, radius = point.allowedRadiusMm;
    addRegion(`point-${point.id}`, { x: at.x - radius, y: at.y - radius, z: -settings.elevationMm }, { x: at.x + radius, y: at.y + radius, z: at.z + settings.headPenetrationMm + point.headRadiusMm });
  }
  const maxHeadRadiusMm = Math.max(settings.headRadiusMm, ...points.map(point => point.headRadiusMm));
  const dimensions = hollowPlan.canonical.dimensionsMm, envelope = { minMm: { x: -clearanceMm, y: -clearanceMm, z: -settings.elevationMm }, maxMm: { x: dimensions.x + clearanceMm, y: dimensions.y + clearanceMm, z: dimensions.z + (settings.supportsEnabled ? settings.headPenetrationMm + maxHeadRadiusMm : 0) } };
  envelope.minMm = clean(envelope.minMm); envelope.maxMm = clean(envelope.maxMm);
  if (settings.padEnabled && settings.padThicknessMm + settings.padWallHeightMm > 0) addRegion('native-pad', { ...envelope.minMm }, { x: envelope.maxMm.x, y: envelope.maxMm.y, z: -settings.elevationMm + settings.padThicknessMm + settings.padWallHeightMm });
  for (const region of regions) if (AXES.some(axis => region.minMm[axis] < envelope.minMm[axis] || region.maxMm[axis] > envelope.maxMm[axis])) throw fail('An authorized support region exceeds its prior global envelope.');
  const metadata = nativePoints.length ? Buffer.from(`support_points_format_version=1\nobject_id=1|${nativePoints.map(point => [...AXES.map(axis => point.objectLocalMm[axis]), point.headRadiusMm, 2].join(' ')).join(' ')}\n`, 'ascii') : null;
  const normalized = { mode: request.mode, clearanceMm, points, regions: normalizedRegions };
  const record = { schemaVersion: 1, method: 'prusa-2.9.7-hollow-support-request-v1', sourceBinding: { ...expectedBinding }, hollowPlanSha256: hollowPlan.sha256, request: normalized, preset: settings,
    native: { version3mf: 1, objectOrdinal: 1, supportMetadataPath: PATH, supportMetadataSha256: metadata ? hash(metadata) : null, points: nativePoints }, sourceContactToleranceMm: toleranceMm,
    geometry: { modelElevationMm: settings.elevationMm, supportEnvelope: envelope, supportRegions: regions }, temporarySupportRemovalRequired: settings.supportsEnabled || settings.padEnabled, functionalVoidClearanceCertified: false, productionEligible: false };
  record.sha256 = hash(JSON.stringify(record)); check();
  return { plan: freeze(record), metadata };
}

function verifyResinHollowSupports(source, hollowPlan, expectedBinding, preset, record) {
  if (!plain(record) || !plain(record.request)) throw fail('A frozen support request record is required.');
  const actual = prepareResinHollowSupports(source, hollowPlan, expectedBinding, preset, record.request);
  if (!isDeepStrictEqual(actual.plan, record)) throw fail('The support request or its source/profile changed.', 'RESIN_HOLLOW_SUPPORT_CHANGED', 409);
  return actual;
}

function createSupportedHollow3mf(source, hollowPlan, expectedBinding, preset, record, placement) {
  const supported = verifyResinHollowSupports(source, hollowPlan, expectedBinding, preset, record), base = createResinHollow3mf(source, hollowPlan, expectedBinding, placement), archive = new Zip(base.threeMf);
  if (supported.metadata) archive.addFile(PATH, supported.metadata);
  for (const entry of archive.getEntries()) { entry.header.timeval = 33 << 16; entry.header.method = 0; entry.header.made = 20; entry.header.flags = 0; entry.header.attr = 0; entry.header.inAttr = 0; }
  const threeMf = archive.toBuffer();
  if (threeMf.length > 32 * 1024 * 1024) throw fail('The supported native input exceeds its byte bound.', 'RESIN_HOLLOW_SUPPORT_LIMIT', 413);
  return { threeMf, sha256: hash(threeMf), hollowPlanSha256: hollowPlan.sha256, supportPlanSha256: record.sha256, productionEligible: false };
}

function supportFields(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024 || bytes.some(value => value > 127)) throw fail('Invalid native support metadata.', 'RESIN_HOLLOW_SUPPORT_CHANGED', 409);
  const match = /^support_points_format_version=1\r?\nobject_id=1\|([^\r\n]+)\r?\n?$/.exec(bytes.toString('ascii'));
  if (!match) throw fail('Support metadata must address exactly one version-1 object.', 'RESIN_HOLLOW_SUPPORT_CHANGED', 409);
  const tokens = match[1].split(' '), decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!tokens.length || tokens.length % 5 || tokens.length > MAX_POINTS * 5 || tokens.some(value => !decimal.test(value))) throw fail('Support metadata fields or separators are invalid.', 'RESIN_HOLLOW_SUPPORT_CHANGED', 409);
  return tokens.map((token, index) => { const raw = Number(token); if (index % 5 === 4 && raw !== 2) throw fail('An authored support point must retain its exact manual type.', 'RESIN_HOLLOW_SUPPORT_CHANGED', 409); const value = Math.fround(raw); if (!Number.isFinite(value)) throw fail('Support metadata contains a nonfinite native field.', 'RESIN_HOLLOW_SUPPORT_CHANGED', 409); return value === 0 ? 0 : value; });
}

function assertSupportedHollowInput(actual, expected, role = 'final') {
  if (!['final', 'hollow-reference', 'solid-reference'].includes(role)) throw fail('Invalid supported native input role.');
  const limits = { maxArchiveBytes: 32 * 1024 * 1024, maxEntryBytes: 32 * 1024 * 1024, maxTotalUncompressedBytes: 32 * 1024 * 1024, maxEntries: 5, maxCompressionRatio: 10000 };
  const entries = bytes => new Map(inspectZip(bytes, limits).entries.map(entry => [entry.name, readZipEntry(bytes, entry, limits)]));
  const supplied = entries(actual), wanted = entries(expected), drainPath = 'Metadata/Slic3r_PE_sla_drain_holes.txt';
  if (role === 'solid-reference') wanted.delete(drainPath);
  if (role !== 'final' && !supplied.has(PATH)) wanted.delete(PATH);
  if (supplied.size !== wanted.size) throw fail('Supported native input has missing or additional content.', 'RESIN_HOLLOW_SUPPORT_CHANGED', 409);
  for (const [name, bytes] of wanted) {
    const item = supplied.get(name);
    if (!item || (name === PATH ? !isDeepStrictEqual(supportFields(item), supportFields(bytes)) : !item.equals(bytes))) throw fail('Supported native geometry, contacts or placement changed.', 'RESIN_HOLLOW_SUPPORT_CHANGED', 409);
  }
  return { sha256: hash(actual), role, entries: supplied.size };
}

module.exports = { prepareResinHollowSupports, verifyResinHollowSupports, createSupportedHollow3mf, assertSupportedHollowInput };
