'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runWindowsNative } = require('../src/slicing/windows-native-job');
const { createControlledNativeCapture, isControlledNativeCapture, RESIN_CONTROLLED_CAPTURE_LIMITS } = require('../src/slicing/resin-controlled-capture');
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), MiB = 1024 * 1024;
const basic = () => ({ cwd: path.resolve('.'), providers: { prusa: { executable: path.resolve('prusa.exe'), version: '2.9.7' }, uvtools: { executable: path.resolve('UVtoolsCmd.exe'), version: '7.1.2' } } });

test('capture configuration and early cancellation reject without a provider or injectable runner', async () => {
  for (const change of [v => v.run = () => {}, v => v.providers.prusa.version = '2.9.6', v => v.providers.uvtools.sha256 = 'not-a-hash', v => v.providers.prusa.executable = 'relative.exe', v => v.providers.uvtools.extra = true, v => v.limits = { maxFileBytes: 512 * MiB + 1 }, v => v.limits = { processCommitLimitBytes: 512 * MiB, jobCommitLimitBytes: 128 * MiB }, v => v.limits = { timeoutMs: '1000' }, v => v.signal = {}]) { const value = basic(); change(value); await assert.rejects(createControlledNativeCapture(value), { code: 'RESIN_CAPTURE_INVALID' }); }
  const controller = new AbortController(); controller.abort(); await assert.rejects(createControlledNativeCapture({ ...basic(), signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(RESIN_CONTROLLED_CAPTURE_LIMITS.maxFileBytes, 512 * MiB); assert.equal(RESIN_CONTROLLED_CAPTURE_LIMITS.maxInvocations, 64);
  assert.equal(isControlledNativeCapture({ invoke() {} }), false); assert.equal(isControlledNativeCapture(null), false);
});

test('unsupported platforms never choose an unguarded fallback', { skip: process.platform === 'win32' ? 'The real guarded Windows path is exercised below.' : false }, async () => {
  await assert.rejects(createControlledNativeCapture(basic()), { code: 'WINDOWS_NATIVE_UNSUPPORTED' });
});

const OWNED_PROVIDER = `using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class OwnedCaptureInterface {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetShortPathNameW(string path,StringBuilder result,uint count);
 public static int Main(string[] args) {
  if(args.Length==0)return 9;
  if(args[0]=="--help"){Console.WriteLine("PrusaSlicer-2.9.7\\n--export-sla");return 0;}
  if(args[0]=="--core-version"){Console.WriteLine("7.1.2");return 0;}
  if(args[0]=="copy"){File.Copy(args[1],args[2],false);Console.WriteLine("owned fixture copy");Console.Error.Write("owned stderr");return 0;}
  if(args[0]=="apply"){File.AppendAllText(args[1],"|applied");File.WriteAllText(args[2],"owned-receipt");return 0;}
  if(args[0]=="alter-input"){File.AppendAllText(args[1],"|unapproved");File.Copy(args[1],args[2],false);return 0;}
  if(args[0]=="sleep"){File.WriteAllText(args[1],"ready");Thread.Sleep(Int32.Parse(args[2]));return 0;}
  if(args[0]=="fail")return 7;
  if(args[0]=="short-path"){for(int i=1;i<args.Length;i++){var output=new StringBuilder(32768);uint n=GetShortPathNameW(args[i],output,(uint)output.Capacity);if(n==0||n>=output.Capacity)return 8;Console.WriteLine(output.ToString());}return 0;}
  return 11;
 }
}`;

async function waitFile(filename) { const until = Date.now() + 10000; while (Date.now() < until) { try { if ((await fs.readFile(filename, 'utf8')) === 'ready') return; } catch (error) { if (error.code !== 'ENOENT') throw error; } await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('Owned native fixture did not become ready.'); }

test('real Windows capture binds selected bytes, immutable files, fresh outputs and session-owned mutations', { skip: process.platform !== 'win32' ? 'Requires Windows Job APIs and the built-in owned-fixture compiler.' : false, timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quickprint-controlled-capture-'));
  t.after(async () => { const resolved = await fs.realpath(root); assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase()); assert.match(path.basename(resolved), /^quickprint-controlled-capture-/); await fs.rm(resolved, { recursive: true, force: true }); });
  const source = path.join(root, 'owned.cs'), compiled = path.join(root, 'owned.exe'); await fs.writeFile(source, OWNED_PROVIDER);
  const literal = value => "'" + value.replaceAll("'", "''") + "'", powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const built = await runWindowsNative(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Add-Type -Path ${literal(source)} -OutputAssembly ${literal(compiled)} -OutputType ConsoleApplication`], { cwd: root, timeoutMs: 15000 }); assert.equal(built.code, 0, built.stderr);
  const prusaDir = path.join(root, 'configured prusa'), uvDir = path.join(root, 'configured uvtools'); await fs.mkdir(prusaDir); await fs.mkdir(uvDir);
  const providers = { prusa: { executable: path.join(prusaDir, 'owned prusa.exe'), version: '2.9.7' }, uvtools: { executable: path.join(uvDir, 'owned uvtools.exe'), version: '7.1.2' } };
  for (const provider of Object.values(providers)) { await fs.copyFile(compiled, provider.executable); provider.sha256 = hash(await fs.readFile(provider.executable)); }
  for (const [directory, names] of [[prusaDir, ['PrusaSlicer.dll']], [uvDir, ['UVtoolsCmd.dll', 'UVtools.Core.dll']]]) for (const name of names) await fs.writeFile(path.join(directory, name), 'Owned selected dependency fixture: ' + name);
  let counter = 0;
  async function create(extra = {}) { const cwd = path.join(root, 'owned work ' + (++counter)); await fs.mkdir(cwd); const input = path.join(cwd, 'frozen input.txt'); await fs.writeFile(input, 'frozen-source'); const capture = await createControlledNativeCapture({ cwd, providers, limits: { timeoutMs: 5000, maxOutputBytes: 4096, processCommitLimitBytes: 128 * MiB, jobCommitLimitBytes: 256 * MiB }, ...extra }); return { cwd, input, capture }; }
  const copySpec = (f, id = 'copy') => ({ id, provider: 'prusa', argv: ['copy', f.input, path.join(f.cwd, id + '.goo')], inputs: [{ id: 'source', filePath: f.input, expectedSha256: hash('frozen-source') }], outputs: [{ id: 'goo', filePath: path.join(f.cwd, id + '.goo'), maxBytes: 1024 }] });

  await t.test('real version probes, selected dependencies and capability brands are not caller JSON authority', async () => {
    const f = await create(); try { const manifest = f.capture.getProviderManifest(), probes = f.capture.getInvocations(); assert.equal(isControlledNativeCapture(f.capture), true); assert.equal(isControlledNativeCapture({ ...f.capture }), false); assert.equal(probes.length, 2); assert.equal(Object.values(manifest.providers).flatMap(p => p.files).length, 5); assert.match(manifest.sha256, /^[a-f0-9]{64}$/); assert.equal(f.capture.getImplementationManifest().files.length, 4); assert.ok(probes.every(r => r.controlledExecution && r.nativeInvocationAttested === false && f.capture.ownsInvocation(r))); assert.equal(f.capture.ownsInvocation(JSON.parse(JSON.stringify(probes[0]))), false); assert.equal(Object.isFrozen(manifest.providers.prusa.files[0].pathBinding), true); } finally { await f.capture.close(); } assert.equal(isControlledNativeCapture(f.capture), false);
  });
  await t.test('fresh output, then an owned in-place edit plus a fresh receipt, bind exact before/after hashes', async () => {
    const f = await create(); const copied = await f.capture.invoke(copySpec(f)), goo = path.join(f.cwd, 'copy.goo'), receipt = path.join(f.cwd, 'parameters.receipt');
    const applied = await f.capture.invoke({ id: 'parameters', provider: 'uvtools', argv: ['apply', goo, receipt], inputs: [], mutations: [{ id: 'mutable-goo', filePath: goo, expectedSha256: hash('frozen-source') }], outputs: [{ id: 'receipt', filePath: receipt, maxBytes: 64 }] });
    assert.equal(copied.stdout.trim(), 'owned fixture copy'); assert.equal(copied.stderr, 'owned stderr'); assert.equal(applied.invocation.mutationsBefore[0].sha256, hash('frozen-source')); assert.equal(applied.invocation.outputsAfter.find(r => r.id === 'mutable-goo').sha256, hash('frozen-source|applied'));
    assert.equal(applied.invocation.resourceReceipt.assignedAtCreation, true); assert.equal(applied.invocation.resourceReceipt.processCommitLimitBytes, 128 * MiB); assert.ok(f.capture.ownsInvocation(applied.invocation)); assert.equal(applied.invocation.nativeInvocationAttested, false);
    await f.capture.close(); await assert.rejects(f.capture.invoke(copySpec(f, 'after-close')), { code: 'RESIN_CAPTURE_CLOSED' });
  });
  await t.test('an enqueued request snapshots argv and file descriptors before the caller can replace them', async () => {
    const f = await create({ limits: { timeoutMs: 5000, maxInvocations: 3 } }), spec = copySpec(f, 'snapshot'), pending = f.capture.invoke(spec);
    spec.id = 'changed'; spec.argv[0] = 'fail'; spec.argv[1] = path.join(root, 'outside'); spec.inputs[0].filePath = path.join(root, 'outside'); spec.outputs.length = 0;
    await assert.rejects(f.capture.invoke(copySpec(f, 'over-reserved-budget')), { code: 'RESIN_CAPTURE_LIMIT', status: 413 });
    const result = await pending; assert.equal(result.invocation.id, 'snapshot'); assert.equal(result.invocation.argv[0], 'copy'); assert.equal(result.invocation.inputsBefore[0].sha256, hash('frozen-source')); await f.capture.close();
  });
  await t.test('existing outputs, unowned mutations, path escapes and junctions cannot start an output-producing call', async () => {
    const f = await create(), spec = copySpec(f); await fs.writeFile(spec.outputs[0].filePath, 'earlier evidence');
    await assert.rejects(f.capture.invoke(spec), { code: 'RESIN_CAPTURE_OUTPUT_EXISTS' });
    await assert.rejects(f.capture.invoke({ id: 'not-owned', provider: 'uvtools', argv: ['apply', f.input, path.join(f.cwd, 'receipt')], inputs: [], outputs: [{ id: 'receipt', filePath: path.join(f.cwd, 'receipt') }], mutations: [{ id: 'source', filePath: f.input }] }), { code: 'RESIN_CAPTURE_MUTATION' });
    const escape = copySpec(f, 'escape'); escape.outputs[0].filePath = path.join(root, 'outside.goo'); escape.argv[2] = escape.outputs[0].filePath; await assert.rejects(f.capture.invoke(escape), { code: 'RESIN_CAPTURE_PATH' });
    const outside = path.join(root, 'outside-input.txt'); await fs.writeFile(outside, 'owned outside file'); const lexical = copySpec(f, 'physical-ancestor'); lexical.inputs[0].filePath = outside; lexical.inputs[0].expectedSha256 = hash('owned outside file'); lexical.argv[1] = outside;
    const originalRelative = path.relative, canonicalCwd = await fs.realpath(f.cwd), canonicalOutside = await fs.realpath(outside);
    // Model the lexical prefix ambiguity of a Windows case-sensitive sibling:
    // physical ancestor IDs still have to contain the original managed root.
    path.relative = (from, to) => from === canonicalCwd && [outside, canonicalOutside].includes(to) ? path.basename(outside) : originalRelative(from, to);
    try { await assert.rejects(f.capture.invoke(lexical), error => error.code === 'RESIN_CAPTURE_PATH' && /physically below/.test(error.message)); } finally { path.relative = originalRelative; }
    const link = path.join(f.cwd, 'linked'); await fs.symlink(f.cwd, link, 'junction'); const linked = copySpec(f, 'linked'); linked.inputs[0].filePath = path.join(link, path.basename(f.input)); linked.argv[1] = linked.inputs[0].filePath;
    try { await assert.rejects(f.capture.invoke(linked), { code: 'RESIN_CAPTURE_PATH' }); } finally { await fs.unlink(link); }
    assert.equal(f.capture.getInvocations().length, 2); await f.capture.close();
  });
  await t.test('provider input changes and nonzero native exits taint a session instead of issuing reusable successful records', async () => {
    const f = await create(); await assert.rejects(f.capture.invoke({ ...copySpec(f), argv: ['alter-input', f.input, path.join(f.cwd, 'copy.goo')] }), error => error.code === 'RESIN_CAPTURE_CHANGED' && error.invocation.status === 'failed' && !f.capture.ownsInvocation(error.invocation));
    assert.equal(isControlledNativeCapture(f.capture), false); await assert.rejects(f.capture.invoke(copySpec(f, 'retry')), { code: 'RESIN_CAPTURE_TAINTED' }); await f.capture.close();
    const failed = await create(); await assert.rejects(failed.capture.invoke({ id: 'exit', provider: 'prusa', argv: ['fail'], inputs: [], outputs: [] }), error => error.code === 'RESIN_CAPTURE_NATIVE_EXIT' && error.nativeCode === 7 && error.invocation.controlledExecution); await failed.capture.close();
  });
  await t.test('selected provider DLL changes during a real call invalidate its output and record bounded failed observations', async () => {
    const f = await create(), dependency = path.join(uvDir, 'UVtools.Core.dll'), original = await fs.readFile(dependency), marker = path.join(f.cwd, 'provider-change.txt');
    const pending = f.capture.invoke({ id: 'provider-change', provider: 'prusa', argv: ['sleep', marker, '1000'], inputs: [], outputs: [{ id: 'marker', filePath: marker }] }); pending.catch(() => {});
    try { await waitFile(marker); await fs.appendFile(dependency, '|changed-during-call'); await assert.rejects(pending, error => error.code === 'RESIN_CAPTURE_PROVIDER_CHANGED' && error.invocation.status === 'failed' && error.invocation.outputsAfter.files[0].sha256 === hash('ready')); assert.equal(isControlledNativeCapture(f.capture), false); await assert.rejects(f.capture.close(), { code: 'RESIN_CAPTURE_PROVIDER_CHANGED' }); }
    finally { await fs.writeFile(dependency, original); }
  });
  await t.test('aggregate bounds stop hashing oversized output and failed native calls cannot adopt it', async () => {
    const f = await create({ limits: { timeoutMs: 5000, maxAggregateBytes: 20 } });
    await assert.rejects(f.capture.invoke(copySpec(f)), error => error.status === 413 && error.invocation.status === 'failed' && error.invocation.inputsAfter.status === 'bounded-post-call-observation' && !f.capture.ownsInvocation(error.invocation));
    await f.capture.close();
  });
  await t.test('the close boundary detects later tracked output corruption and repeats the same failure', async () => {
    const f = await create(); await f.capture.invoke(copySpec(f)); await fs.appendFile(path.join(f.cwd, 'copy.goo'), '|changed-after-capture');
    const first = f.capture.close(), again = f.capture.close(); assert.equal(first, again); await assert.rejects(first, { code: 'RESIN_CAPTURE_CHANGED' });
  });
  await t.test('actual DOS aliases preserve cwd, provider, input and fresh-output identity without permitting linked ancestors', async t => {
    const f = await create(); await f.capture.close(); const aliases = await runWindowsNative(compiled, ['short-path', f.cwd, providers.prusa.executable, providers.uvtools.executable, f.input], { cwd: root, timeoutMs: 5000 }); assert.equal(aliases.code, 0, aliases.stderr);
    const [cwd, prusa, uvtools, input] = aliases.stdout.trim().split(/\r?\n/); if (cwd.toLowerCase() === f.cwd.toLowerCase() && input.toLowerCase() === f.input.toLowerCase()) return t.skip('The fixture volume does not create DOS aliases.');
    const capture = await createControlledNativeCapture({ cwd, providers: { prusa: { ...providers.prusa, executable: prusa }, uvtools: { ...providers.uvtools, executable: uvtools } }, limits: { timeoutMs: 5000 } });
    const target = path.join(cwd, 'alias output.goo'), result = await capture.invoke({ id: 'alias-copy', provider: 'prusa', argv: ['copy', input, target], inputs: [{ id: 'source', filePath: input }], outputs: [{ id: 'goo', filePath: target }] });
    assert.equal(result.invocation.inputsBefore[0].filePath, await fs.realpath(f.input)); assert.equal(result.invocation.cwd, await fs.realpath(f.cwd)); await capture.close();
  });
  await t.test('cancellation settles the real owned native process and never brands an incomplete output', async () => {
    const controller = new AbortController(), f = await create({ signal: controller.signal }), marker = path.join(f.cwd, 'ready.txt'), pending = f.capture.invoke({ id: 'waiting', provider: 'prusa', argv: ['sleep', marker, '10000'], inputs: [], outputs: [{ id: 'marker', filePath: marker }] }); pending.catch(() => {});
    await waitFile(marker); controller.abort(); await assert.rejects(pending, error => error.code === 'ABORTED' && !f.capture.ownsInvocation(error.invocation)); await assert.rejects(f.capture.close(), { code: 'ABORTED' });
    assert.deepEqual((await fs.readdir(f.cwd)).filter(name => name.startsWith('.windows-native-job-')), []);
  });
});
