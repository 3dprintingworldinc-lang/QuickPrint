'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');

const dist = path.resolve(__dirname, '../dist');
const project = path.resolve(__dirname, '..');
const archivePath = path.join(dist, 'win-unpacked/resources/app.asar');
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}
const sources = filesUnder(path.join(project, 'src')).filter((file) => !file.endsWith('.test.js'));
sources.push(path.join(project, 'assets/quickprint.png'));
for (const file of sources) {
  const relative = path.relative(project, file).split(path.sep).join('/');
  if (!fs.readFileSync(file).equals(asar.extractFile(archivePath, relative))) {
    throw new Error(`Source changed during packaging: ${relative}. Run the build again after edits finish.`);
  }
}
for (const file of filesUnder(path.join(project, 'docs')).filter((file) => file.endsWith('.md'))) {
  const relative = path.relative(path.join(project, 'docs'), file);
  if (!fs.readFileSync(file).equals(fs.readFileSync(path.join(dist, 'win-unpacked/resources/documentation', relative)))) {
    throw new Error(`Documentation changed during packaging: ${relative}. Run the build again.`);
  }
}
const names = fs.readdirSync(dist).filter((name) => /\.(exe|zip|blockmap)$/.test(name)).sort();
if (!names.some((name) => name.endsWith('.exe'))) throw new Error('No Windows executable was produced.');
const artifacts = names.map((name) => {
  const data = fs.readFileSync(path.join(dist, name));
  if (name.endsWith('.exe') && data.subarray(0, 2).toString() !== 'MZ') throw new Error(`${name} is not a Windows executable.`);
  return { name, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
});
const rows = artifacts.map(({ name, sha256 }) => `${sha256}  ${name}`);
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${rows.join('\n')}\n`);
fs.writeFileSync(path.join(dist, 'release-manifest.json'), `${JSON.stringify({
  product: 'QuickPrint',
  version: require('../package.json').version,
  electron: require('electron/package.json').version,
  electronBuilder: require('electron-builder/package.json').version,
  target: 'Windows x64',
  builtAt: new Date().toISOString(),
  builderPlatform: process.platform,
  packagedApplicationSha256: crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex'),
  sourceFilesVerified: sources.length,
  artifacts,
}, null, 2)}\n`);
console.log(`Saved SHA256SUMS.txt for ${names.length} Windows build artifacts.`);
