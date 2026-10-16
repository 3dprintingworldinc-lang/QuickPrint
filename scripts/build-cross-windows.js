'use strict';

// electron-builder already extracts NSIS uninstallers without running Windows
// code on macOS. Use that same exported reader through the public packager
// factory extension on Linux, where a usable Wine installation may be absent.
// Pin the builder because the NSIS target methods are version-specific. No
// downloaded executable, package file, TLS policy, or checksum is modified.
const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('electron-builder');
const { WinPackager } = require('app-builder-lib/out/winPackager');
const { UninstallerReader, nsisTemplatesDir } = require('app-builder-lib/out/targets/nsis/nsisUtil');

if (require('electron-builder/package.json').version !== '26.15.3') {
  throw new Error('Review the Linux NSIS extraction extension before updating electron-builder from 26.15.3.');
}

async function extractUninstaller(defines, commands, installerPath, sharedHeader, archs) {
  if (this.options.script) throw new Error('Linux cross-build extension requires the stock NSIS installer template.');
  const script = await fs.readFile(path.join(nsisTemplatesDir, 'installer.nsi'), 'utf8');
  const uninstallerPath = path.join(this.outDir, `${path.basename(installerPath, 'exe')}__uninstaller.exe`);
  defines.BUILD_UNINSTALLER = null;
  defines.UNINSTALLER_OUT_FILE = path.win32.join('Z:', uninstallerPath);
  await this.executeMakensis(defines, commands, sharedHeader + await this.computeFinalScript(script, false, archs));
  await UninstallerReader.exec(installerPath, uninstallerPath);
  const bytes = await fs.readFile(uninstallerPath);
  const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
  if (bytes.subarray(0, 2).toString() !== 'MZ' || peOffset < 64 || bytes.subarray(peOffset, peOffset + 4).toString() !== 'PE\0\0') {
    throw new Error('NSIS extraction did not produce a valid Windows uninstaller.');
  }
  await this.packager.signIf(uninstallerPath);
  delete defines.BUILD_UNINSTALLER;
  defines.UNINSTALLER_OUT_FILE = uninstallerPath;
  return { script, isCustomScript: false };
}

class CrossWinPackager extends WinPackager {
  createTargets(targets, mapper) {
    super.createTargets(targets, (name, factory) => mapper(name, (outDir) => {
      const target = factory(outDir);
      if (name === 'nsis') target.computeScriptAndSignUninstaller = extractUninstaller.bind(target);
      return target;
    }));
  }
}

const args = process.argv.slice(2);
if (args.some((arg) => !['--dir', '--portable-only'].includes(arg))) throw new Error('Linux cross-build accepts --dir or --portable-only only.');
const config = {};
if (process.env.ELECTRON_CACHE || process.env.electron_config_cache) {
  config.electronDownload = { cache: process.env.ELECTRON_CACHE || process.env.electron_config_cache };
}
build({
  projectDir: path.resolve(__dirname, '..'),
  win: args.includes('--dir') ? [] : (args.includes('--portable-only') ? ['portable'] : ['nsis', 'portable']),
  x64: true,
  dir: args.includes('--dir'),
  publish: 'never',
  config,
  platformPackagerFactory: (info, platform) => {
    if (platform.name !== 'windows') throw new Error('This builder only supports Windows targets.');
    return new CrossWinPackager(info);
  },
}).catch((error) => { console.error(error); process.exitCode = 1; });
