'use strict';

// A bounded audit of encoded raster intervals. It is not a CAD kernel, a cured
// resin model, or a geometric/physical wall or drainage certificate.
// Boundary policy is explicit: exact-raster preserves interval equality in the
// outer band; voxel-enclosure uses only the supplied uncertainty and full-grid
// source material/black sample-center distance witnesses. It never retries with
// a wider band. Processed-source exterior seeds must reach the frame halo while
// remaining outside the source and within actual processed void.
// Voxel enclosure also retains the strict definite thin-wall loss guard: even
// binary surface erosion within the boundary band may be held. This is not a
// continuous-surface Hausdorff bound or a geometric wall certificate.
const { performance } = require('node:perf_hooks');

const LIMITS = Object.freeze({ maxVoxels: 20000000, maxAxisLength: 65536, maxDrains: 64,
  maxWorkingBytes: 768 * 1024 * 1024, maxOperations: 2000000000, maxTimeMs: 300000, maxWitnesses: 8 });
const DEFAULT_TIME_MS = 60000;
const AXES = ['x','y','z'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail = (message,code = 'RESIN_HOLLOW_GRID_INPUT',status = 400) => Object.assign(new Error(message),{ code,status });
function exact(value,keys,label) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key => !keys.includes(key))) throw fail(`${label} has unsupported or missing fields.`);
}
function number(value,label,minimum,maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw fail(`${label} is outside the supported finite range.`);
  return value === 0 ? 0 : value;
}
function vector(value,label,minimum,maximum) {
  exact(value,AXES,label);
  return Object.fromEntries(AXES.map(axis => [axis,number(value[axis],label,minimum,maximum)]));
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function readLimits(value) {
  if (value === undefined) return { ...LIMITS, maxTimeMs: DEFAULT_TIME_MS };
  if (!plain(value) || Reflect.ownKeys(value).some(key => !Object.hasOwn(LIMITS,key))) throw fail('Grid limits contain an unsupported key.','RESIN_HOLLOW_GRID_LIMITS');
  for (const [key,item] of Object.entries(value)) if (!Number.isSafeInteger(item) || item < 1 || item > LIMITS[key]) throw fail('Grid limits may only lower positive whole-number hard bounds.','RESIN_HOLLOW_GRID_LIMITS');
  return { ...LIMITS, maxTimeMs: DEFAULT_TIME_MS, ...value };
}
function workBudget(limits,signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('Use a native AbortSignal.');
  const started = performance.now(); let operations = 0;
  return {
    check() {
      if (signal?.aborted) throw fail('The hollow raster audit was cancelled.','RESIN_HOLLOW_GRID_ABORTED',499);
      if (performance.now()-started > limits.maxTimeMs) throw fail('The hollow raster audit exceeded its deadline.','RESIN_HOLLOW_GRID_TIMEOUT',413);
    },
    step(count = 1) {
      operations += count;
      if (!Number.isSafeInteger(operations) || operations > limits.maxOperations) throw fail('The hollow raster audit exceeded its operation budget.','RESIN_HOLLOW_GRID_OPERATIONS',413);
      if (count > 1 || !(operations & 1023)) this.check();
    },
    get operations() { return operations; },
  };
}
function validate(input) {
  if (!plain(input) || Reflect.ownKeys(input).some(key => !['solid','hollow','frame','wallThicknessMm','uncertaintyMm','drains','boundaryPolicy','exteriorSeedPolicy','limits','signal'].includes(key))) throw fail('Supply only the declared raster grid audit fields.');
  const boundaryPolicy=input.boundaryPolicy===undefined?'exact-raster':input.boundaryPolicy;
  if (!['exact-raster','voxel-enclosure'].includes(boundaryPolicy)) throw fail('Choose an explicit supported raster boundary policy.');
  const exteriorSeedPolicy=input.exteriorSeedPolicy===undefined?'source-exterior':input.exteriorSeedPolicy;
  if (!['source-exterior','processed-source-exterior'].includes(exteriorSeedPolicy)) throw fail('Choose an explicit supported drain exterior seed policy.');
  const limits = readLimits(input.limits), work = workBudget(limits,input.signal); work.check();
  exact(input.frame,['nx','ny','nz','pitchMm','originMm','direction'],'Grid frame');
  const frame = { nx:input.frame.nx,ny:input.frame.ny,nz:input.frame.nz,
    pitchMm:vector(input.frame.pitchMm,'Voxel pitch',1e-9,10000),originMm:vector(input.frame.originMm,'Grid origin',-1000000,1000000),direction:vector(input.frame.direction,'Grid direction',-1,1) };
  for (const key of ['nx','ny','nz']) if (!Number.isSafeInteger(frame[key]) || frame[key] < 3 || frame[key] > limits.maxAxisLength) throw fail('Grid dimensions require bounded whole numbers and an exterior halo.','RESIN_HOLLOW_GRID_DIMENSIONS');
  if (![1,-1].includes(frame.direction.x) || ![1,-1].includes(frame.direction.y) || frame.direction.z !== 1) throw fail('Grid X/Y directions must be ±1 and Z must increase.');
  const plane = frame.nx*frame.ny, count = plane*frame.nz, longest = Math.max(frame.nx,frame.ny,frame.nz);
  if (!Number.isSafeInteger(count) || count > limits.maxVoxels) throw fail('The grid exceeds its voxel bound.','RESIN_HOLLOW_GRID_VOXELS',413);
  for (const axis of AXES) if (frame.pitchMm[axis]*frame['n'+axis] > 1000000) throw fail('The grid physical extent is unsupported.');
  const wall = number(input.wallThicknessMm,'Wall thickness',1e-9,10000), uncertainty = number(input.uncertaintyMm,'Raster uncertainty',0,10000);
  const buffers = new Set(), arrays = [];
  for (const [label,interval] of [['Solid',input.solid],['Hollow',input.hollow]]) {
    exact(interval,['lower','upper'],label+' intervals');
    for (const key of ['lower','upper']) {
      const array = interval[key];
      if (!(array instanceof Uint8Array) || array.length !== count || array.byteLength !== count || (typeof SharedArrayBuffer !== 'undefined' && array.buffer instanceof SharedArrayBuffer)) throw fail('Each interval must be a nonshared Uint8Array matching the complete grid.','RESIN_HOLLOW_GRID_ARRAY');
      buffers.add(array.buffer); arrays.push(array);
    }
  }
  if (!Array.isArray(input.drains) || !input.drains.length || input.drains.length > limits.maxDrains) throw fail('Provide a bounded nonempty list of explicit drain cylinders.','RESIN_HOLLOW_GRID_DRAINS');
  const ids = new Set(), drains = input.drains.map(drain => {
    exact(drain,['id','startMm','direction','radiusMm','lengthMm'],'Drain');
    if (typeof drain.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(drain.id) || ids.has(drain.id)) throw fail('Drain identifiers must be unique bounded ASCII strings.','RESIN_HOLLOW_GRID_DRAINS');
    ids.add(drain.id);
    const start = vector(drain.startMm,'Drain start',-1000000,1000000), direction = vector(drain.direction,'Drain direction',-1,1);
    if (Math.abs(Math.hypot(direction.x,direction.y,direction.z)-1) > 1e-12) throw fail('Drain directions must be explicit unit vectors.','RESIN_HOLLOW_GRID_DRAINS');
    return { id:drain.id,startMm:start,direction,radiusMm:number(drain.radiusMm,'Drain radius',1e-9,10000),lengthMm:number(drain.lengthMm,'Drain length',1e-9,1000000) };
  });
  // Two Float64 fields, expected/owner/three visited masks, and one shared
  // Uint32 queue. One 1D Float64/Int32 envelope scratch set serves every pass.
  const additionalArrayBytes = count*25+longest*20+8, inputViewBytes = count*4;
  const backingBytes = [...buffers].reduce((sum,buffer) => sum+buffer.byteLength,0);
  if (!Number.isSafeInteger(additionalArrayBytes) || Math.max(backingBytes,inputViewBytes)+additionalArrayBytes > limits.maxWorkingBytes) throw fail('The complete input and working arrays exceed the memory budget.','RESIN_HOLLOW_GRID_MEMORY',413);
  const [solidLower,solidUpper,hollowLower,hollowUpper] = arrays;
  for (let z=0;z<frame.nz;z++) for (let y=0;y<frame.ny;y++) for (let x=0;x<frame.nx;x++) {
    work.step(); const i=z*plane+y*frame.nx+x;
    if (solidLower[i]>solidUpper[i] || hollowLower[i]>hollowUpper[i]) throw fail('Every lower interval sample must be no greater than its upper sample.','RESIN_HOLLOW_GRID_INTERVAL');
    if ((x===0 || y===0 || z===0 || x===frame.nx-1 || y===frame.ny-1 || z===frame.nz-1) && solidUpper[i] !== 0) throw fail('The solid reference requires one entirely empty exterior halo.','RESIN_HOLLOW_GRID_HALO');
  }
  work.check();
  return { frame,plane,count,longest,wall,uncertainty,drains,boundaryPolicy,exteriorSeedPolicy,limits,work,solid:{ lower:solidLower,upper:solidUpper },hollow:{ lower:hollowLower,upper:hollowUpper },memory:{ inputViewBytes,additionalArrayBytes,conservativeVisiblePeakBytes:inputViewBytes+additionalArrayBytes } };
}
function distanceField(interval,lower,config,scratch,target,materialSites=false) {
  const { frame,plane,count,work } = config, distance = target??new Float64Array(count),{ values,sites,cuts } = scratch;
  for (let i=0;i<count;i++) { work.step(); const material=lower?interval.lower[i]===255:interval.upper[i]>0; distance[i]=(materialSites?!material:material)?Infinity:0; }
  const line = (base,stride,length,pitch) => {
    for (let q=0;q<length;q++) { work.step(); values[q]=distance[base+q*stride]; }
    let first=0; while (first<length && !Number.isFinite(values[first])) { work.step(); first++; }
    // A line without a site remains infinite until the later axes encounter a
    // finite site. An entirely empty source has infinite material distance.
    if (first===length) return;
    let k=0; sites[0]=first; cuts[0]=-Infinity; cuts[1]=Infinity; const weight=pitch*pitch;
    for (let q=first+1;q<length;q++) {
      work.step(); if (!Number.isFinite(values[q])) continue;
      let prior=sites[k],split=((values[q]+weight*q*q)-(values[prior]+weight*prior*prior))/(2*weight*(q-prior));
      while (split<=cuts[k]) { work.step(); k--; prior=sites[k]; split=((values[q]+weight*q*q)-(values[prior]+weight*prior*prior))/(2*weight*(q-prior)); }
      sites[++k]=q; cuts[k]=split; cuts[k+1]=Infinity;
    }
    k=0;
    for (let q=0;q<length;q++) { work.step(); while (cuts[k+1]<q) { work.step(); k++; } const delta=q-sites[k]; distance[base+q*stride]=weight*delta*delta+values[sites[k]]; }
  };
  for (let z=0;z<frame.nz;z++) for (let y=0;y<frame.ny;y++) line(z*plane+y*frame.nx,1,frame.nx,frame.pitchMm.x);
  for (let z=0;z<frame.nz;z++) for (let x=0;x<frame.nx;x++) line(z*plane+x,frame.nx,frame.ny,frame.pitchMm.y);
  for (let y=0;y<frame.ny;y++) for (let x=0;x<frame.nx;x++) line(y*frame.nx+x,plane,frame.nz,frame.pitchMm.z);
  return distance;
}
function coordinates(i,config) {
  const { frame,plane }=config,x=i%frame.nx,y=Math.floor(i/frame.nx)%frame.ny,z=Math.floor(i/plane);
  return { x:frame.originMm.x+frame.direction.x*(x+.5)*frame.pitchMm.x,
    y:frame.originMm.y+frame.direction.y*(y+.5)*frame.pitchMm.y,z:frame.originMm.z+(z+.5)*frame.pitchMm.z };
}
function cylinder(tool,point,uncertainty,lower) {
  const x=point.x-tool.startMm.x,y=point.y-tool.startMm.y,z=point.z-tool.startMm.z;
  const along=x*tool.direction.x+y*tool.direction.y+z*tool.direction.z,radius=tool.radiusMm+(lower?-uncertainty:uncertainty);
  // A cross product avoids subtracting nearly equal squared axial lengths
  // when a short-radius cylinder begins far from this bounded model.
  const a=y*tool.direction.z-z*tool.direction.y,b=z*tool.direction.x-x*tool.direction.z,c=x*tool.direction.y-y*tool.direction.x;
  return radius>0 && along>=(lower?uncertainty:-uncertainty) && along<=tool.lengthMm+(lower?-uncertainty:uncertainty) && a*a+b*b+c*c<=radius*radius;
}
function toolRoi(tool,config) {
  const { frame,uncertainty }=config,radius=tool.radiusMm+uncertainty,roi={};
  for (const axis of AXES) {
    const end=tool.startMm[axis]+tool.direction[axis]*tool.lengthMm,a=(Math.min(tool.startMm[axis],end)-radius-frame.originMm[axis])/(frame.direction[axis]*frame.pitchMm[axis])-.5,
      b=(Math.max(tool.startMm[axis],end)+radius-frame.originMm[axis])/(frame.direction[axis]*frame.pitchMm[axis])-.5;
    // One integer cell of search padding prevents floating-point ROI rounding
    // from removing a tangent candidate. Exact cylinder tests still decide it.
    roi[axis]={ min:Math.max(0,Math.floor(Math.min(a,b))-1),max:Math.min(frame['n'+axis]-1,Math.ceil(Math.max(a,b))+1) };
  }
  return roi;
}
function eachRoi(roi,config,visit) {
  const { frame,plane,work }=config;
  for (let z=roi.z.min;z<=roi.z.max;z++) for (let y=roi.y.min;y<=roi.y.max;y++) for (let x=roi.x.min;x<=roi.x.max;x++) { work.step(); visit(z*plane+y*frame.nx+x); }
}
function eachBoundary(config,visit) {
  const { frame,plane,work }=config;
  for (let z=0;z<frame.nz;z++) for (let y=0;y<frame.ny;y++) { work.step(2); visit(z*plane+y*frame.nx); visit(z*plane+y*frame.nx+frame.nx-1); }
  for (let z=0;z<frame.nz;z++) for (let x=0;x<frame.nx;x++) { work.step(2); visit(z*plane+x); visit(z*plane+(frame.ny-1)*frame.nx+x); }
  for (let y=0;y<frame.ny;y++) for (let x=0;x<frame.nx;x++) { work.step(2); visit(y*frame.nx+x); visit((frame.nz-1)*plane+y*frame.nx+x); }
}
function flood(interval,possible,config,visited,queue,{ tool,roi,sourceExterior,allowed }={}) {
  const { frame,plane,work,uncertainty }=config;
  // Reset only the candidate region for per-drain work; cells outside the
  // cylinder are never read as visited/seeded for that restricted traversal.
  if (roi) eachRoi(roi,config,i=>{ visited[i]=0; }); else { work.step(config.count); visited.fill(0); }
  let head=0,tail=0,seeds=0;
  const accepts=i=>(!allowed || allowed[i]) && (possible?interval.lower[i]<255:interval.upper[i]===0) && (!tool || cylinder(tool,coordinates(i,config),uncertainty,!possible));
  const seed=i=>{ if (!visited[i] && (!sourceExterior || sourceExterior[i]) && accepts(i)) { visited[i]=1; queue[tail++]=i; seeds++; } };
  if (roi) eachRoi(roi,config,seed); else eachBoundary(config,seed);
  const add=(i,x,y,z)=>{
    work.step();
    if (roi && (x<roi.x.min || x>roi.x.max || y<roi.y.min || y>roi.y.max || z<roi.z.min || z>roi.z.max)) return;
    if (!visited[i] && accepts(i)) { visited[i]=1; queue[tail++]=i; }
  };
  while (head<tail) {
    work.step(); const i=queue[head++],x=i%frame.nx,y=Math.floor(i/frame.nx)%frame.ny,z=Math.floor(i/plane);
    if (possible) {
      for (let zz=Math.max(0,z-1);zz<=Math.min(frame.nz-1,z+1);zz++) for (let yy=Math.max(0,y-1);yy<=Math.min(frame.ny-1,y+1);yy++) for (let xx=Math.max(0,x-1);xx<=Math.min(frame.nx-1,x+1);xx++) if (xx!==x || yy!==y || zz!==z) add(zz*plane+yy*frame.nx+xx,xx,yy,zz);
    } else {
      if (x) add(i-1,x-1,y,z); if (x+1<frame.nx) add(i+1,x+1,y,z);
      if (y) add(i-frame.nx,x,y-1,z); if (y+1<frame.ny) add(i+frame.nx,x,y+1,z);
      if (z) add(i-plane,x,y,z-1); if (z+1<frame.nz) add(i+plane,x,y,z+1);
    }
  }
  return { seeds,visitedCells:tail };
}
function auditResinHollowGrid(input) {
  const config=validate(input),{ solid,hollow,frame,plane,count,longest,wall,uncertainty,limits,work,drains,boundaryPolicy,exteriorSeedPolicy }=config;
  const scratch={ values:new Float64Array(longest),sites:new Int32Array(longest),cuts:new Float64Array(longest+1) };
  const distanceLower=distanceField(solid,true,config,scratch),distanceUpper=new Float64Array(count);
  const expected=new Uint8Array(count),owner=new Uint8Array(count),sourceExteriorLower=new Uint8Array(count),sourceExteriorUpper=new Uint8Array(count),visited=new Uint8Array(count),queue=new Uint32Array(count);
  if (boundaryPolicy==='voxel-enclosure') {
    // Reuse one distance field and the not-yet-populated cavity mask. The
    // complete material-nearness witness is saved before the same Float64
    // buffer is replaced with distance to source black samples.
    distanceField(solid,false,config,scratch,distanceUpper,true);
    for (let i=0;i<count;i++) { work.step(); expected[i]=distanceUpper[i]<=uncertainty**2?1:0; }
  }
  distanceField(solid,false,config,scratch,distanceUpper);
  const rois=drains.map(tool=>toolRoi(tool,config));
  for (let drain=0;drain<drains.length;drain++) eachRoi(rois[drain],config,i=>{
    if (cylinder(drains[drain],coordinates(i,config),uncertainty,false)) owner[i]=owner[i]===0?drain+1:owner[i]===drain+1?owner[i]:255;
  });
  const sourceLowerReach=flood(solid,false,config,sourceExteriorLower,queue),sourceUpperReach=flood(solid,true,config,sourceExteriorUpper,queue);
  let processedSourceLowerReach=null,processedSourceUpperReach=null;
  if (exteriorSeedPolicy==='processed-source-exterior') {
    // Reach the actual frame halo without ever passing through source material.
    // An opening through another drain/cavity cannot seed an exterior pocket
    // behind a cap over this drill. The source masks can then be reused in-place.
    processedSourceLowerReach=flood(hollow,false,config,visited,queue,{allowed:sourceExteriorLower});
    work.step(count); sourceExteriorLower.set(visited);
    processedSourceUpperReach=flood(hollow,true,config,visited,queue,{allowed:sourceExteriorUpper});
    work.step(count); sourceExteriorUpper.set(visited);
  }
  const counts={ expectedDeepCavity:0,addedOutsideSource:0,changedOuterBandOutsideDrains:0,definitelyRetainedExpectedCavity:0,ambiguousExpectedCavity:0,definitelyThinWallOutsideDrains:0,removedSamplesAwayFromDrains:0,
    cavityUnreachableLower:0,cavityUnreachableUpper:0 };
  const witnesses=Object.fromEntries(['addedOutsideSource','changedOuterBandOutsideDrains','definitelyRetainedExpectedCavity','ambiguousExpectedCavity','definitelyThinWallOutsideDrains','cavityUnreachableUpper'].map(key=>[key,[]]));
  const enclosure={upperMaterialOutsideSourceDilation:0,protectedOuterWallCells:0,protectedOuterWallLoss:0,changedOuterBandOutsideBoundaryBand:0,changedOuterBandWithinBoundaryBand:0,sourceUpperOuterWallSamples:0,sourceUpperOuterWallBeyondHollowDilation:0};
  const enclosureWitnesses=Object.fromEntries(['upperMaterialOutsideSourceDilation','protectedOuterWallLoss','changedOuterBandOutsideBoundaryBand','sourceUpperOuterWallBeyondHollowDilation'].map(key=>[key,[]]));
  const witness=(key,i)=>{ if (witnesses[key].length<limits.maxWitnesses) witnesses[key].push({ index:i,cell:{x:i%frame.nx,y:Math.floor(i/frame.nx)%frame.ny,z:Math.floor(i/plane)} }); };
  const enclosureWitness=(key,i)=>{ if (enclosureWitnesses[key].length<limits.maxWitnesses) enclosureWitnesses[key].push({index:i,cell:{x:i%frame.nx,y:Math.floor(i/frame.nx)%frame.ny,z:Math.floor(i/plane)}}); };
  const expectedThreshold=(wall+uncertainty)**2,outerThreshold=uncertainty<wall?(wall-uncertainty)**2:0;
  let minimumLower=Infinity,minimumUpper=Infinity;
  for (let i=0;i<count;i++) {
    work.step();
    const nearSourceMaterial=expected[i]===1;
    expected[i]=0;
    if (boundaryPolicy==='voxel-enclosure') {
      if (hollow.upper[i]>0 && !nearSourceMaterial) { enclosure.upperMaterialOutsideSourceDilation++; enclosureWitness('upperMaterialOutsideSourceDilation',i); }
      if (!owner[i] && solid.lower[i]===255 && distanceLower[i]>uncertainty**2 && distanceUpper[i]<outerThreshold) {
        enclosure.protectedOuterWallCells++;
        if (hollow.lower[i]!==255) { enclosure.protectedOuterWallLoss++; enclosureWitness('protectedOuterWallLoss',i); }
      }
      if (!owner[i] && distanceUpper[i]<outerThreshold && (solid.lower[i]!==hollow.lower[i] || solid.upper[i]!==hollow.upper[i])) {
        if (nearSourceMaterial && distanceUpper[i]<=uncertainty**2) enclosure.changedOuterBandWithinBoundaryBand++;
        else { enclosure.changedOuterBandOutsideBoundaryBand++; enclosureWitness('changedOuterBandOutsideBoundaryBand',i); }
      }
    }
    if (distanceLower[i]>expectedThreshold) { expected[i]=1; counts.expectedDeepCavity++; if (hollow.lower[i]===255) { counts.definitelyRetainedExpectedCavity++; witness('definitelyRetainedExpectedCavity',i); } else if (hollow.upper[i]>0) { counts.ambiguousExpectedCavity++; witness('ambiguousExpectedCavity',i); } }
    if (solid.upper[i]===0 && hollow.upper[i]>0) { counts.addedOutsideSource++; witness('addedOutsideSource',i); }
    if (!owner[i] && distanceUpper[i]<outerThreshold && (solid.lower[i]!==hollow.lower[i] || solid.upper[i]!==hollow.upper[i])) { counts.changedOuterBandOutsideDrains++; witness('changedOuterBandOutsideDrains',i); }
    if (!owner[i] && solid.lower[i]===255 && hollow.upper[i]===0) {
      counts.removedSamplesAwayFromDrains++; minimumLower=Math.min(minimumLower,distanceLower[i]); minimumUpper=Math.min(minimumUpper,distanceUpper[i]);
      if (distanceUpper[i]<outerThreshold) { counts.definitelyThinWallOutsideDrains++; witness('definitelyThinWallOutsideDrains',i); }
    }
  }
  if (boundaryPolicy==='voxel-enclosure') {
    // Source-lower distances have already contributed the deep-cavity mask and
    // wall minima. Reuse that complete Float64 field for the reverse enclosure
    // witness, so gray/thin features without any eroded-white core cannot
    // disappear farther than the same declared uncertainty from result material.
    distanceField(hollow,false,config,scratch,distanceLower,true);
    for (let i=0;i<count;i++) {
      work.step();
      if (!owner[i] && solid.upper[i]>0 && distanceUpper[i]<outerThreshold) {
        enclosure.sourceUpperOuterWallSamples++;
        if (distanceLower[i]>uncertainty**2) { enclosure.sourceUpperOuterWallBeyondHollowDilation++; enclosureWitness('sourceUpperOuterWallBeyondHollowDilation',i); }
      }
    }
  }
  const hollowLowerReach=flood(hollow,false,config,visited,queue);
  for (let i=0;i<count;i++) { work.step(); if (expected[i] && hollow.upper[i]===0 && !visited[i]) counts.cavityUnreachableLower++; }
  // The upper flood is also required for gray expected cells that do not enter
  // the lower flood at all. A gray-only sealed cavity must not evade the check.
  let hollowUpperReach=null;
  if (counts.cavityUnreachableLower || counts.ambiguousExpectedCavity) {
    hollowUpperReach=flood(hollow,true,config,visited,queue);
    for (let i=0;i<count;i++) { work.step(); if (expected[i] && hollow.lower[i]<255 && !visited[i]) { counts.cavityUnreachableUpper++; witness('cavityUnreachableUpper',i); } }
  }
  const drainResults=[];
  for (let drain=0;drain<drains.length;drain++) {
    const tool=drains[drain],roi=rois[drain];
    let lowerCandidates=0,possibleCandidates=0,lowerReached=0,possibleReached=0,removedWallCells=0,uniqueRemovedWallCells=0,ambiguousWallCells=0,retainedChannelCells=0,ambiguousChannelCells=0;
    const channelWitnesses={retained:[],ambiguous:[]};
    eachRoi(roi,config,i=>{
      const point=coordinates(i,config);
      if (cylinder(tool,point,uncertainty,false)) possibleCandidates++;
      if (!cylinder(tool,point,uncertainty,true)) return;
      lowerCandidates++;
      if (hollow.upper[i]>0) {
        const key=hollow.lower[i]===255?'retained':'ambiguous';
        if (key==='retained') retainedChannelCells++; else ambiguousChannelCells++;
        if (channelWitnesses[key].length<limits.maxWitnesses) channelWitnesses[key].push({index:i,cell:{x:i%frame.nx,y:Math.floor(i/frame.nx)%frame.ny,z:Math.floor(i/plane)}});
      }
      if (solid.lower[i]===255 && distanceUpper[i]<=expectedThreshold) {
        if (hollow.upper[i]===0) { removedWallCells++; if (owner[i]===drain+1) uniqueRemovedWallCells++; }
        else if (hollow.lower[i]<255) ambiguousWallCells++;
      }
    });
    const lower=flood(hollow,false,config,visited,queue,{tool,roi,sourceExterior:sourceExteriorLower});
    eachRoi(roi,config,i=>{ if (visited[i] && expected[i]) lowerReached++; });
    let upper=null;
    if (!lowerReached) {
      upper=flood(hollow,true,config,visited,queue,{tool,roi,sourceExterior:sourceExteriorUpper});
      eachRoi(roi,config,i=>{ if (visited[i] && expected[i]) possibleReached++; });
    }
    const halfDiagonal=Math.hypot(frame.pitchMm.x,frame.pitchMm.y,frame.pitchMm.z)/2;
    const resolutionSupported=tool.radiusMm>uncertainty+halfDiagonal && tool.lengthMm>2*uncertainty+Math.max(frame.pitchMm.x,frame.pitchMm.y,frame.pitchMm.z) && lowerCandidates>0;
    const reasons=[]; let disposition;
    if (retainedChannelCells) { disposition='nonconforming'; reasons.push('requested-channel-obstruction'); }
    else if (ambiguousChannelCells) { disposition='inconclusive'; reasons.push('requested-channel-ambiguous'); }
    else if (lowerReached && uniqueRemovedWallCells>0) disposition='conforming';
    else if (!counts.expectedDeepCavity || !resolutionSupported) { disposition='inconclusive'; reasons.push('channel-unresolved-at-declared-grid'); }
    else if (!lowerReached && possibleReached===0) { disposition='nonconforming'; reasons.push('no-possible-exterior-to-cavity-channel'); }
    else { disposition='inconclusive'; if (!lowerReached) reasons.push('only-possible-void-channel'); if (!uniqueRemovedWallCells) reasons.push(removedWallCells?'wall-removal-overlaps-another-drain':'no-distinct-definite-wall-removal'); }
    drainResults.push({ id:tool.id,disposition,reasons,fullyBlackExteriorToCavity:lowerReached>0,possibleExteriorToCavity:lowerReached>0||possibleReached>0,lowerCandidateCells:lowerCandidates,possibleCandidateCells:possibleCandidates,
      lowerInnerReached:lowerReached,possibleInnerReached:upper?possibleReached:null,definitelyRemovedWallCells:removedWallCells,distinctDefinitelyRemovedWallCells:uniqueRemovedWallCells,ambiguousWallCells,
      retainedLowerCylinderCells:retainedChannelCells,ambiguousLowerCylinderCells:ambiguousChannelCells,lowerCylinderWitnesses:channelWitnesses,lowerFlood:lower,upperFlood:upper });
  }
  const reasons=[];
  const boundaryFailures=boundaryPolicy==='exact-raster'?['addedOutsideSource','changedOuterBandOutsideDrains']:[];
  for (const key of [...boundaryFailures,'definitelyRetainedExpectedCavity','definitelyThinWallOutsideDrains','cavityUnreachableUpper']) if (counts[key]) reasons.push(key);
  if (boundaryPolicy==='voxel-enclosure') for (const key of ['upperMaterialOutsideSourceDilation','protectedOuterWallLoss','changedOuterBandOutsideBoundaryBand','sourceUpperOuterWallBeyondHollowDilation']) if (enclosure[key]) reasons.push(key);
  if (drainResults.some(drain=>drain.disposition==='nonconforming')) reasons.push('drain-nonconforming');
  const definiteFailure=reasons.length>0;
  if (!counts.expectedDeepCavity) reasons.push('no-resolved-expected-cavity');
  if (uncertainty>=wall) reasons.push('wall-request-not-resolved-by-uncertainty');
  if (counts.ambiguousExpectedCavity) reasons.push('ambiguous-expected-cavity');
  if (counts.cavityUnreachableLower && !counts.cavityUnreachableUpper) reasons.push('only-possible-cavity-connectivity');
  if (drainResults.some(drain=>drain.disposition==='inconclusive')) reasons.push('drain-inconclusive');
  const disposition=definiteFailure?'nonconforming':reasons.length?'inconclusive':'conforming';
  const lowerDistance=Number.isFinite(minimumLower)?Math.sqrt(minimumLower):null,upperDistance=Number.isFinite(minimumUpper)?Math.sqrt(minimumUpper):null;
  const result={schemaVersion:1,method:'bounded-reference-raster-grid-audit-v1',disposition,reasons,frame,wallThicknessMm:wall,uncertaintyMm:uncertainty,boundaryPolicy,exteriorSeedPolicy,
    boundaryEnclosure:boundaryPolicy==='voxel-enclosure'?{counts:enclosure,witnesses:enclosureWitnesses,distancePolicy:'full-grid anisotropic Euclidean sample-center distance; source upper material nonzero and source black upper zero; unchanged supplied uncertainty'}:null,
    occupancyPolicy:{materialLower:'all represented samples equal 255',materialUpper:'any represented sample is nonzero',voidLower:'all represented samples equal zero',voidUpper:'not all represented samples equal 255',lowerConnectivity:6,upperConnectivity:26},
    counts,witnesses,wallCenterDistanceMm:{lower:lowerDistance,upper:upperDistance},wallResolutionIntervalMm:{lower:lowerDistance===null?null:Math.max(0,lowerDistance-uncertainty),upper:upperDistance===null?null:upperDistance+uncertainty},
    connectivity:{sourceExteriorLower:sourceLowerReach,sourceExteriorUpper:sourceUpperReach,processedSourceExteriorLower:processedSourceLowerReach,processedSourceExteriorUpper:processedSourceUpperReach,hollowExteriorLower:hollowLowerReach,hollowExteriorUpper:hollowUpperReach},drains:drainResults,
    geometricWallCertification:false,physicalDrainageCertification:false,limits:{...limits},resources:{chargedOperations:work.operations,...config.memory,memoryPolicy:'four visible input arrays plus complete additional working arrays; oversized backing buffers also checked'}};
  work.check(); freeze(result); work.check(); return result;
}

module.exports={auditResinHollowGrid,RESIN_HOLLOW_GRID_LIMITS:LIMITS};
