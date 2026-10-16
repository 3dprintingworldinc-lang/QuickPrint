'use strict';

const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { createHash } = require('node:crypto');
const { MAX_FILE_BYTES, supportedFile, safeFileName } = require('./validation');

function signature(stat) {
  return [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':');
}

async function pollFolder(manager, config, checkpoint) {
  const directory = path.resolve(config.path);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const names = new Set();
  checkpoint.files ||= {};
  let handled = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (manager.stopping) break;
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (/\.(tmp|part|partial|crdownload)$/i.test(name) || name.startsWith('.')) continue;
    names.add(name);
    const filePath = path.join(directory, name);
    let stat;
    try { stat = await fs.lstat(filePath); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const version = signature(stat);
    let state = checkpoint.files[name];
    if (!state || state.signature !== version) {
      state = checkpoint.files[name] = { signature: version, stableSince: manager.now() };
    }
    if (state.done || manager.now() - state.stableSince < (config.settleMs ?? 2000)) continue;
    // Bound both imports and rejected inputs, including a large unsupported
    // document folder accidentally selected as a print inbox.
    if (handled >= 25) break;
    handled++;
    if (!supportedFile(name) || stat.size === 0 || stat.size > MAX_FILE_BYTES) {
      state.done = true;
      await manager.event(config, 'warning', 'connector.file_skipped', !supportedFile(name) ? 'An unsupported file was skipped. Supported inputs are STL, STEP, STP, OBJ, 3MF and G-code.' : 'An empty file or file larger than 100 MiB was skipped.');
      continue;
    }
    // A descriptor and post-read checks prevent a changed/partially written file
    // from being submitted under the identity of an earlier observation.
    let handle;
    let data;
    try {
      handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const before = await handle.stat();
      if (!before.isFile() || signature(before) !== version) continue;
      const bounded = Buffer.allocUnsafe(before.size + 1);
      let bytesRead = 0;
      while (bytesRead < bounded.length) {
        const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
      data = bounded.subarray(0, bytesRead);
      const after = await handle.stat();
      const current = await fs.lstat(filePath);
      if (data.length !== before.size || signature(after) !== version || signature(current) !== version || current.isSymbolicLink()) {
        delete checkpoint.files[name];
        continue;
      }
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes(error.code)) { delete checkpoint.files[name]; continue; }
      throw error;
    } finally { if (handle) await handle.close(); }
    const sourceId = createHash('sha256').update(JSON.stringify([checkpoint.location, name, version])).update(data).digest('hex');
    const result = await manager.service.submit({
      source: `folder:${config.id}`,
      sourceId,
      name: safeFileName(name),
      customer: config.defaults?.customer || '',
      quantity: config.defaults?.quantity || 1,
      notes: config.defaults?.notes || '',
      files: [{ name: safeFileName(name), data }],
    });
    state.done = true;
    state.sourceId = sourceId;
    if (!result.duplicate) manager.imported(config.id, result.jobs?.length || 1);
    await manager.persist();
  }
  // Retain completed identities for existing files; remove missing-file entries.
  // The stable source ID still deduplicates a retry after a checkpoint failure.
  if (handled < 25) for (const name of Object.keys(checkpoint.files)) if (!names.has(name)) delete checkpoint.files[name];
  await manager.persist();
}

module.exports = { pollFolder };
