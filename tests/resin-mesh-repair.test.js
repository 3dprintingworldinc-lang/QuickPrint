'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { createHash }=require('node:crypto');
const { prepareResinMeshRepair,verifyResinMeshRepair,RESIN_MESH_REPAIR_LIMITS }=require('../src/slicing/resin-mesh-repair');
const { forEachResinTriangle }=require('../src/slicing/resin-geometry');
const { auditResinMesh }=require('../src/slicing/resin-mesh');
const hash=bytes => createHash('sha256').update(bytes).digest('hex');
const reverse=triangles => triangles.map(([a,b,c]) => [[...a],[...c],[...b]]);
function box(origin=[0,0,0],size=[1,1,1]) {
  const points=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].map(p => p.map((v,i) => Math.fround(origin[i]+v*size[i])));
  return [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]].map(face => face.map(i => [...points[i]]));
}
const tetra=points => [[0,2,1],[0,1,3],[0,3,2],[1,2,3]].map(face => face.map(i => points[i]));
function binary(triangles) {
  const buffer=Buffer.alloc(84+triangles.length*50);buffer.write('Owned exact mesh repair fixture');buffer.writeUInt32LE(triangles.length,80);
  triangles.forEach((t,i) => t.forEach((p,j) => p.forEach((v,k) => buffer.writeFloatLE(v,84+i*50+12+j*12+k*4))));return buffer;
}
function read(buffer) { const triangles=[];forEachResinTriangle(buffer,{ format:'stl',units:'mm' },t => triangles.push(t));return triangles; }
const geometryKey=t => t.map(p => p.map(v => v===0?0:v).join(',')).sort().join(';');
const geometricSet=buffer => [...new Set(read(buffer).map(geometryKey))].sort();
function torus(major=16,minor=8) {
  const points=[];
  for(let i=0;i<major;i++)for(let j=0;j<minor;j++){const u=2*Math.PI*i/major,v=2*Math.PI*j/minor;points.push([Math.fround((2+0.5*Math.cos(v))*Math.cos(u)+2.5),Math.fround((2+0.5*Math.cos(v))*Math.sin(u)+2.5),Math.fround(0.5*Math.sin(v)+0.5)]);}
  const point=(i,j) => points[(i%major)*minor+j%minor],triangles=[];
  for(let i=0;i<major;i++)for(let j=0;j<minor;j++)triangles.push([point(i,j),point(i+1,j),point(i+1,j+1)],[point(i,j),point(i+1,j+1),point(i,j+1)]);
  return triangles;
}

test('exact duplicate removal and local orientation repair account for every original face without changing any distinct triangle',() => {
  const cube=box(),source=binary([...reverse([cube[0]]),...cube.slice(1),cube[0],[cube[0][1],cube[0][2],cube[0][0]]]),before=Buffer.from(source);
  const { stl,proof }=prepareResinMeshRepair(source);
  assert.deepEqual(source,before);assert.equal(proof.sourceSha256,hash(source));assert.equal(proof.outputSha256,hash(stl));
  assert.deepEqual(geometricSet(stl),geometricSet(source));assert.equal(proof.sourceTriangleCount,14);assert.equal(proof.outputTriangleCount,12);
  assert.deepEqual(proof.operations,{ removedExactDuplicateFaces:2,reorientedUniqueFaces:1,reorientedSourceFaces:1,recomputedNormals:12,coordinatesMoved:0,holesFilled:0,uniqueTrianglesRemoved:0 });
  const input=read(source),output=read(stl);
  assert.deepEqual(proof.faces.map(f => f.sourceFace),input.map((_,i) => i));assert.equal(new Set(proof.faces.map(f => f.outputFace)).size,12);
  for(const face of proof.faces)assert.equal(geometryKey(input[face.sourceFace]),geometryKey(output[face.outputFace]));
  assert.equal(proof.faces[0].flipped,true);assert.equal(proof.faces[12].duplicate,true);assert.equal(proof.faces[12].outputFace,0);assert.equal(proof.faces[12].flipped,false);
  assert.equal(proof.components[0].signedVolumeMm3,1);assert.equal(proof.components[0].winding,'positive');
  assert.equal(proof.intersectionStatus,'not_checked');assert.equal(proof.cavityStatus,'not_classified');assert.equal(proof.solidCertified,false);assert.equal(proof.physicalPartCount,'not_inferred');
});

test('cyclic face ordering and opposite-wound duplicates retain exactly one geometric face; coplanar neighboring faces remain distinct',() => {
  const cube=box(),[a,b,c]=cube[0],source=binary([...cube,[b,c,a],[a,c,b]]),result=prepareResinMeshRepair(source);
  assert.equal(result.proof.outputTriangleCount,12);assert.equal(result.proof.operations.removedExactDuplicateFaces,2);
  assert.equal(result.proof.faces[12].flipped,false);assert.equal(result.proof.faces[13].flipped,true);
  assert.deepEqual(read(result.stl).slice(0,2).map(geometryKey),cube.slice(0,2).map(geometryKey));
  assert.deepEqual(geometricSet(result.stl),geometricSet(source));
});

test('a wholly inverted closed shell becomes outward while its coordinate bytes are only permuted within each face',() => {
  const source=binary(reverse(box())),result=prepareResinMeshRepair(source);
  assert.equal(result.proof.operations.reorientedUniqueFaces,12);assert.equal(result.proof.components[0].reversedAfterConsistency,true);
  assert.equal(result.proof.components[0].signedVolumeMm3,1);assert.deepEqual(geometricSet(source),geometricSet(result.stl));
  for(let i=0;i<12;i++)for(const [target,original]of [[0,0],[1,2],[2,1]])assert.ok(result.stl.subarray(84+i*50+12+target*12,84+i*50+24+target*12).equals(source.subarray(84+i*50+12+original*12,84+i*50+24+original*12)));
});

test('separated inverted components are repaired independently and a real 1e-6 mm gap is never welded',() => {
  const source=binary([...box(),...reverse(box([1.000001,0,0]))]),result=prepareResinMeshRepair(source),proof=result.proof;
  assert.equal(proof.componentCount,2);assert.equal(proof.vertexCount,16);assert.equal(proof.outputTriangleCount,24);assert.equal(proof.operations.reorientedUniqueFaces,12);
  assert.deepEqual(proof.components.map(c => c.signedVolumeMm3),[1,1]);assert.ok(proof.components[1].boundsMm.min.x > 1);
  assert.deepEqual(geometricSet(source),geometricSet(result.stl));assert.equal(proof.operations.coordinatesMoved,0);
  assert.deepEqual(proof.components.map(c => c.reversedAfterConsistency),[false,true]);
});

test('overlapping, nesting and touching component AABBs are held without guessing cavity semantics',() => {
  for(const second of [box([0.25,0.25,0.25],[0.25,0.25,0.25]),box([0.5,0.5,0.5]),box([1,0.25,0.25],[1,0.5,0.5])]) {
    const source=binary([...box(),...reverse(second)]),before=Buffer.from(source);
    assert.throws(() => prepareResinMeshRepair(source),{ code:'RESIN_MESH_REPAIR_AMBIGUOUS_COMPONENTS' });assert.deepEqual(source,before);
  }
});

test('open holes and isolated nondegenerate triangles are never silently filled or dropped',() => {
  for(const triangles of [box().slice(1),[...box(),[[10,0,0],[11,0,0],[10,1,0]]]]) {
    const source=binary(triangles),before=Buffer.from(source);
    assert.throws(() => prepareResinMeshRepair(source),{ code:'RESIN_MESH_REPAIR_OPEN' });assert.deepEqual(source,before);
  }
});

test('third edge incidence and a closed bow-tie vertex fail independent manifold checks',() => {
  const first=tetra([[0,0,0],[1,0,0],[0,1,0],[0,0,1]]);
  const edgeSharing=tetra([[0,0,0],[1,0,0],[0,-1,0],[0,0,-1]]);
  assert.throws(() => prepareResinMeshRepair(binary([...first,...edgeSharing])),{ code:'RESIN_MESH_REPAIR_NON_MANIFOLD_EDGE' });
  const opposite=tetra([[0,0,0],[-1,0,0],[0,-1,0],[0,0,-1]]),bowtie=[...first,...opposite].map(t => t.map(p => p.map(v => v+1)));
  assert.throws(() => prepareResinMeshRepair(binary(bowtie)),{ code:'RESIN_MESH_NON_MANIFOLD_VERTEX' });
});

test('closed non-orientable topology and zero-volume shells are held rather than changing geometric faces',() => {
  const points=[[0,0,0],[2,0,0],[0,3,0],[0,0,5],[1,2,3],[4,5,6]],projectiveFaces=[[1,2,3],[1,2,4],[1,3,5],[1,4,6],[1,5,6],[2,3,6],[2,4,5],[2,5,6],[3,4,5],[3,4,6]];
  const source=binary(projectiveFaces.map(face => face.map(i => points[i-1]))),before=Buffer.from(source);
  assert.throws(() => prepareResinMeshRepair(source),{ code:'RESIN_MESH_REPAIR_NON_ORIENTABLE' });assert.deepEqual(source,before);
  const flat=tetra([[0,0,0],[1,0,0],[0,1,0],[0.25,0.25,0]]);
  assert.throws(() => prepareResinMeshRepair(binary(flat)),{ code:'RESIN_MESH_VOLUME_INVALID' });
});

test('a curved genus-one frame repairs one face and duplicate while preserving its tunnel and all exact source coordinates',() => {
  const original=torus(),flawed=original.map(t => t.map(p => [...p]));[flawed[17][1],flawed[17][2]]=[flawed[17][2],flawed[17][1]];
  const source=binary([...flawed,original[0]]),result=prepareResinMeshRepair(source);
  assert.equal(result.proof.outputTriangleCount,256);assert.equal(result.proof.componentCount,1);assert.equal(result.proof.operations.removedExactDuplicateFaces,1);
  assert.deepEqual(result.proof.faces.filter(f => f.flipped).map(f => f.sourceFace),[17]);assert.deepEqual(geometricSet(result.stl),geometricSet(source));
  const audited=auditResinMesh(result.stl,{ format:'stl',units:'mm' });assert.equal(audited.vertexCount-audited.edgeCount+audited.triangleCount,0);
  assert.ok(audited.signedShellVolumeMm3>8 && audited.signedShellVolumeMm3<10);
});

test('large-offset float32 components preserve small representable features and translation-stable signed volume',() => {
  const source=binary([...box([0,0,0],[16,16,16]),...reverse(box([100000000,100000000,100000000],[16,16,16]))]),result=prepareResinMeshRepair(source);
  assert.deepEqual(result.proof.components.map(c => c.signedVolumeMm3),[4096,4096]);assert.deepEqual(geometricSet(result.stl),geometricSet(source));
  assert.equal(result.proof.outputBoundsMm.max.x,100000016);assert.equal(result.proof.operations.coordinatesMoved,0);
});

test('normals are recomputed consistently with every emitted face winding',() => {
  const source=binary(reverse(torus())),{ stl }=prepareResinMeshRepair(source),triangles=read(stl);
  triangles.forEach(([p,q,r],i) => { const a=q.map((v,k) => v-p[k]),b=r.map((v,k) => v-p[k]),n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],actual=[0,1,2].map(k => stl.readFloatLE(84+i*50+k*4));assert.ok(n.reduce((sum,v,k) => sum+v*actual[k],0)>0);assert.ok(Math.abs(Math.hypot(...actual)-1)<1e-6); });
});

test('proof and output are deterministic, frozen, JSON round-trip stable and independently rederived',() => {
  const source=binary([...box(),box()[0]]),options={ limits:{ maxTriangles:20,maxVertices:20,maxEdges:30,maxComponents:2 } },first=prepareResinMeshRepair(source,options),second=prepareResinMeshRepair(source,options);
  assert.deepEqual(first,second);assert.ok(Object.isFrozen(first.proof.faces[0]));assert.throws(() => { first.proof.faces[0].outputFace=8; },TypeError);
  const record={ stl:Buffer.from(first.stl),proof:JSON.parse(JSON.stringify(first.proof)) };
  assert.deepEqual(verifyResinMeshRepair(source,record),first.proof);assert.deepEqual(verifyResinMeshRepair(source,record,options),first.proof);
});

test('changing bytes, any accounting record or its claimed identity cannot pass verification',() => {
  const source=binary([...box(),box()[0]]),result=prepareResinMeshRepair(source);
  for(const mutate of [r => { r.stl[12]^=1; },r => { r.stl[96]^=1; },r => { r.proof.faces[12].outputFace=1; },r => { r.proof.faces[0].flipped=!r.proof.faces[0].flipped; },r => { r.proof.outputSha256='0'.repeat(64); },r => { r.proof.components[0].volumeMm3=99; },r => { r.proof.operations.coordinatesMoved=1; },r => { r.proof.method='other'; },r => { r.proof.proofSha256='0'.repeat(64); }]) {
    const record={ stl:Buffer.from(result.stl),proof:JSON.parse(JSON.stringify(result.proof)) };mutate(record);
    assert.throws(() => verifyResinMeshRepair(source,record),{ code:'RESIN_MESH_REPAIR_CHANGED' });
  }
});

test('input normalization, geometry grammar, facet metadata and option bounds remain explicit',() => {
  const source=binary(box()),attribute=Buffer.from(source),nan=Buffer.from(source);attribute.writeUInt16LE(1,84+48);nan.writeFloatLE(NaN,84+12);
  for(const bytes of [Buffer.alloc(0),Buffer.from('solid empty\nendsolid empty\n'),source.subarray(0,-1),binary(box([1,1,1])),attribute])assert.throws(() => prepareResinMeshRepair(bytes),{ code:'RESIN_MESH_REPAIR_INPUT' });
  assert.throws(() => prepareResinMeshRepair(nan));
  for(const options of [null,[],{units:'in'},{limits:{maxTriangles:0}},{limits:{maxTriangles:250001}},{limits:{maxTimeMs:'10'}},{limits:{unknown:1}},{limits:{[Symbol('hidden')]:1}}])assert.throws(() => prepareResinMeshRepair(source,options),{ code:'RESIN_MESH_REPAIR_OPTIONS' });
});

test('byte, triangle, vertex, edge, component, proof and elapsed-work limits fail closed',() => {
  const source=binary(box());
  for(const limits of [{maxBytes:source.length-1},{maxTriangles:11},{maxVertices:7},{maxEdges:17},{maxProofBytes:100}])assert.throws(() => prepareResinMeshRepair(source,{limits}),e => ['RESIN_MESH_REPAIR_INPUT','RESIN_MESH_REPAIR_LIMIT'].includes(e.code));
  assert.throws(() => prepareResinMeshRepair(binary([...box(),...box([3,0,0])]),{limits:{maxComponents:1}}),{ code:'RESIN_MESH_REPAIR_LIMIT' });
  assert.throws(() => prepareResinMeshRepair(binary(torus(64,64)),{limits:{maxTimeMs:1}}),{ code:'RESIN_MESH_REPAIR_TIMEOUT' });
  assert.equal(RESIN_MESH_REPAIR_LIMITS.maxTriangles,250000);assert.equal(RESIN_MESH_REPAIR_LIMITS.maxVertices,250000);
});
