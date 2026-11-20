'use strict';

const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os'), Module=require('node:module');
const {createHash}=require('node:crypto');
const {MODEL}=require('./helpers/resin-slice');
const {createPlateSliceFixture,gooForInstances}=require('./helpers/resin-plate-slice');
const {loadProfile,parseIssueReport}=require('../src/slicing/resin-engine');
const {prepareResinGeometry}=require('../src/slicing/resin-geometry');
const {inspectGoo}=require('../src/slicing/goo');
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>hash(JSON.stringify(canonical(value)));
const without=(value,key)=>{const result={...value};delete result[key];return result;};

// Only the two native/audit boundaries are replaced in this isolated test
// module load. The public adapter has no injection hook. Geometry, managed
// bytes, complete GOO replication, independent proof, receipts and replay are
// exercised by the real modules. These fixtures never claim actual native QA.
const contexts=new Map(),sessions=new WeakSet();
const engine={
  async verifyControlledResinHollowPreparation(record,options){const f=contexts.get(record.sha256);if(!f||f.faults.held)throw Object.assign(new Error('Heavy audit held'),{code:'TEST_HEAVY_HELD'});f.heavy++;const current=await engine.inspectControlledResinHollowBindings(record,options);return{...current,hollowPreparationSha256:record.sha256};},
  async inspectControlledResinHollowBindings(record,options){const f=contexts.get(record?.sha256);if(!f||!options.source.equals(MODEL))throw Object.assign(new Error('Source changed'),{code:'TEST_REFERENCE_CHANGED'});f.light++;for(const descriptor of f.descriptors){const bytes=await fs.readFile(descriptor.filePath);if(bytes.length!==descriptor.bytes||hash(bytes)!==descriptor.sha256)throw Object.assign(new Error('Reference changed'),{code:'TEST_REFERENCE_CHANGED'});}return{bindingHash:f.faults.bindingChanged?'f'.repeat(64):f.bindingHash,hollowPreparationSha256:record.sha256,sha256:record.roles.final.artifact.sha256};}
};
const capture={
  isControlledNativeCapture:value=>sessions.has(value),
  async createControlledNativeCapture(options){
    const f=[...contexts.values()].find(f=>f.root===path.dirname(options.cwd)||f.root===options.cwd);if(!f)throw new Error('Unknown fixture');f.factories++;
    const invocations=[],owned=new WeakSet();let closed=false;
    const session={getInvocations:()=>[{cwd:options.cwd}],getProviderManifest:()=>f.hollow.providerManifest,getImplementationManifest:()=>f.captureImplementation,ownsInvocation:value=>owned.has(value),async close(){closed=true;sessions.delete(session);f.closed++;},async invoke(spec){
      assert.equal(closed,false);f.calls.push(spec);
      if(f.faults.mutateArtifact){const bytes=await fs.readFile(spec.inputs[0].filePath);bytes[194]^=1;await fs.writeFile(spec.inputs[0].filePath,bytes);}
      const filePath=spec.inputs[0].filePath,bytes=await fs.readFile(filePath),stdout=f.faults.issues?'Issues: 1\nIsland fixture':'Issues: 0',stderr='';
      const input={id:spec.inputs[0].id,filePath,bytes:bytes.length,sha256:hash(bytes),owned:false};
      const invocation={schemaVersion:1,method:'controlled-windows-provider-capture-v1',id:spec.id,status:'succeeded',controlledExecution:true,nativeInvocationAttested:false,provider:'uvtools',providerManifestSha256:f.hollow.providerManifest.sha256,providerVerification:{before:true,after:true},implementation:f.captureImplementation,executable:f.hollow.providerManifest.providers.uvtools.executable,version:'7.1.2',cwd:options.cwd,argv:spec.argv,argumentDirectories:[],inputsBefore:[input],inputsAfter:[input],mutationsBefore:[],outputsAfter:[],stdout:{bytes:Buffer.byteLength(stdout),sha256:hash(stdout)},stderr:{bytes:0,sha256:hash('')},resourceReceipt:structuredClone(f.resourceReceipt)};
      if(f.faults.badGuard)invocation.resourceReceipt.assignedAtCreation=false;
      invocation.sha256=digest(invocation);if(!f.faults.unowned)owned.add(invocation);invocations.push(invocation);return{stdout,stderr,invocation};
    }};sessions.add(session);return session;
  }
};
const adapterPath=require.resolve('../src/slicing/resin-hollow-plate'),originalLoad=Module._load;
let adapter;
try{Module._load=function(request,parent,isMain){if(parent?.filename===adapterPath&&request==='./resin-hollow-engine')return engine;if(parent?.filename===adapterPath&&request==='./resin-controlled-capture')return capture;return originalLoad.call(this,request,parent,isMain);};delete require.cache[adapterPath];adapter=require(adapterPath);}finally{Module._load=originalLoad;delete require.cache[adapterPath];}

async function fixture(t,{mirrorX=false,mirrorY=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'quickprint-hollow-plate-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await createPlateSliceFixture(root);
  const profilePath=path.join(root,'resin-profile.json'),profile=JSON.parse(await fs.readFile(profilePath));profile.expected.mirrorX=mirrorX;profile.expected.mirrorY=mirrorY;await fs.writeFile(profilePath,JSON.stringify(profile));
  const presetPath=profile.presetPath,preset=(await fs.readFile(presetPath,'utf8')).replace(/display_mirror_x=[01]/,`display_mirror_x=${+mirrorX}`).replace(/display_mirror_y=[01]/,`display_mirror_y=${+mirrorY}`);await fs.writeFile(presetPath,preset);
  const loaded=await loadProfile(profilePath),prepared=prepareResinGeometry(MODEL,{format:'stl',units:'mm',sizing:{mode:'original'}}),refDir=path.join(root,'reference');await fs.mkdir(refDir);
  const descriptors=[];async function put(name,bytes){const filePath=path.join(refDir,name);await fs.writeFile(filePath,bytes);const item={filePath,bytes:bytes.length,sha256:hash(bytes)};descriptors.push(item);return item;}
  const source=await put('source.stl',MODEL),inputGeometry=await put('normalized.stl',prepared.stl),originalJson=await put('profile.json',await fs.readFile(profilePath)),baselinePreset=await put('preset.ini',loaded.preset);
  const placement={x:18.125,y:8.125,z:0},goo=gooForInstances({placements:[placement],dimensions:{x:3,y:3,z:3},profile:loaded.profile,ini:loaded.ini});
  const artifact=await put('reference.goo',goo),input3mf=await put('source.3mf',Buffer.from('test native boundary input')),sl1=await put('reference.sl1',Buffer.from('test native boundary sla'));
  const captureImplementation={method:'test-only-capture',files:[{name:'test-boundary',bytes:1,sha256:'a'.repeat(64)}]},resourceReceipt={schemaVersion:1,method:'windows-job-object-v1',processId:123,parentWasInJob:false,assignedAtCreation:true,assignedBeforeResume:true,killOnJobClose:true,descendantsTerminatedOnCompletion:true,limitFlags:0x2300,stopReason:null,outputLimitExceeded:false,processCommitLimitBytes:1024**3,jobCommitLimitBytes:1024**3,peakProcessCommitBytes:1000000,peakJobCommitBytes:1000000,elapsedMs:100,memoryAccounting:'committed-virtual-memory-not-rss',memoryLimitObserved:false,memoryLimitMessages:[],memoryNotificationsGuaranteed:false,peakCommitObservation:'after-root-exit-before-job-close',peakJobAccounting:'high-water-may-include-denied-commit-attempts',managedEnvironment:{DOTNET_PROCESSOR_COUNT:'1'},supervisorManifest:{files:[{name:'test-boundary-supervisor',bytes:1,sha256:'b'.repeat(64)}]}};resourceReceipt.supervisorManifest.sha256=hash(JSON.stringify(resourceReceipt.supervisorManifest.files));
  const hollow={schemaVersion:1,source,inputGeometry,profile:{originalJson,baselinePreset},profileSha256:loaded.profileSha256,inputs:{hollowPlan:{request:{orientation:{x:0,y:0,z:0}}},placement},roles:{final:{artifact,input3mf,sl1,inspection:inspectGoo(goo),analysis:parseIssueReport('Issues: 0')}},providerManifest:{sha256:'c'.repeat(64),providers:{prusa:{executable:path.join(root,'Prusa.exe'),version:'2.9.7',files:[{sha256:'d'.repeat(64)}]},uvtools:{executable:path.join(root,'UVtoolsCmd.exe'),version:'7.1.2',files:[{sha256:'e'.repeat(64)}]}}},tool:{name:'test boundary',version:'test',executableSha256:'7'.repeat(64),binaryManifest:[{name:'test-provider',bytes:1,sha256:'8'.repeat(64)}]},invocations:[{implementation:captureImplementation,resourceReceipt}],sizingPlan:prepared.plan};hollow.sha256=digest(hollow);
  const f={root,loaded,hollow,prepared,descriptors,captureImplementation,resourceReceipt,bindingHash:hash(root),heavy:0,light:0,factories:0,closed:0,calls:[],faults:{}};contexts.set(hollow.sha256,f);t.after(()=>contexts.delete(hollow.sha256));
  f.options={source:MODEL,hollowPreparation:hollow,profile:loaded.profile,ini:loaded.ini,preset:loaded.preset,requested:{copies:3,gapMm:1,marginMm:1},directory:root};
  f.prepare=()=>adapter.prepareResinHollowPlate(f.options);
  f.verify=async(result,record=result.platePreparation,extra={})=>adapter.verifyResinHollowPlatePreparation(MODEL,record,{hollowPreparation:hollow,profile:loaded.profile,ini:loaded.ini,preset:loaded.preset,artifactBytes:await fs.readFile(result.filePath),directory:root,referenceCapability:result.hollowReferenceCapability,...extra});
  f.persist=async record=>{record.preparationSha256=digest(without(record,'preparationSha256'));await fs.writeFile(record.recordPath,JSON.stringify(record,null,2));};return f;
}

test('opaque reference capability requires fixed heavy audit and rejects serialized or stale substitutes',async t=>{
  const f=await fixture(t);f.faults.held=true;await assert.rejects(f.prepare(),{code:'TEST_HEAVY_HELD'});assert.equal(f.factories,0);f.faults.held=false;
  const capability=await adapter.verifyResinHollowPlateReference(f.hollow,{source:MODEL,directory:f.root});assert.deepEqual(Object.keys(capability),[]);assert.equal(f.heavy,1);
  for(const fake of [{},JSON.parse(JSON.stringify(capability)),Object.create(capability)])await assert.rejects(adapter.prepareResinHollowPlate({...f.options,referenceCapability:fake}),{code:'RESIN_HOLLOW_PLATE_REFERENCE_REQUIRED'});
  f.faults.bindingChanged=true;await assert.rejects(adapter.prepareResinHollowPlate({...f.options,referenceCapability:capability}),{code:'RESIN_HOLLOW_PLATE_REFERENCE_CHANGED'});assert.equal(f.factories,0);
});

test('caller conformance flags and fake captures cannot bypass actual controlled native entry',async t=>{
  const f=await fixture(t);for(const capture of [{invoke:async()=>({stdout:'Issues: 0'})},null,{}])await assert.rejects(adapter.prepareResinHollowPlate({...f.options,capture}),{code:'RESIN_HOLLOW_PLATE_CAPTURE_REQUIRED'});
  await assert.rejects(adapter.prepareResinHollowPlate({...f.options,inspectAnalyze:async()=>({passed:true})}),{code:'RESIN_HOLLOW_PLATE_INPUT'});assert.equal(f.factories,0);assert.equal(f.heavy,0);
  await assert.rejects(adapter.prepareResinHollowPlate({...f.options,requested:{copies:0,gapMm:1,marginMm:1}}),{code:'RESIN_PLATE_INVALID_REQUEST'});
});

test('exact repeated hollow unit captures actual count, stable tool, readonly analysis and full persisted replay',async t=>{
  const f=await fixture(t),result=await f.prepare(),record=result.platePreparation;
  assert.equal(result.modelCopiesPerRun,3);assert.equal(record.method,'controlled-hollow-reference-raster-replication-v1');assert.equal(record.engineSourceSha256,hash(MODEL));assert.equal(record.sourceSha256,f.prepared.transformedSha256);assert.equal(record.hollowPreparationSha256,f.hollow.sha256);assert.equal(record.rasterProof.totalForegroundPixels,record.rasterProof.referenceForegroundPixels*3);assert.equal(result.printReady,false);assert.equal(result.printerCompatible,false);assert.equal(record.productionEligible,false);assert.equal(record.nativeInvocationAttested,false);
  assert.equal(f.heavy,1);assert.equal(f.factories,1);assert.equal(f.closed,1);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].argv.slice(0,2),['--quiet','print-issues']);assert.equal(f.calls[0].argv[2],result.filePath);assert.deepEqual(f.calls[0].mutations,[]);assert.deepEqual(f.calls[0].outputs,[]);assert.equal(f.calls[0].inputs[0].expectedSha256,result.sha256);
  const replay=await f.verify(result,JSON.parse(JSON.stringify(record)));assert.equal(replay.modelCopiesPerRun,3);assert.equal(f.heavy,1,'opaque capability caches only prior heavy work');assert.ok(f.light>=4);assert.ok(Object.isFrozen(replay.layout));
  const second=await adapter.prepareResinHollowPlate({...f.options,requested:{copies:2,gapMm:1,marginMm:1},referenceCapability:result.hollowReferenceCapability});assert.equal(second.modelCopiesPerRun,2);assert.equal(second.tool.executableSha256,result.tool.executableSha256,'per-order recipe/artifact/count never changes tool qualification fingerprint');
  await f.verify(result,record,{referenceCapability:undefined});assert.equal(f.heavy,2,'restart without private capability reruns fixed heavy audit');
});

test('all mirror policies survive JSON restart with exact pixel-union proof',async t=>{
  for(const [mirrorX,mirrorY]of[[false,false],[false,true],[true,false],[true,true]])await t.test(`${mirrorX}/${mirrorY}`,async child=>{const f=await fixture(child,{mirrorX,mirrorY}),result=await f.prepare();assert.deepEqual(result.platePreparation,JSON.parse(JSON.stringify(result.platePreparation)));const replay=await f.verify(result);assert.equal(replay.rasterProof.imageEquivalent,true);assert.equal(replay.modelCopiesPerRun,3);});
});

test('analysis issues, missing actual invocation brand and invalid process receipts hold capture and close session',async t=>{
  for(const [fault,code]of[['issues','RESIN_HOLLOW_PLATE_NATIVE_ISSUES'],['unowned','RESIN_HOLLOW_PLATE_CAPTURE_REQUIRED'],['badGuard','RESIN_HOLLOW_PLATE_EXECUTION_CHANGED'],['mutateArtifact','RESIN_HOLLOW_PLATE_CHANGED']])await t.test(fault,async child=>{const f=await fixture(child);f.faults[fault]=true;await assert.rejects(f.prepare(),{code});assert.equal(f.calls.length,1);assert.equal(f.closed,1);});
});

test('rehashing metadata cannot change quantity, recipe, native command, guard or preview pixels',async t=>{
  const cases=[['count',record=>{record.requested.copies=2;}],['recipe',record=>{record.hollowPreparation.inputs.placement.x+=.625;}],['command',record=>{record.analysisCapture.invocation.argv.push('--bogus');record.analysisCapture.invocation.sha256=digest(without(record.analysisCapture.invocation,'sha256'));}],['guard',record=>{record.analysisCapture.invocation.resourceReceipt.killOnJobClose=false;record.analysisCapture.invocation.sha256=digest(without(record.analysisCapture.invocation,'sha256'));}],['report',record=>{record.analysisCapture.stdout='Issues: 1\nIsland';}],['tool',record=>{record.tool.executableSha256='0'.repeat(64);}]];
  for(const[label,mutate]of cases)await t.test(label,async child=>{const f=await fixture(child),result=await f.prepare(),record=structuredClone(result.platePreparation);mutate(record);await f.persist(record);await assert.rejects(f.verify(result,record));});
  const f=await fixture(t),result=await f.prepare(),bytes=await fs.readFile(result.filePath);bytes[194]^=1;await fs.writeFile(result.filePath,bytes);const record=structuredClone(result.platePreparation);record.artifact.sha256=hash(bytes);record.artifactSha256=hash(bytes);await f.persist(record);await assert.rejects(f.verify(result,record),{code:'RESIN_HOLLOW_PLATE_CHANGED'});
});

test('current original/normalized source, profile, artifact and managed record scope are rechecked',async t=>{
  const f=await fixture(t),result=await f.prepare();
  await assert.rejects(adapter.verifyResinHollowPlatePreparation(Buffer.from('different'),result.platePreparation,{hollowPreparation:f.hollow,profile:f.loaded.profile,ini:f.loaded.ini,preset:f.loaded.preset,artifactBytes:await fs.readFile(result.filePath),directory:f.root,referenceCapability:result.hollowReferenceCapability}),{code:'RESIN_HOLLOW_PLATE_REFERENCE_REQUIRED'});
  await assert.rejects(f.verify(result,result.platePreparation,{profile:{...f.loaded.profile,material:'different'}}),{code:'RESIN_HOLLOW_PLATE_PROFILE_CHANGED'});
  const changed=structuredClone(result.platePreparation);changed.recordPath=path.join(path.dirname(f.root),'unrelated.json');changed.preparationSha256=digest(without(changed,'preparationSha256'));await assert.rejects(f.verify(result,changed),{code:'RESIN_HOLLOW_PLATE_PATH'});
  await fs.appendFile(f.hollow.inputGeometry.filePath,'changed');await assert.rejects(f.verify(result),{code:'TEST_REFERENCE_CHANGED'});
});

test('aborted and shared buffers fail before native capture',async t=>{
  const f=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(adapter.prepareResinHollowPlate({...f.options,signal:controller.signal}),{code:'ABORTED'});await assert.rejects(adapter.prepareResinHollowPlate({...f.options,source:Buffer.from(new SharedArrayBuffer(16))}),{code:'RESIN_HOLLOW_PLATE_INPUT'});assert.equal(f.factories,0);
});

test('resealed native guard accounting and broad ancestor cwd remain invalid replay evidence',async t=>{
  const cases=[
    ['supervisor digest',record=>{record.analysisCapture.invocation.resourceReceipt.supervisorManifest.sha256='0'.repeat(64);}],
    ['observed memory stop',record=>{record.analysisCapture.invocation.resourceReceipt.memoryLimitObserved=true;record.analysisCapture.invocation.resourceReceipt.memoryLimitMessages=[9];}],
    ['unbounded memory accounting',record=>{record.analysisCapture.invocation.resourceReceipt.memoryAccounting='rss';}],
    ['tree bound below process',record=>{record.analysisCapture.invocation.resourceReceipt.jobCommitLimitBytes=512*1024**2;}],
    ['ancestor cwd',record=>{record.captureDirectory=path.dirname(path.dirname(record.captureDirectory));record.analysisCapture.invocation.cwd=record.captureDirectory;}]
  ];
  for(const[label,mutate]of cases)await t.test(label,async child=>{const f=await fixture(child),result=await f.prepare(),record=structuredClone(result.platePreparation);mutate(record);record.analysisCapture.invocation.sha256=digest(without(record.analysisCapture.invocation,'sha256'));await f.persist(record);await assert.rejects(f.verify(result,record),{code:label==='ancestor cwd'?'RESIN_HOLLOW_PLATE_PATH':'RESIN_HOLLOW_PLATE_EXECUTION_CHANGED'});});
});

test('an opaque shared session is accepted only at the exact managed parent and remains owned by its caller',async t=>{
  const f=await fixture(t),session=await capture.createControlledNativeCapture({cwd:f.root});
  const result=await adapter.prepareResinHollowPlate({...f.options,capture:session});assert.equal(result.platePreparation.captureDirectory,f.root);assert.equal(f.factories,1);assert.equal(f.closed,0);assert.equal(capture.isControlledNativeCapture(session),true);await f.verify(result);await session.close();assert.equal(f.closed,1);
});
