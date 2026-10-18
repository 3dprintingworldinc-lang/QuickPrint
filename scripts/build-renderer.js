'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');

buildSync({
  entryPoints: [path.join(root, 'src/simulation/scene.js')],
  outfile: path.join(root, 'src/renderer/simulation-scene.js'),
  bundle: true,
  format: 'iife',
  globalName: 'QuickPrintScene',
  platform: 'browser',
  target: 'chrome130',
  minify: true,
  legalComments: 'eof',
  sourcemap: false,
  logLevel: 'warning',
});
fs.writeFileSync(path.join(root, 'src/renderer/THIRD-PARTY-NOTICES.txt'),
  'The 3D simulation renderer includes Three.js.\n\n' + fs.readFileSync(path.join(root, 'node_modules/three/LICENSE'), 'utf8'));
console.log('Built the offline 3D simulation renderer.');
