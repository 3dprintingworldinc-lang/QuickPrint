'use strict';

// A source-bound native request, not a cavity/wall/drain verification receipt.
// Production still rejects hollowing until the resulting geometry is verified.
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const Zip = require('adm-zip');
const { measureResinGeometry, measureResinOrientation } = require('./resin-geometry');
const { prepareResinPlateSource } = require('./resin-plate');
const { createResinPlate3mf } = require('./resin-plate-engine');

const AXES = ['x', 'y', 'z'];
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 100 * 1024 * 1024;
const MAX_DRAINS = 64;
const COINCIDENT_START_MM = 0.01;
const METADATA_PATH = 'Metadata/Slic3r_PE_sla_drain_holes.txt';
const hash = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_HOLLOW_PLAN_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const point = values => Object.fromEntries(AXES.map((axis, index) => [axis, values[index] === 0 ? 0 : values[index]]));
const values = value => AXES.map(axis => value[axis]);
function keys(value, expected, label) {
  if (!plain(value) || Reflect.ownKeys(value).length !== expected.length || Reflect.ownKeys(value).some(key => !expected.includes(key))) throw fail(`${label} must contain exactly ${expected.join(', ')}.`);
}
function number(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(`${label} must be a finite number from ${min} through ${max}.`);
  return value === 0 ? 0 : value;
}
function vector(value, label, min, max) {
  keys(value, AXES, label);
  return point(AXES.map(axis => number(value[axis], `${label}.${axis}`, min, max)));
}
function binding(value) {
  keys(value, ['sourceSha256', 'geometrySha256', 'sizingSha256'], 'Hollow source binding');
  for (const [key, item] of Object.entries(value)) if (typeof item !== 'string' || !HASH.test(item)) throw fail(`${key} must be a SHA-256 digest.`);
  return { sourceSha256: value.sourceSha256, geometrySha256: value.geometrySha256, sizingSha256: value.sizingSha256 };
}
function normalizeRequest(value) {
  keys(value, ['binding', 'orientation', 'wallThicknessMm', 'quality', 'closingDistanceMm', 'drains'], 'Hollow request');
  const source = binding(value.binding), orientation = vector(value.orientation, 'Orientation degrees', -360, 360);
  // These are the pinned PrusaSlicer 2.9.7 PrintConfig bounds, not calibrated
  // physical wall values or a claim about the native algorithm's accuracy.
  const wallThicknessMm = number(value.wallThicknessMm, 'Requested wall thickness', 1, 10);
  const quality = number(value.quality, 'Hollowing quality', 0, 1);
  const closingDistanceMm = number(value.closingDistanceMm, 'Closing distance', 0, 10);
  if (!Array.isArray(value.drains) || !value.drains.length || value.drains.length > MAX_DRAINS) throw fail('Declare from 1 through 64 explicit drain cylinders.');
  const ids = new Set();
  const drains = value.drains.map((drain, index) => {
    keys(drain, ['id', 'startMm', 'direction', 'radiusMm', 'lengthMm'], `Drain ${index + 1}`);
    if (typeof drain.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(drain.id) || ids.has(drain.id)) throw fail('Drain IDs must be unique ASCII letters, digits, underscores or hyphens, up to 48 characters.');
    ids.add(drain.id);
    const startMm = vector(drain.startMm, `Drain ${drain.id} start`, -10000, 10000);
    const direction = vector(drain.direction, `Drain ${drain.id} unit direction`, -1, 1);
    if (Math.abs(Math.hypot(...values(direction)) - 1) > 1e-12) throw fail(`Drain ${drain.id} requires an explicit unit direction.`);
    return { id: drain.id, startMm, direction, radiusMm: number(drain.radiusMm, 'Drain radius', 0.001, 1000), lengthMm: number(drain.lengthMm, 'Drain length', 0.001, 10000) };
  });
  return { binding: source, orientation, wallThicknessMm, quality, closingDistanceMm, drains };
}
function rotation(orientation) {
  const [x, y, z] = values(orientation).map(value => value * Math.PI / 180);
  const [cx, cy, cz] = [x, y, z].map(Math.cos), [sx, sy, sz] = [x, y, z].map(Math.sin);
  // Same explicit Z -> X -> Y convention as canonical plate geometry.
  return ([x, y, z]) => {
    const zx = x * cz - y * sz, zy = x * sz + y * cz, xy = zy * cx - z * sx, xz = zy * sx + z * cx;
    return [zx * cy + xz * sy, xy, -zx * sy + xz * cy];
  };
}

function prepareResinHollowPlan(source, request) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > MAX_BYTES) throw fail('Hollow planning requires a bounded normalized STL.', 'RESIN_HOLLOW_PLAN_LIMIT', 413);
  const normalized = normalizeRequest(request), input = Buffer.from(source);
  if (hash(input) !== normalized.binding.geometrySha256) throw fail('The hollow request does not match the reviewed sized geometry.', 'RESIN_HOLLOW_SOURCE_CHANGED', 409);
  const parse = { format: 'stl', units: 'mm' }, measured = measureResinGeometry(input, parse);
  if (AXES.some(axis => measured.sourceBounds.min[axis] !== 0 || measured.sourceDimensionsMm[axis] <= 0)) throw fail('Hollow input must be the zero-origin sized millimetre STL.');
  const oriented = measureResinOrientation(input, { ...parse, orientation: normalized.orientation });
  const canonical = prepareResinPlateSource(input, { orientation: normalized.orientation });
  const center = AXES.map(axis => (canonical.bounds.min[axis] + canonical.bounds.max[axis]) / 2);
  const rotate = rotation(normalized.orientation), signatures = new Set(), cylinders = [];
  const nativeDrains = normalized.drains.map(drain => {
    const rotated = rotate(values(drain.startMm));
    const canonicalStart = rotated.map((value, index) => value - oriented.boundsMm.min[AXES[index]]);
    const localStart = canonicalStart.map((value, index) => value - center[index]);
    const direction = rotate(values(drain.direction)).map(Math.fround);
    const magnitude = Math.hypot(...direction), unit = direction.map(value => value / magnitude);
    // Format version 1 deliberately stores a point 1 mm outside, and a cylinder
    // 1 mm longer. The importer adds normalized(direction) and subtracts 1 mm.
    const position = localStart.map((value, index) => Math.fround(value - unit[index]));
    const radius = Math.fround(drain.radiusMm), height = Math.fround(drain.lengthMm + 1);
    const serialized = [...position, ...direction, radius, height].map(value => value === 0 ? 0 : value);
    if (serialized.some(value => !Number.isFinite(value)) || Math.fround(height - 1) <= 0) throw fail('Native drain metadata loses a positive finite cylinder.', 'RESIN_HOLLOW_PLAN_PRECISION');
    const signature = serialized.join(' ');
    if (signatures.has(signature)) throw fail('Two planned drains become the same native cylinder.', 'RESIN_HOLLOW_PLAN_DUPLICATE');
    // Distinct float32 sidecar positions can collapse during the importer's
    // subsequent float32 +unitDirection compensation. Conservatively reject
    // near-coincident starts with identical native direction/radius/height;
    // this policy does not pretend to simulate Eigen normalization exactly.
    if (cylinders.some(previous => serialized.slice(3).every((value, index) => value === previous[index + 3]) && position.every((value, index) => Math.abs(value - previous[index]) <= COINCIDENT_START_MM))) throw fail('Same-direction native drain starts must differ by more than 0.01 mm on at least one axis.', 'RESIN_HOLLOW_PLAN_DUPLICATE');
    cylinders.push(serialized);
    signatures.add(signature);
    return { id: drain.id, requestedCanonicalStartMm: point(canonicalStart), requestedObjectLocalStartMm: point(localStart), serializedPositionMm: point(position), serializedDirection: point(direction), serializedRadiusMm: radius, serializedHeightMm: height, lengthAfterImportMm: Math.fround(height - 1) };
  });
  const text = `drain_holes_format_version=1\nobject_id=1|${[...signatures].join(' ')}\n`;
  const drainMetadata = Buffer.from(text, 'ascii');
  const record = {
    schemaVersion: 1, method: 'prusa-2.9.7-hollow-request-v1', frame: 'sized-normalized-mm-before-orientation', request: normalized,
    canonical: { sha256: canonical.sha256, triangleCount: canonical.triangleCount, boundsMm: canonical.bounds, dimensionsMm: canonical.dimensionsMm, nativeObjectCenterMm: point(center) },
    native: { version3mf: 1, objectOrdinal: 1, drainMetadataPath: METADATA_PATH, drainMetadataSha256: hash(drainMetadata), drains: nativeDrains,
      positionImport: 'float32(position + float32_normalize(direction)); requested positions are not exact imported positions',
      coincidentSameCylinderStartToleranceMm: COINCIDENT_START_MM,
      additionalNativeStickOutLengthMm: 1,
      presetOverrides: { hollowing_enable: '1', hollowing_min_thickness: String(normalized.wallThicknessMm), hollowing_quality: String(normalized.quality), hollowing_closing_distance: String(normalized.closingDistanceMm) } },
    verification: { status: 'request-only', geometryVerified: false, drainConnectivityVerified: false, wallThicknessVerified: false, productionEligible: false },
  };
  record.sha256 = hash(JSON.stringify(record));
  return { stl: canonical.stl, drainMetadata, plan: freeze(record) };
}

function verifyResinHollowPlan(source, record, expectedBinding) {
  const expected = binding(expectedBinding);
  if (!plain(record) || !plain(record.request) || !isDeepStrictEqual(record.request.binding, expected)) throw fail('The hollow request is bound to a different source or sizing review.', 'RESIN_HOLLOW_SOURCE_CHANGED', 409);
  const prepared = prepareResinHollowPlan(source, record.request);
  if (!isDeepStrictEqual(record, prepared.plan)) throw fail('Hollow request metadata changed; regenerate it from the reviewed source.', 'RESIN_HOLLOW_PLAN_CHANGED', 409);
  return prepared;
}

function createResinHollow3mf(source, record, expectedBinding, placement) {
  keys(placement, AXES, 'Reference placement');
  const location = vector(placement, 'Reference placement', 0, 10000);
  const prepared = verifyResinHollowPlan(source, record, expectedBinding);
  const archive = new Zip(createResinPlate3mf(prepared.stl, [location]));
  const model = archive.readAsText('3D/3dmodel.model');
  // Without this marker Prusa's legacy import bakes the build transform into
  // the mesh before centering, changing the interpretation of hole metadata.
  archive.updateFile('3D/3dmodel.model', Buffer.from(model.replace('<resources>', '<metadata name="slic3rpe:Version3mf">1</metadata><resources>')));
  archive.addFile(METADATA_PATH, prepared.drainMetadata);
  for (const entry of archive.getEntries()) {
    // ASCII-only paths and fixed DOS headers avoid OS, timezone, clock and
    // compression-version differences in an otherwise identical request.
    entry.header.timeval = 33 << 16; entry.header.method = 0;
    entry.header.made = 20; entry.header.flags = 0;
    entry.header.attr = 0; entry.header.inAttr = 0;
  }
  const threeMf = archive.toBuffer();
  if (threeMf.length > MAX_BYTES) throw fail('Hollow 3MF exceeds its byte bound.', 'RESIN_HOLLOW_PLAN_LIMIT', 413);
  return { threeMf, sha256: hash(threeMf), planSha256: record.sha256, placement: freeze(location), productionEligible: false };
}

module.exports = { prepareResinHollowPlan, verifyResinHollowPlan, createResinHollow3mf };
