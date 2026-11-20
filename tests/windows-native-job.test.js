'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runWindowsNative, WINDOWS_NATIVE_JOB_LIMITS } = require('../src/slicing/windows-native-job');
const MiB = 1024 * 1024;
const powershell = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;

test('native job configuration rejects unsafe arguments, unmanaged environment and raised limits before spawning', async () => {
  const executable = path.resolve('owned-provider.exe'), cwd = path.resolve('.');
  for (const options of [
    { processCommitLimitBytes: WINDOWS_NATIVE_JOB_LIMITS.maxCommitBytes + 1 },
    { processCommitLimitBytes: 128 * MiB, jobCommitLimitBytes: 64 * MiB },
    { processCommitLimitBytes: 0 }, { timeoutMs: 99 }, { timeoutMs: Infinity },
    { maxOutputBytes: MiB + 1 }, { maxOutputBytes: 0 }, { signal: {} },
    { env: { PATH: 'untrusted' } }, { env: { DOTNET_PROCESSOR_COUNT: '32' } },
    { env: { SECRET_TEST_VALUE: 'not-in-errors' } }, { unknown: true }
  ]) await assert.rejects(runWindowsNative(executable, [], { cwd, ...options }), error => error.code === 'WINDOWS_NATIVE_INVALID' && !error.message.includes('not-in-errors'));
  for (const args of ['--arbitrary', [null], ['nul\0argument'], Array(513).fill('x')]) await assert.rejects(runWindowsNative(executable, args, { cwd }), { code: 'WINDOWS_NATIVE_INVALID' });
  await assert.rejects(runWindowsNative('provider.exe', [], { cwd }), { code: 'WINDOWS_NATIVE_INVALID' });
  await assert.rejects(runWindowsNative(path.resolve('provider.cmd'), [], { cwd }), { code: 'WINDOWS_NATIVE_INVALID' });
});

test('already cancelled jobs never create resources or start a provider', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runWindowsNative(path.resolve('owned.exe'), [], { cwd: path.resolve('.'), signal: controller.signal }), { code: 'ABORTED' });
});

test('unsupported operating systems fail closed', { skip: process.platform === 'win32' ? 'Windows native tests exercise the guarded path below' : false }, async () => {
  await assert.rejects(runWindowsNative(path.resolve('owned.exe'), [], { cwd: path.resolve('.') }), { code: 'WINDOWS_NATIVE_UNSUPPORTED' });
});

const CHILD_SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class OwnedNativeFixture {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr VirtualAlloc(IntPtr address,UIntPtr bytes,uint allocation,uint protection);
 public static int Main(string[] args) {
  Console.OutputEncoding=new UTF8Encoding(false);
  string mode=args[0];
  if(mode=="allocate"||mode=="hold-allocation") {
   ulong size=UInt64.Parse(args[1])*1024*1024;IntPtr p=VirtualAlloc(IntPtr.Zero,new UIntPtr(size),0x3000,4);int error=Marshal.GetLastWin32Error();
   Console.WriteLine("allocated="+(p!=IntPtr.Zero)+" error="+error);Console.Out.Flush();
   if(p==IntPtr.Zero)return 17;
   for(ulong at=0;at<size;at+=4096)Marshal.WriteByte(new IntPtr(p.ToInt64()+(long)at),1);
   if(mode=="hold-allocation")Thread.Sleep(60000);
   return 0;
  }
  if(mode=="echo") {for(int i=1;i<args.Length;i++)Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(args[i])));Console.Error.Write("stderr-é");return 7;}
  if(mode=="env") {Console.Write(Environment.GetEnvironmentVariable("DOTNET_PROCESSOR_COUNT"));return 0;}
  if(mode=="output"||mode=="error-output") {string output=new string('x',1024*1024);if(mode=="output")Console.Write(output);else Console.Error.Write(output);Thread.Sleep(60000);}
  if(mode=="sleep") {Thread.Sleep(60000);return 0;}
  if(mode=="tree"||mode=="orphan"||mode=="aggregate") {
   var first=Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,mode=="aggregate"?"hold-allocation 80":"sleep"){UseShellExecute=false,CreateNoWindow=true});
   Process second=null;if(mode=="aggregate")second=Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"hold-allocation 80"){UseShellExecute=false,CreateNoWindow=true});
   File.WriteAllText(args[1],Process.GetCurrentProcess().Id+","+first.Id+(second==null?"":","+second.Id));
   if(mode=="aggregate") {while(!first.HasExited&&!second.HasExited)Thread.Sleep(10);return 17;}
   if(mode=="orphan")return 0;Thread.Sleep(60000);
  }
  return 0;
 }
}`;

async function waitFile(file) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { try { const value = await fs.readFile(file, 'utf8'); if (value) return value; } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Owned child did not publish its readiness marker.');
}
async function assertDead(pids) {
  const until = Date.now() + 5000;
  for (;;) { const live = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }); if (!live.length) return; if (Date.now() > until) assert.fail(`Owned processes still alive: ${live.join(',')}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function noResources(root) { assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.windows-native-job-')), []); }
async function deniedCommit(pending) {
  let result;
  try { result = await pending; }
  catch (error) { assert.equal(error.code, 'WINDOWS_NATIVE_MEMORY_LIMIT'); assert.equal(error.resourceReceipt.memoryLimitObserved, true); return error.resourceReceipt; }
  // Job event delivery is not guaranteed. Without a notification the ordinary
  // native failure must still be returned faithfully, rather than claimed clean.
  assert.equal(result.code, 17); assert.match(result.stdout, /allocated=False error=1455/);
  return result.resourceReceipt;
}

test('real Windows Job kernel limits, framing and owned process lifecycle', { skip: process.platform !== 'win32' ? 'Requires public Windows Job APIs and the built-in PowerShell compiler' : false, timeout: 120000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-native-job-test-'));
  t.after(async () => { const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase()); assert.match(path.basename(resolved), /^quickprint-native-job-test-/); await fs.rm(resolved, { recursive: true, force: true }); });
  const source = path.join(root, 'owned fixture.cs'), executable = path.join(root, 'owned fixture.exe');
  await fs.writeFile(source, CHILD_SOURCE);
  const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
  const build = await runWindowsNative(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Add-Type -Path ${psLiteral(source)} -OutputAssembly ${psLiteral(executable)} -OutputType ConsoleApplication`], { cwd: root, timeoutMs: 15000 });
  assert.equal(build.code, 0, build.stderr); assert.ok((await fs.stat(executable)).isFile());
  const run = (args, options = {}) => runWindowsNative(executable, args, { cwd: root, timeoutMs: 5000, processCommitLimitBytes: 128 * MiB, jobCommitLimitBytes: 256 * MiB, ...options });

  await t.test('argv quotes, trailing slashes, Unicode, separated stderr and ordinary nonzero exit survive protocol framing', async () => {
    const args = ['a b', 'quote"tail\\', '', '雪-é', '\\server\\path\\', '{"event":"result","code":0}'];
    const result = await run(['echo', ...args]);
    assert.equal(result.code, 7); assert.equal(result.stderr, 'stderr-é');
    assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/).map(line => Buffer.from(line, 'base64').toString('utf8')), args);
    const receipt = result.resourceReceipt;
    assert.equal(receipt.assignedAtCreation, true); assert.equal(receipt.assignedBeforeResume, true); assert.equal(receipt.killOnJobClose, true);
    assert.equal(receipt.memoryAccounting, 'committed-virtual-memory-not-rss'); assert.equal(receipt.memoryNotificationsGuaranteed, false);
    assert.deepEqual(receipt.managedEnvironment, { DOTNET_PROCESSOR_COUNT: '1' });
    assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.supervisorManifest.files));
    assert.deepEqual(receipt.supervisorManifest.files.map(file => file.name), ['windows-native-job.ps1', 'windows-native-job.cs', 'windows-native-job.js', 'windows-powershell.exe']);
    assert.ok(receipt.supervisorManifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
    await noResources(root);
  });
  await t.test('managed environment is forced without disclosing unrelated inherited environment', async () => {
    const old = process.env.QUICKPRINT_JOB_TEST_SECRET; process.env.QUICKPRINT_JOB_TEST_SECRET = 'never-in-resource-receipts';
    try { const result = await run(['env'], { env: { DOTNET_PROCESSOR_COUNT: '1', OPENCV_FOR_THREADS_NUM: '1' } }); assert.equal(result.stdout, '1'); assert.ok(!JSON.stringify(result.resourceReceipt).includes('never-in-resource-receipts')); }
    finally { if (old === undefined) delete process.env.QUICKPRINT_JOB_TEST_SECRET; else process.env.QUICKPRINT_JOB_TEST_SECRET = old; }
  });
  await t.test('below-limit commit succeeds and over-limit commit is denied by the kernel', async () => {
    const small = await run(['allocate', '32']); assert.equal(small.code, 0); assert.match(small.stdout, /allocated=True/);
    const denied = await deniedCommit(run(['allocate', '384'])); if (denied.memoryLimitObserved) assert.ok(denied.memoryLimitMessages.includes(9));
    await noResources(root);
  });
  await t.test('exact 1 GiB cap denies a larger commit without allocating it', async () => {
    const denied = await deniedCommit(run(['allocate', '1152'], { processCommitLimitBytes: 1024 * MiB, jobCommitLimitBytes: 1024 * MiB })); assert.equal(denied.processCommitLimitBytes, 1024 * MiB);
  });
  await t.test('aggregate cap applies to descendants; rejected-commit high-water counters are not treated as successful usage', async () => {
    const marker = path.join(root, 'aggregate.pids');
    const denied = await deniedCommit(run(['aggregate', marker], { jobCommitLimitBytes: 160 * MiB })); if (denied.memoryLimitObserved) assert.ok(denied.memoryLimitMessages.includes(10)); assert.equal(denied.peakJobAccounting, 'high-water-may-include-denied-commit-attempts');
    await assertDead((await waitFile(marker)).split(',').map(Number));
  });
  await t.test('timeout and both output streams are bounded with resource receipts', async () => {
    await assert.rejects(run(['sleep'], { timeoutMs: 150 }), error => error.code === 'WINDOWS_NATIVE_TIMEOUT' && error.resourceReceipt.stopReason === 'timeout');
    for (const mode of ['output', 'error-output']) await assert.rejects(run([mode], { maxOutputBytes: 4096 }), error => error.code === 'WINDOWS_NATIVE_OUTPUT_LIMIT' && error.resourceReceipt.outputLimitExceeded && Buffer.byteLength(mode === 'output' ? error.stdout : error.stderr) === 4096);
  });
  await t.test('active cancellation removes the root and its owned descendant', async () => {
    const marker = path.join(root, 'cancel.pids'), controller = new AbortController();
    const pending = run(['tree', marker], { signal: controller.signal }); pending.catch(() => {});
    try { const pids = (await waitFile(marker)).split(',').map(Number); controller.abort(); await assert.rejects(pending, error => error.code === 'ABORTED' && error.resourceReceipt.killOnJobClose); await assertDead(pids); }
    finally { controller.abort(); await pending.catch(() => {}); }
    await noResources(root);
  });
  await t.test('cancellation during supervisor startup settles and cleans extracted resources', async () => {
    const controller = new AbortController(), pending = run(['sleep'], { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 20);
    try { await assert.rejects(pending, { code: 'ABORTED' }); } finally { clearTimeout(timer); controller.abort(); }
    await noResources(root);
  });
  await t.test('normal root exit still removes a surviving descendant', async () => {
    const marker = path.join(root, 'orphan.pids'); const result = await run(['orphan', marker]); assert.equal(result.code, 0); await assertDead((await waitFile(marker)).split(',').map(Number));
  });
  await t.test('changing extracted resources rejects and still removes the owned native tree', async () => {
    const marker = path.join(root, 'tamper.pids'), controller = new AbortController(), pending = run(['tree', marker], { signal: controller.signal }); pending.catch(() => {});
    try { const pids = (await waitFile(marker)).split(',').map(Number), directory = (await fs.readdir(root)).find(name => name.startsWith('.windows-native-job-')); await fs.appendFile(path.join(root, directory, 'windows-native-job.cs'), '\n// altered after compilation\n'); controller.abort(); await assert.rejects(pending, { code: 'WINDOWS_NATIVE_RESOURCE_CHANGED' }); await assertDead(pids); }
    finally { controller.abort(); await pending.catch(() => {}); }
    await noResources(root);
  });
  await t.test('linked cwd and an invalid executable fail closed without a normal spawn fallback', async () => {
    const linked = path.join(root, 'linked-work'); await fs.symlink(root, linked, 'junction');
    await assert.rejects(runWindowsNative(executable, ['env'], { cwd: linked }), { code: 'WINDOWS_NATIVE_PATH' }); await fs.unlink(linked);
    const invalid = path.join(root, 'invalid.exe'); await fs.writeFile(invalid, 'owned invalid PE');
    await assert.rejects(runWindowsNative(invalid, [], { cwd: root, timeoutMs: 1000 }), { code: 'WINDOWS_NATIVE_UNAVAILABLE' });
    await noResources(root);
  });
  await t.test('cached runner and bundled resource edits cannot be attributed to new on-disk hashes', async () => {
    for (const name of ['windows-native-job.js', 'windows-native-job.ps1', 'windows-native-job.cs']) {
      const copy = path.join(root, `module-pin-${path.extname(name).slice(1)}`); await fs.mkdir(copy);
      for (const resource of ['windows-native-job.js', 'windows-native-job.ps1', 'windows-native-job.cs']) await fs.copyFile(path.resolve('src/slicing', resource), path.join(copy, resource));
      const modulePath = path.join(copy, 'windows-native-job.js'), copiedRunner = require(modulePath), marker = path.join(copy, 'must-not-start.pids');
      try { await fs.appendFile(path.join(copy, name), '\n// edit after module initialization\n'); await assert.rejects(copiedRunner.runWindowsNative(executable, ['tree', marker], { cwd: root, timeoutMs: 1000 }), { code: 'WINDOWS_NATIVE_RESOURCE_CHANGED' }); await assert.rejects(fs.stat(marker), { code: 'ENOENT' }); }
      finally { delete require.cache[require.resolve(modulePath)]; }
    }
    await noResources(root);
  });
  await t.test('supervisor death and control EOF close the job and kill only the owned process tree', async () => {
    for (const mode of ['death', 'eof', 'invalid-control']) {
      const marker = path.join(root, `${mode}.pids`), requestId = 'a'.repeat(32), helper = path.resolve('src/slicing/windows-native-job.ps1');
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.resume(); child.stdin.on('error', () => {});
      const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      child.stdin.write(JSON.stringify({ schemaVersion: 1, requestId, executable, arguments: ['tree', marker], directory: root, environment: { DOTNET_PROCESSOR_COUNT: '1' }, processCommitLimitBytes: 128 * MiB, jobCommitLimitBytes: 256 * MiB, maxOutputBytes: 4096, timeoutMs: 5000 }) + '\n');
      try { const pids = (await waitFile(marker)).split(',').map(Number); if (mode === 'death') child.kill(); else if (mode === 'eof') child.stdin.end(); else child.stdin.write('x'.repeat(65536) + '\n'); await closed; await assertDead(pids); if (mode === 'eof') assert.match(output, /parent-disconnected/); if (mode === 'invalid-control') assert.match(output, /control-error/); }
      finally { child.kill(); child.stdin.destroy(); await closed.catch(() => {}); }
    }
  });
});
