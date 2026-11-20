'use strict';

// A managed derivative of frozen mesh bytes. Repair is explicit and limited to
// the exact edits proved by resin-mesh-repair; source units normalize once.
const fs=require('node:fs/promises');
const path=require('node:path');
const { createHash }=require('node:crypto');
const { performance }=require('node:perf_hooks');
const { isDeepStrictEqual }=require('node:util');
const { prepareResinGeometry,measureResinGeometry,forEachResinTriangle }=require('./resin-geometry');
const { prepareResinMeshRepair,RESIN_MESH_REPAIR_LIMITS }=require('./resin-mesh-repair');

const METHOD='normalized-exact-mesh-repair-v1',MAX_BYTES=100*1024*1024,MAX_PROOF_BYTES=64*1024*1024;
const HASH=/^[a-f0-9]{64}$/;
const GEOMETRY_LIMITS=Object.freeze({ maxBytes:MAX_BYTES,maxTriangles:RESIN_MESH_REPAIR_LIMITS.maxTriangles,maxVertices:RESIN_MESH_REPAIR_LIMITS.maxVertices });
const plain=value => value && typeof value==='object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const hash=bytes => createHash('sha256').update(bytes).digest('hex');
const fail=(message,code='RESIN_REPAIR_CHANGED',status=409) => Object.assign(new Error(message),{code,status});
const canonical=value => Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])):value;
const proofBytes=proof => Buffer.from(JSON.stringify(canonical(proof))+'\n');
const exact=(value,keys) => plain(value) && Reflect.ownKeys(value).length===keys.length && Reflect.ownKeys(value).every(key => keys.includes(key));
const absolute=value => typeof value==='string' && value.length<=4000 && !/[\0\r\n]/.test(value) && path.isAbsolute(value);
const check=signal => signal?.throwIfAborted();

function sourceOptions(options,keys) {
  if (!plain(options) || Reflect.ownKeys(options).some(key => !keys.includes(key)) || !Buffer.isBuffer(options.source) || !options.source.length || options.source.length>MAX_BYTES || !['stl','obj'].includes(options.format) || !['mm','in','m'].includes(options.units) || (options.signal!==undefined && !(options.signal instanceof AbortSignal))) throw fail('Declare bounded STL/OBJ source bytes, units and managed paths only.','RESIN_REPAIR_OPTIONS',400);
  check(options.signal);
}

// Inspect every existing parent, including the managed root itself. Creating
// parents one at a time avoids accepting a pre-existing directory link.
async function directoryChain(directory,{create=false}={}) {
  if (!absolute(directory)) throw fail('Repair evidence requires an absolute managed directory.','RESIN_REPAIR_PATH',400);
  const resolved=path.resolve(directory),root=path.parse(resolved).root;
  let current=root;
  for (const segment of path.relative(root,resolved).split(path.sep).filter(Boolean)) {
    current=path.join(current,segment);
    let info;
    try { info=await fs.lstat(current); }
    catch (error) {
      if (!create || error.code!=='ENOENT') throw fail('The repair evidence directory is missing or unavailable.','RESIN_REPAIR_PATH');
      await fs.mkdir(current).catch(cause => { if(cause.code!=='EEXIST')throw cause; });
      info=await fs.lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Repair directory parents cannot use links.','RESIN_REPAIR_PATH');
  }
  const info=await fs.lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Repair evidence root cannot use links.','RESIN_REPAIR_PATH');
  return resolved;
}

async function managedDirectory(root,directory) {
  root=await directoryChain(root);directory=await directoryChain(directory);
  const relative=path.relative(root,directory);
  if (!relative || relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !/^repair-[A-Za-z0-9_-]{6,80}$/.test(path.basename(directory))) throw fail('Repair evidence must remain in a unique managed repair directory.','RESIN_REPAIR_PATH');
  if (path.relative(await fs.realpath(root),await fs.realpath(directory))!==relative) throw fail('Repair evidence resolves outside its managed directory.','RESIN_REPAIR_PATH');
  return directory;
}

async function readFileBounded(filePath,maximum,signal) {
  check(signal);
  const info=await fs.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size>maximum) throw fail('Repair evidence is linked, empty or exceeds its file bound.');
  const handle=await fs.open(filePath,'r');
  try {
    const pinned=await handle.stat();
    if (!pinned.isFile() || pinned.size!==info.size || pinned.ino!==info.ino || pinned.dev!==info.dev) throw fail('Repair evidence changed while opening it.');
    const bytes=Buffer.alloc(info.size);let offset=0;
    while(offset<bytes.length){check(signal);const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}
    if(offset!==bytes.length || (await handle.read(Buffer.alloc(1),0,1,offset)).bytesRead)throw fail('Repair evidence changed during its bounded read.');
    check(signal);return bytes;
  } finally {await handle.close();}
}

async function descriptorBytes(root,directory,descriptor,filename,maximum,signal) {
  if (!exact(descriptor,['filePath','sha256','bytes']) || !absolute(descriptor.filePath) || descriptor.filePath!==path.join(directory,filename) || !HASH.test(descriptor.sha256) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes<1 || descriptor.bytes>maximum) throw fail('Repair evidence descriptor changed.');
  await managedDirectory(root,directory);check(signal);
  const bytes=await readFileBounded(descriptor.filePath,maximum,signal);
  if(bytes.length!==descriptor.bytes || hash(bytes)!==descriptor.sha256)throw fail('Repair evidence bytes no longer match their descriptor.');
  await managedDirectory(root,directory);return bytes;
}

async function repairTool(signal) {
  const binaryManifest=[];
  for(const [name,filename]of [['wrapper',__filename],['geometry',path.join(__dirname,'resin-geometry.js')],['exact-repair',path.join(__dirname,'resin-mesh-repair.js')],['mesh-audit',path.join(__dirname,'resin-mesh.js')]]){
    check(signal);const bytes=await readFileBounded(filename,2*1024*1024,signal);
    binaryManifest.push({name:`quickprint/${name}`,sha256:hash(bytes),bytes:bytes.length});
  }
  return {name:'QuickPrint exact mesh repair',version:'1',executableSha256:hash(JSON.stringify(binaryManifest)),binaryManifest};
}

function injectiveNormalization(source,format,normalized,signal) {
  const started=performance.now(),normalizedToRaw=new Map(),rawVertices=new Set();let visits=0;
  const pointKey=point => point.map(value => value===0?0:value).join(',');
  const time=() => {check(signal);if(performance.now()-started>RESIN_MESH_REPAIR_LIMITS.maxTimeMs)throw fail('Normalization identity audit exceeded its time budget.','RESIN_REPAIR_LIMIT',413);};
  const parsed=forEachResinTriangle(source,{format,units:'mm',limits:GEOMETRY_LIMITS},(points,index) => {
    if(!(visits++ & 255))time();
    points.forEach((rawPoint,vertex) => {
      const offset=84+index*50+12+vertex*12,rawKey=pointKey(rawPoint),normalizedKey=pointKey([0,1,2].map(axis => normalized.readFloatLE(offset+axis*4))),previous=normalizedToRaw.get(normalizedKey);
      if(previous!==undefined && previous!==rawKey)throw fail('Distinct original vertices collapse to the same normalized float32 coordinate; exact repair cannot merge them.','RESIN_REPAIR_PRECISION',422);
      rawVertices.add(rawKey);normalizedToRaw.set(normalizedKey,rawKey);
      if(rawVertices.size>GEOMETRY_LIMITS.maxVertices || normalizedToRaw.size>GEOMETRY_LIMITS.maxVertices)throw fail('Normalization identity audit exceeds its vertex bound.','RESIN_REPAIR_LIMIT',413);
    });
  });
  time();
  if(parsed.triangleCount!==normalized.readUInt32LE(80))throw fail('Normalization changed source triangle accounting.','RESIN_REPAIR_PRECISION',422);
  return {distinctSourceVertices:rawVertices.size,distinctNormalizedVertices:normalizedToRaw.size,injectiveVertexMapping:true};
}

function derive(source,format,units,signal) {
  check(signal);
  const normalized=prepareResinGeometry(source,{format,units,sizing:{mode:'original'},limits:GEOMETRY_LIMITS});
  const identity=injectiveNormalization(source,format,normalized.stl,signal);
  check(signal);const repaired=prepareResinMeshRepair(normalized.stl);check(signal);
  const proof=repaired.proof,report=proofBytes(proof);
  if(report.length>MAX_PROOF_BYTES)throw fail('Full repair proof exceeds its bounded report size.','RESIN_REPAIR_LIMIT',413);
  const summary={operations:proof.operations,normalization:{sourceUnits:units,unitScale:normalized.plan.unitScale,originSourceUnits:normalized.plan.transform.originSourceUnits,...identity},sourceTriangleCount:proof.sourceTriangleCount,outputTriangleCount:proof.outputTriangleCount,vertexCount:proof.vertexCount,edgeCount:proof.edgeCount,componentCount:proof.componentCount,
    normalizedBoundsMm:proof.sourceBoundsMm,boundsMm:proof.outputBoundsMm,topology:proof.topology,intersectionStatus:proof.intersectionStatus,cavityStatus:proof.cavityStatus,solidCertified:false};
  return {normalized,repaired,report,summary,measurement:measureResinGeometry(repaired.stl,{format:'stl',units:'mm',limits:GEOMETRY_LIMITS})};
}

async function prepareResinRepair(options={}) {
  sourceOptions(options,['source','format','units','outputDir','signal']);
  if(!absolute(options.outputDir))throw fail('Choose an absolute managed repair output directory.','RESIN_REPAIR_PATH',400);
  const {source,format,units,signal}=options,original=Buffer.from(source),before=await repairTool(signal);
  check(signal);const derived=derive(original,format,units,signal);
  const root=await directoryChain(options.outputDir,{create:true});check(signal);
  const directory=await fs.mkdtemp(path.join(root,'repair-'));
  const write=async(filename,bytes) => {check(signal);await managedDirectory(root,directory);const filePath=path.join(directory,filename);await fs.writeFile(filePath,bytes,{flag:'wx'});check(signal);return {filePath,sha256:hash(bytes),bytes:bytes.length};};
  const normalizedSource=await write('normalized-source.stl',derived.normalized.stl),proofFile=await write('repair-proof.json',derived.report),output=await write('repaired.stl',derived.repaired.stl);
  const after=await repairTool(signal);
  if(!isDeepStrictEqual(before,after))throw fail('The repair implementation changed while preparing this derivative.','RESIN_REPAIR_TOOL_CHANGED');
  if(hash(source)!==hash(original))throw fail('The supplied original mesh bytes changed during repair.','ORIGINAL_CHANGED');
  const record={schemaVersion:1,method:METHOD,sourceSha256:hash(original),sourceBytes:original.length,sourceFormat:format,sourceUnits:units,coordinateUnits:'mm',units:'mm',normalizationPlan:derived.normalized.plan,
    normalizedSource,proofFile,reportPath:proofFile.filePath,reportSha256:proofFile.sha256,proofSha256:derived.repaired.proof.proofSha256,...output,summary:derived.summary,measurement:derived.measurement,tool:before,createdAt:new Date().toISOString()};
  await verifyResinRepairGeometry(record,{source:original,format,units,directory:root,signal});check(signal);
  if(hash(source)!==record.sourceSha256)throw fail('The original source changed before repair capture.','ORIGINAL_CHANGED');
  return record;
}

async function verifyResinRepairGeometry(record,options={}) {
  sourceOptions(options,['source','format','units','directory','signal']);
  const {source,format,units,signal}=options,original=Buffer.from(source);
  const keys=['schemaVersion','method','sourceSha256','sourceBytes','sourceFormat','sourceUnits','coordinateUnits','units','normalizationPlan','normalizedSource','proofFile','reportPath','reportSha256','proofSha256','filePath','sha256','bytes','summary','measurement','tool','createdAt'];
  if(!exact(record,keys) || record.schemaVersion!==1 || record.method!==METHOD || record.sourceSha256!==hash(original) || record.sourceBytes!==original.length || record.sourceFormat!==format || record.sourceUnits!==units || record.coordinateUnits!=='mm' || record.units!=='mm' || !absolute(record.filePath) || !HASH.test(record.sha256) || !HASH.test(record.proofSha256) || record.reportPath!==record.proofFile?.filePath || record.reportSha256!==record.proofFile?.sha256 || typeof record.createdAt!=='string' || !Number.isFinite(Date.parse(record.createdAt)) || new Date(Date.parse(record.createdAt)).toISOString()!==record.createdAt)throw fail('The saved repair no longer identifies the complete original source and declared units.');
  const root=await directoryChain(options.directory),directory=path.dirname(record.filePath);
  await managedDirectory(root,directory);check(signal);
  const actualTool=await repairTool(signal);
  if(!isDeepStrictEqual(record.tool,actualTool))throw fail('The repair implementation manifest changed.','RESIN_REPAIR_TOOL_CHANGED');
  const expected=derive(original,format,units,signal);
  const normalized=await descriptorBytes(root,directory,record.normalizedSource,'normalized-source.stl',MAX_BYTES,signal);
  const report=await descriptorBytes(root,directory,record.proofFile,'repair-proof.json',MAX_PROOF_BYTES,signal);
  const bytes=await descriptorBytes(root,directory,{filePath:record.filePath,sha256:record.sha256,bytes:record.bytes},'repaired.stl',MAX_BYTES,signal);
  if(!normalized.equals(expected.normalized.stl) || !report.equals(expected.report) || !bytes.equals(expected.repaired.stl) || record.proofSha256!==expected.repaired.proof.proofSha256 || !isDeepStrictEqual(record.normalizationPlan,expected.normalized.plan) || !isDeepStrictEqual(record.summary,expected.summary) || !isDeepStrictEqual(record.measurement,expected.measurement))throw fail('Repair files or claims differ from complete normalization and exact source-face reconstruction.');
  if(!isDeepStrictEqual(actualTool,await repairTool(signal)))throw fail('The repair implementation changed during verification.','RESIN_REPAIR_TOOL_CHANGED');
  if(hash(source)!==record.sourceSha256)throw fail('The supplied original source changed during repair verification.','ORIGINAL_CHANGED');
  check(signal);return {bytes,measurement:expected.measurement,summary:expected.summary};
}

module.exports={prepareResinRepair,verifyResinRepairGeometry};
