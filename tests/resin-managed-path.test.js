'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveManagedResinFile } = require('../src/core/resin-managed-path');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-managed-resin-')), directory = path.join(root, 'managed directory'), nested = path.join(directory, 'nested artifacts');
  await fs.mkdir(nested, { recursive: true }); const filePath = path.join(nested, 'owned model.goo'); await fs.writeFile(filePath, 'Owned path fixture; no model parsing.');
  t.after(async () => { const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase()); assert.match(path.basename(resolved), /^quickprint-managed-resin-/); await fs.rm(resolved, { recursive: true, force: true }); });
  return { root, directory, nested, filePath };
}

test('canonical managed file resolution uses metadata only and preserves source bytes', async t => {
  const f = await fixture(t), readFile = fs.readFile, open = fs.open; let result;
  fs.readFile = async () => { throw new Error('The path helper must not read file contents.'); }; fs.open = async () => { throw new Error('The path helper must not open file data.'); };
  try { result = await resolveManagedResinFile(f.directory, f.filePath); } finally { fs.readFile = readFile; fs.open = open; }
  assert.deepEqual(result, { directory: await fs.realpath(f.directory), filePath: await fs.realpath(f.filePath), relative: path.join('nested artifacts', 'owned model.goo') }); assert.equal(Object.isFrozen(result), true); assert.equal(await fs.readFile(f.filePath, 'utf8'), 'Owned path fixture; no model parsing.');
});

test('both absolute path shapes are bounded before filesystem access', async () => {
  const original = fs.lstat; let calls = 0; fs.lstat = async (...args) => { calls++; return original(...args); };
  try { for (const invalid of ['', 'relative.goo', null, {}, 'x'.repeat(4001), path.resolve('a\nfile'), path.resolve('a\0file')]) { await assert.rejects(resolveManagedResinFile(path.resolve('.'), invalid), { code: 'RESIN_MANAGED_PATH_INVALID', status: 400 }); await assert.rejects(resolveManagedResinFile(invalid, path.resolve('file.goo')), { code: 'RESIN_MANAGED_PATH_INVALID', status: 400 }); } assert.equal(calls, 0); }
  finally { fs.lstat = original; }
});

test('files, directories, missing leaves and sibling-prefix escapes fail their physical managed scope', async t => {
  const f = await fixture(t), sibling = path.join(f.root, 'managed directory sibling'); await fs.mkdir(sibling); const other = path.join(sibling, 'outside.goo'); await fs.writeFile(other, 'Owned negative control.');
  for (const [directory, filename] of [[f.directory, other], [f.directory, f.nested], [f.filePath, f.filePath], [f.directory, path.join(f.nested, 'missing.goo')]]) await assert.rejects(resolveManagedResinFile(directory, filename), { code: 'RESIN_MANAGED_PATH_INVALID', status: 409 });
});

test('directory links and canonical linked ancestors are refused even when the leaf reaches the same file', async t => {
  const f = await fixture(t), link = path.join(f.root, 'directory-link'); await fs.symlink(f.nested, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveManagedResinFile(f.directory, path.join(link, path.basename(f.filePath))), { code: 'RESIN_MANAGED_PATH_INVALID' });
  await assert.rejects(resolveManagedResinFile(link, f.filePath), { code: 'RESIN_MANAGED_PATH_INVALID' });
  const realpath = fs.realpath;
  fs.realpath = async function (value, ...args) { return path.resolve(String(value)) === path.resolve(f.filePath) ? path.join(link, path.basename(f.filePath)) : realpath.call(this, value, ...args); };
  try { await assert.rejects(resolveManagedResinFile(f.directory, f.filePath), { code: 'RESIN_MANAGED_PATH_INVALID' }); } finally { fs.realpath = realpath; }
});

test('a file symlink is never accepted as an ordinary managed artifact', async t => {
  const f = await fixture(t), link = path.join(f.nested, 'file-link.goo');
  try { await fs.symlink(f.filePath, link, 'file'); } catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('This Windows account cannot create file symlinks; junction guards are tested separately.'); throw error; }
  await assert.rejects(resolveManagedResinFile(f.directory, link), { code: 'RESIN_MANAGED_PATH_INVALID' });
});

test('canonicalization cannot substitute a different file or directory with otherwise identical bytes', async t => {
  const f = await fixture(t), otherDir = path.join(f.root, 'different directory'), otherFile = path.join(f.nested, 'different.goo'); await fs.mkdir(otherDir); await fs.copyFile(f.filePath, otherFile);
  const original = fs.realpath;
  for (const [requested, substitute] of [[f.directory, otherDir], [f.filePath, otherFile]]) {
    fs.realpath = async function (value, ...args) { return path.resolve(String(value)) === path.resolve(requested) ? substitute : original.call(this, value, ...args); };
    try { await assert.rejects(resolveManagedResinFile(f.directory, f.filePath), { code: 'RESIN_MANAGED_PATH_INVALID' }); } finally { fs.realpath = original; }
  }
});

test('a changed inode, zero inode or missing device identity is rejected through repeated ancestor observations', async t => {
  const f = await fixture(t), original = fs.lstat, target = await original(f.filePath, { bigint: true });
  for (const mode of ['changed', 'zero', 'device']) {
    let observed = 0, injected = 0;
    // Windows temporary paths can already use DOS aliases. Count the known
    // physical leaf under BOTH input and realpath spellings, rather than only
    // the input string (which otherwise receives just two of four observations).
    fs.lstat = async function (filename, ...args) { const info = await original.call(this, filename, ...args); if (info.dev !== target.dev || info.ino !== target.ino) return info; observed++; if (mode === 'changed' && observed < 3) return info; injected++; return { ...info, ino: mode === 'zero' ? 0n : mode === 'changed' ? info.ino + 1n : info.ino, dev: mode === 'device' ? undefined : info.dev, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }; };
    try { await assert.rejects(resolveManagedResinFile(f.directory, f.filePath), { code: 'RESIN_MANAGED_PATH_INVALID' }); assert.ok(injected > 0, `${mode} identity fault must actually reach the resolver`); if (mode === 'changed') assert.ok(observed >= 3, 'changed identity must be injected after the initial input/canonical binding'); } finally { fs.lstat = original; }
  }
});

test('physical ancestor identity defeats a lexical case-folding sibling ambiguity without changing OS directory settings', async t => {
  const f = await fixture(t), sibling = path.join(f.root, 'different physical sibling'); await fs.mkdir(sibling); const outside = path.join(sibling, 'outside.goo'); await fs.writeFile(outside, 'Owned outside fixture.');
  const original = path.relative, managed = await fs.realpath(f.directory), other = await fs.realpath(outside);
  path.relative = (from, to) => from === managed && to === other ? path.basename(other) : original(from, to);
  try { await assert.rejects(resolveManagedResinFile(f.directory, outside), error => error.code === 'RESIN_MANAGED_PATH_INVALID' && /physically below/.test(error.message)); } finally { path.relative = original; }
});

test('actual Windows DOS aliases for managed parent and artifact resolve to their same canonical physical objects', { skip: process.platform !== 'win32' ? 'Requires Windows short-name APIs.' : false, timeout: 30000 }, async t => {
  const f = await fixture(t), { runWindowsNative } = require('../src/slicing/windows-native-job'), literal = value => "'" + value.replaceAll("'", "''") + "'";
  const definition = 'using System;using System.Text;using System.Runtime.InteropServices;public static class OwnedResinShortPath{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetShortPathNameW(string path,StringBuilder result,uint count);}';
  const command = `Add-Type -TypeDefinition ${literal(definition)}; $b=New-Object System.Text.StringBuilder 32768; @(${literal(f.directory)},${literal(f.filePath)}) | ForEach-Object { [void]$b.Clear(); $n=[OwnedResinShortPath]::GetShortPathNameW($_,$b,32768); if($n -eq 0 -or $n -ge 32768){throw 'Owned short-name query failed'}; [Console]::Out.WriteLine($b.ToString()) }`;
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), result = await runWindowsNative(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { cwd: f.root, timeoutMs: 15000, maxOutputBytes: 4096, processCommitLimitBytes: 512 * 1024 * 1024, jobCommitLimitBytes: 512 * 1024 * 1024 });
  assert.equal(result.code, 0, result.stderr); const [shortDir, shortFile] = result.stdout.trim().split(/\r?\n/);
  if (shortDir.toLowerCase() === f.directory.toLowerCase() && shortFile.toLowerCase() === f.filePath.toLowerCase()) return t.skip('The owned volume does not assign DOS aliases.');
  const expected = { directory: await fs.realpath(f.directory), filePath: await fs.realpath(f.filePath), relative: path.join('nested artifacts', 'owned model.goo') };
  for (const [directory, filename] of [[shortDir, shortFile], [shortDir, f.filePath], [f.directory, shortFile]]) assert.deepEqual(await resolveManagedResinFile(directory, filename), expected);
});
