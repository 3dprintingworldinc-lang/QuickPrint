'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker,isMarkedAsUntransferable } = require('node:worker_threads');
const { RESIN_HOLLOW_GRID_LIMITS:CAPS } = require('./resin-hollow-grid');

const AXES=['x','y','z'];
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=(message,code='RESIN_HOLLOW_GRID_INPUT',status=400)=>Object.assign(new Error(message),{code,status});
const aborted=()=>fail('The hollow raster audit was cancelled.','RESIN_HOLLOW_GRID_ABORTED',499);
function exact(value,keys,label){if(!plain(value)||Reflect.ownKeys(value).length!==keys.length||Reflect.ownKeys(value).some(key=>!keys.includes(key)))throw fail(`${label} has unsupported or missing fields.`);}
function finite(value,minimum,maximum){if(typeof value!=='number'||!Number.isFinite(value)||value<minimum||value>maximum)throw fail('Grid coordinates or dimensions are outside the supported finite range.');return value===0?0:value;}
function vector(value,minimum,maximum){exact(value,AXES,'Vector');return Object.fromEntries(AXES.map(axis=>[axis,finite(value[axis],minimum,maximum)]));}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

function resolveHollowGridWorkerPath({moduleDirectory=__dirname,resourcesPath=process.resourcesPath}={}){
  if(typeof moduleDirectory!=='string'||!path.isAbsolute(moduleDirectory))throw fail('The grid worker module directory is unavailable.','RESIN_HOLLOW_GRID_WORKER_UNAVAILABLE',500);
  if(moduleDirectory.replace(/\\/g,'/').split('/').some(segment=>segment.toLowerCase()==='app.asar')){
    if(typeof resourcesPath!=='string'||!path.isAbsolute(resourcesPath))throw fail('The unpacked grid worker resource directory is unavailable.','RESIN_HOLLOW_GRID_WORKER_UNAVAILABLE',500);
    return path.join(resourcesPath,'app.asar.unpacked','src','slicing','resin-hollow-grid-worker.js');
  }
  return path.join(moduleDirectory,'resin-hollow-grid-worker.js');
}

// Validate metadata, ownership/transfer eligibility, dimensions and the complete
// array-memory estimate before transferring anything. Per-cell interval/halo
// validation stays in the worker so large grids never block the parent loop.
// Keep this allocation estimate aligned with the pure auditor; tests bind it.
function transferInput(input){
  if(!plain(input)||Reflect.ownKeys(input).some(key=>!['solid','hollow','frame','wallThicknessMm','uncertaintyMm','drains','boundaryPolicy','exteriorSeedPolicy','limits','signal'].includes(key)))throw fail('Supply only the declared raster grid audit fields.');
  const boundaryPolicy=input.boundaryPolicy===undefined?'exact-raster':input.boundaryPolicy,exteriorSeedPolicy=input.exteriorSeedPolicy===undefined?'source-exterior':input.exteriorSeedPolicy;
  if(!['exact-raster','voxel-enclosure'].includes(boundaryPolicy)||!['source-exterior','processed-source-exterior'].includes(exteriorSeedPolicy))throw fail('Choose explicit supported raster boundary and drain exterior policies.');
  const signal=input.signal;
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw fail('Use a native AbortSignal.');
  if(signal?.aborted)throw aborted();
  let limits={...CAPS,maxTimeMs:60000};
  if(input.limits!==undefined){if(!plain(input.limits)||Reflect.ownKeys(input.limits).some(key=>!Object.hasOwn(CAPS,key)))throw fail('Grid limits contain an unsupported key.','RESIN_HOLLOW_GRID_LIMITS');for(const[key,value]of Object.entries(input.limits))if(!Number.isSafeInteger(value)||value<1||value>CAPS[key])throw fail('Grid limits may only lower positive whole-number hard bounds.','RESIN_HOLLOW_GRID_LIMITS');limits={...limits,...input.limits};}
  exact(input.frame,['nx','ny','nz','pitchMm','originMm','direction'],'Grid frame');
  const frame={nx:input.frame.nx,ny:input.frame.ny,nz:input.frame.nz,pitchMm:vector(input.frame.pitchMm,1e-9,10000),originMm:vector(input.frame.originMm,-1000000,1000000),direction:vector(input.frame.direction,-1,1)};
  for(const key of['nx','ny','nz'])if(!Number.isSafeInteger(frame[key])||frame[key]<3||frame[key]>limits.maxAxisLength)throw fail('Grid dimensions require bounded whole numbers and an exterior halo.','RESIN_HOLLOW_GRID_DIMENSIONS');
  if(![1,-1].includes(frame.direction.x)||![1,-1].includes(frame.direction.y)||frame.direction.z!==1)throw fail('Grid X/Y directions must be ±1 and Z must increase.');
  const count=frame.nx*frame.ny*frame.nz;
  if(!Number.isSafeInteger(count)||count>limits.maxVoxels)throw fail('The grid exceeds its voxel bound.','RESIN_HOLLOW_GRID_VOXELS',413);
  for(const axis of AXES)if(frame.pitchMm[axis]*frame['n'+axis]>1000000)throw fail('The grid physical extent is unsupported.');
  const wallThicknessMm=finite(input.wallThicknessMm,1e-9,10000),uncertaintyMm=finite(input.uncertaintyMm,0,10000),buffers=new Set();
  const interval=value=>{exact(value,['lower','upper'],'Raster intervals');const result={};for(const key of['lower','upper']){const array=value[key];if(!(array instanceof Uint8Array)||array.length!==count||array.byteLength!==count||!(array.buffer instanceof ArrayBuffer))throw fail('Each interval must be a nonshared Uint8Array matching the complete grid.','RESIN_HOLLOW_GRID_ARRAY');if(typeof isMarkedAsUntransferable!=='function'||isMarkedAsUntransferable(array.buffer))throw fail('Supply owned, transferable raster ArrayBuffers.','RESIN_HOLLOW_GRID_TRANSFER',400);buffers.add(array.buffer);result[key]=array;}return result;};
  const solid=interval(input.solid),hollow=interval(input.hollow);
  if(!Array.isArray(input.drains)||!input.drains.length||input.drains.length>limits.maxDrains)throw fail('Provide a bounded nonempty list of explicit drain cylinders.','RESIN_HOLLOW_GRID_DRAINS');
  const ids=new Set(),drains=input.drains.map(drain=>{exact(drain,['id','startMm','direction','radiusMm','lengthMm'],'Drain');if(typeof drain.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(drain.id)||ids.has(drain.id))throw fail('Drain identifiers must be unique bounded ASCII strings.','RESIN_HOLLOW_GRID_DRAINS');ids.add(drain.id);const startMm=vector(drain.startMm,-1000000,1000000),direction=vector(drain.direction,-1,1);if(Math.abs(Math.hypot(direction.x,direction.y,direction.z)-1)>1e-12)throw fail('Drain directions must be explicit unit vectors.','RESIN_HOLLOW_GRID_DRAINS');return{id:drain.id,startMm,direction,radiusMm:finite(drain.radiusMm,1e-9,10000),lengthMm:finite(drain.lengthMm,1e-9,1000000)};});
  const additional=count*25+Math.max(frame.nx,frame.ny,frame.nz)*20+8,backing=[...buffers].reduce((sum,buffer)=>sum+buffer.byteLength,0);
  if(!Number.isSafeInteger(additional)||Math.max(backing,count*4)+additional>limits.maxWorkingBytes)throw fail('The complete input and working arrays exceed the memory budget.','RESIN_HOLLOW_GRID_MEMORY',413);
  const workerPath=resolveHollowGridWorkerPath();
  try{if(!fs.statSync(workerPath).isFile()||!fs.statSync(path.join(path.dirname(workerPath),'resin-hollow-grid.js')).isFile())throw new Error('Missing resource');}catch{throw fail('The managed grid worker resources are missing.','RESIN_HOLLOW_GRID_WORKER_UNAVAILABLE',500);}
  if(signal?.aborted)throw aborted();
  return{signal,limits,workerPath,transferList:[...buffers],data:{solid,hollow,frame,wallThicknessMm,uncertaintyMm,drains,boundaryPolicy,exteriorSeedPolicy,limits}};
}

/**
 * Audit on a dedicated worker. On a valid schema this TAKES OWNERSHIP of every
 * distinct input ArrayBuffer and detaches it, including all aliases/subviews.
 * Callers must supply owned arrays and must not reuse them after this call.
 * Schema/preflight failures and already-aborted signals transfer nothing.
 */
async function auditResinHollowGridAsync(input){
  const {signal,limits,workerPath,transferList,data}=transferInput(input);
  return new Promise((resolve,reject)=>{
    let worker,timer,settled=false;
    const finish=async(error,result)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      let terminationError;
      try{if(worker)await worker.terminate();}catch{terminationError=fail('The grid worker could not be closed.','RESIN_HOLLOW_GRID_WORKER_FAILED',500);}
      finally{worker?.removeAllListeners();}
      if(error||terminationError)reject(error||terminationError);
      else{try{resolve(freeze(result));}catch{reject(fail('The grid worker result could not be finalized.','RESIN_HOLLOW_GRID_WORKER_FAILED',500));}}
    };
    const onAbort=()=>{void finish(aborted());};
    signal?.addEventListener('abort',onAbort,{once:true});
    if(signal?.aborted){void finish(aborted());return;}
    try{
      worker=new Worker(workerPath,{workerData:data,transferList,resourceLimits:{maxOldGenerationSizeMb:128},name:'quickprint-hollow-grid'});
      worker.once('message',message=>{
        if(message?.ok===true&&message.result?.schemaVersion===1&&message.result.method==='bounded-reference-raster-grid-audit-v1'&&message.result.boundaryPolicy===data.boundaryPolicy&&message.result.exteriorSeedPolicy===data.exteriorSeedPolicy&&['conforming','nonconforming','inconclusive'].includes(message.result.disposition)&&message.result.geometricWallCertification===false&&message.result.physicalDrainageCertification===false){void finish(null,message.result);return;}
        if(message?.ok===false&&typeof message.error?.message==='string'&&message.error.message.length<=2000&&typeof message.error.code==='string'&&/^[A-Z0-9_]{1,100}$/.test(message.error.code)&&Number.isSafeInteger(message.error.status)&&message.error.status>=400&&message.error.status<=599)void finish(fail(message.error.message,message.error.code,message.error.status));
        else void finish(fail('The grid worker returned an invalid result.','RESIN_HOLLOW_GRID_WORKER_FAILED',500));
      });
      worker.once('error',error=>{void finish(error?.code==='ERR_WORKER_OUT_OF_MEMORY'?fail('The grid worker exceeded its managed heap budget.','RESIN_HOLLOW_GRID_WORKER_MEMORY',413):fail('The grid worker failed.','RESIN_HOLLOW_GRID_WORKER_FAILED',500));});
      worker.once('exit',()=>{if(!settled)void finish(fail('The grid worker exited without a complete result.','RESIN_HOLLOW_GRID_WORKER_EXIT',500));});
      timer=setTimeout(()=>{void finish(fail('The hollow raster audit exceeded its deadline.','RESIN_HOLLOW_GRID_TIMEOUT',413));},limits.maxTimeMs);timer.unref?.();
    }catch{void finish(fail('The managed grid worker could not be started.','RESIN_HOLLOW_GRID_WORKER_UNAVAILABLE',500));}
  });
}

module.exports={auditResinHollowGridAsync,resolveHollowGridWorkerPath};
