'use strict';

// Independent, bounded V3.0 stream validation. No full file or image plane is
// retained; one reusable encoded-layer buffer supplies row-split grayscale runs.
const fs=require('node:fs/promises');
const { constants }=require('node:fs');
const path=require('node:path');
const { createHash }=require('node:crypto');
const { performance }=require('node:perf_hooks');
const { setImmediate:yieldImmediate }=require('node:timers/promises');

const HEADER=195477,DEFINITION=70,MAGIC=Buffer.from([7,0,0,0,68,76,80,0]),FOOTER=Buffer.from([0,0,0,7,0,0,0,68,76,80,0]);
const FIXED_BYTES=HEADER+DEFINITION+FOOTER.length+1;
const CAPS=Object.freeze({maxFileBytes:512*1024*1024,maxLayers:25000,maxPixelsPerLayer:100000000,maxLayerBytes:128*1024*1024,maxOperations:250000000,timeoutMs:60000,maxCells:20000000,maxWorkingBytes:192*1024*1024});
const plain=value => value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=(message,code='RESIN_HOLLOW_RASTER_INVALID',status=400) => Object.assign(new Error(message),{code,status});
const exact=(value,keys) => plain(value) && Reflect.ownKeys(value).length===keys.length && Reflect.ownKeys(value).every(key => keys.includes(key));
function configuration(options,allowed) {
  if(!plain(options)||Reflect.ownKeys(options).some(key=>!allowed.includes(key)))throw fail('Unsupported raster options.','RESIN_HOLLOW_RASTER_OPTIONS');
  if(options.signal!==undefined && !(options.signal instanceof AbortSignal))throw fail('Use an AbortSignal for cancellation.','RESIN_HOLLOW_RASTER_OPTIONS');
  const limits={...CAPS};
  if(options.limits!==undefined){if(!plain(options.limits)||Reflect.ownKeys(options.limits).some(key=>typeof key!=='string'||!Object.hasOwn(CAPS,key)))throw fail('Unsupported raster limits.','RESIN_HOLLOW_RASTER_OPTIONS');for(const[key,value]of Object.entries(options.limits)){if(!Number.isSafeInteger(value)||value<1||value>CAPS[key])throw fail('Raster limits may only lower positive hard bounds.','RESIN_HOLLOW_RASTER_OPTIONS');limits[key]=value;}}
  if(limits.maxWorkingBytes<FIXED_BYTES+5)throw fail('Raster working-memory limit cannot hold the fixed header and one image.','RESIN_HOLLOW_RASTER_LIMIT',413);
  return limits;
}
function budget(limits,signal){const start=performance.now();let operations=0,lastYield=0;return{step(count=1){operations+=count;if(!Number.isSafeInteger(operations)||operations>limits.maxOperations)throw fail('Raster work exceeds its operation budget.','RESIN_HOLLOW_RASTER_LIMIT',413);if(!(operations&1023)||count>1)this.check();},check(){signal?.throwIfAborted();if(performance.now()-start>limits.timeoutMs)throw fail('Raster validation exceeded its time budget.','RESIN_HOLLOW_RASTER_TIMEOUT',413);},needsYield:()=>operations-lastYield>=32768,async yield(){lastYield=operations;await yieldImmediate();this.check();},stats:()=>({operations,elapsedMs:performance.now()-start})};}
function invoke(callback,value){if(!callback)return;const result=callback(value);if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw fail('Raster callbacks must be synchronous.','RESIN_HOLLOW_RASTER_CALLBACK');}}
const stable=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);

function headerMetadata(buffer,limits,fileBytes){
  if(buffer.toString('ascii',0,4)!=='V3.0')throw fail('Only GOO V3.0 is supported.');
  if(!buffer.subarray(4,12).equals(MAGIC))throw fail('GOO header magic is invalid.');
  let at=12;
  const text=length=>{const bytes=buffer.subarray(at,at+length);at+=length;const zero=bytes.indexOf(0);let value;try{value=new TextDecoder('utf-8',{fatal:true}).decode(zero<0?bytes:bytes.subarray(0,zero));}catch{throw fail('GOO text is not valid UTF-8.');}if(/[\u0000-\u001f\u007f]/.test(value))throw fail('GOO text contains control characters.');return value.trim();};
  const u8=()=>buffer[at++],u16=()=>{const v=buffer.readUInt16BE(at);at+=2;return v;},u32=()=>{const v=buffer.readUInt32BE(at);at+=4;return v;};
  const num=(label,max,min=0)=>{const v=buffer.readFloatBE(at);at+=4;if(!Number.isFinite(v)||v<min||v>max)throw fail(`GOO ${label} is outside its numeric bounds.`);return v;};
  const flag=label=>{const v=u8();if(v>1)throw fail(`GOO ${label} flag is invalid.`);return Boolean(v);};
  const crlf=label=>{if(u16()!==0x0d0a)throw fail(`GOO ${label} delimiter is invalid.`);};
  const software=text(32),softwareVersion=text(24),createdAt=text(24),machineName=text(32),machineType=text(32),profileName=text(32);
  const antiAliasingLevel=u16(),greyLevel=u16(),blurLevel=u16();at+=116*116*2;crlf('small preview');at+=290*290*2;crlf('large preview');
  const layerCount=u32(),resolutionX=u16(),resolutionY=u16(),pixelsPerLayer=resolutionX*resolutionY;
  if(!layerCount||layerCount>limits.maxLayers||!resolutionX||!resolutionY||pixelsPerLayer>limits.maxPixelsPerLayer)throw fail('GOO layers or resolution exceed the configured bounds.','RESIN_HOLLOW_RASTER_LIMIT',413);
  const mirrorX=flag('X mirror'),mirrorY=flag('Y mirror'),displayWidthMm=num('display width',10000,.001),displayHeightMm=num('display height',10000,.001),machineZMm=num('machine height',10000,.001),layerHeightMm=num('layer height',10,.0001),exposureTimeSeconds=num('exposure time',3600);
  const delayMode=u8();if(delayMode>1)throw fail('GOO delay mode is invalid.');
  const timing={};for(const key of ['lightOffSeconds','bottomWaitBeforeLiftSeconds','bottomWaitAfterLiftSeconds','bottomWaitAfterRetractSeconds','waitBeforeLiftSeconds','waitAfterLiftSeconds','waitAfterRetractSeconds'])timing[key]=num(key,3600);
  const bottomExposureTimeSeconds=num('bottom exposure',3600),bottomLayerCount=u32();if(bottomLayerCount>layerCount)throw fail('GOO bottom-layer count exceeds its layers.');
  const motion={};for(const key of ['bottomLiftDistanceMm','bottomLiftSpeedMmPerMin','liftDistanceMm','liftSpeedMmPerMin','bottomRetractDistanceMm','bottomRetractSpeedMmPerMin','retractDistanceMm','retractSpeedMmPerMin','bottomLiftDistance2Mm','bottomLiftSpeed2MmPerMin','liftDistance2Mm','liftSpeed2MmPerMin','bottomRetractDistance2Mm','bottomRetractSpeed2MmPerMin','retractDistance2Mm','retractSpeed2MmPerMin'])motion[key]=num(key,key.includes('Speed')?100000:machineZMm);
  const bottomLightPwm=u16(),lightPwm=u16();if(bottomLightPwm>255||lightPwm>255)throw fail('GOO light PWM exceeds 255.');
  const perLayerSettings=flag('per-layer settings'),printTimeSeconds=u32(),volumeMm3=num('volume',1e12),materialGrams=num('weight',1e10),materialCost=num('cost',1e10),priceUnit=text(8),layerContentOffset=u32(),grayscaleLevel=u8(),transitionLayerCount=u16();
  if(at!==HEADER||layerContentOffset!==HEADER)throw fail('GOO layer-content offset is invalid.');
  if(grayscaleLevel>1)throw fail('GOO grayscale encoding is unsupported.');
  if(transitionLayerCount>layerCount)throw fail('GOO transition-layer count exceeds its layers.');
  if(HEADER+layerCount*(DEFINITION+5)+FOOTER.length>fileBytes)throw fail('GOO file cannot contain its declared layers.');
  return{format:'goo',version:'V3.0',layerCount,resolutionX,resolutionY,displayWidthMm,displayHeightMm,machineZMm,layerHeightMm,mirrorX,mirrorY,machineName,exposureTimeSeconds,bottomExposureTimeSeconds,bottomLayerCount,transitionLayerCount,software,softwareVersion,createdAt,machineType,profileName,antiAliasingLevel,greyLevel,blurLevel,grayscaleBits:grayscaleLevel===0?4:8,delayMode,timing,motion,bottomLightPwm,lightPwm,perLayerSettings,printTimeSeconds,volumeMm3,materialGrams,materialCost,priceUnit,pixelsPerLayer};
}

function layerDefinition(buffer,index,metadata,previousZ,limits){
  let at=0;const num=(label,max)=>{const v=buffer.readFloatBE(at);at+=4;if(!Number.isFinite(v)||v<0||v>max)throw fail(`GOO layer ${index+1} ${label} is invalid.`);return v;};
  if(buffer.readUInt16BE(at)>1)throw fail('GOO layer pause flag is invalid.');at+=2;num('pause height',metadata.machineZMm);const zMm=num('position',metadata.machineZMm+.001);if(zMm<=previousZ)throw fail('GOO layer positions must increase.');
  const exposure=num('exposure',3600);for(let i=0;i<4;i++)num('delay',3600);for(let i=0;i<8;i++)num('motion',i%2?100000:metadata.machineZMm);
  if(buffer.readUInt16BE(at)>255)throw fail('GOO layer light PWM exceeds 255.');at+=2;if(buffer.readUInt16BE(at)!==0x0d0a)throw fail('GOO layer definition delimiter is invalid.');at+=2;
  const length=buffer.readUInt32BE(at);if(length<3||length>limits.maxLayerBytes)throw fail('GOO encoded-layer payload exceeds its bounds.','RESIN_HOLLOW_RASTER_LIMIT',413);
  return{zMm,exposure,length};
}

async function scan(filePath,options,limits,initialize){
  if(typeof filePath!=='string'||filePath.length>4000||/[\0\r\n]/.test(filePath)||!path.isAbsolute(filePath))throw fail('Choose an absolute regular GOO file.','RESIN_HOLLOW_RASTER_OPTIONS');
  for(const key of ['onRun','onLayer'])if(options[key]!==undefined&&typeof options[key]!=='function')throw fail('Raster callbacks must be functions.','RESIN_HOLLOW_RASTER_OPTIONS');
  const work=budget(limits,options.signal);work.check();
  const initial=await fs.lstat(filePath,{bigint:true});
  if(!initial.isFile()||initial.isSymbolicLink())throw fail('GOO input must be a regular file without a symbolic link.','RESIN_HOLLOW_RASTER_FILE');
  if(initial.size>BigInt(limits.maxFileBytes))throw fail('GOO file exceeds its byte bound.','RESIN_HOLLOW_RASTER_LIMIT',413);
  const fileBytes=Number(initial.size);if(fileBytes<HEADER+DEFINITION+5+FOOTER.length)throw fail('GOO file is truncated.');
  const resolved=await fs.realpath(filePath),handle=await fs.open(filePath,constants.O_RDONLY|(constants.O_NOFOLLOW||0));let position=0;
  const digest=createHash('sha256'),definitions=createHash('sha256');
  try{
    if(!stable(initial,await handle.stat({bigint:true})))throw fail('GOO file changed while opening it.','RESIN_HOLLOW_RASTER_CHANGED',409);
    const read=async(buffer,length,label)=>{work.check();if(position+length>fileBytes)throw fail(`Truncated GOO ${label}.`);let filled=0;while(filled<length){work.check();const result=await handle.read(buffer,filled,length-filled,position+filled);if(!result.bytesRead)throw fail(`Short GOO ${label} read.`);filled+=result.bytesRead;}position+=length;digest.update(buffer.subarray(0,length));work.check();};
    const header=Buffer.alloc(HEADER),definition=Buffer.alloc(DEFINITION),tail=Buffer.alloc(FOOTER.length+1);
    await read(header,HEADER,'header');const base=headerMetadata(header,limits,fileBytes);
    const payloadBufferBytes=Math.min(limits.maxLayerBytes+2,fileBytes-HEADER-DEFINITION-FOOTER.length);
    const preflight=extra=>{if(!Number.isSafeInteger(extra)||extra<0||FIXED_BYTES+payloadBufferBytes+extra>limits.maxWorkingBytes)throw fail('Raster buffers and grid exceed the working-memory bound.','RESIN_HOLLOW_RASTER_LIMIT',413);};
    preflight(0);const hooks=initialize?await initialize(base,{preflight,payloadBufferBytes,fixedOwnedBytes:FIXED_BYTES},work):{};
    const extraOwnedBytes=hooks.extraOwnedBytes||0;preflight(extraOwnedBytes);const payload=Buffer.alloc(payloadBufferBytes);
    const onRun=hooks.onRun||options.onRun,onLayer=hooks.onLayer||options.onLayer,positions=[];
    let previousZ=0,nonemptyLayerCount=0,totalExposedPixels=0,totalRuns=0,rowRuns=0,foregroundIntensity=0,maxPayload=0,minExposureSeconds=Infinity,maxExposureSeconds=0,minX=Infinity,minY=Infinity,maxX=0,maxY=0;
    for(let layer=0;layer<base.layerCount;layer++){
      work.check();await read(definition,DEFINITION,'layer definition');const fields=layerDefinition(definition,layer,base,previousZ,limits);previousZ=fields.zMm;positions.push(fields.zMm);minExposureSeconds=Math.min(minExposureSeconds,fields.exposure);maxExposureSeconds=Math.max(maxExposureSeconds,fields.exposure);definitions.update(definition.subarray(0,66));
      if(onLayer){work.step();const owned=Buffer.alloc(66);definition.copy(owned,0,0,66);invoke(onLayer,{index:layer,zMm:fields.zMm,definition:owned});}
      if(fields.length+2>payload.length)throw fail('GOO layer cannot fit the declared file.');
      await read(payload,fields.length+2,'layer image');maxPayload=Math.max(maxPayload,fields.length);
      if(payload[0]!==0x55||payload[fields.length]!==13||payload[fields.length+1]!==10)throw fail('GOO image marker or delimiter is invalid.');
      let cursor=1,checksum=0,pixels=0,color=0,exposed=0;const checksumAt=fields.length-1,maximum=base.grayscaleBits===4?15:255;
      const byte=()=>{work.step();if(cursor>=checksumAt)throw fail('GOO RLE token is truncated.');const value=payload[cursor++];checksum=(checksum+value)&255;return value;};
      while(cursor<checksumAt){
        const token=byte(),type=token>>>6;let count;
        if(type===2){color+=(token&32?-1:1)*(token&15);count=token&16?byte():1;}
        else{color=type===0?0:type===3?maximum:byte();let upper=0;for(let n=(token>>>4)&3;n>0;n--)upper=upper*256+byte();count=upper*16+(token&15);}
        if(color<0||color>maximum||!count||count>base.pixelsPerLayer-pixels)throw fail('GOO RLE color or pixel count is invalid.');
        totalRuns++;let current=pixels,left=count;const gray=base.grayscaleBits===4?color*17:color;
        if(gray){exposed+=count;foregroundIntensity+=count*gray;}
        while(left){
          work.step();const row=Math.floor(current/base.resolutionX),start=current%base.resolutionX,length=Math.min(left,base.resolutionX-start),end=start+length;rowRuns++;
          if(gray){minX=Math.min(minX,start);maxX=Math.max(maxX,end);minY=Math.min(minY,row);maxY=Math.max(maxY,row+1);}
          invoke(onRun,{layer,row,start,end,color:gray});current+=length;left-=length;
          if(work.needsYield())await work.yield();
        }
        pixels+=count;if(work.needsYield())await work.yield();
      }
      if(pixels!==base.pixelsPerLayer||payload[checksumAt]!==((checksum^255)&255))throw fail('GOO image checksum or decoded pixel count is invalid.');
      if(exposed)nonemptyLayerCount++;totalExposedPixels+=exposed;
    }
    await read(tail,FOOTER.length,'footer');if(!tail.subarray(0,FOOTER.length).equals(FOOTER)||position!==fileBytes)throw fail('GOO footer or trailing-byte count is invalid.');
    const eof=await handle.read(tail,0,1,position);if(eof.bytesRead)throw fail('GOO grew after its declared end.','RESIN_HOLLOW_RASTER_CHANGED',409);
    let afterPath;try{afterPath=await fs.lstat(filePath,{bigint:true});}catch{throw fail('GOO path changed during scanning.','RESIN_HOLLOW_RASTER_CHANGED',409);}
    if(afterPath.isSymbolicLink()||!afterPath.isFile()||!stable(initial,afterPath)||!stable(initial,await handle.stat({bigint:true}))||await fs.realpath(filePath)!==resolved)throw fail('GOO identity, size or timestamps changed during scanning.','RESIN_HOLLOW_RASTER_CHANGED',409);
    work.check();const sha256=digest.digest('hex');
    const metadata={...base,totalHeightMm:previousZ,minExposureSeconds,maxExposureSeconds,nonemptyLayerCount,totalExposedPixels,totalRuns,sha256,validatedLayerData:true,printerCompatible:false,qualification:'Structural validation does not establish resin calibration, image orientation, support quality, firmware compatibility, or physical print success.'};
    return{metadata,boundsPx:totalExposedPixels?{x:minX,y:minY,width:maxX-minX,height:maxY-minY}:null,layerPositionsMm:positions,definitionsSha256:definitions.digest('hex'),sha256,stats:{...work.stats(),fileBytes,bytesRead:position,encodedRuns:totalRuns,rowRuns,totalForegroundIntensity:foregroundIntensity,maxLayerPayloadBytes:maxPayload,payloadBufferBytes,gridBytes:extraOwnedBytes,ownedWorkingBytes:FIXED_BYTES+payloadBufferBytes+extraOwnedBytes,workingByteAccounting:'fixed byte buffers + one reused encoded payload buffer + grid typed arrays; JavaScript metadata/runtime and callback-retained allocations excluded',fullFileAllocated:false,fullPixelPlaneAllocated:false,callbackRetainedAllocationsExcluded:true}};
  }finally{await handle.close();}
}

async function scanResinGooFile(filePath,options={}){const limits=configuration(options,['onRun','onLayer','limits','signal']);return scan(filePath,options,limits);}

function gridPolicy(options){
  if(typeof options.expectedSha256!=='string'||!/^[a-f0-9]{64}$/.test(options.expectedSha256)||!exact(options.crop,['x','y','width','height'])||!exact(options.reduction,['x','y','z']))throw fail('A grid needs an expected file hash, explicit crop and reduction factors.','RESIN_HOLLOW_RASTER_OPTIONS');
  const crop={...options.crop},reduction={...options.reduction};
  for(const key of ['x','y'])if(!Number.isSafeInteger(crop[key])||Math.abs(crop[key])>0x7fffffff)throw fail('Crop origins must be bounded integer pixel indices.','RESIN_HOLLOW_RASTER_OPTIONS');
  for(const key of ['width','height'])if(!Number.isSafeInteger(crop[key])||crop[key]<1||crop[key]>0x7fffffff)throw fail('Crop extents must be positive bounded integers.','RESIN_HOLLOW_RASTER_OPTIONS');
  for(const value of Object.values(reduction))if(!Number.isSafeInteger(value)||value<1||value>0x7fffffff)throw fail('Reduction factors must be positive bounded integers.','RESIN_HOLLOW_RASTER_OPTIONS');
  return{crop,reduction};
}

async function buildResinHollowGrid(filePath,options={}){
  const limits=configuration(options,['expectedSha256','crop','reduction','limits','signal']),{crop,reduction}=gridPolicy(options);let grid;
  const result=await scan(filePath,{signal:options.signal},limits,async(metadata,memory,work)=>{
    const interiorDimensions={x:Math.ceil(crop.width/reduction.x),y:Math.ceil(crop.height/reduction.y),z:Math.ceil(metadata.layerCount/reduction.z)},dimensions=Object.fromEntries(Object.entries(interiorDimensions).map(([key,value])=>[key,value+2]));
    const cells=dimensions.x*dimensions.y*dimensions.z;if(!Number.isSafeInteger(cells)||cells>limits.maxCells)throw fail('Interval grid exceeds its cell bound.','RESIN_HOLLOW_RASTER_LIMIT',413);
    const gridBytes=cells*2;memory.preflight(gridBytes);const lower=new Uint8Array(cells),upper=new Uint8Array(cells),nx=dimensions.x,ny=dimensions.y;
    for(let z=0;z<interiorDimensions.z;z++)for(let y=0;y<interiorDimensions.y;y++)for(let x=0;x<interiorDimensions.x;x++){
      work.step();const startX=crop.x+x*reduction.x,startY=crop.y+y*reduction.y;
      if(startX>=0&&startY>=0&&startX+reduction.x<=metadata.resolutionX&&startY+reduction.y<=metadata.resolutionY&&(x+1)*reduction.x<=crop.width&&(y+1)*reduction.y<=crop.height&&(z+1)*reduction.z<=metadata.layerCount)lower[((z+1)*ny+y+1)*nx+x+1]=255;
      if(work.needsYield())await work.yield();
    }
    grid={lower,upper,frame:{crop,reduction,dimensions,interiorDimensions,halo:1,indexOrder:'x-fastest-y-z',pixelIndexOrigin:{x:crop.x-reduction.x,y:crop.y-reduction.y,z:-reduction.z},sourceDimensions:{x:metadata.resolutionX,y:metadata.resolutionY,z:metadata.layerCount}},foregroundOutsideCropPixels:0,foregroundOutsideCropIntensity:0};
    return{extraOwnedBytes:gridBytes,onRun({layer,row,start,end,color}){
      const withinY=row>=crop.y&&row<crop.y+crop.height,a=Math.max(start,crop.x),b=Math.min(end,crop.x+crop.width),overlap=withinY?Math.max(0,b-a):0;
      if(color){const outside=end-start-overlap;grid.foregroundOutsideCropPixels+=outside;grid.foregroundOutsideCropIntensity+=outside*color;}
      if(!withinY||b<=a)return;
      const y=Math.floor((row-crop.y)/reduction.y)+1,z=Math.floor(layer/reduction.z)+1,first=Math.floor((a-crop.x)/reduction.x),last=Math.floor((b-1-crop.x)/reduction.x);
      const begin=(z*ny+y)*nx+first+1,endIndex=(z*ny+y)*nx+last+2;
      // Extremal colors only affect one bound. Bulk typed-array writes avoid
      // revisiting every coarse cell in each dominant black/white source row.
      if(color===0){work.step();lower.fill(0,begin,endIndex);return;}
      if(color===255){work.step();upper.fill(255,begin,endIndex);return;}
      for(let x=first;x<=last;x++){work.step();const index=(z*ny+y)*nx+x+1;lower[index]=Math.min(lower[index],color);upper[index]=Math.max(upper[index],color);}
    }};
  });
  if(result.sha256!==options.expectedSha256)throw fail('GOO bytes do not match the bound artifact hash.','RESIN_HOLLOW_RASTER_CHANGED',409);
  return{schemaVersion:1,...result,...grid};
}

module.exports={scanResinGooFile,buildResinHollowGrid,RESIN_HOLLOW_RASTER_LIMITS:CAPS};
