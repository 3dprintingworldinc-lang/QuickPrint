'use strict';

// Bind path spelling to physical objects without reading model/artifact bytes.
// DOS aliases are valid; links and lexical case-folding alone grant no scope.
const fs = require('node:fs/promises');
const path = require('node:path');

const invalid = (message, status = 409) => Object.assign(new Error(message), { code: 'RESIN_MANAGED_PATH_INVALID', status });
function absolute(value) {
  if (typeof value !== 'string' || !value.length || value.length > 4000 || /[\0\r\n]/.test(value) || !path.isAbsolute(value)) throw invalid('Use a bounded absolute managed resin path.', 400);
  return path.resolve(value);
}
async function chain(filename, directory) {
  const root = path.parse(filename).root, names = [root]; let current = root;
  for (const part of path.relative(root, filename).split(path.sep).filter(Boolean)) { current = path.join(current, part); names.push(current); }
  const entries = [];
  for (let index = 0; index < names.length; index++) {
    const info = await fs.lstat(names[index], { bigint: true }), needsDirectory = index < names.length - 1 || directory;
    if (info.isSymbolicLink() || (needsDirectory ? !info.isDirectory() : !info.isFile()) || typeof info.dev !== 'bigint' || typeof info.ino !== 'bigint' || info.ino <= 0n) throw invalid('Managed resin paths require ordinary nonlinked objects with stable identities.');
    entries.push({ dev: info.dev, ino: info.ino, directory: info.isDirectory() });
  }
  return entries;
}
const sameObject = (left, right) => left.dev === right.dev && left.ino === right.ino && left.directory === right.directory;
const sameChain = (left, right) => left.length === right.length && left.every((item, index) => sameObject(item, right[index]));
async function bind(filename, directory) {
  const input = absolute(filename), inputChain = await chain(input, directory), canonical = absolute(await fs.realpath(input)), canonicalChain = await chain(canonical, directory);
  if (!sameObject(inputChain.at(-1), canonicalChain.at(-1))) throw invalid('The input and canonical resin paths refer to different objects.');
  return { input, canonical, directory, inputChain, canonicalChain };
}
async function unchanged(binding) {
  const input = await chain(binding.input, binding.directory), canonical = await chain(binding.canonical, binding.directory);
  if (!sameChain(input, binding.inputChain) || !sameChain(canonical, binding.canonicalChain) || !sameObject(input.at(-1), canonical.at(-1))) throw invalid('A managed resin path changed identity during resolution.');
}

async function resolveManagedResinFile(directory, filePath) {
  try {
    // Validate both shapes before the first filesystem operation.
    const requestedDirectory = absolute(directory), requestedFile = absolute(filePath), managed = await bind(requestedDirectory, true), file = await bind(requestedFile, false);
    const managedObject = managed.canonicalChain.at(-1);
    if (!file.canonicalChain.slice(0, -1).some(item => sameObject(item, managedObject))) throw invalid('The resin file is not physically below its managed directory.');
    const relative = path.relative(managed.canonical, file.canonical);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw invalid('The resin file escapes its canonical managed directory.');
    await unchanged(managed); await unchanged(file);
    return Object.freeze({ directory: managed.canonical, filePath: file.canonical, relative });
  } catch (error) {
    if (error.code === 'RESIN_MANAGED_PATH_INVALID') throw error;
    throw invalid('The managed resin directory or file is unavailable or changed during resolution.');
  }
}

module.exports = { resolveManagedResinFile };
