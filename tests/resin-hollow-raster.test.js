'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const sync=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { createHash }=require('node:crypto');
const { performance }=require('node:perf_hooks');
const { inspectGoo }=require('../src/slicing/goo');
const { scanResinGooFile,buildResinHollowGrid,RESIN_HOLLOW_RASTER_LIMITS }=require('../src/slicing/resin-hollow-raster');
const { goo }=require('./helpers/resin-slice');
const HEADER=195477,LAYER=70;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function image(tokens){return Buffer.from([0x55,...tokens,tokens.reduce((sum,value)=>(sum+value)&255,0)^255]);}
function token(color,count,maximum=255){const upper=[];let value=Math.floor(count/16);while(value){upper.unshift(value&255);value=Math.floor(value/256);}return[(color===0?0:color===maximum?0xc0:0x40)|(upper.length<<4)|(count&15),...(color!==0&&color!==maximum?[color]:[]),...upper];}
function encode(pixels,maximum){const result=[];for(let i=0;i<pixels.length;){let end=i+1;while(end<pixels.length&&pixels[end]===pixels[i])end++;result.push(...token(pixels[i],end-i,maximum));i=end;}return result;}
function fixture({width=4,height=2,planes,encoded,layers=2,bits=8}={}){
  const base=goo(),header=Buffer.from(base.subarray(0,HEADER));layers=planes?.length||encoded?.length||layers;
  header.writeUInt32BE(layers,195310);header.writeUInt16BE(width,195314);header.writeUInt16BE(height,195316);header[195474]=bits===4?0:1;
  const parts=[header];
  for(let i=0;i<layers;i++){const definition=Buffer.from(base.subarray(HEADER,HEADER+LAYER));definition.writeFloatBE((i+1)*.05,6);definition.writeFloatBE(i?2:20,10);const data=image(encoded?encoded[i]:planes?encode(planes[i],bits===4?15:255):token(bits===4?15:255,width*height,bits===4?15:255));definition.writeUInt32BE(data.length,66);parts.push(definition,data,Buffer.from([13,10]));}
  parts.push(Buffer.from([0,0,0,7,0,0,0,68,76,80,0]));return Buffer.concat(parts);
}
async function fileFixture(t,bytes=fixture()) {const root=await fs.mkdtemp(path.join(os.tmpdir(),'quickprint-hollow-raster-')),filePath=path.join(root,'source.goo');await fs.writeFile(filePath,bytes);t.after(()=>fs.rm(root,{recursive:true,force:true}));return{root,filePath,bytes,async write(value){await fs.writeFile(filePath,value);}};}
function definitionsHash(bytes){const digest=createHash('sha256');let at=HEADER;for(let i=0;i<bytes.readUInt32BE(195310);i++){digest.update(bytes.subarray(at,at+66));at+=LAYER+bytes.readUInt32BE(at+66)+2;}return digest.digest('hex');}

test('stream validation matches the independent existing GOO reader, complete SHA and physical definition hash',async t=>{
  const f=await fileFixture(t),runs=[],layers=[];
  const result=await scanResinGooFile(f.filePath,{onRun:run=>runs.push(run),onLayer:layer=>layers.push(layer)});
  assert.deepEqual(result.metadata,inspectGoo(f.bytes));assert.equal(result.sha256,hash(f.bytes));assert.equal(result.definitionsSha256,definitionsHash(f.bytes));
  assert.deepEqual(result.boundsPx,{x:0,y:0,width:4,height:2});assert.deepEqual(result.layerPositionsMm,[Math.fround(.05),Math.fround(.1)]);
  assert.equal(runs.length,4);assert.ok(runs.every(run=>run.start===0&&run.end===4&&run.color===255));assert.equal(layers.length,2);
  assert.equal(layers[0].definition.length,66);assert.equal(layers[0].definition.buffer.byteLength,66);assert.notEqual(layers[0].definition.buffer,layers[1].definition.buffer);
  assert.equal(result.stats.fullFileAllocated,false);assert.equal(result.stats.fullPixelPlaneAllocated,false);assert.equal(result.stats.bytesRead,f.bytes.length);
});

test('zero runs are reported, split at row boundaries, and four-bit delta grammar maps exactly to eight-bit gray',async t=>{
  const f=await fileFixture(t,fixture({bits:4,encoded:[[0x42,7,0x91,3,0xb2,3],[0x03,0xc2,0x03]]})),actual=[[],[]];
  const result=await scanResinGooFile(f.filePath,{onRun:run=>{assert.ok(run.start>=0&&run.end<=4);actual[run.layer].push(...Array(run.end-run.start).fill(run.color));}});
  assert.deepEqual(actual,[[119,119,136,136,136,102,102,102],[0,0,0,255,255,0,0,0]]);assert.deepEqual(result.metadata,inspectGoo(f.bytes));
  assert.equal(result.stats.totalForegroundIntensity,actual.flat().reduce((a,b)=>a+b,0));assert.equal(result.stats.rowRuns,8);
  const black=fixture({encoded:[[0x08],[0x18,0]]});await f.write(black);const rows=[];const empty=await scanResinGooFile(f.filePath,{onRun:r=>rows.push(r)});assert.equal(empty.boundsPx,null);assert.equal(empty.metadata.totalExposedPixels,0);assert.equal(rows.length,4);assert.ok(rows.every(r=>r.color===0));
});

test('layer callback owns its definition copy and cannot corrupt validation or other definitions',async t=>{
  const f=await fileFixture(t),seen=[];
  const result=await scanResinGooFile(f.filePath,{onLayer:layer=>{seen.push(layer.definition);new Uint8Array(layer.definition.buffer).fill(0);}});
  assert.equal(result.sha256,hash(f.bytes));assert.equal(result.definitionsSha256,definitionsHash(f.bytes));assert.ok(seen.every(buffer=>buffer.every(v=>v===0)));
});

test('16K layers stream from short encoded payloads without allocating a full pixel plane',async t=>{
  const bytes=fixture({width:15120,height:6230,layers:8});bytes.writeFloatBE(211.68,195320);bytes.writeFloatBE(118.37,195324);bytes.writeFloatBE(220,195328);
  const f=await fileFixture(t,bytes),result=await scanResinGooFile(f.filePath);
  assert.deepEqual(result.metadata,inspectGoo(bytes,{limits:{maxFileBytes:512*1024*1024,maxPixelsPerLayer:100000000,maxLayerBytes:128*1024*1024}}));
  assert.equal(result.metadata.totalExposedPixels,15120*6230*8);assert.equal(result.stats.rowRuns,6230*8);assert.ok(result.stats.ownedWorkingBytes<1024*1024);assert.ok(result.stats.payloadBufferBytes<10000);
  const grid=await buildResinHollowGrid(f.filePath,{expectedSha256:hash(bytes),crop:{x:0,y:0,width:15120,height:6230},reduction:{x:2048,y:1024,z:4}});
  assert.deepEqual(grid.frame.interiorDimensions,{x:8,y:7,z:2});assert.equal(grid.foregroundOutsideCropPixels,0);assert.equal(grid.stats.fullPixelPlaneAllocated,false);
});

test('long 16K binary spans aggregate under a bounded operation budget through exact bulk extrema updates',async t=>{
  const bytes=fixture({width:15120,height:6230,layers:128}),f=await fileFixture(t,bytes);
  const grid=await buildResinHollowGrid(f.filePath,{expectedSha256:hash(bytes),crop:{x:0,y:0,width:15120,height:6230},reduction:{x:32,y:32,z:32},limits:{maxOperations:5000000}});
  assert.equal(grid.metadata.layerCount,128);assert.equal(grid.metadata.totalExposedPixels,15120*6230*128);assert.ok(grid.stats.operations<5000000);assert.ok(grid.stats.ownedWorkingBytes<2*1024*1024);
  const {x:nx,y:ny}=grid.frame.dimensions;assert.equal(grid.lower[(ny+1)*nx+1],255);assert.equal(grid.upper[(ny+1)*nx+1],255);
});

test('interval aggregation equals a separate voxel oracle including zero pixels, out-of-screen crop, halo and partial XYZ blocks',async t=>{
  const planes=[[255,255,0,0,0,255,255,0,128,0,0,0,255,255,0],[255,255,0,255,0,255,255,0,255,0,0,0,255,255,0],[255,255,255,255,255,255,255,255,255,255,255,255,255,255,255]],crop={x:-1,y:0,width:7,height:4},reduction={x:2,y:2,z:2};
  const f=await fileFixture(t,fixture({width:5,height:3,planes})),grid=await buildResinHollowGrid(f.filePath,{expectedSha256:hash(f.bytes),crop,reduction}),{dimensions:d,interiorDimensions:n}=grid.frame;
  const lower=new Uint8Array(d.x*d.y*d.z),upper=new Uint8Array(lower.length);
  for(let z=0;z<n.z;z++)for(let y=0;y<n.y;y++)for(let x=0;x<n.x;x++){const pixels=[];for(let dz=0;dz<2;dz++)for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){const px=crop.x+x*2+dx,py=crop.y+y*2+dy,pz=z*2+dz;pixels.push(pz<3&&x*2+dx<crop.width&&y*2+dy<crop.height&&px>=0&&px<5&&py>=0&&py<3?planes[pz][py*5+px]:0);}const i=((z+1)*d.y+y+1)*d.x+x+1;lower[i]=Math.min(...pixels);upper[i]=Math.max(...pixels);}
  assert.deepEqual(grid.lower,lower);assert.deepEqual(grid.upper,upper);assert.deepEqual(grid.frame.pixelIndexOrigin,{x:-3,y:-2,z:-2});assert.equal(grid.foregroundOutsideCropPixels,0);
  assert.equal(grid.lower.buffer instanceof SharedArrayBuffer,false);assert.equal(grid.upper.buffer instanceof SharedArrayBuffer,false);
  assert.equal(grid.lower[((1*d.y)+1)*d.x+2],0,'partial screen edge includes known-zero positions');
});

test('a full-white coarse block has lower255 while gray/background and partial-edge blocks retain honest intervals',async t=>{
  const planes=[Array(15).fill(255),Array(15).fill(255),Array(15).fill(255)],f=await fileFixture(t,fixture({width:5,height:3,planes}));
  const grid=await buildResinHollowGrid(f.filePath,{expectedSha256:hash(f.bytes),crop:{x:0,y:0,width:5,height:3},reduction:{x:2,y:2,z:2}}),{x:nx,y:ny}=grid.frame.dimensions;
  assert.equal(grid.lower[(ny+1)*nx+1],255);assert.equal(grid.upper[(ny+1)*nx+1],255);assert.equal(grid.lower[(ny+1)*nx+3],0);assert.equal(grid.upper[(ny+1)*nx+3],255);
  assert.equal(grid.lower[(2*ny+1)*nx+1],0,'unrepresented final Z layer is zero');assert.equal(grid.upper[(2*ny+1)*nx+1],255);
});

test('all foreground excluded by crop is counted across layers rather than silently discarded',async t=>{
  const planes=[[0,255,0,128,0,255,0,255],[255,0,0,0,0,0,0,255]],f=await fileFixture(t,fixture({planes})),crop={x:1,y:0,width:2,height:1};
  const grid=await buildResinHollowGrid(f.filePath,{expectedSha256:hash(f.bytes),crop,reduction:{x:1,y:1,z:1}});
  const foreground=planes.flat().filter(v=>v>0),inside=[planes[0][1],planes[0][2],planes[1][1],planes[1][2]].filter(v=>v>0);
  assert.equal(grid.foregroundOutsideCropPixels,foreground.length-inside.length);assert.equal(grid.foregroundOutsideCropIntensity,foreground.reduce((a,b)=>a+b,0)-inside.reduce((a,b)=>a+b,0));
  await assert.rejects(buildResinHollowGrid(f.filePath,{expectedSha256:'0'.repeat(64),crop,reduction:{x:1,y:1,z:1}}),{code:'RESIN_HOLLOW_RASTER_CHANGED'});
});

test('all global float families and layer physical fields reject nonfinite values independently',async t=>{
  const f=await fileFixture(t),globalFloats=[195320,195324,195328,195332,195336,...Array.from({length:7},(_,i)=>195341+i*4),195369,...Array.from({length:16},(_,i)=>195377+i*4),195450,195454,195458];
  for(const at of globalFloats){const bytes=fixture();bytes.writeFloatBE(NaN,at);await f.write(bytes);await assert.rejects(scanResinGooFile(f.filePath),{code:'RESIN_HOLLOW_RASTER_INVALID'});}
  for(const at of [2,6,10,14,18,22,26,30,34,38,42,46,50,54,58]){const bytes=fixture();bytes.writeFloatBE(Infinity,HEADER+at);await f.write(bytes);await assert.rejects(scanResinGooFile(f.filePath),{code:'RESIN_HOLLOW_RASTER_INVALID'});}
  const wrongZ=fixture();wrongZ.writeFloatBE(.01,HEADER+75+6);await f.write(wrongZ);await assert.rejects(scanResinGooFile(f.filePath),/positions must increase/);
});

test('version, magic, flags, delimiters, offsets, footer and trailing bytes fail closed',async t=>{
  const f=await fileFixture(t);
  for(const mutate of [b=>b[0]^=1,b=>b[4]^=1,b=>b[27106]^=1,b=>b[195308]^=1,b=>b[195470]^=1,b=>b[195474]=2,b=>b[195318]=2,b=>b[195340]=2,b=>b[195445]=2,b=>b.writeUInt16BE(256,195441),b=>b.writeUInt16BE(256,HEADER+62),b=>b.writeUInt16BE(2,HEADER),b=>b[HEADER+64]^=1,b=>b[b.length-1]^=1]){const bytes=fixture();mutate(bytes);await f.write(bytes);await assert.rejects(scanResinGooFile(f.filePath));}
  await f.write(Buffer.concat([fixture(),Buffer.from([0])]));await assert.rejects(scanResinGooFile(f.filePath));
  await f.write(fixture().subarray(0,-20));await assert.rejects(scanResinGooFile(f.filePath));
});

test('RLE overflow, underrun, zero count, truncated tokens, checksum and four-bit overflow are independently rejected',async t=>{
  const f=await fileFixture(t);
  for(const tokens of [[0xc7],[0xc9],[0xc0],[0xd8],[0x42],[0x92],[0xc7,0x81]]){await f.write(fixture({encoded:[tokens,tokens]}));await assert.rejects(scanResinGooFile(f.filePath));}
  await f.write(fixture({bits:4,encoded:[[0x48,16],[0xc8]]}));await assert.rejects(scanResinGooFile(f.filePath));
  const checksum=fixture();checksum[HEADER+75+72]^=1;await f.write(checksum);await assert.rejects(scanResinGooFile(f.filePath),/checksum/);
});

test('source mutation, truncation and replacement through synchronous callbacks never return a verified SHA',async t=>{
  const f=await fileFixture(t);
  await assert.rejects(scanResinGooFile(f.filePath,{onLayer:({index})=>{if(index===0){const bytes=Buffer.from(f.bytes);bytes[12]^=1;sync.writeFileSync(f.filePath,bytes);sync.utimesSync(f.filePath,new Date(),new Date(Date.now()+2000));}}}),{code:'RESIN_HOLLOW_RASTER_CHANGED'});
  await f.write(f.bytes);await assert.rejects(scanResinGooFile(f.filePath,{onLayer:({index})=>{if(index===0)sync.truncateSync(f.filePath,HEADER+LAYER);}}));
  await f.write(f.bytes);await assert.rejects(scanResinGooFile(f.filePath,{onLayer:({index})=>{if(index===0){sync.renameSync(f.filePath,path.join(f.root,'old.goo'));sync.writeFileSync(f.filePath,f.bytes);}}}),{code:'RESIN_HOLLOW_RASTER_CHANGED'});
});

test('bounded reads tolerate nonterminal short reads but reject an unexpected zero-byte read',async t=>{
  const f=await fileFixture(t),original=fs.open;let calls=0,truncate=false;
  fs.open=async(...args)=>{const handle=await original(...args);return{stat:handle.stat.bind(handle),close:handle.close.bind(handle),read(buffer,offset,length,position){calls++;return truncate&&position>=HEADER+LAYER+1?Promise.resolve({bytesRead:0,buffer}):handle.read(buffer,offset,Math.min(length,1024),position);}};};
  try{assert.equal((await scanResinGooFile(f.filePath)).sha256,hash(f.bytes));assert.ok(calls>190);truncate=true;await assert.rejects(scanResinGooFile(f.filePath),/Short GOO/);}finally{fs.open=original;}
});

test('callbacks are sync-only, aborts preserve their reason and CPU deadline is checked',async t=>{
  const f=await fileFixture(t);await assert.rejects(scanResinGooFile(f.filePath,{onRun:async()=>{}}),{code:'RESIN_HOLLOW_RASTER_CALLBACK'});await assert.rejects(scanResinGooFile(f.filePath,{onLayer:()=>Promise.reject(new Error('owned asynchronous rejection'))}),{code:'RESIN_HOLLOW_RASTER_CALLBACK'});
  const controller=new AbortController(),reason=Object.assign(new Error('Owned abort'),{code:'OWNED_ABORT'});controller.abort(reason);await assert.rejects(scanResinGooFile(f.filePath,{signal:controller.signal}),{code:'OWNED_ABORT'});
  const during=new AbortController();await assert.rejects(scanResinGooFile(f.filePath,{signal:during.signal,onLayer:()=>during.abort(reason)}),{code:'OWNED_ABORT'});
  await assert.rejects(scanResinGooFile(f.filePath,{limits:{timeoutMs:1},onRun:()=>{const until=performance.now()+3;while(performance.now()<until){}}}),{code:'RESIN_HOLLOW_RASTER_TIMEOUT'});
});

test('long decoding yields to external cancellation instead of blocking until the final layer',async t=>{
  const plane=Array.from({length:10000},(_,i)=>i%2?128:0),f=await fileFixture(t,fixture({width:100,height:100,planes:Array.from({length:8},()=>plane)})),controller=new AbortController(),reason=Object.assign(new Error('External abort'),{code:'EXTERNAL_ABORT'});let callbacks=0,timer;
  await assert.rejects(scanResinGooFile(f.filePath,{signal:controller.signal,onRun:()=>{if(++callbacks===1)timer=setTimeout(()=>controller.abort(reason),0);}}),{code:'EXTERNAL_ABORT'});
  clearTimeout(timer);assert.ok(callbacks>0&&callbacks<80000);
});

test('small randomized interval grids match direct source-voxel aggregation across arbitrary crop/reduction boundaries',async t=>{
  const f=await fileFixture(t);let state=123456;
  const random=max=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%max;};
  for(let trial=0;trial<16;trial++){
    const width=1+random(7),height=1+random(5),depth=1+random(5),bits=trial%2?4:8,colors=bits===4?[0,3,7,15]:[0,17,128,255],raw=Array.from({length:depth},()=>Array.from({length:width*height},()=>colors[random(4)])),planes=raw.map(p=>p.map(c=>bits===4?c*17:c));
    const bytes=fixture({width,height,planes:raw,bits}),crop={x:random(5)-2,y:random(5)-2,width:1+random(9),height:1+random(7)},reduction={x:1+random(4),y:1+random(4),z:1+random(4)};await f.write(bytes);
    const grid=await buildResinHollowGrid(f.filePath,{expectedSha256:hash(bytes),crop,reduction}),d=grid.frame.dimensions,n=grid.frame.interiorDimensions,lower=new Uint8Array(grid.lower.length),upper=new Uint8Array(lower.length);
    for(let z=0;z<n.z;z++)for(let y=0;y<n.y;y++)for(let x=0;x<n.x;x++){let min=255,max=0;for(let dz=0;dz<reduction.z;dz++)for(let dy=0;dy<reduction.y;dy++)for(let dx=0;dx<reduction.x;dx++){const rx=x*reduction.x+dx,ry=y*reduction.y+dy,sx=crop.x+rx,sy=crop.y+ry,sz=z*reduction.z+dz,value=rx<crop.width&&ry<crop.height&&sx>=0&&sx<width&&sy>=0&&sy<height&&sz<depth?planes[sz][sy*width+sx]:0;min=Math.min(min,value);max=Math.max(max,value);}const at=((z+1)*d.y+y+1)*d.x+x+1;lower[at]=min;upper[at]=max;}
    assert.deepEqual(grid.lower,lower,`lower trial ${trial}`);assert.deepEqual(grid.upper,upper,`upper trial ${trial}`);
  }
});

test('file, layer, pixel, payload, operation, grid and working-byte caps are checked before growth',async t=>{
  const f=await fileFixture(t);
  for(const limits of [{maxFileBytes:f.bytes.length-1},{maxLayers:1},{maxPixelsPerLayer:7},{maxLayerBytes:2},{maxOperations:1},{maxWorkingBytes:100}])await assert.rejects(scanResinGooFile(f.filePath,{limits}),{code:'RESIN_HOLLOW_RASTER_LIMIT'});
  const options={expectedSha256:hash(f.bytes),crop:{x:0,y:0,width:4,height:2},reduction:{x:1,y:1,z:1}};
  await assert.rejects(buildResinHollowGrid(f.filePath,{...options,limits:{maxCells:95}}),{code:'RESIN_HOLLOW_RASTER_LIMIT'});
  const scanned=await scanResinGooFile(f.filePath),cells=6*4*4;
  await assert.rejects(buildResinHollowGrid(f.filePath,{...options,limits:{maxWorkingBytes:scanned.stats.ownedWorkingBytes+2*cells-1}}),{code:'RESIN_HOLLOW_RASTER_LIMIT'});
  assert.equal(RESIN_HOLLOW_RASTER_LIMITS.maxCells,20000000);
});

test('strict option types, crop/reduction keys and regular-file requirement reject unsupported inputs',async t=>{
  const f=await fileFixture(t);
  for(const options of [null,[],{expected:{}},{onRun:1},{signal:{}},{limits:{unknown:1}},{limits:{maxOperations:250000001}},{limits:{timeoutMs:'60'}}])await assert.rejects(scanResinGooFile(f.filePath,options),{code:'RESIN_HOLLOW_RASTER_OPTIONS'});
  await assert.rejects(scanResinGooFile('relative.goo'),{code:'RESIN_HOLLOW_RASTER_OPTIONS'});await assert.rejects(scanResinGooFile(f.root),{code:'RESIN_HOLLOW_RASTER_FILE'});
  const base={expectedSha256:hash(f.bytes),crop:{x:0,y:0,width:4,height:2},reduction:{x:1,y:1,z:1}};
  for(const patch of [{expectedSha256:'bad'},{crop:{...base.crop,width:0}},{crop:{...base.crop,x:.5}},{crop:{...base.crop,extra:1}},{reduction:{x:1,y:1,z:0}},{reduction:{x:1,y:1,z:1,extra:1}}])await assert.rejects(buildResinHollowGrid(f.filePath,{...base,...patch}),{code:'RESIN_HOLLOW_RASTER_OPTIONS'});
});

test('a local actual native 16K artifact cross-checks the independent streaming reader',async t=>{
  const native=path.resolve('artifacts/resin-16k-raster-verification/replicated20.goo');
  if(!sync.existsSync(native)){t.skip('Local native verification artifact is not distributed with the repository.');return;}
  const bytes=await fs.readFile(native),stream=await scanResinGooFile(native);
  assert.deepEqual(stream.metadata,inspectGoo(bytes,{limits:{maxFileBytes:512*1024*1024,maxPixelsPerLayer:100000000,maxLayerBytes:128*1024*1024}}));assert.equal(stream.sha256,hash(bytes));assert.equal(stream.metadata.resolutionX,15120);assert.equal(stream.metadata.layerCount,8);
});
