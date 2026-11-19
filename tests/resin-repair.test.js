'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const { createHash }=require('node:crypto');
const { prepareResinRepair,verifyResinRepairGeometry }=require('../src/slicing/resin-repair');
const { forEachResinTriangle }=require('../src/slicing/resin-geometry');
const { MODEL }=require('./helpers/resin-slice');
const hash=bytes => createHash('sha256').update(bytes).digest('hex');
const canonical=value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])):value;
const triangles=[];forEachResinTriangle(MODEL,{format:'stl',units:'mm'},t => triangles.push(t));
function source(format='stl',{offset=0,duplicate=true,flipped=true}={}) {
  const faces=triangles.map(t => t.map(p => p.map(v => v+offset)));
  if(flipped)[faces[3][1],faces[3][2]]=[faces[3][2],faces[3][1]];
  if(duplicate)faces.push(faces[0]);
  if(format==='obj')return Buffer.from(faces.flatMap(t => t.map(p => 'v '+p.join(' '))).join('\n')+'\n'+faces.map((_,i) => `f ${3*i+1} ${3*i+2} ${3*i+3}`).join('\n')+'\n');
  return Buffer.from('solid owned\n'+faces.map(t => 'facet normal 0 0 0\nouter loop\n'+t.map(p => 'vertex '+p.join(' ')).join('\n')+'\nendloop\nendfacet').join('\n')+'\nendsolid owned\n');
}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'quickprint-repair-wrapper-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const outputDir=path.join(root,'managed','repair');
  return {root,outputDir,async prepare(raw=source(),format='stl',units='mm'){const record=await prepareResinRepair({source:raw,format,units,outputDir});return {record,raw,format,units};},verify(f,record=f.record,extras={}){return verifyResinRepairGeometry(record,{source:f.raw,format:f.format,units:f.units,directory:outputDir,...extras});}};
}

test('managed repair preserves original bytes and stores only bounded descriptors/summary in the replayable record',async t => {
  const f=await fixture(t),raw=source(),before=Buffer.from(raw),prepared=await f.prepare(raw),{record}=prepared;
  assert.deepEqual(raw,before);assert.equal(record.method,'normalized-exact-mesh-repair-v1');assert.equal(record.sourceSha256,hash(raw));assert.equal(record.sourceUnits,'mm');
  assert.equal(record.coordinateUnits,'mm');assert.equal(record.units,'mm');assert.equal(record.summary.sourceTriangleCount,13);assert.equal(record.summary.outputTriangleCount,12);
  assert.equal(record.summary.operations.removedExactDuplicateFaces,1);assert.equal(record.summary.operations.reorientedUniqueFaces,1);assert.equal(record.summary.operations.coordinatesMoved,0);
  assert.equal(record.summary.solidCertified,false);assert.equal(record.summary.intersectionStatus,'not_checked');
  assert.deepEqual((await fs.readdir(path.dirname(record.filePath))).sort(),['normalized-source.stl','repair-proof.json','repaired.stl']);
  const proofBytes=await fs.readFile(record.proofFile.filePath),proof=JSON.parse(proofBytes);
  assert.equal(proof.faces.length,13);assert.equal(proof.proofSha256,record.proofSha256);assert.equal(record.reportSha256,hash(proofBytes));assert.equal(record.reportPath,record.proofFile.filePath);
  assert.equal(record.summary.faces,undefined);assert.equal(record.faces,undefined);assert.ok(Buffer.byteLength(JSON.stringify(record))<16000);
  const reloaded=JSON.parse(JSON.stringify(record)),verified=await f.verify(prepared,reloaded);
  assert.deepEqual(verified.bytes,await fs.readFile(record.filePath));assert.equal(hash(verified.bytes),record.sha256);assert.deepEqual(verified.measurement,record.measurement);assert.deepEqual(verified.summary,record.summary);
});

test('STL and triangulated OBJ normalize mm, inches and metres exactly once before repair',async t => {
  const f=await fixture(t);
  for(const format of ['stl','obj'])for(const [units,scale]of [['mm',1],['in',25.4],['m',1000]]){
    const prepared=await f.prepare(source(format),format,units),record=prepared.record,verified=await f.verify(prepared);
    assert.equal(record.sourceUnits,units);assert.equal(record.normalizationPlan.units,units);assert.equal(record.normalizationPlan.unitScale,scale);assert.equal(record.normalizationPlan.uniformScale,1);
    for(const axis of ['x','y','z'])assert.ok(Math.abs(verified.measurement.sourceDimensionsMm[axis]-3*scale)<Math.max(1e-5,3*scale*1e-6));
    assert.equal(verified.measurement.unitScale,1);assert.equal(verified.measurement.units,'mm');assert.equal(record.normalizationPlan.triangleCount,13);assert.equal(record.summary.outputTriangleCount,12);
    assert.equal(record.summary.normalization.injectiveVertexMapping,true);assert.equal(record.summary.normalization.distinctSourceVertices,8);assert.equal(record.summary.normalization.distinctNormalizedVertices,8);
  }
});

test('distinct raw OBJ vertices cannot collapse into normalized duplicates that disguise unique face loss',async t => {
  const f=await fixture(t),faces=[];
  for(const origin of [0,3,3+1e-8])for(const triangle of triangles)faces.push(triangle.map(point => point.map(value => value/3+origin)));
  const raw=Buffer.from(faces.flatMap(triangle => triangle.map(point => 'v '+point.join(' '))).join('\n')+'\n'+faces.map((_,i) => `f ${3*i+1} ${3*i+2} ${3*i+3}`).join('\n')+'\n');
  const before=Buffer.from(raw);
  await assert.rejects(prepareResinRepair({source:raw,format:'obj',units:'mm',outputDir:f.outputDir}),{code:'RESIN_REPAIR_PRECISION'});
  assert.deepEqual(raw,before);await assert.rejects(fs.access(f.outputDir),{code:'ENOENT'});
});

test('normalization subtracts a large common raw origin and retains its explicit source-to-mm proof',async t => {
  const f=await fixture(t),prepared=await f.prepare(source('obj',{offset:100000000}),'obj','in'),record=prepared.record;
  assert.deepEqual(record.normalizationPlan.transform.originSourceUnits,{x:100000000,y:100000000,z:100000000});
  assert.equal(record.normalizationPlan.transform.scale,25.4);assert.deepEqual(record.summary.normalizedBoundsMm.min,{x:0,y:0,z:0});
  for(const axis of ['x','y','z'])assert.ok(Math.abs(record.measurement.sourceDimensionsMm[axis]-76.2)<1e-5);
  await f.verify(prepared);
});

test('the repair tool fingerprint describes policy code and stays constant across different models, units and paths',async t => {
  const f=await fixture(t),a=await f.prepare(),b=await f.prepare(source('obj',{offset:10}),'obj','in');
  assert.notEqual(a.record.sourceSha256,b.record.sourceSha256);assert.notEqual(a.record.proofSha256,b.record.proofSha256);assert.notEqual(a.record.filePath,b.record.filePath);
  assert.deepEqual(a.record.tool,b.record.tool);assert.equal(a.record.tool.binaryManifest.length,4);
  assert.deepEqual(a.record.tool.binaryManifest.map(e => e.name),['quickprint/wrapper','quickprint/geometry','quickprint/exact-repair','quickprint/mesh-audit']);
  assert.equal(a.record.tool.executableSha256,hash(JSON.stringify(a.record.tool.binaryManifest)));
});

test('source, format, units, normalization, summary, descriptor and tool claim tampering cannot pass replay',async t => {
  const f=await fixture(t),prepared=await f.prepare();
  for(const mutate of [r => {r.sourceSha256='0'.repeat(64);},r => {r.sourceBytes++;},r => {r.sourceFormat='obj';},r => {r.sourceUnits='in';},r => {r.units='in';},r => {r.normalizationPlan.unitScale=25.4;},r => {r.summary.operations.removedExactDuplicateFaces=2;},r => {r.summary.boundsMm.max.x=4;},r => {r.measurement.sourceDimensionsMm.x=4;},r => {r.normalizedSource.bytes++;},r => {r.proofSha256='0'.repeat(64);},r => {r.reportPath=r.filePath;},r => {r.createdAt='yesterday';}]){
    const record=structuredClone(prepared.record);mutate(record);await assert.rejects(f.verify(prepared,record));
  }
  const changedTool=structuredClone(prepared.record);changedTool.tool.binaryManifest[0].sha256='0'.repeat(64);changedTool.tool.executableSha256=hash(JSON.stringify(changedTool.tool.binaryManifest));
  await assert.rejects(f.verify(prepared,changedTool),{code:'RESIN_REPAIR_TOOL_CHANGED'});
  const changedSource=Buffer.from(prepared.raw);changedSource[0]^=1;
  await assert.rejects(f.verify(prepared,prepared.record,{source:changedSource}),{code:'RESIN_REPAIR_CHANGED'});
  await assert.rejects(f.verify(prepared,prepared.record,{units:'in'}),{code:'RESIN_REPAIR_CHANGED'});
});

test('every stored file is rederived, including corrupted normalized source, output and proof bytes',async t => {
  const f=await fixture(t);
  for(const key of ['normalizedSource','proofFile','output']){
    const prepared=await f.prepare(),record=prepared.record,filename=key==='output'?record.filePath:record[key].filePath,bytes=await fs.readFile(filename);bytes[0]^=1;await fs.writeFile(filename,bytes);
    await assert.rejects(f.verify(prepared),{code:'RESIN_REPAIR_CHANGED'});
  }
});

test('resealed evidence cannot drop a distinct face or forge its complete source-face report',async t => {
  const f=await fixture(t),prepared=await f.prepare(),record=structuredClone(prepared.record),output=await fs.readFile(record.filePath);
  const dropped=Buffer.from(output.subarray(0,output.length-50));dropped.writeUInt32LE(11,80);await fs.writeFile(record.filePath,dropped);record.sha256=hash(dropped);record.bytes=dropped.length;
  const proof=JSON.parse(await fs.readFile(record.proofFile.filePath));proof.outputTriangleCount=11;proof.outputBytes=dropped.length;proof.outputSha256=record.sha256;proof.faces=proof.faces.filter(face => face.outputFace!==11);proof.operations.uniqueTrianglesRemoved=1;
  const {proofSha256,...body}=proof;proof.proofSha256=hash(JSON.stringify(canonical(body)));record.proofSha256=proof.proofSha256;
  const report=Buffer.from(JSON.stringify(canonical(proof))+'\n');await fs.writeFile(record.proofFile.filePath,report);record.proofFile.sha256=hash(report);record.proofFile.bytes=report.length;record.reportSha256=record.proofFile.sha256;record.summary.outputTriangleCount=11;record.summary.operations.uniqueTrianglesRemoved=1;
  await assert.rejects(f.verify(prepared,record),{code:'RESIN_REPAIR_CHANGED'});
});

test('resealing a changed report or normalized input cannot replace the independently reconstructed files',async t => {
  const f=await fixture(t);
  for(const key of ['proofFile','normalizedSource']){
    const prepared=await f.prepare(),record=structuredClone(prepared.record),bytes=await fs.readFile(record[key].filePath);
    if(key==='proofFile'){const report=JSON.parse(bytes);report.faces[0].flipped=!report.faces[0].flipped;const altered=Buffer.from(JSON.stringify(report));await fs.writeFile(record[key].filePath,altered);record[key].sha256=hash(altered);record[key].bytes=altered.length;record.reportSha256=record[key].sha256;}
    else {bytes[84+12]^=1;await fs.writeFile(record[key].filePath,bytes);record[key].sha256=hash(bytes);}
    await assert.rejects(f.verify(prepared,record),{code:'RESIN_REPAIR_CHANGED'});
  }
});

test('outside paths and sibling evidence cannot replace the fixed files inside one repair directory',async t => {
  const f=await fixture(t),a=await f.prepare(),b=await f.prepare();
  const outside=structuredClone(a.record);outside.filePath=path.join(f.root,'repaired.stl');await fs.copyFile(a.record.filePath,outside.filePath);
  await assert.rejects(f.verify(a,outside),{code:'RESIN_REPAIR_PATH'});
  const sibling=structuredClone(a.record);sibling.normalizedSource=b.record.normalizedSource;
  await assert.rejects(f.verify(a,sibling),{code:'RESIN_REPAIR_CHANGED'});
  const escaped=structuredClone(a.record);escaped.proofFile.filePath=path.join(path.dirname(a.record.filePath),'..','repair-proof.json');escaped.reportPath=escaped.proofFile.filePath;
  await assert.rejects(f.verify(a,escaped),{code:'RESIN_REPAIR_CHANGED'});
});

test('directory links cannot redirect preparation or persisted evidence outside the managed tree',async t => {
  const f=await fixture(t),outside=path.join(f.root,'outside'),link=path.join(f.root,'link');await fs.mkdir(outside);
  await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(prepareResinRepair({source:source(),format:'stl',units:'mm',outputDir:path.join(link,'new')}),{code:'RESIN_REPAIR_PATH'});assert.deepEqual(await fs.readdir(outside),[]);
  const prepared=await f.prepare(),directory=path.dirname(prepared.record.filePath),moved=directory+'-saved';await fs.rename(directory,moved);await fs.symlink(moved,directory,process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.verify(prepared),{code:'RESIN_REPAIR_PATH'});
});

test('leaf symbolic links are refused even when their destination contains the exact expected bytes',async t => {
  const f=await fixture(t),prepared=await f.prepare(),outside=path.join(f.root,'outside.stl');await fs.copyFile(prepared.record.filePath,outside);await fs.unlink(prepared.record.filePath);
  try{await fs.symlink(outside,prepared.record.filePath,'file');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('This platform does not permit file symbolic links.');return;}throw error;}
  await assert.rejects(f.verify(prepared),{code:'RESIN_REPAIR_CHANGED'});assert.equal(hash(await fs.readFile(outside)),prepared.record.sha256);
});

test('abort before and during asynchronous preparation or verification never yields an adopted record',async t => {
  const f=await fixture(t),reason=Object.assign(new Error('Owned cancellation'),{code:'OWNED_ABORT'}),early=new AbortController();early.abort(reason);
  await assert.rejects(prepareResinRepair({source:source(),format:'stl',units:'mm',outputDir:f.outputDir,signal:early.signal}),{code:'OWNED_ABORT'});
  const active=new AbortController(),pending=prepareResinRepair({source:source(),format:'stl',units:'mm',outputDir:f.outputDir,signal:active.signal});active.abort(reason);await assert.rejects(pending,{code:'OWNED_ABORT'});
  const prepared=await f.prepare();await assert.rejects(f.verify(prepared,prepared.record,{signal:early.signal}),{code:'OWNED_ABORT'});
});

test('caller mutation of source bytes during awaited preparation rejects capture',async t => {
  const f=await fixture(t),raw=source(),pending=prepareResinRepair({source:raw,format:'stl',units:'mm',outputDir:f.outputDir});raw[0]^=1;
  await assert.rejects(pending,{code:'ORIGINAL_CHANGED'});
});

test('verification pins supplied source bytes across its awaited file reads',async t => {
  const f=await fixture(t),prepared=await f.prepare(),pending=f.verify(prepared);prepared.raw[0]^=1;
  await assert.rejects(pending,{code:'ORIGINAL_CHANGED'});
});

test('strict request bounds refuse formats, units, paths and override fields before writing managed output',async t => {
  const f=await fixture(t),base={source:source(),format:'stl',units:'mm',outputDir:f.outputDir};
  for(const patch of [{source:Buffer.alloc(0)},{source:'mesh'},{format:'step'},{units:'cm'},{outputDir:'relative'},{signal:{}},{inputPath:'secret.stl'},{run:()=>{}},{limits:{maxTriangles:1000000}}])await assert.rejects(prepareResinRepair({...base,...patch}));
  await assert.rejects(fs.access(f.outputDir),{code:'ENOENT'});
  const open=triangles.slice(1),bytes=Buffer.from('solid open\n'+open.map(t => 'facet normal 0 0 0\nouter loop\n'+t.map(p => 'vertex '+p.join(' ')).join('\n')+'\nendloop\nendfacet').join('\n')+'\nendsolid open\n');
  await assert.rejects(prepareResinRepair({...base,source:bytes}),{code:'RESIN_MESH_REPAIR_OPEN'});await assert.rejects(fs.access(f.outputDir),{code:'ENOENT'});
});
