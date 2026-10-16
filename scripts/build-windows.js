'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

// Cache paths can be overridden for sandboxed builders. TLS and archive checksum
// validation remain enabled; no unverified Electron or builder downloads are used.
const env = { ...process.env };
if (env.HTTPS_PROXY || env.HTTP_PROXY) {
  env.ELECTRON_GET_USE_PROXY = '1';
  env.GLOBAL_AGENT_HTTPS_PROXY ||= env.HTTPS_PROXY || env.HTTP_PROXY;
  env.GLOBAL_AGENT_HTTP_PROXY ||= env.HTTP_PROXY || env.HTTPS_PROXY;
}
const crossBuild = process.platform !== 'win32' && env.QUICKPRINT_USE_SYSTEM_WINE !== '1';
const args = crossBuild
  ? [path.join(__dirname, 'build-cross-windows.js')]
  : [require.resolve('electron-builder/out/cli/cli.js'), '--win', '--x64', '--publish', 'never'];
if (!crossBuild && (env.ELECTRON_CACHE || env.electron_config_cache)) {
  args.push(`--config.electronDownload.cache=${env.ELECTRON_CACHE || env.electron_config_cache}`);
}
args.push(...process.argv.slice(2));
const child = spawn(process.execPath, args, { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit' });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => {
  if (code !== 0) { process.exitCode = code || 1; return; }
  if (process.argv.includes('--dir')) return;
  require('./build-checksums');
});
