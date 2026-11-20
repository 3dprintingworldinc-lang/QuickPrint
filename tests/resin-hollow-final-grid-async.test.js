'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {EventEmitter,getEventListeners}=require('node:events'),threads=require('node:worker_threads');
const {auditResinHollowFinalGrid}=require('../src/slicing/resin-hollow-final-grid');
const {auditResinHollowFinalGridAsync,resolveHollowFinalGridWorkerPath}=require('../src/slicing/resin-hollow-final-grid-async');
function fixture(){
  const frame={nx:25,ny:25,nz:37,pitchMm:{x:.25,y:.25,z:.25},originMm:{x:-.5,y:-.5,z:-.5},direction:{x:1,y:1,z:1}},n=25*25*37,solid=new Uint8Array(n),at=(x,y,z)=>(z*25+y)*25+x;
  for(let z=12;z<=28;z++)for(let y=4;y<=20;y++)for(let x=4;x<=20;x++)solid[at(x,y,z)]=255;
  const body=solid.slice();for(let z=15;z<=25;z++)for(let y=7;y<=17;y++)for(let x=7;x<=17;x++)body[at(x,y,z)]=0;
  const drains=[1.625,3.625].map((x,i)=>({id:'drain-'+i,startMm:{x,y:2.625,z:1.5},direction:{x:0,y:0,z:1},radiusMm:.75,lengthMm:3}));
  for(let z=0;z<37;z++)for(let y=0;y<25;y++)for(let x=0;x<25;x++){const p={x:-.5+(x+.5)*.25,y:-.5+(y+.5)*.25,z:-.5+(z+.5)*.25};if(drains.some(d=>(p.x-d.startMm.x)**2+(p.y-d.startMm.y)**2<=d.radiusMm**2&&p.z>=1.5&&p.z<=4.5))body[at(x,y,z)]=0;}
  const final=body.slice();for(let z=2;z<=3;z++)for(let y=3;y<=21;y++)for(let x=3;x<=21;x++)final[at(x,y,z)]=255;for(let z=4;z<=11;z++)final[at(12,5,z)]=255;
  return{solidBody:{lower:solid,upper:solid.slice()},hollowBody:{lower:body,upper:body.slice()},final:{lower:final,upper:final.slice()},frame,wallThicknessMm:.75,uncertaintyMm:Math.sqrt(3)*.25,drains,supportEnvelope:{minMm:{x:0,y:0,z:0},maxMm:{x:5,y:5,z:2.5}},supportRegions:[{id:'pad',minMm:{x:.25,y:.25,z:0},maxMm:{x:5,y:5,z:.5}},{id:'post',minMm:{x:2.5,y:.75,z:.5},maxMm:{x:2.75,y:1,z:2.5}}]};
}
const arrays=input=>['solidBody','hollowBody','final'].flatMap(key=>[input[key].lower,input[key].upper]);
test('real final worker equals the pure supported audit and takes all six owned buffers',async()=>{
  const input=fixture(),expected=auditResinHollowFinalGrid(input),controller=new AbortController();input.signal=controller.signal;
  const buffers=arrays(input).map(a=>a.buffer),pending=auditResinHollowFinalGridAsync(input);assert.ok(buffers.every(buffer=>buffer.byteLength===0));
  const result=await pending;assert.deepEqual(result,expected);assert.equal(result.disposition,'conforming');assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.supportRegions[0]));assert.equal(result.productionEligible,false);assert.equal(result.bodyReferencePrecondition.callerMustVerifyConforming,true);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});
test('aliased and subview buffers transfer once with their complete backing ownership',async()=>{
  const input=fixture();for(const key of['solidBody','hollowBody','final'])input[key].upper=input[key].lower;
  const n=input.final.lower.length,backing=new ArrayBuffer(n+12),view=new Uint8Array(backing,6,n);view.set(input.final.lower);input.final={lower:view,upper:view};const alias=new Uint8Array(backing),expected=auditResinHollowFinalGrid(input);
  assert.deepEqual(await auditResinHollowFinalGridAsync(input),expected);assert.equal(alias.byteLength,0);assert.equal(backing.byteLength,0);
});
test('support-region and boundary policy are explicit and never inferred or replaced',async()=>{
  const input=fixture();input.boundaryPolicy='voxel-enclosure';const expected=auditResinHollowFinalGrid(input),actual=await auditResinHollowFinalGridAsync(input);assert.deepEqual(actual,expected);assert.equal(actual.supportRegions.length,2);
  const none=fixture();delete none.supportRegions;const result=await auditResinHollowFinalGridAsync(none);assert.deepEqual(result.supportRegions,[]);assert.equal(result.disposition,'nonconforming');assert.ok(result.counts.outsideAuthorizedSupportRegions>0);
});
test('shape, transfer, support metadata and cumulative six-buffer limits reject before detaching',async()=>{
  for(const change of[
    i=>{i.final.lower=new Uint8Array(1);},i=>{i.hollowBody.upper=new Uint8Array(new SharedArrayBuffer(i.hollowBody.upper.length));},
    i=>{i.frame.nz=1.2;},i=>{i.frame.direction.z=-1;},i=>{i.limits={maxVoxels:100};},i=>{i.limits={maxWorkingBytes:1000};},i=>{i.limits={constructor:1};},
    i=>{i.supportRegions[1].id=i.supportRegions[0].id;},i=>{i.supportRegions=new Array(2);},i=>{i.supportEnvelope.maxMm.x=0;},i=>{i.supportRegions[0].maxMm.z=0;},
    i=>{i.drains=new Array(2);},i=>{i.drains[0].direction.z=.5;},i=>{i.drains[1].id=i.drains[0].id;},i=>{i.boundaryPolicy='fallback';},i=>{i.exteriorSeedPolicy='source-exterior';},
  ]){const input=fixture();change(input);const buffers=arrays(input).map(a=>a.buffer),sizes=buffers.map(b=>b.byteLength);await assert.rejects(auditResinHollowFinalGridAsync(input));assert.deepEqual(buffers.map(b=>b.byteLength),sizes);}
  const input=fixture(),expected=auditResinHollowFinalGrid(input);input.limits={maxWorkingBytes:expected.resources.conservativeVisiblePeakBytes-1};await assert.rejects(auditResinHollowFinalGridAsync(input),{code:'RESIN_HOLLOW_FINAL_MEMORY'});assert.ok(arrays(input).every(a=>a.byteLength>0));
  const marked=fixture();threads.markAsUntransferable(marked.final.lower.buffer);await assert.rejects(auditResinHollowFinalGridAsync(marked),{code:'RESIN_HOLLOW_FINAL_TRANSFER'});assert.ok(arrays(marked).every(a=>a.byteLength>0));
});
test('worker-side interval, halo and operation-budget failures retain stable typed errors',async()=>{
  const interval=fixture();interval.final.lower[0]=255;await assert.rejects(auditResinHollowFinalGridAsync(interval),{code:'RESIN_HOLLOW_FINAL_INTERVAL',status:400});assert.ok(arrays(interval).every(a=>a.byteLength===0));
  const halo=fixture();halo.solidBody.lower[0]=halo.solidBody.upper[0]=255;await assert.rejects(auditResinHollowFinalGridAsync(halo),{code:'RESIN_HOLLOW_FINAL_HALO',status:400});
  const budget=fixture();budget.limits={maxOperations:100};await assert.rejects(auditResinHollowFinalGridAsync(budget),{code:'RESIN_HOLLOW_FINAL_OPERATIONS',status:413});
});
test('already aborted inputs retain ownership and parent timeout closes the active final worker',async()=>{
  const input=fixture(),controller=new AbortController();controller.abort();input.signal=controller.signal;await assert.rejects(auditResinHollowFinalGridAsync(input),{code:'RESIN_HOLLOW_FINAL_ABORTED',status:499});assert.ok(arrays(input).every(a=>a.byteLength>0));
  const timed=fixture(),active=new AbortController();timed.signal=active.signal;timed.limits={maxTimeMs:1};await assert.rejects(auditResinHollowFinalGridAsync(timed),{code:'RESIN_HOLLOW_FINAL_TIMEOUT',status:413});assert.equal(getEventListeners(active.signal,'abort').length,0);
});
test('a large six-buffer final audit leaves parent heartbeat and external cancellation responsive',async()=>{
  const input=fixture(),n=131**3,controller=new AbortController();input.frame={...input.frame,nx:131,ny:131,nz:131};for(const key of['solidBody','hollowBody','final'])input[key]={lower:new Uint8Array(n),upper:new Uint8Array(n)};input.signal=controller.signal;
  let beats=0;const heartbeat=setInterval(()=>beats++,5),cancel=setTimeout(()=>controller.abort(),100),start=performance.now();
  try{await assert.rejects(auditResinHollowFinalGridAsync(input),{code:'RESIN_HOLLOW_FINAL_ABORTED'});assert.ok(performance.now()-start<1500);assert.ok(beats>=2);assert.equal(getEventListeners(controller.signal,'abort').length,0);}finally{clearInterval(heartbeat);clearTimeout(cancel);}
});
test('ASAR worker resolution selects the unpacked final and base auditors',()=>{
  const worker=resolveHollowFinalGridWorkerPath();for(const name of[path.basename(worker),'resin-hollow-final-grid.js','resin-hollow-grid.js'])assert.ok(fs.statSync(path.join(path.dirname(worker),name)).isFile());
  const resources=path.resolve('owned-final-resources'),moduleDirectory=path.join(resources,'app.asar','src','slicing');assert.equal(resolveHollowFinalGridWorkerPath({moduleDirectory,resourcesPath:resources}),path.join(resources,'app.asar.unpacked','src','slicing','resin-hollow-final-grid-worker.js'));
  assert.throws(()=>resolveHollowFinalGridWorkerPath({moduleDirectory,resourcesPath:''}),{code:'RESIN_HOLLOW_FINAL_WORKER_UNAVAILABLE'});
});
test('unexpected worker lifecycle, malformed receipt and changed support policy fail after awaited cleanup',async()=>{
  const filename=require.resolve('../src/slicing/resin-hollow-final-grid-async'),saved=require.cache[filename],Original=threads.Worker;
  for(const mode of['exit','error','message','cycle','wrong-regions']){
    let instance;class FakeWorker extends EventEmitter{constructor(file,options){super();instance=this;this.options=options;this.terminated=0;queueMicrotask(()=>{if(['cycle','wrong-regions'].includes(mode)){const result=auditResinHollowFinalGrid(options.workerData);const changed=structuredClone(result);if(mode==='cycle')changed.cycle=changed;else changed.supportRegions=[];this.emit('message',{ok:true,result:changed});}else this.emit(mode,mode==='message'?{ok:true,result:{}}:mode==='error'?new Error('owned worker failure'):0);});}async terminate(){await new Promise(r=>setTimeout(r,1));this.terminated++;return 0;}}
    let injected;try{threads.Worker=FakeWorker;delete require.cache[filename];injected=require(filename);}finally{threads.Worker=Original;delete require.cache[filename];require.cache[filename]=saved;}
    const input=fixture(),controller=new AbortController();input.signal=controller.signal;await assert.rejects(injected.auditResinHollowFinalGridAsync(input),{code:mode==='exit'?'RESIN_HOLLOW_FINAL_WORKER_EXIT':'RESIN_HOLLOW_FINAL_WORKER_FAILED'});assert.equal(instance.terminated,1);assert.deepEqual(instance.eventNames(),[]);assert.equal(instance.options.transferList.length,6);assert.equal(Object.hasOwn(instance.options.workerData,'signal'),false);assert.equal(getEventListeners(controller.signal,'abort').length,0);
  }
});
