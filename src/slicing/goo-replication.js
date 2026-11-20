'use strict';

const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { inspectGoo } = require('./goo');
const { verifyGooPlate } = require('./goo-plate');

const HEADER = 195477, DEFINITION = 70;
const ENCODER_VERSION = 1;
const MAXIMUM = Object.freeze({ maxFileBytes: 512 * 1024 * 1024, maxLayers: 25000, maxPixelsPerLayer: 100000000,
  maxLayerBytes: 128 * 1024 * 1024, maxSegmentsPerLayer: 1000000, maxOperations: 50000000, maxCopies: 500, timeoutMs: 30000 });
const PREVIEWS = Object.freeze([{ size: 116, offset: 194 }, { size: 290, offset: 27108 }]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function fail(message, code = 'GOO_REPLICATION_INVALID', status = 400) { return Object.assign(new Error(message), { code, status }); }
function limits(input) {
  if (input === undefined) return { ...MAXIMUM };
  if (!object(input) || Reflect.ownKeys(input).some(key => !Object.hasOwn(MAXIMUM,key) || !Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > MAXIMUM[key])) throw fail('Replication limits may only lower the supported positive bounds.', 'GOO_REPLICATION_OPTIONS');
  return { ...MAXIMUM, ...input };
}
function options(input) {
  if (!object(input) || Object.keys(input).some(key => !['translationsPx','marginPx','minGapPx','limits'].includes(key))) throw fail('Provide only exact pixel placements, margins, gap and bounded limits.', 'GOO_REPLICATION_OPTIONS');
  const bounds = limits(input.limits), translations = input.translationsPx;
  if (!Array.isArray(translations) || !translations.length || translations.length > bounds.maxCopies || translations.some(p => !object(p) || Object.keys(p).sort().join(',') !== 'x,y' || !Number.isSafeInteger(p.x) || !Number.isSafeInteger(p.y))) throw fail('Provide 1–500 exact integer pixel translations.', 'GOO_REPLICATION_OPTIONS');
  const margin = input.marginPx === undefined ? { x: 1, y: 1 } : input.marginPx, gap = input.minGapPx === undefined ? 0 : input.minGapPx;
  if (!object(margin) || Object.keys(margin).sort().join(',') !== 'x,y' || !['x','y'].every(key => Number.isSafeInteger(margin[key]) && margin[key] >= 1) || !Number.isSafeInteger(gap) || gap < 0) throw fail('Use positive integer clear margins and a nonnegative pixel gap.', 'GOO_REPLICATION_OPTIONS');
  return { bounds, translations: translations.map(p => ({ x: p.x === 0 ? 0 : p.x, y: p.y === 0 ? 0 : p.y })), margin: { x: margin.x, y: margin.y }, gap: gap === 0 ? 0 : gap };
}
function budget(bounds) {
  const started = performance.now(); let operations = 0;
  return {
    step(count = 1) { operations += count; if (!Number.isSafeInteger(operations) || operations > bounds.maxOperations) throw fail('Raster replication exceeds its operation limit.', 'GOO_REPLICATION_LIMIT'); if (count > 1 || !(operations & 1023)) this.check(); },
    check() { if (performance.now() - started > bounds.timeoutMs) throw fail('Raster replication exceeds its time limit.', 'GOO_REPLICATION_LIMIT'); },
    remaining() { this.check(); const remaining = bounds.maxOperations - operations, milliseconds = Math.floor(bounds.timeoutMs - (performance.now() - started)); if (remaining < 1 || milliseconds < 1) throw fail('Raster replication has no remaining verification budget.', 'GOO_REPLICATION_LIMIT'); return { ...bounds, maxOperations: remaining, timeoutMs: milliseconds }; },
  };
}

// This reader/absolute-run encoder does not call the plate verifier's decoder.
// The full source is structurally inspected first; every resulting artifact is
// then checked independently by verifyGooPlate before it can be returned.
function readLayer(buffer, offset, metadata, bounds, work) {
  const bytes = buffer.readUInt32BE(offset + 66), end = offset + DEFINITION + bytes - 1;
  let cursor = offset + DEFINITION, checksum = 0, pixels = 0, color = 0, pending;
  const rows = [], maximumGray = metadata.grayscaleBits === 4 ? 15 : 255;
  if (buffer[cursor++] !== 0x55) throw fail('The source raster marker is invalid.');
  const byte = () => { if (cursor >= end) throw fail('The source raster token is truncated.'); const value = buffer[cursor++]; checksum = (checksum + value) & 255; return value; };
  const append = row => { if (rows.length >= bounds.maxSegmentsPerLayer) throw fail('The source layer exceeds its segment limit.', 'GOO_REPLICATION_LIMIT'); rows.push(row); };
  while (cursor < end) {
    work.step(); const token = byte(), type = token >>> 6; let count;
    if (type === 2) { color += (token & 0x20 ? -1 : 1) * (token & 15); count = token & 0x10 ? byte() : 1; }
    else { color = type === 0 ? 0 : type === 3 ? maximumGray : byte(); let upper = 0; for (let extra = (token >>> 4) & 3; extra > 0; extra--) upper = upper * 256 + byte(); count = upper * 16 + (token & 15); }
    if (color < 0 || color > maximumGray || !count || count > metadata.pixelsPerLayer - pixels) throw fail('The source raster run exceeds its color or image bounds.');
    if (color) {
      let position = pixels, left = count;
      while (left) {
        work.step(); const row = Math.floor(position / metadata.resolutionX), start = position % metadata.resolutionX, length = Math.min(left, metadata.resolutionX - start);
        if (pending && pending.row === row && pending.end === start && pending.color === color) pending.end += length;
        else { if (pending) append(pending); pending = { row, start, end: start + length, color }; }
        position += length; left -= length;
      }
    }
    pixels += count;
  }
  if (pending) append(pending);
  if (pixels !== metadata.pixelsPerLayer || buffer[cursor++] !== (checksum ^ 255) || buffer[cursor++] !== 13 || buffer[cursor++] !== 10) throw fail('The source raster checksum, length or delimiter is invalid.');
  return { rows, next: cursor, definition: buffer.subarray(offset, offset + 66) };
}
function thumbnails(metadata) {
  return PREVIEWS.map(({ size, offset }) => {
    const scale = Math.min(size / metadata.displayWidthMm, size / metadata.displayHeightMm);
    const width = Math.min(size, Math.max(1, Math.round(metadata.displayWidthMm * scale))), height = Math.min(size, Math.max(1, Math.round(metadata.displayHeightMm * scale)));
    return { size, offset, width, height, left: Math.floor((size - width) / 2), top: Math.floor((size - height) / 2), values: Buffer.alloc(size * size) };
  });
}
function project(thumbnail, segment, metadata, work) {
  const left = Math.floor(segment.start * thumbnail.width / metadata.resolutionX), right = Math.ceil(segment.end * thumbnail.width / metadata.resolutionX);
  const top = Math.floor(segment.row * thumbnail.height / metadata.resolutionY), bottom = Math.ceil((segment.row + 1) * thumbnail.height / metadata.resolutionY);
  const gray = Math.round(segment.color * 255 / (metadata.grayscaleBits === 4 ? 15 : 255));
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) { work.step(); const i = (y + thumbnail.top) * thumbnail.size + x + thumbnail.left; if (thumbnail.values[i] < gray) thumbnail.values[i] = gray; }
}
function encodeLayer(rows, metadata, bounds, work, previews) {
  rows.sort((a,b) => { work.step(); return a.row - b.row || a.start - b.start || a.end - b.end; });
  const chunks = [], maximumGray = metadata.grayscaleBits === 4 ? 15 : 255;
  let chunk = Buffer.alloc(Math.min(65536, bounds.maxLayerBytes)), used = 0, length = 1, checksum = 0, position = 0, priorColor = 0, priorCount = 0;
  const put = value => { work.step(); if (++length + 1 > bounds.maxLayerBytes) throw fail('The generated layer exceeds its byte limit.', 'GOO_REPLICATION_LIMIT'); if (used === chunk.length) { chunks.push(chunk); chunk = Buffer.alloc(Math.min(65536, bounds.maxLayerBytes)); used = 0; } chunk[used++] = value; checksum = (checksum + value) & 255; };
  const absolute = (color,count) => {
    if (!count) return; let upper = Math.floor(count / 16), extra = 0; while (upper >= 256 ** extra) extra++;
    if (extra > 3) throw fail('A generated run exceeds the specified GOO length encoding.');
    put((color === 0 ? 0 : color === maximumGray ? 0xc0 : 0x40) | (extra << 4) | (count & 15));
    if (color !== 0 && color !== maximumGray) put(color);
    for (let index = extra - 1; index >= 0; index--) put(Math.floor(upper / 256 ** index) & 255);
  };
  const run = (color,count) => { if (!count) return; if (color === priorColor) priorCount += count; else { absolute(priorColor,priorCount); priorColor = color; priorCount = count; } };
  for (const row of rows) {
    work.step(); const target = row.row * metadata.resolutionX + row.start;
    if (target < position) throw fail('Translated copies overlap exposed pixels.', 'GOO_REPLICATION_OVERLAP');
    run(0,target-position); run(row.color,row.end-row.start); position = target + row.end - row.start;
    for (const preview of previews) project(preview,row,metadata,work);
  }
  run(0,metadata.pixelsPerLayer-position); absolute(priorColor,priorCount);
  if (used) chunks.push(chunk.subarray(0,used));
  return Buffer.concat([Buffer.from([0x55]),...chunks,Buffer.from([checksum ^ 255])],length+1);
}
function scaledEstimates(header,metadata,copies) {
  const output = {};
  for (const [key,offset,maximum] of [['volumeMm3',195450,1e12],['materialGrams',195454,1e10],['materialCost',195458,1e10]]) {
    const value = metadata[key] * copies;
    if (!Number.isFinite(value) || value < 0 || value > maximum) throw fail('Replicated material estimates exceed the supported numeric range.', 'GOO_REPLICATION_ESTIMATE_OVERFLOW');
    header.writeFloatBE(value,offset); const written = header.readFloatBE(offset);
    if (!Number.isFinite(written) || written < 0 || written > maximum) throw fail('Replicated material estimates cannot be represented safely.', 'GOO_REPLICATION_ESTIMATE_OVERFLOW');
    output[key] = written;
  }
  return output;
}

function replicateGooPlate(referenceBuffer,input = {}) {
  const { bounds,translations,margin,gap } = options(input), work = budget(bounds);
  work.check();
  const metadata = inspectGoo(referenceBuffer,{ limits: { maxFileBytes: bounds.maxFileBytes, maxLayers: bounds.maxLayers, maxPixelsPerLayer: bounds.maxPixelsPerLayer, maxLayerBytes: bounds.maxLayerBytes } });
  work.step(metadata.totalRuns);
  if (margin.x * 2 >= metadata.resolutionX || margin.y * 2 >= metadata.resolutionY || gap > Math.max(metadata.resolutionX,metadata.resolutionY)) throw fail('Margins or gap exceed the raster dimensions.', 'GOO_REPLICATION_OPTIONS');
  const header = Buffer.from(referenceBuffer.subarray(0,HEADER)), previews = thumbnails(metadata), parts = [header];
  const estimates = scaledEstimates(header,metadata,translations.length), definitions = createHash('sha256'), content = createHash('sha256');
  // Preserve the reference timestamp for deterministic output. Physical fields
  // and every per-layer definition remain byte-for-byte unchanged.
  header.fill(0,12,68); header.write('QuickPrint',12,'ascii'); header.write('goo-replication/1',44,'ascii');
  let offset = HEADER, bytes = HEADER;
  for (let index = 0; index < metadata.layerCount; index++) {
    work.check(); const source = readLayer(referenceBuffer,offset,metadata,bounds,work); offset = source.next;
    if (source.rows.length * translations.length > bounds.maxSegmentsPerLayer) throw fail('The translated layer exceeds its segment limit.', 'GOO_REPLICATION_LIMIT');
    const rows = [];
    for (const segment of source.rows) {
      if (segment.start < margin.x || segment.end > metadata.resolutionX-margin.x || segment.row < margin.y || segment.row >= metadata.resolutionY-margin.y) throw fail('Reference foreground touches the required clear margin.', 'GOO_REPLICATION_CLIPPED');
      for (const p of translations) {
        work.step(); const row = { row: segment.row+p.y,start: segment.start+p.x,end: segment.end+p.x,color: segment.color };
        if (row.start < margin.x || row.end > metadata.resolutionX-margin.x || row.row < margin.y || row.row >= metadata.resolutionY-margin.y) throw fail('A translated copy exceeds the required clear margin.', 'GOO_REPLICATION_CLIPPED');
        rows.push(row);
      }
    }
    const image = encodeLayer(rows,metadata,bounds,work,previews), length = Buffer.alloc(4); length.writeUInt32BE(image.length);
    bytes += DEFINITION+image.length+2;
    if (bytes + referenceBuffer.length-offset > bounds.maxFileBytes) throw fail('The generated GOO exceeds its file byte limit.', 'GOO_REPLICATION_LIMIT');
    definitions.update(source.definition); content.update(image); parts.push(source.definition,length,image,Buffer.from([13,10]));
  }
  const previewRecords = [];
  for (const preview of previews) {
    const target = header.subarray(preview.offset,preview.offset+preview.size*preview.size*2);
    for (let i = 0; i < preview.values.length; i++) { work.step(); const gray = preview.values[i]; target.writeUInt16BE(((gray >>> 3) << 11) | ((gray >>> 2) << 5) | (gray >>> 3),i*2); }
    previewRecords.push({ width: preview.size,height: preview.size,sha256: hash(target) });
  }
  parts.push(referenceBuffer.subarray(offset)); const buffer = Buffer.concat(parts);
  const proof = verifyGooPlate(referenceBuffer,buffer,{ translationsPx: translations,marginPx: margin,minGapPx: gap,limits: work.remaining() });
  const derivation = { schemaVersion: 1,mode: 'exact-raster-replication',encoderVersion: ENCODER_VERSION,referenceSha256: metadata.sha256,artifactSha256: hash(buffer),referenceBytes: referenceBuffer.length,artifactBytes: buffer.length,
    copiesPerRun: translations.length,layerCount: metadata.layerCount,translationsPx: translations,marginPx: margin,minGapPx: gap,layerDefinitionsSha256: definitions.digest('hex'),encodedImageContentSha256: content.digest('hex'),rasterProofSha256: proof.proofSha256,
    thumbnails: { policy: 'letterboxed-top-down-max-intensity-all-layers',frame: 'encoded-raster',orientationPolicy: 'mirror-flags-preserved-not-physical-handedness-proof',format: 'RGB565BE',images: previewRecords },
    estimates: { policy: 'reference-material-estimates-times-copies',copies: translations.length,...estimates,printTimeSeconds: metadata.printTimeSeconds,printTimePolicy: 'unchanged-reference-physical-schedule-estimate-not-a-duration-guarantee' } };
  derivation.derivationSha256 = hash(JSON.stringify(canonical(derivation)));
  work.check();
  return Object.freeze({ buffer,proof,derivation: freeze(derivation) });
}

module.exports = { replicateGooPlate };
