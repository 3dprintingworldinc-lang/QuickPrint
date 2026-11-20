'use strict';

// Explicit exact triangle edits only. This is neither a hole filler nor an
// intersection/cavity classifier, and it never establishes physical part count.
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const { forEachResinTriangle } = require('./resin-geometry');
const { auditResinMesh, RESIN_MESH_LIMITS } = require('./resin-mesh');

const METHOD = 'exact-mesh-repair-v1';
const LIMITS = Object.freeze({ ...RESIN_MESH_LIMITS, maxProofBytes: 64 * 1024 * 1024 });
const AXES = ['x','y','z'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'RESIN_MESH_REPAIR_INVALID', status = 422) => Object.assign(new Error(message), { code, status });
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const next = halfedge => halfedge - halfedge % 3 + (halfedge % 3 + 1) % 3;
const faceKey = ids => [...ids].sort((a,b) => a-b).join(':');
const parity = ([a,b,c]) => ((a>b) + (a>c) + (b>c)) & 1;
const pointKey = point => point.map(value => value === 0 ? 0 : value).join(',');
const boundsObject = (minimum,maximum) => ({ min: Object.fromEntries(AXES.map((axis,i) => [axis,minimum[i] === 0 ? 0 : minimum[i]])), max: Object.fromEntries(AXES.map((axis,i) => [axis,maximum[i] === 0 ? 0 : maximum[i]])) });

function settings(options) {
  if (!plain(options) || Reflect.ownKeys(options).some(key => key !== 'limits') || (options.limits !== undefined && !plain(options.limits))) throw fail('Supply only bounded mesh repair limits.', 'RESIN_MESH_REPAIR_OPTIONS', 400);
  const limits = { ...LIMITS };
  if (options.limits && Reflect.ownKeys(options.limits).some(key => typeof key !== 'string' || !Object.hasOwn(LIMITS,key))) throw fail('Mesh repair limits contain an unsupported key.', 'RESIN_MESH_REPAIR_OPTIONS',400);
  for (const [key,value] of Object.entries(options.limits || {})) {
    if (!Object.hasOwn(LIMITS,key) || !Number.isSafeInteger(value) || value < 1 || value > LIMITS[key]) throw fail('Mesh repair limits may only lower positive hard bounds.', 'RESIN_MESH_REPAIR_OPTIONS', 400);
    limits[key] = value;
  }
  return limits;
}

function prepareResinMeshRepair(source, options = {}) {
  const limits = settings(options), started = performance.now(); let steps = 0;
  const check = () => { if (performance.now()-started > limits.maxTimeMs) throw fail('Exact mesh repair exceeded its time budget.', 'RESIN_MESH_REPAIR_TIMEOUT', 413); };
  const tick = () => { if (!(steps++ & 255)) check(); };
  if (!Buffer.isBuffer(source) || source.length < 84 || source.length > limits.maxBytes) throw fail('Supply a bounded normalized binary millimetre STL.', 'RESIN_MESH_REPAIR_INPUT', 400);
  const sourceCount = source.readUInt32LE(80);
  if (!sourceCount || 84+sourceCount*50 !== source.length) throw fail('Repair requires the normalized binary STL triangle table.', 'RESIN_MESH_REPAIR_INPUT', 400);
  if (sourceCount > limits.maxTriangles) throw fail('Source triangle count exceeds the repair limit.', 'RESIN_MESH_REPAIR_LIMIT', 413);
  const vertices = new Uint32Array(sourceCount*3), twins = new Int32Array(sourceCount*3).fill(-1);
  const sourceToOutput = new Uint32Array(sourceCount), sourceParity = new Uint8Array(sourceCount), retainedSources = [], retainedParity = [], keys = [];
  const coordinates = [], vertexIds = new Map(), groups = new Map(), edges = new Map();
  const minimum = [Infinity,Infinity,Infinity], maximum = [-Infinity,-Infinity,-Infinity], edgeBase = LIMITS.maxVertices+1;
  const identify = point => {
    const key = pointKey(point); let id = vertexIds.get(key);
    if (id !== undefined) return id;
    if (coordinates.length >= limits.maxVertices) throw fail('Source exceeds the exact vertex limit.', 'RESIN_MESH_REPAIR_LIMIT', 413);
    id = coordinates.length; vertexIds.set(key,id); coordinates.push(point);
    for (let axis=0;axis<3;axis++) { minimum[axis] = Math.min(minimum[axis],point[axis]); maximum[axis] = Math.max(maximum[axis],point[axis]); }
    return id;
  };
  try {
    forEachResinTriangle(source,{ format: 'stl',units: 'mm',limits: { maxBytes: limits.maxBytes,maxTriangles: limits.maxTriangles,maxVertices: limits.maxVertices } },(points,index) => {
      tick();
      if (source.readUInt16LE(84+index*50+48) !== 0) throw fail('Normalized STL repair does not discard facet attribute/color data.', 'RESIN_MESH_REPAIR_INPUT', 400);
      const ids = points.map(identify), key = faceKey(ids), orientation = parity(ids), existing = groups.get(key);
      sourceParity[index] = orientation;
      if (existing !== undefined) { sourceToOutput[index] = existing; return; }
      const output = retainedSources.length;
      groups.set(key,output); sourceToOutput[index] = output; retainedSources.push(index); retainedParity.push(orientation); keys.push(key);
      ids.forEach((id,at) => { vertices[output*3+at] = id; });
      for (let at=0;at<3;at++) {
        const halfedge = output*3+at, a = ids[at], b = ids[(at+1)%3], edge = Math.min(a,b)*edgeBase+Math.max(a,b), previous = edges.get(edge);
        if (previous === undefined) {
          if (edges.size >= limits.maxEdges) throw fail('Source exceeds the exact edge limit.', 'RESIN_MESH_REPAIR_LIMIT', 413);
          edges.set(edge,halfedge);
        } else {
          if (twins[previous] !== -1) throw fail('Distinct source triangles have a non-manifold edge; none can be discarded.', 'RESIN_MESH_REPAIR_NON_MANIFOLD_EDGE');
          twins[halfedge] = previous; twins[previous] = halfedge;
        }
      }
    });
  } catch (failure) {
    if (failure.code === 'RESIN_GEOMETRY_LIMIT') throw fail(failure.message,'RESIN_MESH_REPAIR_LIMIT',413);
    throw failure;
  }
  check();
  if (minimum.some(value => value !== 0)) throw fail('Repair input must already have a common zero origin in millimetres.', 'RESIN_MESH_REPAIR_INPUT',400);
  const count = retainedSources.length, vertexCount = coordinates.length, edgeCount = edges.size;
  for (let halfedge=0;halfedge<count*3;halfedge++) { tick(); if (twins[halfedge] === -1) throw fail('Open source boundaries require an explicit geometric change; exact repair cannot fill them.', 'RESIN_MESH_REPAIR_OPEN'); }
  const flips = new Int8Array(count).fill(-1), labels = new Uint32Array(count), queue = new Uint32Array(count);
  let componentCount = 0;
  for (let seed=0;seed<count;seed++) {
    tick(); if (flips[seed] !== -1) continue;
    if (componentCount >= limits.maxComponents) throw fail('Source exceeds the component limit.', 'RESIN_MESH_REPAIR_LIMIT',413);
    componentCount++; let head=0,tail=1; queue[0]=seed; flips[seed]=0; labels[seed]=componentCount;
    while (head<tail) {
      tick(); const triangle=queue[head++];
      for (let at=0;at<3;at++) {
        const halfedge=triangle*3+at,twin=twins[halfedge],neighbor=Math.floor(twin/3);
        const sameDirection=vertices[halfedge]===vertices[twin],expected=flips[triangle] ^ Number(sameDirection);
        if (flips[neighbor] === -1) { flips[neighbor]=expected;labels[neighbor]=componentCount;queue[tail++]=neighbor; }
        else if (flips[neighbor] !== expected) throw fail('The exact source topology is not orientable.', 'RESIN_MESH_REPAIR_NON_ORIENTABLE');
      }
    }
  }
  const outputBytes=84+count*50;
  if (outputBytes > limits.maxBytes) throw fail('Repaired STL exceeds the output limit.', 'RESIN_MESH_REPAIR_LIMIT',413);
  const emit = () => {
    const stl=Buffer.alloc(outputBytes); stl.write('QuickPrint exact mesh repair v1; millimetres'); stl.writeUInt32LE(count,80);
    for (let index=0;index<count;index++) {
      tick(); const sourceOffset=84+retainedSources[index]*50,targetOffset=84+index*50;
      const order=flips[index] ? [0,2,1] : [0,1,2];
      // Copy original float32 coordinate bytes. No rounding, origin change,
      // unit conversion or tolerance weld takes place in this operation.
      order.forEach((original,at) => source.copy(stl,targetOffset+12+at*12,sourceOffset+12+original*12,sourceOffset+24+original*12));
      const points=order.map(at => coordinates[vertices[index*3+at]]),a=points[1].map((v,axis) => v-points[0][axis]),b=points[2].map((v,axis) => v-points[0][axis]);
      const normal=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],length=Math.hypot(...normal);
      if (!Number.isFinite(length) || length === 0) throw fail('A retained triangle has no finite normal.', 'RESIN_MESH_REPAIR_INVALID');
      normal.forEach((value,axis) => stl.writeFloatLE(value/length,targetOffset+axis*4));
    }
    return stl;
  };
  const audit = stl => {
    check(); const remaining=Math.max(1,Math.floor(limits.maxTimeMs-(performance.now()-started)));
    const { maxProofBytes,...auditLimits }=limits;
    const result=auditResinMesh(stl,{ format: 'stl',units: 'mm',limits: { ...auditLimits,maxTimeMs: Math.min(limits.maxTimeMs,remaining) } });
    check(); return result;
  };
  const baseAudit=audit(emit());
  if (baseAudit.componentCount !== componentCount) throw fail('Independent component accounting disagrees.', 'RESIN_MESH_REPAIR_CHANGED');
  // AABB separation is deliberately conservative. Contact, nesting or overlap
  // cannot establish independent outward shells without a cavity classifier.
  for (let index=0;index<componentCount;index++) for (let other=0;other<index;other++) {
    tick(); const a=baseAudit.components[index].boundsMm,b=baseAudit.components[other].boundsMm;
    if (!AXES.some(axis => a.max[axis] < b.min[axis] || b.max[axis] < a.min[axis])) throw fail('Overlapping, touching or nested component bounds require cavity/intersection review.', 'RESIN_MESH_REPAIR_AMBIGUOUS_COMPONENTS');
  }
  const componentReversed=baseAudit.components.map(component => component.signedVolumeMm3 < 0);
  for (let index=0;index<count;index++) { tick(); if (componentReversed[labels[index]-1]) flips[index]^=1; }
  const stl=emit(),outputAudit=audit(stl);
  if (outputAudit.components.some(component => component.winding !== 'positive')) throw fail('Repair did not establish positive oriented closed components.', 'RESIN_MESH_REPAIR_CHANGED');
  // Independently parse the written bytes and compare their exact vertex IDs
  // and geometric face identities with every retained unique source triangle.
  const written=new Set();
  forEachResinTriangle(stl,{ format:'stl',units:'mm',limits:{ maxBytes:limits.maxBytes,maxTriangles:limits.maxTriangles,maxVertices:limits.maxVertices } },(points,index) => {
    tick(); const ids=points.map(point => vertexIds.get(pointKey(point)));
    if (ids.some(id => id === undefined) || faceKey(ids) !== keys[index] || parity(ids) !== (retainedParity[index]^flips[index]) || written.has(keys[index])) throw fail('Emitted geometry is not the exact unique source triangle set.', 'RESIN_MESH_REPAIR_CHANGED');
    written.add(keys[index]);
  });
  if (written.size !== groups.size || outputAudit.vertexCount !== vertexCount || outputAudit.triangleCount !== count || !isDeepStrictEqual(outputAudit.boundsMm,boundsObject(minimum,maximum))) throw fail('Repair changed source geometry or independent counts.', 'RESIN_MESH_REPAIR_CHANGED');
  const faces=[]; let sourceFlips=0;
  for (let sourceFace=0;sourceFace<sourceCount;sourceFace++) {
    tick(); const outputFace=sourceToOutput[sourceFace],flipped=Boolean(sourceParity[sourceFace]^retainedParity[outputFace]^flips[outputFace]);
    sourceFlips+=Number(flipped);
    faces.push({ sourceFace,outputFace,componentId:labels[outputFace],duplicate:retainedSources[outputFace]!==sourceFace,flipped });
  }
  const body={ schemaVersion:1,method:METHOD,coordinateUnits:'mm',sourceSha256:hash(source),sourceBytes:source.length,outputSha256:hash(stl),outputBytes:stl.length,
    sourceTriangleCount:sourceCount,outputTriangleCount:count,vertexCount,edgeCount,componentCount,sourceBoundsMm:boundsObject(minimum,maximum),outputBoundsMm:outputAudit.boundsMm,
    operations:{ removedExactDuplicateFaces:sourceCount-count,reorientedUniqueFaces:flips.reduce((sum,value) => sum+value,0),reorientedSourceFaces:sourceFlips,recomputedNormals:count,coordinatesMoved:0,holesFilled:0,uniqueTrianglesRemoved:0 },
    orientationPolicy:'positive-single-or-strictly-disjoint-component-aabbs',faces,
    components:outputAudit.components.map((component,index) => ({ ...component,reversedAfterConsistency:componentReversed[index] })),topology:outputAudit.topology,
    intersectionStatus:'not_checked',cavityStatus:'not_classified',solidCertified:false,physicalPartCount:'not_inferred',limits:{...limits} };
  const serialized=JSON.stringify(canonical(body));
  if (Buffer.byteLength(serialized)+100 > limits.maxProofBytes) throw fail('Repair face accounting exceeds the proof byte limit.', 'RESIN_MESH_REPAIR_LIMIT',413);
  check(); const proof=freeze({ ...body,proofSha256:hash(serialized) }); check();
  return Object.freeze({ stl,proof });
}

function verifyResinMeshRepair(source, record, options) {
  if (!plain(record) || Reflect.ownKeys(record).length !== 2 || Reflect.ownKeys(record).some(key => key !== 'stl' && key !== 'proof') || !Buffer.isBuffer(record.stl) || !plain(record.proof) || record.proof.method !== METHOD) throw fail('Supply the complete exact mesh repair output and proof.', 'RESIN_MESH_REPAIR_CHANGED',409);
  const rebuilt=prepareResinMeshRepair(source,options === undefined ? { limits:record.proof.limits } : options);
  if (!record.stl.equals(rebuilt.stl) || !isDeepStrictEqual(record.proof,rebuilt.proof)) throw fail('Repair bytes or complete source-face accounting changed.', 'RESIN_MESH_REPAIR_CHANGED',409);
  return rebuilt.proof;
}

module.exports={ prepareResinMeshRepair,verifyResinMeshRepair,RESIN_MESH_REPAIR_LIMITS:LIMITS };
