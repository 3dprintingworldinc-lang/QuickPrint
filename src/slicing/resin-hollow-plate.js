'use strict';

// A plate repeats the complete independently verified supported hollow unit.
// The private capability caches a heavy audit, never a serialized ready flag.
// Live capture uses the real controlled factory; saved invocation records are
// replay evidence, not cryptographic attestation of a past native invocation.
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { performance } = require('node:perf_hooks');
const { normalizeResinPlateOptions, deriveResinPlateLayout } = require('./resin-plate-engine');
const { inspectGooRaster, verifyGooPlate } = require('./goo-plate');
const { replicateGooPlate } = require('./goo-replication');
const { inspectGoo } = require('./goo');
const { parseIni, parseIssueReport, assertTargetProperties } = require('./resin-engine');
const { verifyControlledResinHollowPreparation, inspectControlledResinHollowBindings } = require('./resin-hollow-engine');
const { createControlledNativeCapture, isControlledNativeCapture } = require('./resin-controlled-capture');

const MiB = 1024 * 1024, MAX_GOO = 512 * MiB, MAX_SOURCE = 100 * MiB, MAX_RECORD = 12 * MiB;
const METHOD = 'controlled-hollow-reference-raster-replication-v1';
const HASH = /^[a-f0-9]{64}$/, CAPABILITIES = new WeakMap();
const CHECKS = ['--islands', '--resin-traps', '--suction-cups', '--touching-bounds', '--print-height', '--empty-layers'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const without = (value, key) => { const result = { ...value }; delete result[key]; return result; };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const fail = (message, code = 'RESIN_HOLLOW_PLATE_INVALID', status = 409) => Object.assign(new Error(message), { code, status });
const sameStat = (a,b) => ['dev','ino','size','mtimeNs','ctimeNs'].every(key => a[key] === b[key]);
function keys(value, allowed, required, label) { if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value,key))) throw fail(`Invalid ${label}.`, 'RESIN_HOLLOW_PLATE_INPUT', 400); }
function buffer(value, maximum, label) { if (!Buffer.isBuffer(value) || !value.length || value.length > maximum || (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer)) throw fail(`Use a bounded owned ${label} buffer.`, 'RESIN_HOLLOW_PLATE_INPUT', 400); }
function absolute(value) { if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4000 || /[\0\r\n]/.test(value)) throw fail('Use an absolute managed directory.', 'RESIN_HOLLOW_PLATE_PATH'); return path.resolve(value); }
function contained(root, file) { const relative = path.relative(root,file); if (!relative || relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw fail('Hollow plate evidence must stay below its managed directory.', 'RESIN_HOLLOW_PLATE_PATH'); }
async function local(file, directory) {
  const check = async name => { let at = path.parse(name).root; const parts = [at]; for (const part of path.relative(at,name).split(path.sep).filter(Boolean)) { at = path.join(at,part); parts.push(at); } for (let index=0; index<parts.length; index++) { const item=await fs.lstat(parts[index],{bigint:true}); if (item.isSymbolicLink() || (index<parts.length-1 || directory ? !item.isDirectory() : !item.isFile()) || item.ino<=0n) throw fail('Hollow plate evidence requires ordinary nonlinked paths.', 'RESIN_HOLLOW_PLATE_PATH'); } };
  const input=absolute(file); await check(input); const result=await fs.realpath(input); await check(result);
  const a=await fs.lstat(input,{bigint:true}),b=await fs.lstat(result,{bigint:true}); if(a.dev!==b.dev || a.ino!==b.ino) throw fail('Hollow plate path changed identity.', 'RESIN_HOLLOW_PLATE_PATH'); return result;
}
async function read(root, descriptor, maximum, signal) {
  if (signal?.aborted) throw fail('Hollow plate preparation cancelled.', 'ABORTED');
  if (!plain(descriptor) || !HASH.test(descriptor.sha256||'') || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes<1 || descriptor.bytes>maximum) throw fail('Invalid bounded hollow plate descriptor.', 'RESIN_HOLLOW_PLATE_CHANGED');
  const requested=absolute(descriptor.filePath); contained(root,requested); const actual=await local(requested,false); contained(root,actual);
  const before=await fs.lstat(actual,{bigint:true}); if(before.size!==BigInt(descriptor.bytes) || before.nlink!==1n) throw fail('Hollow plate file size or links changed.', 'RESIN_HOLLOW_PLATE_CHANGED');
  const file=await fs.open(actual,'r');
  try {
    if(!sameStat(before,await file.stat({bigint:true}))) throw fail('Hollow plate file changed while opening.', 'RESIN_HOLLOW_PLATE_CHANGED');
    const bytes=Buffer.allocUnsafe(descriptor.bytes); let at=0;
    while(at<bytes.length) { if(signal?.aborted) throw fail('Hollow plate preparation cancelled.','ABORTED'); const part=await file.read(bytes,at,Math.min(MiB,bytes.length-at),at); if(!part.bytesRead) throw fail('Hollow plate file was truncated.','RESIN_HOLLOW_PLATE_CHANGED'); at+=part.bytesRead; }
    if((await file.read(Buffer.alloc(1),0,1,at)).bytesRead || hash(bytes)!==descriptor.sha256 || !sameStat(before,await file.stat({bigint:true})) || !sameStat(before,await fs.lstat(actual,{bigint:true}))) throw fail('Hollow plate file changed during verification.', 'RESIN_HOLLOW_PLATE_CHANGED'); await local(actual,false); return bytes;
  } finally { await file.close(); }
}
async function put(filePath,bytes) { await fs.writeFile(filePath,bytes,{flag:'wx'}); return {filePath,bytes:bytes.length,sha256:hash(bytes)}; }
const PINS = ['resin-hollow-plate.js','resin-plate-engine.js','resin-plate.js','goo-replication.js','goo-plate.js','goo.js','resin-controlled-capture.js'].map(name => { const bytes=syncFs.readFileSync(path.join(__dirname,name)); return {name,bytes:bytes.length,sha256:hash(bytes)}; });
async function implementation() { for(const pin of PINS) { const bytes=await fs.readFile(path.join(__dirname,pin.name)); if(bytes.length!==pin.bytes || hash(bytes)!==pin.sha256) throw fail('Hollow plate implementation changed; restart before preparation.', 'RESIN_HOLLOW_PLATE_TOOL_CHANGED'); } return {files:PINS.map(item=>({...item})),sha256:digest(PINS)}; }
function deadline(signal, timeoutMs=900000) {
  if(signal!==undefined && !(signal instanceof AbortSignal)) throw fail('Use an AbortSignal.', 'RESIN_HOLLOW_PLATE_INPUT',400);
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<1000 || timeoutMs>3600000) throw fail('Use a bounded one-second to one-hour hollow plate deadline.', 'RESIN_HOLLOW_PLATE_INPUT',400);
  const started=performance.now(); return () => { if(signal?.aborted) throw fail('Hollow plate preparation cancelled.','ABORTED'); const remaining=Math.floor(timeoutMs-(performance.now()-started)); if(remaining<1) throw fail('Hollow plate preparation exceeded its deadline.','RESIN_HOLLOW_PLATE_TIMEOUT'); return remaining; };
}

async function verifyResinHollowPlateReference(record, options) {
  keys(options,['source','directory','signal','timeoutMs'],['source','directory'],'hollow reference verification'); buffer(options.source,MAX_SOURCE,'source'); const remaining=deadline(options.signal,options.timeoutMs);
  const directory=await local(options.directory,true), impl=await implementation(); remaining();
  const verified=await verifyControlledResinHollowPreparation(record,{...options,directory,timeoutMs:Math.max(1000,remaining())});
  const current=await inspectControlledResinHollowBindings(record,{...options,directory});
  if(verified.bindingHash!==current.bindingHash || verified.hollowPreparationSha256!==record.sha256 || verified.sha256!==record.roles.final.artifact.sha256) throw fail('Hollow reference changed during its independent audit.','RESIN_HOLLOW_PLATE_REFERENCE_CHANGED');
  const capability=Object.freeze(Object.create(null)); CAPABILITIES.set(capability,{recordSha256:record.sha256,sourceSha256:hash(options.source),bindingHash:current.bindingHash,directory,implementationSha256:impl.sha256}); remaining(); return capability;
}
async function reference(record,options) {
  let capability=options.referenceCapability;
  if(capability===undefined) capability=await verifyResinHollowPlateReference(record,{source:options.source,directory:options.directory,signal:options.signal,timeoutMs:options.timeoutMs});
  const cached=CAPABILITIES.get(capability);
  if(!cached || cached.recordSha256!==record.sha256 || cached.sourceSha256!==hash(options.source) || cached.directory!==await local(options.directory,true) || cached.implementationSha256!==(await implementation()).sha256) throw fail('Use a current independently verified hollow reference capability.','RESIN_HOLLOW_PLATE_REFERENCE_REQUIRED');
  const current=await inspectControlledResinHollowBindings(record,{source:options.source,directory:options.directory,signal:options.signal,timeoutMs:options.timeoutMs});
  if(current.bindingHash!==cached.bindingHash) throw fail('Hollow reference files or providers changed after their independent audit.','RESIN_HOLLOW_PLATE_REFERENCE_CHANGED');
  return capability;
}
async function derive(record,options) {
  const normalized=await read(options.directory,record.inputGeometry,MAX_SOURCE,options.signal), originalProfile=await read(options.directory,record.profile.originalJson,MiB,options.signal), baseline=await read(options.directory,record.profile.baselinePreset,MiB,options.signal);
  if(!isDeepStrictEqual(JSON.parse(originalProfile),options.profile) || !baseline.equals(options.preset) || !isDeepStrictEqual(parseIni(baseline.toString('utf8')),options.ini) || hash(Buffer.concat([originalProfile,Buffer.from('\0'),baseline]))!==record.profileSha256) throw fail('The current selected profile differs from the verified hollow reference.','RESIN_HOLLOW_PLATE_PROFILE_CHANGED');
  const orientation=record.inputs.hollowPlan.request.orientation;
  const bytes=await read(options.directory,record.roles.final.artifact,MAX_GOO,options.signal), raster=inspectGooRaster(bytes);
  const ref={placement:record.inputs.placement,totalHeightMm:record.roles.final.inspection.totalHeightMm};
  const derived=deriveResinPlateLayout(normalized,orientation,options.requested,ref,raster,options.profile,options.ini);
  return {normalized,bytes,orientation,reference:ref,...derived};
}
function inspect(bytes,profile,ini) {
  const inspection=inspectGoo(bytes,{limits:{maxFileBytes:MAX_GOO},expected:{...profile.expected,machineZMm:Number(ini.max_print_height),machineName:profile.printerModel,exposureTimeSeconds:profile.uvtoolsProperties.ExposureTime,bottomExposureTimeSeconds:profile.uvtoolsProperties.BottomExposureTime,bottomLayerCount:profile.uvtoolsProperties.BottomLayerCount}});
  assertTargetProperties(inspection,profile.uvtoolsProperties); if(inspection.perLayerSettings) throw fail('Per-layer overrides are not qualified by this hollow plate preparation.','RESIN_HOLLOW_PLATE_SCHEDULE'); return inspection;
}
function tool(referenceTool,impl) { const binaryManifest=[...referenceTool.binaryManifest,...impl.files.map(item=>({...item,name:'hollow-plate/'+item.name}))].sort((a,b)=>a.name.localeCompare(b.name)); return {name:'Controlled hollow SLA reference + exact plate replication',version:'2.9.7 / 7.1.2 / hollow-plate-v1',executableSha256:digest({referenceToolSha256:referenceTool.executableSha256,binaryManifest}),binaryManifest}; }
function analysisArgv(filePath) { return ['--quiet','print-issues',filePath,...CHECKS]; }
function validateAnalysis(record,hollow) {
  const item=record.analysisCapture,call=item?.invocation,receipt=call?.resourceReceipt,provider=hollow.providerManifest.providers.uvtools;
  const expectedInput=call?.inputsBefore?.[0];
  if(!plain(item) || typeof item.stdout!=='string' || typeof item.stderr!=='string' || Buffer.byteLength(item.stdout)+Buffer.byteLength(item.stderr)>MiB || !call || call.method!=='controlled-windows-provider-capture-v1' || call.schemaVersion!==1 || call.status!=='succeeded' || call.controlledExecution!==true || call.nativeInvocationAttested!==false || !/^hollow-plate-issues-[a-f0-9-]{36}$/.test(call.id) || call.sha256!==digest(without(call,'sha256')) || call.provider!=='uvtools' || call.providerManifestSha256!==hollow.providerManifest.sha256 || call.executable!==provider.executable || call.version!==provider.version || call.cwd!==record.captureDirectory || !isDeepStrictEqual(call.argv,analysisArgv(record.artifact.filePath)) || !isDeepStrictEqual(call.providerVerification,{before:true,after:true}) || !isDeepStrictEqual(call.implementation,hollow.invocations[0].implementation) || !isDeepStrictEqual(call.stdout,{bytes:Buffer.byteLength(item.stdout),sha256:hash(item.stdout)}) || !isDeepStrictEqual(call.stderr,{bytes:Buffer.byteLength(item.stderr),sha256:hash(item.stderr)}) || !Array.isArray(call.inputsBefore) || call.inputsBefore.length!==1 || expectedInput.id!=='plate-artifact' || expectedInput.filePath!==record.artifact.filePath || expectedInput.sha256!==record.artifact.sha256 || expectedInput.bytes!==record.artifact.bytes || !isDeepStrictEqual(call.inputsBefore,call.inputsAfter) || call.outputsAfter?.length!==0 || call.mutationsBefore?.length!==0 || call.argumentDirectories?.length!==0) throw fail('Hollow plate native analysis differs from its exact read-only command and artifact.','RESIN_HOLLOW_PLATE_EXECUTION_CHANGED');
  if(receipt?.schemaVersion!==1 || receipt.method!=='windows-job-object-v1' || receipt.assignedAtCreation!==true || receipt.assignedBeforeResume!==true || receipt.killOnJobClose!==true || receipt.descendantsTerminatedOnCompletion!==true || receipt.limitFlags!==0x2300 || receipt.stopReason!==null || receipt.outputLimitExceeded!==false || ![receipt.processCommitLimitBytes,receipt.jobCommitLimitBytes].every(value=>Number.isSafeInteger(value)&&value>0&&value<=1024*MiB) || receipt.jobCommitLimitBytes<receipt.processCommitLimitBytes || receipt.managedEnvironment?.DOTNET_PROCESSOR_COUNT!=='1' || receipt.memoryAccounting!=='committed-virtual-memory-not-rss' || receipt.memoryLimitObserved!==false || !isDeepStrictEqual(receipt.memoryLimitMessages,[]) || receipt.memoryNotificationsGuaranteed!==false || receipt.peakCommitObservation!=='after-root-exit-before-job-close' || receipt.peakJobAccounting!=='high-water-may-include-denied-commit-attempts' || typeof receipt.parentWasInJob!=='boolean' || !Number.isSafeInteger(receipt.processId) || receipt.processId<1 || ![receipt.peakProcessCommitBytes,receipt.peakJobCommitBytes,receipt.elapsedMs].every(value=>Number.isSafeInteger(value)&&value>=0) || receipt.elapsedMs>135000) throw fail('Hollow plate native analysis lacks its bounded process-tree receipt.','RESIN_HOLLOW_PLATE_EXECUTION_CHANGED');
  const supervisor=receipt.supervisorManifest?.files, prior=hollow.invocations[0].resourceReceipt?.supervisorManifest?.files;
  if(!Array.isArray(supervisor) || !Array.isArray(prior) || !isDeepStrictEqual(supervisor,prior) || receipt.supervisorManifest.sha256!==hash(JSON.stringify(supervisor))) throw fail('Hollow plate native supervisor differs from the verified reference.','RESIN_HOLLOW_PLATE_EXECUTION_CHANGED');
  const analysis=parseIssueReport(item.stdout+item.stderr);
  if(!analysis.passed || analysis.count!==0 || !isDeepStrictEqual(record.analysis,analysis)) throw fail('The final repeated hollow artifact has native print issues.','RESIN_HOLLOW_PLATE_NATIVE_ISSUES');
}

async function prepareResinHollowPlate(options) {
  const required=['source','hollowPreparation','profile','ini','preset','requested','directory'];
  keys(options,[...required,'signal','timeoutMs','referenceCapability','capture'],required,'controlled hollow plate request'); buffer(options.source,MAX_SOURCE,'source'); buffer(options.preset,MiB,'preset');
  const remaining=deadline(options.signal,options.timeoutMs), requested=normalizeResinPlateOptions(options.requested), parent=await local(options.directory,true);
  // Check the opaque session before any native factory call, including probes.
  if(options.capture!==undefined && !isControlledNativeCapture(options.capture)) throw fail('A real open controlled capture session is required.','RESIN_HOLLOW_PLATE_CAPTURE_REQUIRED');
  const capability=await reference(options.hollowPreparation,{...options,directory:parent,timeoutMs:remaining()}), hollow=options.hollowPreparation;
  const derived=await derive(hollow,{...options,directory:parent,requested}), impl=await implementation(); remaining();
  const captureDirectory=await fs.mkdtemp(path.join(parent,'hollow-plate-')), filePath=path.join(captureDirectory,'prepared.goo'); let session=options.capture,own=false;
  try {
    const replicated=replicateGooPlate(derived.bytes,{translationsPx:derived.translationsPx,marginPx:derived.reservation.marginPx,minGapPx:derived.reservation.minGapPx}); remaining();
    const artifact=await put(filePath,replicated.buffer);
    const providers=Object.fromEntries(Object.entries(hollow.providerManifest.providers).map(([id,item])=>[id,{executable:item.executable,version:item.version,sha256:item.files[0].sha256}]));
    if(!session) { own=true; session=await createControlledNativeCapture({cwd:captureDirectory,providers,signal:options.signal,limits:{timeoutMs:Math.min(120000,remaining())}}); }
    if(!isControlledNativeCapture(session) || session.getProviderManifest().sha256!==hollow.providerManifest.sha256 || !['prusa','uvtools'].every(id=>session.getProviderManifest().providers[id].executable===hollow.providerManifest.providers[id].executable&&session.getProviderManifest().providers[id].version===hollow.providerManifest.providers[id].version) || !isDeepStrictEqual(session.getImplementationManifest(),hollow.invocations[0].implementation)) throw fail('The final analysis capture differs from the verified reference providers.','RESIN_HOLLOW_PLATE_CAPTURE_REQUIRED');
    const actualRoot=session.getInvocations()[0]?.cwd;
    if(actualRoot!==(own?captureDirectory:parent)) throw fail('The native capture must use this exact fresh artifact root or shared managed parent.','RESIN_HOLLOW_PLATE_CAPTURE_REQUIRED');
    const run=await session.invoke({id:'hollow-plate-issues-'+randomUUID(),provider:'uvtools',argv:analysisArgv(filePath),inputs:[{id:'plate-artifact',filePath,maxBytes:MAX_GOO,expectedSha256:artifact.sha256}],outputs:[],mutations:[],timeoutMs:Math.min(120000,remaining())});
    if(!session.ownsInvocation(run.invocation)) throw fail('The final analysis is not owned by its real controlled session.','RESIN_HOLLOW_PLATE_CAPTURE_REQUIRED');
    const analysis=parseIssueReport(run.stdout+run.stderr); if(!analysis.passed) throw fail('The final repeated hollow artifact has native print issues.','RESIN_HOLLOW_PLATE_NATIVE_ISSUES');
    const artifactBytes=await read(parent,artifact,MAX_GOO,options.signal), inspection=inspect(artifactBytes,options.profile,options.ini);
    const rasterProof=verifyGooPlate(derived.bytes,artifactBytes,{translationsPx:derived.translationsPx,marginPx:derived.reservation.marginPx,minGapPx:derived.reservation.minGapPx});
    if(!isDeepStrictEqual(rasterProof,replicated.proof)) throw fail('Independent hollow plate pixel proof differs from the generated artifact.','RESIN_HOLLOW_PLATE_CHANGED');
    const body={schemaVersion:1,method:METHOD,recordPath:path.join(captureDirectory,'plate-preparation.json'),captureDirectory:actualRoot,artifact,requested,orientation:structuredClone(derived.orientation),sourceSha256:hash(derived.normalized),engineSourceSha256:hash(options.source),profileSha256:hollow.profileSha256,hollowPreparation:hollow,hollowPreparationSha256:hollow.sha256,reference:{...hollow.roles.final.artifact,input3mf:hollow.roles.final.input3mf,placement:hollow.inputs.placement,layerCount:inspection.layerCount,totalHeightMm:inspection.totalHeightMm},supportEnvelopeMm:derived.reservation.supportEnvelopeMm,supportHeightMm:derived.reservation.supportHeightMm,layout:derived.layout,replication:replicated.derivation,rasterProof,artifactSha256:artifact.sha256,analysis,analysisCapture:{stdout:run.stdout,stderr:run.stderr,invocation:run.invocation},implementation:impl,tool:tool(hollow.tool,impl),controlledExecution:true,nativeInvocationAttested:false,productionEligible:false};
    validateAnalysis(body,hollow); const record={...body,preparationSha256:digest(body)}, encoded=Buffer.from(JSON.stringify(record,null,2));
    if(encoded.length>MAX_RECORD) throw fail('The hollow plate receipt exceeds its file bound.','RESIN_HOLLOW_PLATE_LIMIT',413);
    await put(record.recordPath,encoded); if(own) { await session.close(); session=null; }
    await verifyResinHollowPlatePreparation(options.source,record,{hollowPreparation:hollow,profile:options.profile,ini:options.ini,preset:options.preset,artifactBytes,directory:parent,referenceCapability:capability,signal:options.signal,timeoutMs:remaining()}); remaining();
    return {filePath,sha256:artifact.sha256,bytes:artifact.bytes,inspection,analysis,status:'sliced_pending_qualification',printReady:false,printerCompatible:false,format:'goo',sourceSha256:hash(options.source),profileSha256:hollow.profileSha256,printerId:options.profile.printerId,printerModel:options.profile.printerModel,material:options.profile.material,tool:body.tool,inputGeometry:hollow.inputGeometry,sizingPlan:hollow.sizingPlan,orientation:derived.orientation,modelCopiesPerRun:derived.layout.copiesPlaced,hollowPreparation:hollow,platePreparation:freeze(record),referenceSl1Sha256:hollow.roles.final.sl1.sha256,hollowReferenceCapability:capability};
  } finally { if(own&&session) await session.close().catch(()=>{}); }
}

async function verifyResinHollowPlatePreparation(sourceOriginal,record,options) {
  keys(options,['hollowPreparation','profile','ini','preset','artifactBytes','directory','referenceCapability','signal','timeoutMs'],['hollowPreparation','profile','ini','preset','artifactBytes','directory'],'hollow plate verification'); buffer(sourceOriginal,MAX_SOURCE,'source'); buffer(options.preset,MiB,'preset'); buffer(options.artifactBytes,MAX_GOO,'artifact'); options={...options,source:sourceOriginal}; const remaining=deadline(options.signal,options.timeoutMs);
  if(!plain(record) || record.schemaVersion!==1 || record.method!==METHOD || !HASH.test(record.preparationSha256||'') || record.preparationSha256!==digest(without(record,'preparationSha256')) || record.controlledExecution!==true || record.nativeInvocationAttested!==false || record.productionEligible!==false || Buffer.byteLength(JSON.stringify(record))>MAX_RECORD) throw fail('A complete unchanged controlled hollow plate receipt is required.','RESIN_HOLLOW_PLATE_CHANGED');
  const parent=await local(options.directory,true), hollow=record.hollowPreparation;
  if(!isDeepStrictEqual(hollow,options.hollowPreparation)) throw fail('The current hollow preparation differs from the plate reference.','RESIN_HOLLOW_PLATE_CHANGED');
  const capability=await reference(hollow,{...options,directory:parent,timeoutMs:remaining()}), requested=normalizeResinPlateOptions(record.requested), impl=await implementation();
  const recordPath=absolute(record.recordPath); contained(parent,recordPath); await local(recordPath,false);
  const artifactRoot=await local(path.dirname(absolute(record.artifact?.filePath)),true), captureRoot=await local(record.captureDirectory,true);
  if(path.dirname(artifactRoot)!==parent || !path.basename(artifactRoot).startsWith('hollow-plate-') || path.basename(record.artifact.filePath)!=='prepared.goo' || recordPath!==path.join(artifactRoot,'plate-preparation.json') || (captureRoot!==parent&&captureRoot!==artifactRoot) || record.captureDirectory!==captureRoot) throw fail('Hollow plate capture and receipt must retain their exact managed roots.','RESIN_HOLLOW_PLATE_PATH');
  const encoded=Buffer.from(JSON.stringify(record,null,2));
  const persisted=await read(parent,{filePath:recordPath,bytes:encoded.length,sha256:hash(encoded)},MAX_RECORD,options.signal); if(!isDeepStrictEqual(JSON.parse(persisted),record)) throw fail('The persisted hollow plate receipt changed.','RESIN_HOLLOW_PLATE_CHANGED');
  const derived=await derive(hollow,{...options,directory:parent,requested});
  if(record.sourceSha256!==hash(derived.normalized) || record.engineSourceSha256!==hash(options.source) || record.profileSha256!==hollow.profileSha256 || record.hollowPreparationSha256!==hollow.sha256 || !isDeepStrictEqual(record.orientation,derived.orientation) || !isDeepStrictEqual(record.layout,derived.layout) || record.supportEnvelopeMm!==derived.reservation.supportEnvelopeMm || record.supportHeightMm!==derived.reservation.supportHeightMm || !isDeepStrictEqual(record.implementation,impl) || !isDeepStrictEqual(record.tool,tool(hollow.tool,impl))) throw fail('The hollow plate source, layout, profile or implementation changed.','RESIN_HOLLOW_PLATE_CHANGED');
  const expectedRef={...hollow.roles.final.artifact,input3mf:hollow.roles.final.input3mf,placement:hollow.inputs.placement,layerCount:hollow.roles.final.inspection.layerCount,totalHeightMm:hollow.roles.final.inspection.totalHeightMm};
  if(!isDeepStrictEqual(record.reference,expectedRef)) throw fail('The single-unit native hollow reference changed.','RESIN_HOLLOW_PLATE_CHANGED');
  const artifact=await read(parent,record.artifact,MAX_GOO,options.signal); if(!artifact.equals(options.artifactBytes) || record.artifactSha256!==hash(artifact)) throw fail('The repeated hollow artifact changed.','RESIN_HOLLOW_PLATE_CHANGED'); inspect(artifact,options.profile,options.ini);
  const regenerated=replicateGooPlate(derived.bytes,{translationsPx:derived.translationsPx,marginPx:derived.reservation.marginPx,minGapPx:derived.reservation.minGapPx}), proof=verifyGooPlate(derived.bytes,artifact,{translationsPx:derived.translationsPx,marginPx:derived.reservation.marginPx,minGapPx:derived.reservation.minGapPx});
  if(!regenerated.buffer.equals(artifact) || !isDeepStrictEqual(regenerated.derivation,record.replication) || !isDeepStrictEqual(regenerated.proof,proof) || !isDeepStrictEqual(proof,record.rasterProof)) throw fail('The complete repeated hollow raster, previews or estimates differ from independent reconstruction.','RESIN_HOLLOW_PLATE_CHANGED');
  validateAnalysis(record,hollow); await reference(hollow,{...options,directory:parent,referenceCapability:capability}); remaining();
  return freeze({schemaVersion:1,method:METHOD,modelCopiesPerRun:derived.layout.copiesPlaced,requested,orientation:derived.orientation,sourceSha256:record.sourceSha256,engineSourceSha256:record.engineSourceSha256,hollowPreparationSha256:hollow.sha256,artifactSha256:record.artifactSha256,layout:derived.layout,rasterProof:proof,preparationSha256:record.preparationSha256,nativeInvocationAttested:false,productionEligible:false});
}

module.exports={prepareResinHollowPlate,verifyResinHollowPlateReference,verifyResinHollowPlatePreparation};
