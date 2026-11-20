'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {EventEmitter,getEventListeners}=require('node:events');
const workerThreads=require('node:worker_threads');
const {auditResinHollowGrid}=require('../src/slicing/resin-hollow-grid');
const {auditResinHollowGridAsync,resolveHollowGridWorkerPath}=require('../src/slicing/resin-hollow-grid-async');

function fixture(){
  const frame={nx:21,ny:21,nz:21,pitchMm:{x:.25,y:.25,z:.25},originMm:{x:-.5,y:-.5,z:-.5},direction:{x:1,y:1,z:1}},n=21**3,solid=new Uint8Array(n),hollow=new Uint8Array(n),at=(x,y,z)=>z*441+y*21+x;
  for(let z=2;z<=18;z++)for(let y=2;y<=18;y++)for(let x=2;x<=18;x++)solid[at(x,y,z)]=255;
  hollow.set(solid);for(let z=5;z<=15;z++)for(let y=5;y<=15;y++)for(let x=5;x<=15;x++)hollow[at(x,y,z)]=0;
  const drains=[1.125,3.125].map((x,i)=>({id:'drain-'+i,startMm:{x,y:2.125,z:-1},direction:{x:0,y:0,z:1},radiusMm:.75,lengthMm:3}));
  for(let z=0;z<21;z++)for(let y=0;y<21;y++)for(let x=0;x<21;x++){const p={x:-.5+(x+.5)*.25,y:-.5+(y+.5)*.25,z:-.5+(z+.5)*.25};if(drains.some(d=>(p.x-d.startMm.x)**2+(p.y-d.startMm.y)**2<=d.radiusMm**2&&p.z>=-1&&p.z<=2))hollow[at(x,y,z)]=0;}
  return{solid:{lower:solid,upper:solid},hollow:{lower:hollow,upper:hollow},frame,wallThicknessMm:.75,uncertaintyMm:Math.sqrt(3)*.25,drains};
}
function arrays(input){return[input.solid.lower,input.solid.upper,input.hollow.lower,input.hollow.upper];}

test('the real worker returns the identical frozen pure audit and transfers each aliased buffer only once',async()=>{
  const input=fixture(),expected=auditResinHollowGrid(input),controller=new AbortController();input.signal=controller.signal;const backing=[...new Set(arrays(input).map(a=>a.buffer))];
  const pending=auditResinHollowGridAsync(input);for(const buffer of backing)assert.equal(buffer.byteLength,0,'valid input ownership must transfer without copying');
  const result=await pending;assert.deepEqual(result,expected);assert.equal(result.disposition,'conforming');assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.drains[0]));assert.deepEqual(JSON.parse(JSON.stringify(result)),result);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('owned subviews transfer the whole backing store and all aliases as documented',async()=>{
  const input=fixture(),n=input.solid.lower.length,backing=new ArrayBuffer(n+8),view=new Uint8Array(backing,4,n);view.set(input.solid.lower);input.solid={lower:view,upper:view};const alias=new Uint8Array(backing),expected=auditResinHollowGrid(input);
  const result=await auditResinHollowGridAsync(input);assert.deepEqual(result,expected);assert.equal(backing.byteLength,0);assert.equal(alias.byteLength,0);assert.equal(view.byteLength,0);
});

test('explicit boundary and processed-exterior policies are preserved through the worker without fallback',async()=>{
  const input=fixture();input.boundaryPolicy='voxel-enclosure';input.exteriorSeedPolicy='processed-source-exterior';
  const n=input.solid.lower.length;input.solid={lower:input.solid.lower.slice(),upper:input.solid.upper.slice()};input.hollow={lower:input.hollow.lower.slice(),upper:input.hollow.upper.slice()};
  const at=14*441+4*21+2;input.solid.lower[at]=input.solid.upper[at]=128;input.hollow.lower[at]=input.hollow.upper[at]=129;
  const expected=auditResinHollowGrid(input),result=await auditResinHollowGridAsync(input);
  assert.equal(n,21**3);assert.deepEqual(result,expected);assert.equal(result.disposition,'conforming');assert.equal(result.boundaryPolicy,'voxel-enclosure');assert.equal(result.exteriorSeedPolicy,'processed-source-exterior');assert.equal(result.boundaryEnclosure.counts.changedOuterBandWithinBoundaryBand,1);assert.ok(arrays(input).every(a=>a.byteLength===0));
});

test('shape, nonshared ownership, limits and memory failures reject before detaching any input',async()=>{
  for(const mutate of[
    i=>{i.frame.nx=1.5;},i=>{i.frame.direction.z=-1;},i=>{i.solid.lower=new Uint8Array(1);},
    i=>{i.solid.lower=new Uint8Array(new SharedArrayBuffer(i.solid.lower.length));},i=>{i.drains[0].direction.z=.9;},i=>{i.drains[1].id=i.drains[0].id;},
    i=>{i.limits={maxWorkingBytes:1000};},i=>{i.limits={maxVoxels:100};},i=>{i.limits={constructor:1};},i=>{i.unexpected=true;},i=>{i.boundaryPolicy='automatic';},i=>{i.boundaryPolicy=null;},i=>{i.exteriorSeedPolicy='final';},i=>{i.exteriorSeedPolicy=null;},
  ]){const input=fixture();mutate(input);const buffers=arrays(input).map(a=>a.buffer),sizes=buffers.map(b=>b.byteLength);await assert.rejects(auditResinHollowGridAsync(input));assert.deepEqual(buffers.map(b=>b.byteLength),sizes);}
  const input=fixture(),expected=auditResinHollowGrid(input);input.limits={maxWorkingBytes:expected.resources.conservativeVisiblePeakBytes-1};await assert.rejects(auditResinHollowGridAsync(input),{code:'RESIN_HOLLOW_GRID_MEMORY'});assert.ok(arrays(input).every(a=>a.byteLength>0));
  const marked=fixture();workerThreads.markAsUntransferable(marked.solid.lower.buffer);await assert.rejects(auditResinHollowGridAsync(marked),{code:'RESIN_HOLLOW_GRID_TRANSFER'});assert.ok(arrays(marked).every(a=>a.byteLength>0));
});

test('worker-side interval and source-halo validation errors preserve stable code and status',async()=>{
  const invalid=fixture();invalid.solid={lower:invalid.solid.lower.slice(),upper:invalid.solid.upper.slice()};invalid.solid.lower[0]=255;
  await assert.rejects(auditResinHollowGridAsync(invalid),{code:'RESIN_HOLLOW_GRID_INTERVAL',status:400});assert.ok(arrays(invalid).every(a=>a.byteLength===0));
  const halo=fixture();halo.solid.upper[0]=255;await assert.rejects(auditResinHollowGridAsync(halo),{code:'RESIN_HOLLOW_GRID_HALO',status:400});
  const budget=fixture();budget.limits={maxOperations:100};await assert.rejects(auditResinHollowGridAsync(budget),{code:'RESIN_HOLLOW_GRID_OPERATIONS',status:413});
});

test('already cancelled input stays owned by the caller and a parent timeout closes its worker',async()=>{
  const input=fixture(),controller=new AbortController();controller.abort();input.signal=controller.signal;await assert.rejects(auditResinHollowGridAsync(input),{code:'RESIN_HOLLOW_GRID_ABORTED',status:499});assert.ok(arrays(input).every(a=>a.byteLength>0));assert.equal(getEventListeners(controller.signal,'abort').length,0);
  const timed=fixture(),active=new AbortController();timed.signal=active.signal;timed.limits={maxTimeMs:1};await assert.rejects(auditResinHollowGridAsync(timed),{code:'RESIN_HOLLOW_GRID_TIMEOUT',status:413});assert.equal(getEventListeners(active.signal,'abort').length,0);assert.ok(arrays(timed).every(a=>a.byteLength===0));
});

test('an external timer cancels a large active audit promptly while the parent heartbeat keeps running',async()=>{
  const input=fixture(),n=131**3,controller=new AbortController();input.frame={...input.frame,nx:131,ny:131,nz:131};input.solid={lower:new Uint8Array(n),upper:new Uint8Array(n)};input.hollow={lower:new Uint8Array(n),upper:new Uint8Array(n)};input.signal=controller.signal;input.boundaryPolicy='voxel-enclosure';input.exteriorSeedPolicy='processed-source-exterior';
  let beats=0;const heartbeat=setInterval(()=>{beats++;},5),cancel=setTimeout(()=>controller.abort(),100),started=performance.now();
  try{await assert.rejects(auditResinHollowGridAsync(input),{code:'RESIN_HOLLOW_GRID_ABORTED',status:499});assert.ok(performance.now()-started<1500);assert.ok(beats>=2,'CPU work must not block parent timers');assert.equal(getEventListeners(controller.signal,'abort').length,0);}finally{clearInterval(heartbeat);clearTimeout(cancel);}
});

test('source and app.asar paths resolve the managed worker adjacent to the matching unpacked auditor',()=>{
  const actual=resolveHollowGridWorkerPath();assert.ok(fs.statSync(actual).isFile());assert.ok(fs.statSync(path.join(path.dirname(actual),'resin-hollow-grid.js')).isFile());
  const resources=path.resolve('owned-fixture-resources'),moduleDirectory=path.join(resources,'app.asar','src','slicing');assert.equal(resolveHollowGridWorkerPath({moduleDirectory,resourcesPath:resources}),path.join(resources,'app.asar.unpacked','src','slicing','resin-hollow-grid-worker.js'));
  const backup=path.join(resources,'app.asar.backup','src','slicing');assert.equal(resolveHollowGridWorkerPath({moduleDirectory:backup}),path.join(backup,'resin-hollow-grid-worker.js'));
  assert.throws(()=>resolveHollowGridWorkerPath({moduleDirectory,resourcesPath:''}),{code:'RESIN_HOLLOW_GRID_WORKER_UNAVAILABLE'});
});

test('unexpected exit, worker error and malformed message all await termination and remove lifecycle listeners',async()=>{
  const filename=require.resolve('../src/slicing/resin-hollow-grid-async'),saved=require.cache[filename],OriginalWorker=workerThreads.Worker;
  for(const mode of['exit','error','message','cyclic-message','wrong-policy']){
    let instance;
    class FakeWorker extends EventEmitter{
      constructor(workerPath,options){super();instance=this;this.options=options;this.terminated=0;queueMicrotask(()=>{if(mode==='cyclic-message'||mode==='wrong-policy'){const result={schemaVersion:1,method:'bounded-reference-raster-grid-audit-v1',disposition:'conforming',boundaryPolicy:mode==='wrong-policy'?'voxel-enclosure':'exact-raster',exteriorSeedPolicy:'source-exterior',geometricWallCertification:false,physicalDrainageCertification:false};if(mode==='cyclic-message')result.cycle=result;this.emit('message',{ok:true,result});}else this.emit(mode,mode==='message'?{ok:true,result:{}}:mode==='error'?new Error('fixture worker failed'):0);});}
      async terminate(){this.terminated++;return 0;}
    }
    let injected;
    try{workerThreads.Worker=FakeWorker;delete require.cache[filename];injected=require(filename);}finally{workerThreads.Worker=OriginalWorker;delete require.cache[filename];require.cache[filename]=saved;}
    const controller=new AbortController(),input=fixture();input.signal=controller.signal;await assert.rejects(injected.auditResinHollowGridAsync(input),{code:mode==='exit'?'RESIN_HOLLOW_GRID_WORKER_EXIT':'RESIN_HOLLOW_GRID_WORKER_FAILED'});
    assert.equal(instance.terminated,1);assert.deepEqual(instance.eventNames(),[]);assert.equal(getEventListeners(controller.signal,'abort').length,0);assert.equal(instance.options.resourceLimits.maxOldGenerationSizeMb,128);assert.equal(instance.options.transferList.length,2);assert.equal(Object.hasOwn(instance.options.workerData,'signal'),false);
  }
});
