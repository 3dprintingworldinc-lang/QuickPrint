'use strict';

// Trusted generated plates use one shared mesh and explicit 3MF instances.
// Quantity is established by exact, independently checked raster replication;
// it is never inferred from native exit status or a mesh component count.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { forEachResinTriangle, float32Tolerance } = require('./resin-geometry');
const { prepareResinPlateSource, planResinPlate } = require('./resin-plate');
const { inspectGooRaster, verifyGooPlate } = require('./goo-plate');
const { inspectGoo } = require('./goo');

const MAX_MODEL = 100 * 1024 * 1024, MAX_GOO = 512 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const fail = (message, code = 'RESIN_PLATE_INVALID', status = 409) => Object.assign(new Error(message), { code, status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const canonicalHash = value => hash(JSON.stringify(canonical(value)));
const PINNED_SLA_DEFAULTS = Object.freeze({ support_object_elevation: '5', pad_wall_thickness: '2', pad_wall_height: '0', pad_around_object: '0', pad_around_object_everywhere: '0', tower_hop_height: '0,0', relative_correction: '1,1', relative_correction_x: '1', relative_correction_y: '1', relative_correction_z: '1', material_correction: '1,1,1', material_correction_x: '1', material_correction_y: '1', material_correction_z: '1', zcorrection_layers: '0' });

function assertPackedEffectiveSettings(effective, requested) {
  const same = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    const left = a.trim().replace(/\s*,\s*/g, ','), right = b.trim().replace(/\s*,\s*/g, ',');
    if (numeric.test(left) && numeric.test(right)) return Number(left) === Number(right);
    if (left.includes(',') && right.includes(',') && left.split(',').every(value => numeric.test(value)) && right.split(',').every(value => numeric.test(value))) return isDeepStrictEqual(left.split(',').map(Number), right.split(',').map(Number));
    return left === right;
  };
  for (const [key, value] of Object.entries({ ...PINNED_SLA_DEFAULTS, ...requested })) {
    // tower_hop_height is an SLAPrint validation setting omitted from the SL1
    // effective preset by 2.9.7 when its printer technology does not expose it.
    if (key === 'tower_hop_height' && effective[key] === undefined && requested[key] === undefined) continue;
    if (!same(effective[key], value)) throw fail(`Packed SLA changed or omitted requested setting ${key}.`, 'RESIN_EFFECTIVE_PROFILE_MISMATCH', 502);
  }
}

function prepareResinPlatePreset(preset, ini) {
  if (!Buffer.isBuffer(preset) || !preset.length || preset.length > 1024 * 1024 || !isDeepStrictEqual(require('./resin-engine').parseIni(preset.toString('utf8')), ini)) throw fail('Packed preparation requires the exact current standalone preset bytes.', 'RESIN_PLATE_CHANGED');
  let normalization = null, effective = preset;
  if (ini.faded_layers !== undefined) {
    const value = Number(ini.faded_layers);
    if (!Number.isSafeInteger(value) || value < 0 || value > 10000 || (ini.material_ow_faded_layers !== undefined && Number(ini.material_ow_faded_layers) !== value)) throw fail('Resolve conflicting SLA material/print faded-layer settings before packing.', 'RESIN_PLATE_PROFILE_CONFLICT', 400);
    if (ini.material_ow_faded_layers === undefined) {
      normalization = { rule: 'material_ow_faded_layers_from_faded_layers', value };
      effective = Buffer.concat([preset, Buffer.from(`${preset.at(-1) === 10 ? '' : '\n'}material_ow_faded_layers = ${value}\n`)]);
    }
  }
  return { original: preset, effective, normalization };
}

function normalizeResinPlateOptions(value) {
  if (!plain(value) || Reflect.ownKeys(value).sort().join(',') !== 'copies,gapMm,marginMm' || !Number.isSafeInteger(value.copies) || value.copies < 1 || value.copies > 500 || typeof value.gapMm !== 'number' || !Number.isFinite(value.gapMm) || value.gapMm < 0 || value.gapMm > 10000 || typeof value.marginMm !== 'number' || !Number.isFinite(value.marginMm) || value.marginMm < 1 || value.marginMm > 10000) throw fail('A packed plate requires copies 1..500, a nonnegative gap and a margin of at least 1 mm.', 'RESIN_PLATE_INVALID_REQUEST', 400);
  return freeze({ copies: value.copies, gapMm: value.gapMm === 0 ? 0 : value.gapMm, marginMm: value.marginMm });
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, number) => {
  for (let bit = 0; bit < 8; bit++) number = number & 1 ? 0xedb88320 ^ (number >>> 1) : number >>> 1;
  return number >>> 0;
});
function crc32(data) { let value = 0xffffffff; for (const byte of data) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function storedZip(files) {
  const locals = [], central = []; let offset = 0;
  for (const [filename, data] of files) {
    const name = Buffer.from(filename, 'ascii'), crc = crc32(data), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(33, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(record, name); offset += local.length + name.length + data.length;
  }
  const directoryBytes = central.reduce((sum, data) => sum + data.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directoryBytes, 12); end.writeUInt32LE(offset, 16);
  if (offset + directoryBytes + end.length > MAX_MODEL) throw fail('Generated 3MF exceeds the model byte limit.', 'RESIN_PLATE_LIMIT', 413);
  return Buffer.concat([...locals, ...central, end]);
}

function createResinPlate3mf(canonicalStl, placements) {
  if (!Array.isArray(placements) || !placements.length || placements.length > 500 || placements.some(value => !plain(value) || !['x','y','z'].every(axis => typeof value[axis] === 'number' && Number.isFinite(value[axis]) && value[axis] >= 0 && value[axis] <= 10000))) throw fail('3MF requires bounded explicit millimetre placements.');
  const vertices = [], triangles = [], vertexIndices = new Map(); let bytes = 0;
  const add = (array, text) => { bytes += Buffer.byteLength(text); if (bytes > MAX_MODEL - 16384) throw fail('Generated 3MF geometry exceeds the model byte limit.', 'RESIN_PLATE_LIMIT', 413); array.push(text); };
  forEachResinTriangle(canonicalStl, { format: 'stl', units: 'mm' }, points => {
    // STL repeats coordinates per triangle. A 3MF indexed mesh must share the
    // corresponding exact vertices so curved faces retain their adjacency.
    // This never rounds, moves, tolerantly welds or drops source geometry.
    const indices = points.map(point => {
      const key = point.join(',');
      if (!vertexIndices.has(key)) {
        if (vertexIndices.size >= 1000000) throw fail('Generated shared-mesh vertex count exceeds its resource bound.', 'RESIN_PLATE_LIMIT', 413);
        vertexIndices.set(key, vertices.length);
        add(vertices, `<vertex x="${point[0]}" y="${point[1]}" z="${point[2]}"/>`);
      }
      return vertexIndices.get(key);
    });
    add(triangles, `<triangle v1="${indices[0]}" v2="${indices[1]}" v3="${indices[2]}"/>`);
  });
  const build = placements.map(value => `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${value.x} ${value.y} ${value.z}"/>`).join('');
  const model = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object></resources><build>${build}</build></model>`, 'utf8');
  return storedZip([
    ['[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')],
    ['_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')],
    ['3D/3dmodel.model', model],
  ]);
}

function profileGeometry(profile, ini) {
  return { ...profile.expected, machineZMm: Number(ini.max_print_height) };
}
function referencePlacement(source, geometry) {
  const pitch = { x: geometry.displayWidthMm / geometry.resolutionX, y: geometry.displayHeightMm / geometry.resolutionY };
  const placement = Object.fromEntries(['x','y'].map(axis => {
    const available = (axis === 'x' ? geometry.displayWidthMm : geometry.displayHeightMm) - source.dimensionsMm[axis];
    if (available < -float32Tolerance(source.dimensionsMm[axis])) throw fail('Oriented source cannot fit the printer reference plate.', 'RESIN_PLATE_NO_CAPACITY');
    return [axis, Math.floor(Math.max(0, available) / (2 * pitch[axis])) * pitch[axis]];
  }));
  return { placement: { ...placement, z: 0 }, pitch };
}

// Defaults are pinned to the verified PrusaSlicer 2.9.7 SLA implementation.
// The exported effective preset is checked against this policy after slicing.
function resinPlateHeightPolicy(source, profile, ini) {
  const value = (key, fallback) => {
    const raw = ini[key] === undefined ? fallback : Number(ini[key]);
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 10000) throw fail(`Packed SLA requires a bounded ${key}.`, 'RESIN_PLATE_HEIGHT_POLICY', 400);
    return raw === 0 ? 0 : raw;
  };
  if (value('pad_around_object', 0) !== 0 || value('pad_around_object_everywhere', 0) !== 0) throw fail('Packed plates require the standard elevated pad policy.', 'RESIN_PLATE_HEIGHT_POLICY', 400);
  for (const key of ['relative_correction_x','relative_correction_y','relative_correction_z','material_correction_x','material_correction_y','material_correction_z']) if (value(key, 1) !== 1) throw fail('Packed plates require unit printer/material geometry correction factors.', 'RESIN_PLATE_HEIGHT_POLICY', 400);
  if (value('zcorrection_layers', 0) !== 0) throw fail('Packed plates require disabled automatic Z correction.', 'RESIN_PLATE_HEIGHT_POLICY', 400);
  for (const [key, count] of [['relative_correction', 2], ['material_correction', 3]]) {
    const values = ini[key] === undefined ? Array(count).fill(1) : ini[key].split(',').map(Number);
    if (values.length !== count || values.some(item => item !== 1)) throw fail('Packed plates require unit printer/material correction factors.', 'RESIN_PLATE_HEIGHT_POLICY', 400);
  }
  const supportElevationMm = ini.supports_enable === '1' ? value('support_object_elevation', 5) : 0;
  const padWallThicknessMm = ini.pad_enable === '1' ? value('pad_wall_thickness', 2) : 0;
  const padWallHeightMm = ini.pad_enable === '1' ? value('pad_wall_height', 0) : 0;
  const towerHop = ini.tower_hop_height === undefined ? [0, 0] : ini.tower_hop_height.split(',').map(Number);
  if (towerHop.length !== 2 || towerHop.some(number => !Number.isFinite(number) || number < 0 || number > 10000)) throw fail('Packed plates require two bounded tower hop heights.', 'RESIN_PLATE_HEIGHT_POLICY', 400);
  const maximumHop = Math.max(...towerHop), towerHopMm = maximumHop === 0 ? 0 : maximumHop;
  const modelHeightMm = source.dimensionsMm.z, roundingReserveMm = Math.max(Number(ini.layer_height), Number(ini.initial_layer_height));
  const upperHeightMm = modelHeightMm + supportElevationMm + padWallThicknessMm + padWallHeightMm + roundingReserveMm + towerHopMm;
  if (!Number.isFinite(roundingReserveMm) || roundingReserveMm <= 0 || upperHeightMm > Number(ini.max_print_height)) throw fail('The model and conservatively reserved support/pad height exceed this printer.', 'RESIN_PLATE_NO_CAPACITY');
  return { modelHeightMm, supportElevationMm, padWallThicknessMm, padWallHeightMm, towerHopMm, roundingReserveMm, upperHeightMm, expectedModelTopMm: modelHeightMm + supportElevationMm + padWallThicknessMm };
}

function envelope(source, reference, raster, geometry, requested) {
  const b = raster.boundsPx, pitch = { x: geometry.displayWidthMm / geometry.resolutionX, y: geometry.displayHeightMm / geometry.resolutionY };
  const worldX = geometry.mirrorX ? [(geometry.resolutionX - b.x - b.width) * pitch.x, (geometry.resolutionX - b.x) * pitch.x] : [b.x * pitch.x, (b.x + b.width) * pitch.x];
  const worldY = geometry.mirrorY ? [b.y * pitch.y, (b.y + b.height) * pitch.y] : [(geometry.resolutionY - b.y - b.height) * pitch.y, (geometry.resolutionY - b.y) * pitch.y];
  const supportEnvelopeMm = Math.max(0, reference.placement.x - worldX[0], worldX[1] - reference.placement.x - source.dimensionsMm.x, reference.placement.y - worldY[0], worldY[1] - reference.placement.y - source.dimensionsMm.y) + Math.max(pitch.x, pitch.y);
  const supportHeightMm = Math.max(0, reference.totalHeightMm - source.dimensionsMm.z);
  const marginPx = { x: Math.max(1, Math.ceil(requested.marginMm / pitch.x)), y: Math.max(1, Math.ceil(requested.marginMm / pitch.y)) };
  return { supportEnvelopeMm, supportHeightMm, pitch, marginPx, minGapPx: Math.ceil(requested.gapMm / Math.min(pitch.x, pitch.y)) };
}

function layoutFor(sourceBytes, orientation, requested, reference, raster, profile, ini) {
  const source = prepareResinPlateSource(sourceBytes, { orientation }), geometry = profileGeometry(profile, ini), reservation = envelope(source, reference, raster, geometry, requested);
  const layout = planResinPlate(sourceBytes, { orientation, bed: { widthMm: geometry.displayWidthMm, heightMm: geometry.displayHeightMm, maxHeightMm: geometry.machineZMm }, copies: requested.copies, gapMm: requested.gapMm, marginMm: requested.marginMm, supportEnvelopeMm: reservation.supportEnvelopeMm, supportHeightMm: reservation.supportHeightMm, pixelPitchMm: reservation.pitch });
  if (!layout.copiesPlaced) throw fail('No whole model and its full support/pad envelope fit the reviewed plate spacing.', 'RESIN_PLATE_NO_CAPACITY');
  const translationsPx = layout.placements.map(item => {
    const x = Math.round((item.offsetMm.x - reference.placement.x) / reservation.pitch.x) * (geometry.mirrorX ? -1 : 1);
    const y = Math.round((item.offsetMm.y - reference.placement.y) / reservation.pitch.y) * (geometry.mirrorY ? 1 : -1);
    // JSON serializes -0 as0. Canonicalize before storing and rederiving proofs
    // so a mirrored zero shift remains verifiable after a persisted restart.
    return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
  });
  for (let index = 0; index < layout.placements.length; index++) for (const axis of ['x','y']) {
    const exact = (layout.placements[index].offsetMm[axis] - reference.placement[axis]) / reservation.pitch[axis];
    if (Math.abs(exact - Math.round(exact)) > 1e-7) throw fail('Packed instances must have exact integer pixel translations.', 'RESIN_PLATE_PIXEL_ALIGNMENT');
  }
  return { source, geometry, reservation, layout, translationsPx };
}

async function readManaged(directory, descriptor, maximum) {
  if (!plain(descriptor) || typeof descriptor.filePath !== 'string' || !path.isAbsolute(descriptor.filePath) || /[\0\r\n]/.test(descriptor.filePath) || !HASH.test(descriptor.sha256 || '') || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > maximum) throw fail('Packed plate evidence needs a bounded managed file.', 'RESIN_PLATE_CHANGED');
  const relative = path.relative(directory, descriptor.filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('Packed plate evidence is outside the managed job directory.', 'RESIN_PLATE_CHANGED');
  let current = directory;
  if (!(await fs.lstat(current)).isDirectory() || (await fs.lstat(current)).isSymbolicLink()) throw fail('Packed plate evidence root cannot use links.', 'RESIN_PLATE_CHANGED');
  for (const part of relative.split(path.sep)) { current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) throw fail('Packed plate evidence cannot use links.', 'RESIN_PLATE_CHANGED'); }
  if (path.relative(await fs.realpath(directory), await fs.realpath(descriptor.filePath)) !== relative) throw fail('Packed plate evidence resolves outside its managed location.', 'RESIN_PLATE_CHANGED');
  const file = await fs.open(descriptor.filePath, 'r');
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.size !== descriptor.bytes || stat.size > maximum) throw fail('Packed plate evidence size changed.', 'RESIN_PLATE_CHANGED');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset !== bytes.length || (await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || hash(bytes) !== descriptor.sha256) throw fail('Packed plate evidence bytes changed.', 'RESIN_PLATE_CHANGED');
    return bytes;
  } finally { await file.close(); }
}

function inspectPlateGoo(bytes, profile, ini) {
  const geometry = profileGeometry(profile, ini), inspection = inspectGoo(bytes, { limits: { maxFileBytes: MAX_GOO }, expected: { ...geometry, machineName: profile.printerModel, exposureTimeSeconds: profile.uvtoolsProperties.ExposureTime, bottomExposureTimeSeconds: profile.uvtoolsProperties.BottomExposureTime, bottomLayerCount: profile.uvtoolsProperties.BottomLayerCount } });
  require('./resin-engine').assertTargetProperties(inspection, profile.uvtoolsProperties);
  if (inspection.perLayerSettings) throw fail('Packed plate evidence requires one global target-parameter profile.', 'RESIN_PLATE_CHANGED');
  return inspection;
}

async function verifyResinPlatePreparation(sourceNormalizedSTL, record, { profile, ini, preset, artifactBytes, directory } = {}) {
  if (!Buffer.isBuffer(sourceNormalizedSTL) || !plain(record) || record.schemaVersion !== 1 || typeof directory !== 'string' || !path.isAbsolute(directory) || !Buffer.isBuffer(artifactBytes) || !HASH.test(record.preparationSha256 || '')) throw fail('A packed plate needs complete source, file and raster evidence.', 'RESIN_PLATE_CHANGED');
  const { preparationSha256, ...body } = record;
  if (canonicalHash(body) !== preparationSha256) throw fail('The packed plate receipt changed.', 'RESIN_PLATE_CHANGED');
  const requested = normalizeResinPlateOptions(record.requested), source = prepareResinPlateSource(sourceNormalizedSTL, { orientation: record.orientation }), geometry = profileGeometry(profile, ini);
  const preparedPreset = prepareResinPlatePreset(preset, ini);
  if (!isDeepStrictEqual(record.presetPreparation?.normalization, preparedPreset.normalization) || !(await readManaged(directory, record.presetPreparation?.original, 1024 * 1024)).equals(preparedPreset.original) || !(await readManaged(directory, record.presetPreparation?.effective, 1024 * 1024)).equals(preparedPreset.effective)) throw fail('The packed preset snapshot or explicit normalization changed.', 'RESIN_PLATE_CHANGED');
  if (!profile.orientationCandidates.some(candidate => isDeepStrictEqual(candidate, record.orientation)) || record.sourceSha256 !== hash(sourceNormalizedSTL) || record.orientedSource?.sha256 !== source.sha256 || record.orientedSource?.bytes !== source.stl.length || record.orientedSource?.triangleCount !== source.triangleCount || !isDeepStrictEqual(record.orientedSource?.bounds, source.bounds)) throw fail('Packed source geometry does not match the reviewed orientation.', 'RESIN_PLATE_CHANGED');
  if (!(await readManaged(directory, record.orientedSource, MAX_MODEL)).equals(source.stl)) throw fail('The oriented shared mesh changed.', 'RESIN_PLATE_CHANGED');
  const heightPolicy = resinPlateHeightPolicy(source, profile, ini), placement = referencePlacement(source, geometry).placement;
  if (!isDeepStrictEqual(heightPolicy, record.heightPolicy) || !isDeepStrictEqual(placement, record.reference?.placement)) throw fail('The packed reference placement or height policy changed.', 'RESIN_PLATE_CHANGED');
  const referenceInput = createResinPlate3mf(source.stl, [placement]);
  if (!(await readManaged(directory, record.reference?.input3mf, MAX_MODEL)).equals(referenceInput)) throw fail('The one-instance reference input changed.', 'RESIN_PLATE_CHANGED');
  const referenceBytes = await readManaged(directory, record.reference, MAX_GOO), referenceInspection = inspectPlateGoo(referenceBytes, profile, ini);
  if (record.reference.layerCount !== referenceInspection.layerCount || record.reference.totalHeightMm !== referenceInspection.totalHeightMm || Math.abs(referenceInspection.totalHeightMm - heightPolicy.expectedModelTopMm) > Math.max(heightPolicy.roundingReserveMm, float32Tolerance(heightPolicy.expectedModelTopMm)) || referenceInspection.totalHeightMm >= geometry.machineZMm - heightPolicy.roundingReserveMm) throw fail('The reference height cannot prove an unclipped complete model.', 'RESIN_PLATE_HEIGHT_POLICY');
  const raster = inspectGooRaster(referenceBytes), derived = layoutFor(sourceNormalizedSTL, record.orientation, requested, record.reference, raster, profile, ini);
  if (!isDeepStrictEqual(record.layout, derived.layout) || record.supportEnvelopeMm !== derived.reservation.supportEnvelopeMm || record.supportHeightMm !== derived.reservation.supportHeightMm) throw fail('The packed layout or support reservation changed.', 'RESIN_PLATE_CHANGED');
  const plateInput = createResinPlate3mf(source.stl, derived.layout.placements.map(item => item.offsetMm));
  if (!(await readManaged(directory, record.plateInput, MAX_MODEL)).equals(plateInput)) throw fail('Packed instances differ from the canonical placement input.', 'RESIN_PLATE_CHANGED');
  const inspection = inspectPlateGoo(artifactBytes, profile, ini);
  if (record.artifactSha256 !== inspection.sha256) throw fail('The packed output changed.', 'RESIN_PLATE_CHANGED');
  let rasterProof;
  const proofOptions = { translationsPx: derived.translationsPx, marginPx: derived.reservation.marginPx, minGapPx: derived.reservation.minGapPx };
  try { rasterProof = verifyGooPlate(referenceBytes, artifactBytes, proofOptions); }
  catch (failure) { failure.plateProofOptions = proofOptions; throw failure; }
  if (!isDeepStrictEqual(record.rasterProof, rasterProof) || rasterProof.copiesPerRun !== derived.layout.copiesPlaced) throw fail('The packed output does not match its saved raster proof.', 'RESIN_PLATE_CHANGED');
  return freeze({ schemaVersion: 1, modelCopiesPerRun: derived.layout.copiesPlaced, requested, orientation: record.orientation, sourceSha256: record.sourceSha256, artifactSha256: inspection.sha256, layout: derived.layout, rasterProof, preparationSha256 });
}

async function preparePackedResinAttempt({ sourceNormalizedSTL, orientation, requested: options, profile, ini, preset, directory, render, signal }) {
  const requested = normalizeResinPlateOptions(options), source = prepareResinPlateSource(sourceNormalizedSTL, { orientation }), geometry = profileGeometry(profile, ini), heightPolicy = resinPlateHeightPolicy(source, profile, ini), placement = referencePlacement(source, geometry).placement;
  const write = async (filename, bytes) => { const filePath = path.join(directory, filename); await fs.writeFile(filePath, bytes, { flag: 'wx' }); return { filePath, sha256: hash(bytes), bytes: bytes.length }; };
  const preparedPreset = prepareResinPlatePreset(preset, ini);
  const presetPreparation = { original: await write('preset-original.ini', preparedPreset.original), effective: await write('preset-effective.ini', preparedPreset.effective), normalization: preparedPreset.normalization };
  const orientedSource = { ...await write('oriented-source.stl', source.stl), bounds: source.bounds, triangleCount: source.triangleCount };
  const referenceInput = await write('reference.3mf', createResinPlate3mf(source.stl, [placement]));
  signal?.throwIfAborted();
  const referenceDirectory = path.join(directory, 'reference'); await fs.mkdir(referenceDirectory);
  const referenceResult = await render(referenceInput.filePath, referenceDirectory, true, { presetPath: presetPreparation.effective.filePath });
  const reference = { placement, input3mf: referenceInput, filePath: referenceResult.filePath, sha256: referenceResult.sha256, bytes: referenceResult.bytes, layerCount: referenceResult.inspection.layerCount, totalHeightMm: referenceResult.inspection.totalHeightMm };
  if (Math.abs(reference.totalHeightMm - heightPolicy.expectedModelTopMm) > Math.max(heightPolicy.roundingReserveMm, float32Tolerance(heightPolicy.expectedModelTopMm)) || reference.totalHeightMm >= geometry.machineZMm - heightPolicy.roundingReserveMm) throw fail('The packed reference may be vertically clipped.', 'RESIN_PLATE_HEIGHT_POLICY');
  const referenceBytes = await readManaged(directory, reference, MAX_GOO), raster = inspectGooRaster(referenceBytes), derived = layoutFor(sourceNormalizedSTL, orientation, requested, reference, raster, profile, ini);
  const plateInput = await write('plate.3mf', createResinPlate3mf(source.stl, derived.layout.placements.map(item => item.offsetMm)));
  signal?.throwIfAborted();
  const plateDirectory = path.join(directory, 'plate'); await fs.mkdir(plateDirectory);
  const result = await render(plateInput.filePath, plateDirectory, true, { presetPath: presetPreparation.effective.filePath }), artifactBytes = await readManaged(directory, result, MAX_GOO);
  const rasterProof = verifyGooPlate(referenceBytes, artifactBytes, { translationsPx: derived.translationsPx, marginPx: derived.reservation.marginPx, minGapPx: derived.reservation.minGapPx });
  const body = { schemaVersion: 1, requested, orientation: structuredClone(orientation), sourceSha256: hash(sourceNormalizedSTL), presetPreparation, orientedSource, reference, heightPolicy, supportEnvelopeMm: derived.reservation.supportEnvelopeMm, supportHeightMm: derived.reservation.supportHeightMm, layout: derived.layout, plateInput, rasterProof, artifactSha256: result.sha256 };
  const platePreparation = { ...body, preparationSha256: canonicalHash(body) };
  signal?.throwIfAborted();
  await verifyResinPlatePreparation(sourceNormalizedSTL, platePreparation, { profile, ini, preset, artifactBytes, directory });
  return { ...result, modelCopiesPerRun: derived.layout.copiesPlaced, platePreparation };
}

module.exports = { normalizeResinPlateOptions, createResinPlate3mf, resinPlateHeightPolicy, prepareResinPlatePreset, assertPackedEffectiveSettings, preparePackedResinAttempt, verifyResinPlatePreparation };
