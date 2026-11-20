'use strict';

// Client choices contain geometry and profile fingerprints, never local paths
// or executable/script options. The manager rederives all native bindings.
const HASH = /^[a-f0-9]{64}$/, AXES = ['x', 'y', 'z'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => Object.assign(new Error(message), { code: 'RESIN_HOLLOW_REVIEW_INVALID', status: 400 });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function keys(value, allowed, required, label) { if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw fail(`Invalid ${label}.`); }
function number(value, min, max, label) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(`Invalid ${label}.`); return value === 0 ? 0 : value; }
function integer(value, min, max, label) { number(value, min, max, label); if (!Number.isSafeInteger(value)) throw fail(`${label} must be a bounded whole number.`); return value === 0 ? 0 : value; }
function vector(value, min, max, label) { keys(value, AXES, AXES, label); return Object.fromEntries(AXES.map(axis => [axis, number(value[axis], min, max, label)])); }
function id(value, ids, length, label) { if (typeof value !== 'string' || !new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${length - 1}}$`).test(value) || ids.has(value)) throw fail(`Use unique bounded ${label} identifiers.`); ids.add(value); return value; }

function normalizeResinHollowReview(value) {
  keys(value, ['geometrySha256', 'profileSha256', 'recipe', 'supportRequest', 'resolutionRequest', 'boundaryPolicy'], ['geometrySha256', 'profileSha256', 'recipe', 'supportRequest', 'resolutionRequest', 'boundaryPolicy'], 'hollow preparation review');
  for (const key of ['geometrySha256', 'profileSha256']) if (typeof value[key] !== 'string' || !HASH.test(value[key])) throw fail(`Review the current ${key} before hollow preparation.`);
  const input = value.recipe;
  keys(input, ['orientation', 'wallThicknessMm', 'quality', 'closingDistanceMm', 'drains'], ['orientation', 'wallThicknessMm', 'quality', 'closingDistanceMm', 'drains'], 'hollow recipe');
  const recipe = { orientation: vector(input.orientation, -360, 360, 'canonical orientation'), wallThicknessMm: number(input.wallThicknessMm, 1, 10, 'wall thickness'), quality: number(input.quality, 0, 1, 'hollow quality'), closingDistanceMm: number(input.closingDistanceMm, 0, 10, 'closing distance') };
  if (!Array.isArray(input.drains) || !input.drains.length || input.drains.length > 64) throw fail('Declare 1..64 intended drain cylinders.');
  const drainIds = new Set();
  recipe.drains = Array.from(input.drains, drain => {
    keys(drain, ['id', 'startMm', 'direction', 'radiusMm', 'lengthMm'], ['id', 'startMm', 'direction', 'radiusMm', 'lengthMm'], 'drain cylinder');
    const direction = vector(drain.direction, -1, 1, 'unit drain direction'); if (Math.abs(Math.hypot(...AXES.map(axis => direction[axis])) - 1) > 1e-12) throw fail('Drain directions must be explicit unit vectors.');
    return { id: id(drain.id, drainIds, 48, 'drain'), startMm: vector(drain.startMm, -10000, 10000, 'drain start'), direction, radiusMm: number(drain.radiusMm, .001, 1000, 'drain radius'), lengthMm: number(drain.lengthMm, .001, 10000, 'drain length') };
  });
  const support = value.supportRequest;
  keys(support, ['mode', 'clearanceMm', 'points', 'regions'], ['mode', 'clearanceMm', 'points', 'regions'], 'prior support request');
  if (!['none', 'automatic', 'points'].includes(support.mode) || !Array.isArray(support.points) || support.points.length > 512 || !Array.isArray(support.regions) || support.regions.length > 512) throw fail('Use a bounded prior support mode, contacts and regions.');
  if (support.mode === 'points' ? !support.points.length : support.points.length) throw fail('Authored point mode requires contacts; other modes require no contacts.');
  if (support.mode === 'none' && support.regions.length || support.mode === 'automatic' && !support.regions.length || support.points.length + support.regions.length > 512) throw fail('Automatic supports require prior regions; total contact/region authority is bounded.');
  const pointIds = new Set(), regionIds = new Set();
  const supportRequest = { mode: support.mode, clearanceMm: number(support.clearanceMm, 0, 100, 'support clearance'), points: Array.from(support.points, point => {
    keys(point, ['id', 'sourceFaceIndex', 'positionMm', 'headRadiusMm', 'allowedRadiusMm'], ['id', 'sourceFaceIndex', 'positionMm', 'headRadiusMm', 'allowedRadiusMm'], 'authored source contact');
    const headRadiusMm = number(point.headRadiusMm, .001, 10, 'support head radius');
    return { id: id(point.id, pointIds, 40, 'contact'), sourceFaceIndex: integer(point.sourceFaceIndex, 0, 249999, 'source face index'), positionMm: vector(point.positionMm, 0, 10000, 'source contact position'), headRadiusMm, allowedRadiusMm: number(point.allowedRadiusMm, headRadiusMm, 100, 'prior contact region radius') };
  }), regions: Array.from(support.regions, region => {
    keys(region, ['id', 'minMm', 'maxMm'], ['id', 'minMm', 'maxMm'], 'prior support region');
    const minMm = vector(region.minMm, -10000, 10000, 'prior region minimum'), maxMm = vector(region.maxMm, -10000, 10000, 'prior region maximum');
    if (AXES.some(axis => minMm[axis] >= maxMm[axis])) throw fail('Prior support regions require positive volume.');
    return { id: id(region.id, regionIds, 40, 'region'), minMm, maxMm };
  }) };
  const requested = value.resolutionRequest;
  keys(requested, ['maximumUncertaintyMm', 'minimumPitchMm', 'reduction', 'maxCells', 'maxWorkingBytes'], ['maximumUncertaintyMm'], 'prior resolution policy');
  const resolutionRequest = { maximumUncertaintyMm: number(requested.maximumUncertaintyMm, Number.MIN_VALUE, recipe.wallThicknessMm / 3, 'maximum encoded uncertainty') };
  if (requested.minimumPitchMm !== undefined) resolutionRequest.minimumPitchMm = vector(requested.minimumPitchMm, 1e-9, 10000, 'minimum encoded pitch');
  if (requested.reduction !== undefined) {
    if (requested.minimumPitchMm !== undefined) throw fail('Choose either fixed integer reduction or an automatic minimum pitch.');
    keys(requested.reduction, AXES, AXES, 'fixed interval reduction');
    resolutionRequest.reduction = Object.fromEntries(AXES.map(axis => [axis, integer(requested.reduction[axis], 1, 512, 'fixed interval reduction')]));
  }
  if (requested.maxCells !== undefined) resolutionRequest.maxCells = integer(requested.maxCells, 1, 20000000, 'grid cell bound');
  if (requested.maxWorkingBytes !== undefined) resolutionRequest.maxWorkingBytes = integer(requested.maxWorkingBytes, 1, 768 * 1024 * 1024, 'grid working-byte bound');
  if (!['exact-raster', 'voxel-enclosure'].includes(value.boundaryPolicy)) throw fail('Review an explicit encoded boundary policy.');
  return freeze({ geometrySha256: value.geometrySha256, profileSha256: value.profileSha256, recipe, supportRequest, resolutionRequest, boundaryPolicy: value.boundaryPolicy });
}

module.exports = { normalizeResinHollowReview };
