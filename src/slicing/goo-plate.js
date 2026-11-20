'use strict';

const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { inspectGoo } = require('./goo');

const HEADER_BYTES = 195477, LAYER_HEADER_BYTES = 70;
const MAX_LIMITS = Object.freeze({ maxFileBytes: 512 * 1024 * 1024, maxLayers: 25000, maxPixelsPerLayer: 100000000,
  maxLayerBytes: 128 * 1024 * 1024, maxSegmentsPerLayer: 1000000, maxOperations: 50000000, maxCopies: 500, timeoutMs: 30000 });
function fail(message, code = 'GOO_PLATE_INVALID', status = 409) { return Object.assign(new Error(message), { code, status }); }
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function limits(input = {}) {
  if (!object(input) || Object.keys(input).some(key => !(key in MAX_LIMITS) || !Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > MAX_LIMITS[key])) throw fail('GOO plate limits may only lower the supported positive bounds.', 'GOO_PLATE_INVALID_OPTIONS', 400);
  return { ...MAX_LIMITS, ...input };
}
function budgetFor(bounds) {
  const started = performance.now(); let operations = 0;
  return {
    step(count = 1) {
      operations += count;
      if (!Number.isSafeInteger(operations) || operations > bounds.maxOperations) throw fail('GOO plate comparison exceeds its operation limit.', 'GOO_PLATE_LIMIT', 400);
      if (count > 1 || (operations & 1023) === 0) this.check();
    },
    check() { if (performance.now() - started > bounds.timeoutMs) throw fail('GOO plate comparison exceeded its time limit.', 'GOO_PLATE_LIMIT', 400); },
  };
}
function inspect(buffer, bounds, budget) {
  budget.check();
  const result = inspectGoo(buffer, { limits: { maxFileBytes: bounds.maxFileBytes, maxLayers: bounds.maxLayers, maxPixelsPerLayer: bounds.maxPixelsPerLayer, maxLayerBytes: bounds.maxLayerBytes } });
  // Account for the existing independent reader's validation pass as well as
  // this module's subsequent RLE/segment comparison. Check elapsed time after
  // that synchronous bounded reader returns, before doing further work.
  budget.step(result.totalRuns); budget.check();
  return result;
}
function* layers(buffer, metadata) {
  let offset = HEADER_BYTES;
  for (let index = 0; index < metadata.layerCount; index++) {
    const bytes = buffer.readUInt32BE(offset + 66);
    yield { index, header: buffer.subarray(offset, offset + 66), begin: offset + LAYER_HEADER_BYTES, bytes };
    offset += LAYER_HEADER_BYTES + bytes + 2;
  }
}

// The same specified GOO RLE grammar is read independently after inspectGoo
// validates the complete file. Runs are split at row boundaries, never expanded
// into pixel planes. Adjacent equal-color segments have one canonical form even
// when two encoders chose different RLE tokens.
function* rasterSegments(buffer, layer, metadata, bounds, budget) {
  let cursor = layer.begin, checksum = 0, pixels = 0, color = 0, pending = null, segments = 0;
  const checksumAt = layer.begin + layer.bytes - 1, maximumGray = metadata.grayscaleBits === 4 ? 15 : 255;
  if (buffer[cursor++] !== 0x55) throw fail('GOO raster image marker changed.');
  const byte = () => {
    if (cursor >= checksumAt) throw fail('GOO raster token is truncated.');
    const value = buffer[cursor++]; checksum = (checksum + value) & 255; return value;
  };
  const counted = value => { if (++segments > bounds.maxSegmentsPerLayer) throw fail('GOO raster exceeds its per-layer segment limit.', 'GOO_PLATE_LIMIT', 400); return value; };
  while (cursor < checksumAt) {
    budget.step();
    const token = byte(), type = token >>> 6;
    let count;
    if (type === 2) {
      color += (token & 0x20 ? -1 : 1) * (token & 15);
      count = token & 0x10 ? byte() : 1;
    } else {
      color = type === 0 ? 0 : type === 3 ? maximumGray : byte();
      let upper = 0;
      for (let extra = (token >>> 4) & 3; extra > 0; extra--) upper = upper * 256 + byte();
      count = upper * 16 + (token & 15);
    }
    if (color < 0 || color > maximumGray || !count || count > metadata.pixelsPerLayer - pixels) throw fail('GOO raster run exceeds its color or image bounds.');
    if (color) {
      let position = pixels, remaining = count;
      while (remaining) {
        budget.step();
        const row = Math.floor(position / metadata.resolutionX), start = position % metadata.resolutionX, length = Math.min(remaining, metadata.resolutionX - start);
        const current = { row, start, end: start + length, color };
        if (pending && pending.row === row && pending.end === start && pending.color === color) pending.end = current.end;
        else { if (pending) yield counted(pending); pending = current; }
        position += length; remaining -= length;
      }
    }
    pixels += count;
  }
  if (pending) yield counted(pending);
  if (pixels !== metadata.pixelsPerLayer || buffer[cursor++] !== (checksum ^ 255) || buffer[cursor++] !== 13 || buffer[cursor] !== 10) throw fail('GOO raster pixel count, checksum or delimiter changed.');
}
function accumulator() { return { minX: Infinity, minY: Infinity, maxX: 0, maxY: 0, pixels: 0, intensity: 0 }; }
function accumulate(total, segment) {
  total.minX = Math.min(total.minX, segment.start); total.maxX = Math.max(total.maxX, segment.end);
  total.minY = Math.min(total.minY, segment.row); total.maxY = Math.max(total.maxY, segment.row + 1);
  total.pixels += segment.end - segment.start;
  total.intensity += (segment.end - segment.start) * segment.color;
}
function bbox(total) { return { x: total.minX, y: total.minY, width: total.maxX - total.minX, height: total.maxY - total.minY }; }
function information(metadata, total) {
  if (!total.pixels) throw fail('The reference GOO has no exposed source geometry.', 'GOO_PLATE_EMPTY');
  return { schemaVersion: 1, sha256: metadata.sha256, layerCount: metadata.layerCount,
    resolutionX: metadata.resolutionX, resolutionY: metadata.resolutionY, displayWidthMm: metadata.displayWidthMm, displayHeightMm: metadata.displayHeightMm,
    mirrorX: metadata.mirrorX, mirrorY: metadata.mirrorY, grayscaleBits: metadata.grayscaleBits,
    boundsPx: bbox(total), totalForegroundPixels: total.pixels, totalForegroundIntensity: total.intensity };
}

function inspectGooRaster(buffer, { limits: options = {} } = {}) {
  const bounds = limits(options), budget = budgetFor(bounds), metadata = inspect(buffer, bounds, budget), total = accumulator();
  for (const layer of layers(buffer, metadata)) for (const segment of rasterSegments(buffer, layer, metadata, bounds, budget)) accumulate(total, segment);
  budget.check();
  return freeze(information(metadata, total));
}
function sameSettings(reference, plate) {
  // Metadata, thumbnails and area-dependent time/volume/price estimates may
  // differ. Machine identity, AA/gray/blur, all global physical settings,
  // grayscale encoding and transition count must match byte for byte.
  return [[92, 156], [188, 194], [195310, 195446], [195470, 195477]].every(([start, end]) => reference.subarray(start, end).equals(plate.subarray(start, end)));
}
function marginValue(value) {
  const result = value === undefined ? { x: 1, y: 1 } : value;
  if (!object(result) || Object.keys(result).sort().join(',') !== 'x,y' || !['x', 'y'].every(key => Number.isSafeInteger(result[key]) && result[key] >= 1)) throw fail('Raster safety margins require positive integer X/Y pixels.', 'GOO_PLATE_INVALID_OPTIONS', 400);
  return { x: result.x, y: result.y };
}
function inside(segment, metadata, margin) {
  return segment.start >= margin.x && segment.end <= metadata.resolutionX - margin.x && segment.row >= margin.y && segment.row < metadata.resolutionY - margin.y;
}

function verifyGooPlate(referenceBuffer, plateBuffer, { translationsPx, marginPx, minGapPx = 0, limits: options = {} } = {}) {
  const bounds = limits(options), margin = marginValue(marginPx), budget = budgetFor(bounds);
  if (!Array.isArray(translationsPx) || !translationsPx.length || translationsPx.length > bounds.maxCopies || translationsPx.some(value => !object(value) || Object.keys(value).sort().join(',') !== 'x,y' || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y)) || !Number.isSafeInteger(minGapPx) || minGapPx < 0) throw fail('Provide a bounded list of exact integer pixel translations and a nonnegative pixel gap.', 'GOO_PLATE_INVALID_OPTIONS', 400);
  // Mirror-derived zero offsets may be -0. JSON stores that as 0, so normalize
  // before hashing and persisting evidence to keep verification stable on restart.
  const translations = translationsPx.map(value => ({ x: value.x === 0 ? 0 : value.x, y: value.y === 0 ? 0 : value.y }));
  minGapPx = minGapPx === 0 ? 0 : minGapPx;
  const reference = inspect(referenceBuffer, bounds, budget), plate = inspect(plateBuffer, bounds, budget);
  if (!sameSettings(referenceBuffer, plateBuffer)) throw fail('Reference and plate GOO machine, encoding or physical settings differ.', 'GOO_PLATE_SETTINGS_MISMATCH');
  if (margin.x * 2 >= reference.resolutionX || margin.y * 2 >= reference.resolutionY || minGapPx > Math.max(reference.resolutionX, reference.resolutionY)) throw fail('Raster margins or gap exceed the image dimensions.', 'GOO_PLATE_INVALID_OPTIONS', 400);
  const total = accumulator(), actualTotal = accumulator(), plateLayers = layers(plateBuffer, plate);
  for (const referenceLayer of layers(referenceBuffer, reference)) {
    budget.check();
    const plateLayer = plateLayers.next().value;
    if (!plateLayer || !referenceLayer.header.equals(plateLayer.header)) throw fail('Reference and plate per-layer exposure, motion, position or control schedule differs.', 'GOO_PLATE_SCHEDULE_MISMATCH');
    const source = [...rasterSegments(referenceBuffer, referenceLayer, reference, bounds, budget)];
    if (source.length * translations.length > bounds.maxSegmentsPerLayer) throw fail('Translated raster exceeds its per-layer segment limit.', 'GOO_PLATE_LIMIT', 400);
    const expected = [];
    for (const segment of source) {
      accumulate(total, segment);
      if (!inside(segment, reference, margin)) throw fail('Reference foreground touches its required clear image margin.', 'GOO_PLATE_CLIPPED');
      for (let copy = 0; copy < translations.length; copy++) {
        budget.step();
        const translation = translations[copy], translated = { row: segment.row + translation.y, start: segment.start + translation.x, end: segment.end + translation.x, color: segment.color, copy };
        if (!inside(translated, plate, margin)) throw fail('A translated copy exceeds its required clear image margin.', 'GOO_PLATE_CLIPPED');
        expected.push(translated);
      }
    }
    expected.sort((a, b) => { budget.step(); return a.row - b.row || a.start - b.start || a.end - b.end || a.copy - b.copy; });
    // Canonicalize in place; retaining another million-entry segment array
    // would add memory without adding evidence.
    let mergedCount = 0;
    for (let read = 0; read < expected.length; read++) {
      const segment = expected[read];
      budget.step();
      const previous = expected[mergedCount - 1];
      if (previous && previous.row === segment.row && previous.end > segment.start) throw fail('Translated source copies overlap exposed pixels.', 'GOO_PLATE_OVERLAP');
      if (previous && previous.row === segment.row && previous.end === segment.start && previous.color === segment.color) previous.end = segment.end;
      else expected[mergedCount++] = segment;
    }
    expected.length = mergedCount;
    let index = 0;
    for (const actual of rasterSegments(plateBuffer, plateLayer, plate, bounds, budget)) {
      budget.step(); accumulate(actualTotal, actual);
      const expectedSegment = expected[index++];
      if (!expectedSegment || actual.row !== expectedSegment.row || actual.start !== expectedSegment.start || actual.end !== expectedSegment.end || actual.color !== expectedSegment.color) throw fail('Plate raster is not the exact grayscale union of the declared source copies.', 'GOO_PLATE_IMAGE_MISMATCH');
    }
    if (index !== expected.length) throw fail('Plate raster is missing declared source copies or pixels.', 'GOO_PLATE_IMAGE_MISMATCH');
  }
  const info = information(reference, total), referenceBoundsPx = info.boundsPx;
  const placements = translations.map(translation => ({ ...translation, boundsPx: { x: referenceBoundsPx.x + translation.x, y: referenceBoundsPx.y + translation.y, width: referenceBoundsPx.width, height: referenceBoundsPx.height } }));
  for (let index = 0; index < placements.length; index++) for (let other = 0; other < index; other++) {
    budget.step();
    const a = placements[index].boundsPx, b = placements[other].boundsPx;
    if (!(a.x + a.width + minGapPx <= b.x || b.x + b.width + minGapPx <= a.x || a.y + a.height + minGapPx <= b.y || b.y + b.height + minGapPx <= a.y)) throw fail('Translated source footprints overlap or violate the minimum gap.', 'GOO_PLATE_OVERLAP');
  }
  if (actualTotal.pixels !== total.pixels * translations.length || actualTotal.intensity !== total.intensity * translations.length || plate.totalExposedPixels !== actualTotal.pixels || reference.totalExposedPixels !== total.pixels) throw fail('Plate foreground totals do not match the declared source copies.', 'GOO_PLATE_IMAGE_MISMATCH');
  budget.check();
  const proof = { schemaVersion: 1, referenceSha256: reference.sha256, artifactSha256: plate.sha256, copiesPerRun: translations.length, imageEquivalent: true,
    layerCount: reference.layerCount, resolutionX: reference.resolutionX, resolutionY: reference.resolutionY, grayscaleBits: reference.grayscaleBits,
    referenceBoundsPx, placements, marginPx: margin, minGapPx,
    referenceForegroundPixels: total.pixels, totalForegroundPixels: actualTotal.pixels,
    referenceForegroundIntensity: total.intensity, totalForegroundIntensity: actualTotal.intensity };
  proof.proofSha256 = hash(JSON.stringify(canonical(proof)));
  return freeze(proof);
}

module.exports = { inspectGooRaster, verifyGooPlate };
