"use strict";
// Bounded ZIP helpers extracted unchanged from PS AM Print; see NOTICE.md.
const zlib = require("node:zlib");
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const DEFAULT_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 4096;
const DEFAULT_MAX_COMPRESSION_RATIO = 250;

function findEndOfCentralDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return -1;
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function safeZipPath(name) {
  const normalized = String(name || "").replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return false;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").some((segment) => segment === "..");
}

function inspectZip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("ZIP data must be a Buffer.");
  const maxArchiveBytes = Number(options.maxArchiveBytes || DEFAULT_MAX_ARCHIVE_BYTES);
  const maxEntryBytes = Number(options.maxEntryBytes || DEFAULT_MAX_ENTRY_BYTES);
  const maxTotalUncompressedBytes = Number(
    options.maxTotalUncompressedBytes || DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES,
  );
  const maxEntries = Number(options.maxEntries || DEFAULT_MAX_ENTRIES);
  const maxCompressionRatio = Number(options.maxCompressionRatio || DEFAULT_MAX_COMPRESSION_RATIO);
  if (buffer.length > maxArchiveBytes) {
    throw new Error(`ZIP archive exceeds the ${maxArchiveBytes}-byte safety limit.`);
  }

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error("No ZIP central directory was found.");
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported by the print-safety validator.");
  }
  if (totalEntries < 1 || totalEntries > maxEntries) {
    throw new Error(`ZIP archive contains an unsafe entry count (${totalEntries}).`);
  }
  if (centralOffset + centralSize > eocd || centralOffset < 0) {
    throw new Error("ZIP central directory points outside the archive.");
  }

  const entries = [];
  const seen = new Set();
  let totalUncompressedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("ZIP central directory is malformed.");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + commentLength;
    if (nameEnd > buffer.length || nextOffset > buffer.length) {
      throw new Error("ZIP central directory entry is truncated.");
    }
    const name = buffer.subarray(nameStart, nameEnd).toString((flags & 0x0800) ? "utf8" : "utf8");
    const lookupName = name.replace(/\\/g, "/").toLowerCase();
    if (!safeZipPath(name)) throw new Error(`ZIP entry has an unsafe path: ${JSON.stringify(name)}.`);
    if (seen.has(lookupName)) throw new Error(`ZIP archive contains a duplicate entry: ${name}.`);
    seen.add(lookupName);
    if (flags & 0x0001) throw new Error(`Encrypted ZIP entry is not permitted: ${name}.`);
    if (![0, 8].includes(method)) {
      throw new Error(`ZIP entry ${name} uses unsupported compression method ${method}.`);
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error("ZIP64 entries are not supported by the print-safety validator.");
    }
    if (uncompressedSize > maxEntryBytes) {
      throw new Error(`ZIP entry ${name} exceeds the per-entry safety limit.`);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > maxCompressionRatio) {
      throw new Error(`ZIP entry ${name} exceeds the compression-ratio safety limit.`);
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > maxTotalUncompressedBytes) {
      throw new Error("ZIP archive exceeds the total uncompressed-size safety limit.");
    }
    entries.push({
      name: name.replace(/\\/g, "/"),
      lookupName,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error("ZIP central directory size does not match its entries.");
  }
  return { entries, totalUncompressedBytes };
}

function readZipEntry(buffer, entry, options = {}) {
  const maxEntryBytes = Number(options.maxEntryBytes || DEFAULT_MAX_ENTRY_BYTES);
  if (!entry || !Number.isSafeInteger(entry.localHeaderOffset)) {
    throw new TypeError("A valid ZIP directory entry is required.");
  }
  if (entry.uncompressedSize > maxEntryBytes) {
    throw new Error(`ZIP entry ${entry.name} exceeds the read safety limit.`);
  }
  const local = entry.localHeaderOffset;
  if (local < 0 || local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`ZIP local header is missing for ${entry.name}.`);
  }
  const localFlags = buffer.readUInt16LE(local + 6);
  const localMethod = buffer.readUInt16LE(local + 8);
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  if (localFlags & 0x0001) throw new Error(`Encrypted ZIP entry is not permitted: ${entry.name}.`);
  if (localMethod !== entry.method) throw new Error(`ZIP compression metadata disagrees for ${entry.name}.`);
  const dataStart = local + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > buffer.length) throw new Error(`ZIP entry ${entry.name} is truncated.`);
  const compressed = buffer.subarray(dataStart, dataEnd);
  let result;
  if (entry.method === 0) result = Buffer.from(compressed);
  else if (entry.method === 8) result = zlib.inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
  else throw new Error(`ZIP entry ${entry.name} uses unsupported compression method ${entry.method}.`);
  if (result.length !== entry.uncompressedSize) {
    throw new Error(`ZIP entry ${entry.name} expanded to an unexpected size.`);
  }
  return result;
}


function decodeXml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlAttributes(tag) {
  const result = {};
  const expression = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = expression.exec(String(tag || ""))) !== null) {
    result[match[1]] = decodeXml(match[2]);
  }
  return result;
}

function parseSliceInfo(text, plateId = null) {
  const source = String(text || "");
  const plateBlocks = [...source.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/gi)]
    .map((match) => match[1]);
  const parsed = plateBlocks.map((block) => {
    const metadata = {};
    for (const match of block.matchAll(/<metadata\b[^>]*\/?\s*>/gi)) {
      const attrs = xmlAttributes(match[0]);
      if (attrs.key) metadata[attrs.key] = attrs.value ?? "";
    }
    const objects = [...block.matchAll(/<object\b[^>]*\/?\s*>/gi)]
      .map((match) => xmlAttributes(match[0]))
      .filter((item) => String(item.skipped || "false").toLowerCase() !== "true");
    const filaments = [...block.matchAll(/<filament\b[^>]*\/?\s*>/gi)]
      .map((match) => xmlAttributes(match[0]));
    const nozzles = [...block.matchAll(/<nozzle\b[^>]*\/?\s*>/gi)]
      .map((match) => xmlAttributes(match[0]));
    const warnings = [...block.matchAll(/<warning\b[^>]*\/?\s*>/gi)]
      .map((match) => xmlAttributes(match[0]));
    return { metadata, objects, filaments, nozzles, warnings };
  });
  if (!parsed.length) throw new Error("Slice metadata does not contain a plate record.");
  const wanted = Number.parseInt(plateId, 10);
  if (Number.isSafeInteger(wanted) && wanted > 0) {
    const selected = parsed.find((item) => Number.parseInt(item.metadata.index, 10) === wanted);
    if (selected) return selected;
  }
  return parsed[0];
}

function canonicalPrinterModel(value) {
  const normalized = String(value || "").trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (!normalized) return "";
  if (normalized.includes("H2D") || normalized === "O1D") return "H2D";
  if (normalized.includes("X1C") || normalized.includes("X1CARBON") || normalized === "BLP001") return "X1C";
  return normalized;
}


module.exports = { inspectZip, readZipEntry, parseSliceInfo, canonicalPrinterModel };
