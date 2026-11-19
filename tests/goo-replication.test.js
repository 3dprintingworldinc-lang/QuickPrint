'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { inspectGoo } = require('../src/slicing/goo');
const { verifyGooPlate } = require('../src/slicing/goo-plate');
const { replicateGooPlate } = require('../src/slicing/goo-replication');

const HEADER = 195477, hash = bytes => createHash('sha256').update(bytes).digest('hex');
const placements = [{ x: -10,y: 0 },{ x: 0,y: 0 },{ x: 10,y: 0 }];
function run(color,count,maximum) {
  const extra = []; let upper = Math.floor(count/16);
  while (upper) { extra.unshift(upper&255); upper = Math.floor(upper/256); }
  return [(color === 0 ? 0 : color === maximum ? 192 : 64)|(extra.length<<4)|(count&15),...(color !== 0 && color !== maximum ? [color] : []),...extra];
}
function fixture({ width = 40,height = 20,bits = 8,mirrorX = false,mirrorY = false,physical = [40,20],images,rawTokens,estimates = [1.25,2.5,0.5] } = {}) {
  const maximum = bits === 4 ? 15 : 255;
  images ||= [new Array(width*height).fill(0),new Array(width*height).fill(0)];
  if (!rawTokens && images.every(layer => layer.every(value => !value))) { images[0][10*width+20] = maximum; images[0][10*width+21] = Math.floor(maximum/2); images[1][10*width+20] = Math.floor(maximum/4); }
  const header = Buffer.alloc(HEADER); header.write('V3.0'); Buffer.from([7,0,0,0,68,76,80,0]).copy(header,4);
  header.write('Independent source fixture',12); header.write('Source version',44); header.write('2026-11-19 12:00:00',68); header.write('Fixture machine',92); header.write('DLP',124); header.write('Fixture profile',156);
  header.writeUInt16BE(8,188); header.writeUInt16BE(1,190); header.fill(255,194,27106); header.writeUInt16BE(0x0d0a,27106); header.fill(255,27108,195308); header.writeUInt16BE(0x0d0a,195308);
  let at = 195310;
  const u8 = v => { header[at++] = v; },u16 = v => { header.writeUInt16BE(v,at); at+=2; },u32 = v => { header.writeUInt32BE(v,at); at+=4; },float = v => { header.writeFloatBE(v,at); at+=4; };
  u32(images.length);u16(width);u16(height);u8(Number(mirrorX));u8(Number(mirrorY));[...physical,30,0.05,2].forEach(float);u8(1);
  for(let i=0;i<7;i++)float(i/10);float(20);u32(1);for(let i=0;i<16;i++)float(i%2?100:5);u16(255);u16(254);u8(1);u32(1234);estimates.forEach(float);header.write('USD',at);at+=8;u32(HEADER);u8(bits===4?0:1);u16(0);assert.equal(at,HEADER);
  const parts=[header];
  images.forEach((pixels,index)=>{
    const tokens=[];
    if(rawTokens)tokens.push(...rawTokens[index]);else for(let i=0;i<pixels.length;){let end=i+1;while(end<pixels.length&&pixels[end]===pixels[i])end++;tokens.push(...run(pixels[i],end-i,maximum));i=end;}
    const image=Buffer.from([85,...tokens,tokens.reduce((sum,v)=>(sum+v)&255,0)^255]),definition=Buffer.alloc(70);
    definition.writeUInt16BE(index?1:0);definition.writeFloatBE(index?0.1:0,2);definition.writeFloatBE((index+1)*0.05,6);definition.writeFloatBE(index?2:20,10);for(let i=0;i<4;i++)definition.writeFloatBE(i/10,14+i*4);for(let i=0;i<8;i++)definition.writeFloatBE(i%2?100:5,30+i*4);definition.writeUInt16BE(253,62);definition.writeUInt16BE(0x0d0a,64);definition.writeUInt32BE(image.length,66);parts.push(definition,image,Buffer.from([13,10]));
  });
  parts.push(Buffer.from([0,0,0,7,0,0,0,68,76,80,0]));return Buffer.concat(parts);
}
function definitions(buffer) { const result=[];let at=HEADER;for(let i=0;i<buffer.readUInt32BE(195310);i++){result.push(Buffer.from(buffer.subarray(at,at+66)));at+=72+buffer.readUInt32BE(at+66);}return result; }
function rgb(buffer,size,x,y) { return buffer.readUInt16BE((size===116?194:27108)+2*(y*size+x)); }
function failure(fn,codes) { assert.throws(fn,error=>codes.includes(error.code),codes.join('/')); }

test('replication deterministically retains every pixel and physical field while updating the whole plate metadata',()=>{
  const source=fixture(),original=Buffer.from(source),result=replicateGooPlate(source,{translationsPx:placements,minGapPx:2}),again=replicateGooPlate(source,{translationsPx:placements,minGapPx:2});
  assert.deepEqual(source,original);assert.deepEqual(result.buffer,again.buffer);assert.deepEqual(result.derivation,again.derivation);assert.deepEqual(result.proof,again.proof);
  assert.deepEqual(result.buffer.subarray(195310,195446),source.subarray(195310,195446));assert.deepEqual(result.buffer.subarray(195462,HEADER),source.subarray(195462,HEADER));assert.deepEqual(definitions(result.buffer),definitions(source));
  const read=inspectGoo(result.buffer);assert.equal(read.printTimeSeconds,1234);assert.equal(read.volumeMm3,3.75);assert.equal(read.materialGrams,7.5);assert.equal(read.materialCost,1.5);assert.equal(read.software,'QuickPrint');
  assert.equal(result.proof.copiesPerRun,3);assert.equal(result.proof.imageEquivalent,true);assert.equal(result.proof.totalForegroundPixels,9);assert.deepEqual(verifyGooPlate(source,result.buffer,{translationsPx:placements,minGapPx:2}),result.proof);
  assert.equal(result.derivation.referenceSha256,hash(source));assert.equal(result.derivation.artifactSha256,hash(result.buffer));assert.equal(result.derivation.mode,'exact-raster-replication');assert.equal(result.derivation.encoderVersion,1);assert.equal(result.derivation.rasterProofSha256,result.proof.proofSha256);
  assert.match(result.derivation.estimates.printTimePolicy,/estimate-not-a-duration-guarantee/);assert.ok(Object.isFrozen(result.derivation.thumbnails.images));assert.deepEqual(JSON.parse(JSON.stringify(result.derivation)),result.derivation);
});

test('both RGB565BE thumbnails show every copy and max over all layers with physical-bed letterboxing',()=>{
  const source=fixture({physical:[80,20]}),{buffer,derivation}=replicateGooPlate(source,{translationsPx:placements});
  for(const size of [116,290]){
    const width=size,height=Math.round(size/4),top=Math.floor((size-height)/2),row=top+Math.floor(10.5*height/20);
    assert.equal(rgb(buffer,size,0,0),0);assert.equal(rgb(buffer,size,size-1,size-1),0);assert.equal(rgb(buffer,size,0,top-1),0);
    for(const offset of [-10,0,10]){assert.equal(rgb(buffer,size,Math.floor((20.5+offset)*width/40),row),65535);const gray=Math.floor(255/2),word=((gray>>>3)<<11)|((gray>>>2)<<5)|(gray>>>3);assert.equal(rgb(buffer,size,Math.floor((21.5+offset)*width/40),row),word);}
    const item=derivation.thumbnails.images.find(item=>item.width===size),begin=size===116?194:27108;assert.equal(item.sha256,hash(buffer.subarray(begin,begin+size*size*2)));
  }
  assert.equal(derivation.thumbnails.frame,'encoded-raster');assert.equal(derivation.thumbnails.format,'RGB565BE');assert.equal(buffer.readUInt16BE(27106),0x0d0a);assert.equal(buffer.readUInt16BE(195308),0x0d0a);
});

test('all mirror combinations and 4/8-bit grayscale produce canonical JSON-stable exact proofs',()=>{
  for(const bits of [4,8])for(const mirrorX of [false,true])for(const mirrorY of [false,true]){
    const source=fixture({bits,mirrorX,mirrorY}),result=replicateGooPlate(source,{translationsPx:[{x:-0,y:-0},{x:-10,y:0}],minGapPx:-0});
    const inspected=inspectGoo(result.buffer);assert.equal(inspected.mirrorX,mirrorX);assert.equal(inspected.mirrorY,mirrorY);assert.equal(inspected.grayscaleBits,bits);assert.equal(result.proof.totalForegroundPixels,6);
    assert.equal(Object.is(result.derivation.translationsPx[0].x,-0),false);assert.equal(Object.is(result.derivation.translationsPx[0].y,-0),false);assert.equal(Object.is(result.derivation.minGapPx,-0),false);assert.deepEqual(JSON.parse(JSON.stringify(result.derivation)),result.derivation);assert.deepEqual(JSON.parse(JSON.stringify(result.proof)),result.proof);
  }
});

test('specified delta runs, signed changes, extended lengths and row-spanning runs survive absolute re-encoding',()=>{
  const width=1024,height=128,before=40*width+500,pixels=new Array(width*height).fill(0);[16,16,17,17,17,15,15,15].forEach((v,i)=>pixels[before+i]=v);
  const tokens=[...run(0,before,255),0x42,16,0x91,3,0xb2,3,...run(0,pixels.length-before-8,255)],source=fixture({width,height,images:[pixels],rawTokens:[tokens],physical:[80,10]});
  const result=replicateGooPlate(source,{translationsPx:[{x:-100,y:-20},{x:100,y:20}]});assert.equal(result.proof.totalForegroundPixels,16);assert.equal(result.proof.totalForegroundIntensity,256);assert.equal(inspectGoo(result.buffer).layerCount,1);
});

test('overlaps, source-edge clipping, translated clipping, insufficient gaps and empty source fail closed',()=>{
  const source=fixture();failure(()=>replicateGooPlate(source,{translationsPx:[{x:0,y:0},{x:0,y:0}]}),['GOO_REPLICATION_OVERLAP']);
  failure(()=>replicateGooPlate(source,{translationsPx:[{x:20,y:0}]}),['GOO_REPLICATION_CLIPPED']);
  failure(()=>replicateGooPlate(source,{translationsPx:[{x:0,y:0}],marginPx:{x:20,y:1}}),['GOO_REPLICATION_OPTIONS']);
  failure(()=>replicateGooPlate(source,{translationsPx:[{x:0,y:0},{x:2,y:0}],minGapPx:1}),['GOO_PLATE_OVERLAP']);
  const edge=[new Array(800).fill(0)];edge[0][400]=255;failure(()=>replicateGooPlate(fixture({images:edge}),{translationsPx:[{x:1,y:0}]}),['GOO_REPLICATION_CLIPPED']);
  const empty=fixture({images:[new Array(800).fill(0)],rawTokens:[run(0,800,255)]});failure(()=>replicateGooPlate(empty,{translationsPx:[{x:0,y:0}]}),['GOO_PLATE_EMPTY']);
});

test('invalid input, checksum, truncation and unknown format are refused before returning a derived artifact',()=>{
  const source=fixture(),bad=Buffer.from(source);bad[HEADER+71]^=1;
  for(const bytes of [bad,source.subarray(0,source.length-1),Buffer.from('not goo')])failure(()=>replicateGooPlate(bytes,{translationsPx:placements}),['INVALID_GOO']);
  const version=Buffer.from(source);version.write('V4.0');failure(()=>replicateGooPlate(version,{translationsPx:placements}),['UNSUPPORTED_GOO_VERSION']);
  failure(()=>replicateGooPlate(source,{translationsPx:[{x:0.5,y:0}]}),['GOO_REPLICATION_OPTIONS']);failure(()=>replicateGooPlate(source,{translationsPx:placements,settings:{exposure:1}}),['GOO_REPLICATION_OPTIONS']);
});

test('only lower resource limits are accepted and work/file/layer/pixel/segment bounds stop the writer',()=>{
  const source=fixture();for(const limits of [{maxFileBytes:source.length-1},{maxLayers:1},{maxPixelsPerLayer:799},{maxLayerBytes:2},{maxOperations:1},{maxSegmentsPerLayer:1}])failure(()=>replicateGooPlate(source,{translationsPx:placements,limits}),['GOO_LIMIT_EXCEEDED','GOO_REPLICATION_LIMIT']);
  for(const limits of [{maxFileBytes:512*1024*1024+1},{maxLayers:25001},{maxPixelsPerLayer:100000001},{maxSegmentsPerLayer:1000001},{maxOperations:50000001},{timeoutMs:30001},{maxCopies:501},{extra:1},{maxFileBytes:0},{constructor:1},{toString:1},{[Symbol('unexpected')]:1}])failure(()=>replicateGooPlate(source,{translationsPx:placements,limits}),['GOO_REPLICATION_OPTIONS']);
  failure(()=>replicateGooPlate(source,{translationsPx:placements,limits:{maxCopies:2}}),['GOO_REPLICATION_OPTIONS']);
});

test('material-estimate overflow refuses derivation without modifying reference values or physical schedules',()=>{
  const source=fixture({estimates:[9e11,9e9,9e9]}),before=Buffer.from(source);failure(()=>replicateGooPlate(source,{translationsPx:placements}),['GOO_REPLICATION_ESTIMATE_OVERFLOW']);assert.deepEqual(source,before);
  const zero=fixture({estimates:[0,0,0]}),read=inspectGoo(replicateGooPlate(zero,{translationsPx:placements}).buffer);assert.equal(read.volumeMm3,0);assert.equal(read.materialGrams,0);assert.equal(read.materialCost,0);
});
