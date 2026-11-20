'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {auditResinHollowGrid,RESIN_HOLLOW_GRID_LIMITS}=require('../src/slicing/resin-hollow-grid');

const index=(f,x,y,z)=>z*f.nx*f.ny+y*f.nx+x;
function point(f,x,y,z){return{x:f.originMm.x+f.direction.x*(x+.5)*f.pitchMm.x,y:f.originMm.y+f.direction.y*(y+.5)*f.pitchMm.y,z:f.originMm.z+(z+.5)*f.pitchMm.z};}
function inCylinder(p,d){const a=[p.x-d.startMm.x,p.y-d.startMm.y,p.z-d.startMm.z],v=[d.direction.x,d.direction.y,d.direction.z],t=a.reduce((s,x,i)=>s+x*v[i],0);return t>=0&&t<=d.lengthMm&&a.reduce((s,x)=>s+x*x,0)-t*t<=d.radiusMm*d.radiusMm;}
function fixture({sealed=false,solidOnly=false,oneDrain=false,tinyDrain=false}={}){
  const frame={nx:21,ny:21,nz:21,pitchMm:{x:.25,y:.25,z:.25},originMm:{x:-.5,y:-.5,z:-.5},direction:{x:1,y:1,z:1}},n=21**3,source=new Uint8Array(n),hollow=new Uint8Array(n);
  for(let z=2;z<=18;z++)for(let y=2;y<=18;y++)for(let x=2;x<=18;x++)source[index(frame,x,y,z)]=255;
  hollow.set(source);if(!solidOnly)for(let z=5;z<=15;z++)for(let y=5;y<=15;y++)for(let x=5;x<=15;x++)hollow[index(frame,x,y,z)]=0;
  const drains=[1.125,...(oneDrain?[]:[3.125])].map((x,i)=>({id:'bottom-'+(i+1),startMm:{x,y:2.125,z:-1},direction:{x:0,y:0,z:1},radiusMm:tinyDrain?.1:.75,lengthMm:3}));
  if(!sealed&&!solidOnly)for(let z=0;z<21;z++)for(let y=0;y<21;y++)for(let x=0;x<21;x++)if(drains.some(d=>inCylinder(point(frame,x,y,z),d)))hollow[index(frame,x,y,z)]=0;
  return{solid:{lower:source,upper:source},hollow:{lower:hollow,upper:hollow},frame,wallThicknessMm:.75,uncertaintyMm:Math.sqrt(3)*.25,drains};
}
function copy(input){return{...input,frame:structuredClone(input.frame),solid:{lower:input.solid.lower.slice(),upper:input.solid.upper.slice()},hollow:{lower:input.hollow.lower.slice(),upper:input.hollow.upper.slice()},drains:structuredClone(input.drains)};}
function setHollow(input,x,y,z,lo,hi=lo){const i=index(input.frame,x,y,z);input.hollow.lower[i]=lo;input.hollow.upper[i]=hi;}

test('default deadline stays one minute while an explicit longer bounded budget changes no geometry predicate',()=>{
  const input=fixture(),normal=auditResinHollowGrid(input),declared=auditResinHollowGrid({...input,limits:{maxTimeMs:180000}});
  assert.equal(normal.limits.maxTimeMs,60000);assert.equal(declared.limits.maxTimeMs,180000);assert.equal(RESIN_HOLLOW_GRID_LIMITS.maxTimeMs,300000);
  assert.equal(declared.disposition,normal.disposition);assert.deepEqual(declared.counts,normal.counts);assert.deepEqual(declared.drains,normal.drains);assert.equal(declared.limits.maxOperations,2000000000);assert.equal(declared.limits.maxWorkingBytes,768*1024*1024);
});

test('source-derived cavity, unchanged outer band and two independent black drain channels conform only to the declared raster band',()=>{
  const input=fixture(),before=copy(input),result=auditResinHollowGrid(input);
  assert.equal(result.disposition,'conforming');assert.deepEqual(result.reasons,[]);assert.ok(result.counts.expectedDeepCavity>0);
  for(const key of['addedOutsideSource','changedOuterBandOutsideDrains','definitelyRetainedExpectedCavity','ambiguousExpectedCavity','definitelyThinWallOutsideDrains','cavityUnreachableLower','cavityUnreachableUpper'])assert.equal(result.counts[key],0,key);
  assert.ok(result.drains.every(d=>d.disposition==='conforming'&&d.fullyBlackExteriorToCavity&&d.distinctDefinitelyRemovedWallCells>0));
  assert.ok(result.wallResolutionIntervalMm.lower<input.wallThicknessMm);assert.equal(result.geometricWallCertification,false);assert.equal(result.physicalDrainageCertification,false);assert.equal(Object.hasOwn(result,'productionEligibility'),false);
  assert.equal(result.occupancyPolicy.lowerConnectivity,6);assert.equal(result.occupancyPolicy.upperConnectivity,26);
  assert.deepEqual(input.solid,before.solid);assert.deepEqual(input.hollow,before.hollow);assert.deepEqual(input.frame,before.frame);assert.deepEqual(input.drains,before.drains);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.drains[0])&&Object.isFrozen(result.frame.pitchMm));assert.deepEqual(JSON.parse(JSON.stringify(result)),result);assert.deepEqual(auditResinHollowGrid(input),result);
});

test('the unchanged solid and a sealed cavity have distinct definite failure witnesses',()=>{
  const unchanged=auditResinHollowGrid(fixture({solidOnly:true}));assert.equal(unchanged.disposition,'nonconforming');assert.equal(unchanged.counts.definitelyRetainedExpectedCavity,unchanged.counts.expectedDeepCavity);
  const sealed=auditResinHollowGrid(fixture({sealed:true}));assert.equal(sealed.disposition,'nonconforming');assert.ok(sealed.counts.cavityUnreachableLower>0);assert.ok(sealed.counts.cavityUnreachableUpper>0);assert.ok(sealed.drains.every(d=>d.disposition==='nonconforming'));
});

test('a half-missing expected cavity fails even though both planned channels and global cavity connectivity pass',()=>{
  const input=copy(fixture());for(let z=12;z<=14;z++)for(let y=6;y<=14;y++)for(let x=10;x<=14;x++)setHollow(input,x,y,z,255);
  const result=auditResinHollowGrid(input);assert.equal(result.disposition,'nonconforming');assert.ok(result.counts.definitelyRetainedExpectedCavity>100);assert.equal(result.counts.cavityUnreachableLower,0);assert.ok(result.drains.every(d=>d.fullyBlackExteriorToCavity));
});

test('a blocked first drill cannot borrow the second drill exterior opening',()=>{
  const input=copy(fixture());for(let z=2;z<=4;z++)for(let y=0;y<21;y++)for(let x=0;x<21;x++)if(inCylinder(point(input.frame,x,y,z),input.drains[0]))setHollow(input,x,y,z,255);
  const result=auditResinHollowGrid(input);assert.equal(result.counts.cavityUnreachableLower,0);assert.equal(result.drains[0].fullyBlackExteriorToCavity,false);assert.equal(result.drains[0].possibleExteriorToCavity,false);assert.equal(result.drains[0].disposition,'nonconforming');assert.equal(result.drains[1].disposition,'conforming');assert.equal(result.disposition,'nonconforming');
});

test('every shrunken drill cell must be black even when a thin path remains open',()=>{
  for(const value of[255,128]){
    const input=copy(fixture());setHollow(input,7,10,3,value);
    const result=auditResinHollowGrid(input),first=result.drains[0];
    assert.equal(first.fullyBlackExteriorToCavity,true,'the remaining center thread still reaches the cavity');
    assert.equal(first.distinctDefinitelyRemovedWallCells>0,true);
    assert.equal(first.retainedLowerCylinderCells,value===255?1:0);assert.equal(first.ambiguousLowerCylinderCells,value===128?1:0);
    assert.equal(first.disposition,value===255?'nonconforming':'inconclusive');assert.equal(result.disposition,first.disposition);
    assert.ok(first.reasons.includes(value===255?'requested-channel-obstruction':'requested-channel-ambiguous'));
    assert.equal(first.lowerCylinderWitnesses[value===255?'retained':'ambiguous'][0].index,index(input.frame,7,10,3));
    assert.equal(result.drains[1].disposition,'conforming');
  }
});

test('processed-source exterior seeds cannot borrow a second drill through a capped source-exterior pocket',()=>{
  const input=copy(fixture());
  // A box outside the reference encloses the first drill mouth. Its only void
  // connection is through that drill, the inner cavity and the second drill.
  for(let z=0;z<=1;z++)for(let y=6;y<=14;y++)for(let x=2;x<=10;x++)if(z===0||x===2||x===10||y===6||y===14)setHollow(input,x,y,z,255);
  const original=auditResinHollowGrid(input),restricted=auditResinHollowGrid({...input,exteriorSeedPolicy:'processed-source-exterior'});
  assert.equal(original.drains[0].fullyBlackExteriorToCavity,true);
  assert.equal(restricted.drains[0].fullyBlackExteriorToCavity,false);assert.equal(restricted.drains[0].possibleExteriorToCavity,false);
  assert.equal(restricted.drains[0].lowerFlood.seeds,0);assert.equal(restricted.drains[1].fullyBlackExteriorToCavity,true);
  assert.ok(restricted.connectivity.processedSourceExteriorLower.visitedCells<original.connectivity.sourceExteriorLower.visitedCells);
  assert.equal(original.exteriorSeedPolicy,'source-exterior');assert.equal(original.connectivity.processedSourceExteriorLower,null);
});

test('explicit voxel enclosure accepts only witnessed boundary-band changes at the unchanged uncertainty',()=>{
  const input=copy(fixture());input.wallThicknessMm=.9;input.uncertaintyMm=.26;
  for(const[y,source,result]of[[4,128,129],[5,128,127]]){const i=index(input.frame,2,y,14);input.solid.lower[i]=input.solid.upper[i]=source;setHollow(input,2,y,14,result);}
  // Set enclosure treats black/white/gray through the same distance policy.
  setHollow(input,1,10,14,255);
  const exact=auditResinHollowGrid(input),explicitExact=auditResinHollowGrid({...input,boundaryPolicy:'exact-raster'}),enclosed=auditResinHollowGrid({...input,boundaryPolicy:'voxel-enclosure'});
  assert.deepEqual(exact,explicitExact);assert.equal(exact.disposition,'nonconforming');assert.equal(exact.boundaryPolicy,'exact-raster');assert.equal(exact.boundaryEnclosure,null);
  assert.equal(enclosed.disposition,'conforming');assert.equal(enclosed.uncertaintyMm,input.uncertaintyMm);assert.equal(enclosed.counts.addedOutsideSource,1);assert.equal(enclosed.counts.changedOuterBandOutsideDrains,3);
  assert.equal(enclosed.boundaryEnclosure.counts.changedOuterBandWithinBoundaryBand,3);assert.equal(enclosed.boundaryEnclosure.counts.upperMaterialOutsideSourceDilation,0);assert.equal(enclosed.boundaryEnclosure.counts.protectedOuterWallLoss,0);assert.equal(enclosed.boundaryEnclosure.counts.changedOuterBandOutsideBoundaryBand,0);
  assert.ok(enclosed.boundaryEnclosure.counts.protectedOuterWallCells>0);assert.deepEqual(JSON.parse(JSON.stringify(enclosed)),enclosed);
  assert.equal(enclosed.resources.additionalArrayBytes,exact.resources.additionalArrayBytes,'material EDT reuses the existing field and mask');
  const lost=copy(input);setHollow(lost,3,10,14,254);const loss=auditResinHollowGrid({...lost,boundaryPolicy:'voxel-enclosure'});assert.equal(loss.disposition,'nonconforming');assert.equal(loss.boundaryEnclosure.counts.protectedOuterWallLoss,1);assert.equal(loss.boundaryEnclosure.counts.changedOuterBandOutsideBoundaryBand,1);
  const far=copy(input);setHollow(far,0,10,14,1);const addition=auditResinHollowGrid({...far,boundaryPolicy:'voxel-enclosure'});assert.equal(addition.disposition,'nonconforming');assert.equal(addition.boundaryEnclosure.counts.upperMaterialOutsideSourceDilation,1);
  // Enclosure never relaxes a definite thin wall, expected cavity, or drill.
  const thin=copy(input);setHollow(thin,2,10,14,0);assert.equal(auditResinHollowGrid({...thin,boundaryPolicy:'voxel-enclosure'}).counts.definitelyThinWallOutsideDrains,1);
  const missing=copy(input);setHollow(missing,10,10,10,255);assert.ok(auditResinHollowGrid({...missing,boundaryPolicy:'voxel-enclosure'}).counts.definitelyRetainedExpectedCavity>0);
});

test('reverse enclosure prevents complete loss of a thin gray antenna without an eroded-white core',()=>{
  const input=copy(fixture());input.boundaryPolicy='voxel-enclosure';input.wallThicknessMm=.9;input.uncertaintyMm=.26;
  // A connected gray feature grows along Z beyond the top of the white cube.
  // Neither protected-white nor definite-white-removal checks can see it.
  for(let z=17;z<=19;z++){const i=index(input.frame,10,10,z);input.solid.lower[i]=input.solid.upper[i]=128;setHollow(input,10,10,z,128);}
  const baseline=auditResinHollowGrid(input);assert.equal(baseline.disposition,'conforming');assert.equal(baseline.boundaryEnclosure.counts.sourceUpperOuterWallBeyondHollowDilation,0);
  for(let z=17;z<=19;z++)setHollow(input,10,10,z,0);
  const result=auditResinHollowGrid(input);assert.equal(result.boundaryEnclosure.counts.protectedOuterWallLoss,0);assert.equal(result.counts.definitelyThinWallOutsideDrains,0);assert.ok(result.boundaryEnclosure.counts.sourceUpperOuterWallBeyondHollowDilation>0);assert.equal(result.disposition,'nonconforming');assert.ok(result.reasons.includes('sourceUpperOuterWallBeyondHollowDilation'));
  assert.ok(result.boundaryEnclosure.witnesses.sourceUpperOuterWallBeyondHollowDilation.length>0);
});

test('enclosure source distances and protected wall counts match an independent anisotropic exhaustive oracle',()=>{
  let seed=195503;const random=()=>((seed=(1664525*seed+1013904223)>>>0)/4294967296);
  for(let trial=0;trial<24;trial++){
    const frame={nx:7,ny:6,nz:5,pitchMm:{x:.071,y:.123,z:.057},originMm:{x:0,y:0,z:0},direction:{x:trial%2?-1:1,y:1,z:1}},n=frame.nx*frame.ny*frame.nz,lo=new Uint8Array(n),hi=new Uint8Array(n),hl=new Uint8Array(n),hu=new Uint8Array(n);
    for(let z=1;z<frame.nz-1;z++)for(let y=1;y<frame.ny-1;y++)for(let x=1;x<frame.nx-1;x++){const i=index(frame,x,y,z),r=random();lo[i]=r>.45?255:r>.2?128:0;hi[i]=r>.1?255:0;}
    for(let i=0;i<n;i++){const r=random();hl[i]=r>.7?255:r>.3?1:0;hu[i]=r>.2?255:0;}
    const wall=.25,delta=.04+random()*.11,expected={upperMaterialOutsideSourceDilation:0,protectedOuterWallCells:0,protectedOuterWallLoss:0,changedOuterBandOutsideBoundaryBand:0,changedOuterBandWithinBoundaryBand:0,sourceUpperOuterWallSamples:0,sourceUpperOuterWallBeyondHollowDilation:0};
    for(let i=0;i<n;i++){
      const x=i%frame.nx,y=Math.floor(i/frame.nx)%frame.ny,z=Math.floor(i/(frame.nx*frame.ny));let material=Infinity,black=Infinity,notWhite=Infinity,hollowMaterial=Infinity;
      for(let j=0;j<n;j++){const xx=j%frame.nx,yy=Math.floor(j/frame.nx)%frame.ny,zz=Math.floor(j/(frame.nx*frame.ny)),d=((x-xx)*frame.pitchMm.x)**2+((y-yy)*frame.pitchMm.y)**2+((z-zz)*frame.pitchMm.z)**2;if(hi[j]>0)material=Math.min(material,d);else black=Math.min(black,d);if(lo[j]!==255)notWhite=Math.min(notWhite,d);if(hu[j]>0)hollowMaterial=Math.min(hollowMaterial,d);}
      if(hu[i]>0&&material>delta**2)expected.upperMaterialOutsideSourceDilation++;
      if(lo[i]===255&&notWhite>delta**2&&black<(wall-delta)**2){expected.protectedOuterWallCells++;if(hl[i]!==255)expected.protectedOuterWallLoss++;}
      if(black<(wall-delta)**2&&(lo[i]!==hl[i]||hi[i]!==hu[i]))expected[material<=delta**2&&black<=delta**2?'changedOuterBandWithinBoundaryBand':'changedOuterBandOutsideBoundaryBand']++;
      if(hi[i]>0&&black<(wall-delta)**2){expected.sourceUpperOuterWallSamples++;if(hollowMaterial>delta**2)expected.sourceUpperOuterWallBeyondHollowDilation++;}
    }
    const result=auditResinHollowGrid({solid:{lower:lo,upper:hi},hollow:{lower:hl,upper:hu},frame,wallThicknessMm:wall,uncertaintyMm:delta,boundaryPolicy:'voxel-enclosure',drains:[{id:'outside',startMm:{x:100,y:100,z:100},direction:{x:0,y:0,z:1},radiusMm:.1,lengthMm:1}]});
    assert.deepEqual(result.boundaryEnclosure.counts,expected);
  }
  const empty=fixture();empty.solid.lower.fill(0);empty.solid.upper.fill(0);empty.hollow.lower.fill(0);empty.hollow.upper.fill(0);setHollow(empty,10,10,10,1);const result=auditResinHollowGrid({...empty,boundaryPolicy:'voxel-enclosure'});assert.equal(result.boundaryEnclosure.counts.upperMaterialOutsideSourceDilation,1,'an entirely empty source has no finite material site');
});

test('thin walls and unexpected foreground, including a changed exterior seed cell, produce definite failures',()=>{
  const thin=copy(fixture());setHollow(thin,2,2,14,0);const reduced=auditResinHollowGrid(thin);assert.equal(reduced.disposition,'nonconforming');assert.equal(reduced.counts.definitelyThinWallOutsideDrains,1);assert.equal(reduced.counts.changedOuterBandOutsideDrains,1);
  const added=copy(fixture());setHollow(added,0,0,0,255);const changed=auditResinHollowGrid(added);assert.equal(changed.disposition,'nonconforming');assert.equal(changed.counts.addedOutsideSource,1);assert.ok(changed.connectivity.hollowExteriorLower.seeds>0);assert.ok(changed.drains.every(d=>d.fullyBlackExteriorToCavity));
});

test('gray deep-cavity occupancy is inconclusive and a gray-only sealed cavity cannot avoid the upper connectivity check',()=>{
  const input=copy(fixture());setHollow(input,10,10,12,128);const result=auditResinHollowGrid(input);assert.equal(result.disposition,'inconclusive');assert.equal(result.counts.ambiguousExpectedCavity,1);assert.equal(result.counts.cavityUnreachableUpper,0);assert.ok(result.drains.every(d=>d.disposition==='conforming'));
  const sealed=copy(fixture({sealed:true}));for(let z=5;z<=15;z++)for(let y=5;y<=15;y++)for(let x=5;x<=15;x++)setHollow(sealed,x,y,z,128);const uncertain=auditResinHollowGrid(sealed);assert.equal(uncertain.counts.cavityUnreachableLower,0);assert.ok(uncertain.counts.ambiguousExpectedCavity>0);assert.ok(uncertain.counts.cavityUnreachableUpper>0);assert.equal(uncertain.disposition,'nonconforming');
});

test('straight and diagonal gray bridges remain upper-only possibilities rather than proven open or definitely sealed',()=>{
  for(const diagonal of[false,true]){const input=copy(fixture({sealed:true}));for(let z=2;z<=5;z++)setHollow(input,diagonal?7+z:10,10,z,128);const result=auditResinHollowGrid(input);assert.ok(result.counts.cavityUnreachableLower>0);assert.equal(result.counts.cavityUnreachableUpper,0);assert.ok(result.reasons.includes('only-possible-cavity-connectivity'));assert.notEqual(result.disposition,'conforming');}
});

test('unresolved cylinders and overlapping wall-removal claims are held without inferring distinct drains',()=>{
  const tiny=auditResinHollowGrid(fixture({oneDrain:true,tinyDrain:true}));assert.equal(tiny.disposition,'inconclusive');assert.equal(tiny.drains[0].disposition,'inconclusive');assert.ok(tiny.drains[0].reasons.includes('channel-unresolved-at-declared-grid'));
  const repeated=copy(fixture({oneDrain:true}));repeated.drains.push({...structuredClone(repeated.drains[0]),id:'same-cylinder-different-id'});const overlap=auditResinHollowGrid(repeated);assert.equal(overlap.disposition,'inconclusive');assert.ok(overlap.drains.every(d=>d.fullyBlackExteriorToCavity&&d.definitelyRemovedWallCells>0&&d.distinctDefinitelyRemovedWallCells===0));
});

test('a pre-existing sealed source air pocket is never a drain exterior seed',()=>{
  const input=copy(fixture());const cell=index(input.frame,8,8,8);input.solid.lower[cell]=input.solid.upper[cell]=0;
  input.drains.push({id:'internal-pocket',startMm:point(input.frame,8,8,8),direction:{x:0,y:0,z:1},radiusMm:.75,lengthMm:2});const result=auditResinHollowGrid(input);const internal=result.drains.find(d=>d.id==='internal-pocket');assert.equal(internal.lowerFlood.seeds,0);assert.equal(internal.fullyBlackExteriorToCavity,false);assert.equal(internal.possibleExteriorToCavity,false);
});

test('mirrored frame coordinates and unequal physical pitches retain the same per-drain meaning',()=>{
  const input=fixture(),baseline=auditResinHollowGrid(input);
  for(const x of[-1,1])for(const y of[-1,1]){const mirrored=copy(input);mirrored.frame.direction={x,y,z:1};mirrored.frame.originMm.x=x<0?4.75:-.5;mirrored.frame.originMm.y=y<0?4.75:-.5;mirrored.drains=mirrored.drains.map(d=>({...d,startMm:{x:x<0?4.25-d.startMm.x:d.startMm.x,y:y<0?4.25-d.startMm.y:d.startMm.y,z:d.startMm.z}}));const result=auditResinHollowGrid(mirrored);assert.equal(result.disposition,baseline.disposition);assert.deepEqual(result.counts,baseline.counts);assert.deepEqual(result.drains.map(d=>d.distinctDefinitelyRemovedWallCells),baseline.drains.map(d=>d.distinctDefinitelyRemovedWallCells));}
  const anisotropic=copy(input);anisotropic.frame.pitchMm={x:.25,y:.3,z:.2};anisotropic.frame.originMm={x:-.5,y:-.6,z:-.4};anisotropic.drains=anisotropic.drains.map(d=>({...d,startMm:{x:d.startMm.x,y:d.startMm.y*1.2,z:-1},radiusMm:1,lengthMm:3}));const result=auditResinHollowGrid(anisotropic);assert.ok(result.counts.expectedDeepCavity>0);assert.ok(result.drains.every(d=>d.fullyBlackExteriorToCavity));assert.equal(result.geometricWallCertification,false);
});

test('anisotropic source distance and erosion counts agree with independent brute force on randomized interval grids',()=>{
  let seed=89321;const random=()=>((seed=(1664525*seed+1013904223)>>>0)/4294967296);
  for(let trial=0;trial<40;trial++){
    const f={nx:7,ny:6,nz:5,pitchMm:{x:.071,y:.123,z:.057},originMm:{x:0,y:0,z:0},direction:{x:1,y:1,z:1}},n=f.nx*f.ny*f.nz,lo=new Uint8Array(n),hi=new Uint8Array(n),full=[];
    for(let z=1;z<f.nz-1;z++)for(let y=1;y<f.ny-1;y++)for(let x=1;x<f.nx-1;x++){const i=index(f,x,y,z),r=random();lo[i]=r>.3?255:r>.15?128:0;hi[i]=r>.1?255:0;if(lo[i]===255)full.push(i);}
    const chosen=full[Math.floor(random()*full.length)],hlo=lo.slice(),hhi=hi.slice();hlo[chosen]=hhi[chosen]=0;
    const wall=.04+random()*.2,uncertainty=.003,distances=[];
    for(const lower of[true,false]){const values=new Array(n);for(let i=0;i<n;i++){const x=i%f.nx,y=Math.floor(i/f.nx)%f.ny,z=Math.floor(i/(f.nx*f.ny));let closest=Infinity;for(let j=0;j<n;j++){if(lower?lo[j]===255:hi[j]>0)continue;const xx=j%f.nx,yy=Math.floor(j/f.nx)%f.ny,zz=Math.floor(j/(f.nx*f.ny));closest=Math.min(closest,((x-xx)*f.pitchMm.x)**2+((y-yy)*f.pitchMm.y)**2+((z-zz)*f.pitchMm.z)**2);}values[i]=closest;}distances.push(values);}
    const result=auditResinHollowGrid({solid:{lower:lo,upper:hi},hollow:{lower:hlo,upper:hhi},frame:f,wallThicknessMm:wall,uncertaintyMm:uncertainty,drains:[{id:'outside',startMm:{x:100,y:100,z:100},direction:{x:0,y:0,z:1},radiusMm:.1,lengthMm:1}]});
    assert.equal(result.counts.expectedDeepCavity,distances[0].filter(v=>v>(wall+uncertainty)**2).length);assert.ok(Math.abs(result.wallCenterDistanceMm.lower-Math.sqrt(distances[0][chosen]))<1e-12);assert.ok(Math.abs(result.wallCenterDistanceMm.upper-Math.sqrt(distances[1][chosen]))<1e-12);
  }
});

test('strict interval, typed-array, halo, coordinate and drain validation happens before working allocations',()=>{
  const base=fixture();for(const change of[i=>{i.solid.lower=new Uint8Array(1);},i=>{i.solid.lower=new Uint8ClampedArray(i.solid.lower.length);},i=>{i.solid.lower=new Uint8Array(new SharedArrayBuffer(i.solid.lower.length));}]){const input=copy(base);change(input);assert.throws(()=>auditResinHollowGrid(input),{code:'RESIN_HOLLOW_GRID_ARRAY'});}
  const bad=copy(base);bad.solid.lower[0]=255;assert.throws(()=>auditResinHollowGrid(bad),{code:'RESIN_HOLLOW_GRID_INTERVAL'});const halo=copy(base);halo.solid.upper[0]=1;assert.throws(()=>auditResinHollowGrid(halo),{code:'RESIN_HOLLOW_GRID_HALO'});
  for(const change of[i=>{i.frame.nx=3.5;},i=>{i.frame.pitchMm.x=NaN;},i=>{i.frame.direction.z=-1;},i=>{i.drains[0].direction.z=.9;},i=>{i.drains[1].id=i.drains[0].id;},i=>{i.extra=1;},i=>{i.drains=[];},i=>{i.boundaryPolicy='automatic';},i=>{i.boundaryPolicy=null;},i=>{i.exteriorSeedPolicy='final';},i=>{i.exteriorSeedPolicy=null;}]){const input=copy(base);change(input);assert.throws(()=>auditResinHollowGrid(input));}
  for(const limits of[{constructor:1},{toString:1},{[Symbol('unexpected')]:1},{maxVoxels:20000001},{maxOperations:2000000001},{maxTimeMs:300001},{maxWorkingBytes:768*1024*1024+1}])assert.throws(()=>auditResinHollowGrid({...base,limits}),{code:'RESIN_HOLLOW_GRID_LIMITS'});
});

test('voxel, dimension, drain, memory, operation, deadline and cancellation budgets fail closed',()=>{
  const input=fixture();for(const[limits,code]of[[{maxVoxels:1000},'RESIN_HOLLOW_GRID_VOXELS'],[{maxAxisLength:10},'RESIN_HOLLOW_GRID_DIMENSIONS'],[{maxDrains:1},'RESIN_HOLLOW_GRID_DRAINS'],[{maxWorkingBytes:1000},'RESIN_HOLLOW_GRID_MEMORY'],[{maxOperations:100},'RESIN_HOLLOW_GRID_OPERATIONS']])assert.throws(()=>auditResinHollowGrid({...input,limits}),{code});
  const record=auditResinHollowGrid(input),oversized=copy(input);oversized.solid.lower=new Uint8Array(new ArrayBuffer(oversized.solid.lower.length*10),0,oversized.solid.lower.length);oversized.solid.lower.set(input.solid.lower);assert.throws(()=>auditResinHollowGrid({...oversized,limits:{maxWorkingBytes:record.resources.conservativeVisiblePeakBytes}}),{code:'RESIN_HOLLOW_GRID_MEMORY'});
  const enclosure=auditResinHollowGrid({...input,boundaryPolicy:'voxel-enclosure'});assert.equal(enclosure.resources.additionalArrayBytes,record.resources.additionalArrayBytes);assert.ok(enclosure.resources.chargedOperations>record.resources.chargedOperations);assert.throws(()=>auditResinHollowGrid({...input,boundaryPolicy:'voxel-enclosure',limits:{maxOperations:record.resources.chargedOperations}}),{code:'RESIN_HOLLOW_GRID_OPERATIONS'});
  const controller=new AbortController();controller.abort();assert.throws(()=>auditResinHollowGrid({...input,signal:controller.signal}),{code:'RESIN_HOLLOW_GRID_ABORTED'});
  const n=81**3,large={...input,solid:{lower:new Uint8Array(n),upper:new Uint8Array(n)},hollow:{lower:new Uint8Array(n),upper:new Uint8Array(n)},frame:{...input.frame,nx:81,ny:81,nz:81},limits:{maxTimeMs:1}};assert.throws(()=>auditResinHollowGrid(large),{code:'RESIN_HOLLOW_GRID_TIMEOUT'});
  assert.equal(RESIN_HOLLOW_GRID_LIMITS.maxVoxels,20000000);assert.equal(RESIN_HOLLOW_GRID_LIMITS.maxOperations,2000000000);assert.ok(record.resources.chargedOperations<record.limits.maxOperations);assert.equal(record.resources.inputViewBytes,21**3*4);assert.equal(record.resources.additionalArrayBytes,21**3*25+21*20+8);
});
