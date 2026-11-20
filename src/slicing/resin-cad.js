'use strict';

// STEP is decoded by an isolated, configured FreeCAD installation. The original
// stays immutable; every solid is checked against independent mesh measurements.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { runProcess } = require('./index');
const { measureResinGeometry, float32Tolerance } = require('./resin-geometry');
const { auditResinMesh } = require('./resin-mesh');

const MAX_BYTES = 100 * 1024 * 1024, MAX_TRIANGLES = 250000;
const WORKER = path.join(__dirname, 'resin-cad-worker.py');
const AUDITOR = path.join(__dirname, 'resin-cad-transfer-audit.py');
const AXES = ['x', 'y', 'z'];
const HASH = /^[a-f0-9]{64}$/;
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = (message, code = 'RESIN_CAD_INVALID', status = 422) => Object.assign(new Error(message), { code, status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

async function readBounded(filePath, maximum = MAX_BYTES) {
  const info = await fs.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > maximum) throw fail('CAD input or evidence exceeds its file bound.', 'RESIN_CAD_FILE_INVALID');
  const handle = await fs.open(filePath, 'r');
  try {
    const pinned = await handle.stat();
    if (!pinned.isFile() || pinned.size !== info.size) throw fail('CAD evidence changed while opening it.', 'RESIN_CAD_CHANGED');
    const bytes = Buffer.alloc(info.size); let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset !== bytes.length || (await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw fail('CAD evidence changed while reading it.', 'RESIN_CAD_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}

async function contained(directory, filename) {
  if (typeof filename !== 'string' || !filename || /[\0\r\n]/.test(filename) || path.isAbsolute(filename) || filename !== path.basename(filename)) throw fail('CAD evidence must use a direct managed file name.');
  const candidate = path.join(directory, filename);
  const info = await fs.lstat(candidate);
  if (info.isSymbolicLink()) throw fail('CAD evidence cannot use symbolic links.');
  const relative = path.relative(await fs.realpath(directory), await fs.realpath(candidate));
  if (relative !== filename) throw fail('CAD evidence resolves outside its work directory.');
  return candidate;
}

async function managedDirectory(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('CAD work must remain inside its managed directory.', 'RESIN_CAD_CHANGED');
  let component = root;
  for (const segment of relative.split(path.sep)) { component = path.join(component, segment); const info = await fs.lstat(component); if (!info.isDirectory() || info.isSymbolicLink()) throw fail('CAD work directories cannot use links.', 'RESIN_CAD_CHANGED'); }
  const actual = path.relative(await fs.realpath(root), await fs.realpath(candidate));
  if (actual !== relative) throw fail('CAD work directory resolves outside its managed location.', 'RESIN_CAD_CHANGED');
}

async function hashFile(filePath) {
  const info = await fs.stat(filePath);
  if (!info.isFile() || !info.size || info.size > 512 * 1024 * 1024) throw fail('FreeCAD provider file is missing or exceeds its bound.', 'RESIN_CAD_CONFIGURATION');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(filePath)) digest.update(bytes);
  return { bytes: info.size, sha256: digest.digest('hex') };
}

async function providerManifest(executable, cadAuditPath, inspectRuntime) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !/^freecadcmd\.exe$/i.test(path.basename(executable)) || path.basename(path.dirname(executable)).toLowerCase() !== 'bin') throw fail('Choose FreeCADCmd.exe in a complete Windows FreeCAD installation.', 'RESIN_CAD_CONFIGURATION', 400);
  const bin = path.dirname(executable), root = path.dirname(bin), python = path.join(bin, 'python.exe');
  const files = new Set([executable, python]);
  const modulePaths = {};
  for (const name of ['FreeCAD', 'Part', 'MeshPart']) {
    let selected;
    for (const directory of [bin, path.join(root, 'lib')]) {
      const candidate = path.join(directory, `${name}.pyd`);
      if (await fs.stat(candidate).then(stat => stat.isFile(), () => false)) { selected = candidate; break; }
    }
    if (!selected) throw fail(`The FreeCAD installation lacks ${name}.pyd.`, 'RESIN_CAD_CONFIGURATION');
    modulePaths[name] = await fs.realpath(selected); files.add(selected);
  }
  modulePaths.pythonExecutable = await fs.realpath(python);
  const dlls = (await fs.readdir(bin)).filter(name => /^(?:TK.*|FreeCAD(?:App|Base)|python\d+)\.dll$/i.test(name));
  for (const required of ['TKernel.dll', 'TKBRep.dll', 'TKMesh.dll', 'TKDESTEP.dll']) if (!dlls.some(name => name.toLowerCase() === required.toLowerCase())) throw fail(`The FreeCAD installation lacks ${required}.`, 'RESIN_CAD_CONFIGURATION');
  if (dlls.length > 256) throw fail('The FreeCAD dependency inventory exceeds its bound.', 'RESIN_CAD_CONFIGURATION');
  dlls.forEach(name => files.add(path.join(bin, name)));
  const entries = [];
  for (const filePath of [...files].sort()) entries.push({ name: `freecad/${path.relative(root, filePath).replaceAll('\\', '/')}`, ...(await hashFile(filePath)) });
  for (const [name, filePath] of [['cad-worker', WORKER], ['cad-transfer-auditor', AUDITOR], ['cad-verifier', __filename], ['cad-runtime-verifier', path.join(__dirname, 'resin-cad-runtime.js')], ['mesh-auditor', path.join(__dirname, 'resin-mesh.js')], ['geometry-parser', path.join(__dirname, 'resin-geometry.js')], ['process-runner', path.join(__dirname, 'index.js')]]) entries.push({ name: `quickprint/${name}`, ...(await hashFile(filePath)) });
  const runtime = await (inspectRuntime || require('./resin-cad-runtime').inspectResinCadRuntime)(cadAuditPath);
  entries.push(...runtime.binaryManifest.map(entry => ({ ...entry, name: `cad-audit/${entry.name}` })));
  return { python, modulePaths, auditModulePaths: runtime.modulePaths, binaryManifest: entries, executableSha256: hash(JSON.stringify(entries)) };
}

function validateBounds(bounds) {
  return plain(bounds) && ['min', 'max'].every(key => plain(bounds[key]) && AXES.every(axis => typeof bounds[key][axis] === 'number' && Number.isFinite(bounds[key][axis]) && Math.abs(bounds[key][axis]) <= 1e9)) && AXES.every(axis => bounds.max[axis] > bounds.min[axis]);
}

function validateReport(report, source, tolerance) {
  const cad = report?.cad;
  if (!plain(report) || report.schemaVersion !== 1 || report.sourceSha256 !== hash(source) || report.sourceBytes !== source.length || report.coordinateUnits !== 'mm' || !isDeepStrictEqual(report.tolerance, tolerance) ||
      !plain(cad) || cad.valid !== true || cad.nonSolidLeafCount !== 0 || !Number.isSafeInteger(cad.solidCount) || cad.solidCount < 1 || cad.solidCount > 128 || !validateBounds(cad.boundsMm) || !isDeepStrictEqual(report.originMm, cad.boundsMm.min) || !positive(cad.volumeMm3) || !positive(cad.areaMm2) ||
      !Array.isArray(report.solids) || report.solids.length !== cad.solidCount || !plain(report.provider) || !Array.isArray(report.provider.freecadVersion) || report.provider.freecadVersion.length < 3 || report.provider.freecadVersion.length > 16 || report.provider.freecadVersion.some(value => typeof value !== 'string' || value.length > 200) || !/^1$/.test(report.provider.freecadVersion[0]) || !/^7\.\d+\.\d+/.test(report.provider.occVersion || '') || !/^3\.\d+\.\d+/.test(report.provider.pythonVersion || '')) throw fail('FreeCAD did not return a complete, source-bound CAD inventory.', 'RESIN_CAD_EVIDENCE_INVALID', 502);
  let triangles = 0, faces = 0, volume = 0, area = 0;
  for (let index = 0; index < report.solids.length; index++) {
    const solid = report.solids[index], artifact = solid?.artifact;
    if (!plain(solid) || solid.index !== index || solid.valid !== true || solid.closed !== true || solid.shellCount !== 1 || !Number.isSafeInteger(solid.faceCount) || solid.faceCount < 1 || solid.meshedFaceCount !== solid.faceCount || !Number.isSafeInteger(solid.triangleCount) || solid.triangleCount < 4 || !validateBounds(solid.boundsMm) || !positive(solid.volumeMm3) || !positive(solid.areaMm2) ||
        !plain(artifact) || artifact.fileName !== `solid-${String(index + 1).padStart(4, '0')}.stl` || !Number.isSafeInteger(artifact.bytes) || artifact.bytes !== 84 + solid.triangleCount * 50 || !HASH.test(artifact.sha256 || '')) throw fail('A CAD solid lacks complete closed-shell or face-meshing evidence.', 'RESIN_CAD_EVIDENCE_INVALID', 502);
    if (!Array.isArray(solid.faceTriangleCounts) || solid.faceTriangleCounts.length !== solid.faceCount || solid.faceTriangleCounts.some(value => !Number.isSafeInteger(value) || value < 1) || solid.faceTriangleCounts.reduce((sum, value) => sum + value, 0) !== solid.triangleCount) throw fail('CAD face coverage does not account for every mesh triangle.', 'RESIN_CAD_EVIDENCE_INVALID', 502);
    triangles += solid.triangleCount; faces += solid.faceCount; volume += solid.volumeMm3; area += solid.areaMm2;
  }
  if (triangles > MAX_TRIANGLES || faces > 50000 || Math.abs(volume - cad.volumeMm3) > Math.max(volume * 1e-10, Number.EPSILON) || Math.abs(area - cad.areaMm2) > Math.max(area * 1e-10, Number.EPSILON)) throw fail('CAD aggregate counts, volume or area are inconsistent.', 'RESIN_CAD_EVIDENCE_INVALID', 502);
}

function validateTransferAudit(audit, source) {
  const diagnostics = audit?.diagnostics, cad = audit?.cad;
  if (!plain(audit) || audit.schemaVersion !== 1 || audit.sourceSha256 !== hash(source) || audit.sourceBytes !== source.length || audit.coordinateUnits !== 'mm' ||
      !plain(audit.provider) || audit.provider.distributionVersion !== '8.0.1.1.0' || audit.provider.ocpVersion !== '8.0.1.1' ||
      !plain(diagnostics) || ['loadFailureCount', 'loadWarningCount', 'transferFailureCount', 'transferWarningCount'].some(key => diagnostics[key] !== 0) || !Number.isSafeInteger(diagnostics.rootCount) || diagnostics.rootCount < 1 || diagnostics.transferredRootCount !== diagnostics.rootCount || !Number.isSafeInteger(diagnostics.shapeCount) || diagnostics.shapeCount < 1 ||
      !plain(cad) || !Number.isSafeInteger(cad.solidCount) || cad.solidCount < 1 || cad.solidCount > 128 || cad.nonSolidLeafCount !== 0 || !validateBounds(cad.boundsMm) || !positive(cad.volumeMm3) || !positive(cad.areaMm2) || !Number.isSafeInteger(cad.faceCount) || cad.faceCount < 1 || cad.faceCount > 50000 || !Array.isArray(cad.solids) || cad.solids.length !== cad.solidCount) throw fail('STEP transfer diagnostics did not prove a complete clean import.', 'RESIN_CAD_TRANSFER_FAILED');
  for (let index = 0; index < cad.solids.length; index++) {
    const solid = cad.solids[index];
    if (!plain(solid) || solid.index !== index || solid.shellCount !== 1 || !Number.isSafeInteger(solid.faceCount) || solid.faceCount < 1 || !validateBounds(solid.boundsMm) || !positive(solid.volumeMm3) || !positive(solid.areaMm2)) throw fail('STEP transfer did not identify valid single-shell solids.', 'RESIN_CAD_TRANSFER_FAILED');
  }
  if (cad.solids.reduce((sum, solid) => sum + solid.faceCount, 0) !== cad.faceCount) throw fail('STEP transfer face counts are inconsistent.', 'RESIN_CAD_TRANSFER_FAILED');
}

function compareInventories(report, audit) {
  const close = (a, b) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-8, Math.abs(b) * 1e-8);
  const closeCoordinate = (a, b) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * Number.EPSILON * 16, Math.abs(b) * Number.EPSILON * 16);
  const boundsMatch = (a, b) => ['min', 'max'].every(side => AXES.every(axis => closeCoordinate(a[side][axis], b[side][axis])));
  if (report.cad.solidCount !== audit.cad.solidCount || report.solids.reduce((sum, solid) => sum + solid.faceCount, 0) !== audit.cad.faceCount || !boundsMatch(report.cad.boundsMm, audit.cad.boundsMm) || !close(report.cad.volumeMm3, audit.cad.volumeMm3) || !close(report.cad.areaMm2, audit.cad.areaMm2)) throw fail('Independent STEP reader and FreeCAD inventories disagree.', 'RESIN_CAD_INVENTORY_MISMATCH');
  const remaining = [...audit.cad.solids];
  for (const solid of report.solids) {
    const index = remaining.findIndex(other => other.faceCount === solid.faceCount && other.shellCount === solid.shellCount && boundsMatch(other.boundsMm, solid.boundsMm) && close(other.volumeMm3, solid.volumeMm3) && close(other.areaMm2, solid.areaMm2));
    if (index < 0) throw fail('A CAD solid was dropped, moved or changed during import.', 'RESIN_CAD_INVENTORY_MISMATCH');
    remaining.splice(index, 1);
  }
}

function compareSolid(solid, audit, tolerance, originMm) {
  if (audit.triangleCount !== solid.triangleCount || audit.componentCount !== 1 || audit.components[0].winding !== 'positive') throw fail('Tessellation does not preserve one outward closed shell per CAD solid.', 'RESIN_CAD_TOPOLOGY_MISMATCH');
  for (const axis of AXES) for (const side of ['min', 'max']) {
    const expected = solid.boundsMm[side][axis] - originMm[axis], actual = audit.boundsMm[side][axis];
    if (Math.abs(actual - expected) > tolerance.linearDeflectionMm * 2 + float32Tolerance(expected)) throw fail('Tessellation changed the CAD solid bounds.', 'RESIN_CAD_GEOMETRY_MISMATCH');
  }
  // A bounded diagnostic of tessellation accuracy, not a Hausdorff-distance or
  // solid-intersection proof. Kernel validity and face coverage are also required.
  const maximumVolumeError = solid.areaMm2 * tolerance.linearDeflectionMm * 2 + solid.volumeMm3 * 1e-6;
  if (Math.abs(audit.components[0].volumeMm3 - solid.volumeMm3) > maximumVolumeError) throw fail('Tessellation differs too far from the analytic CAD volume.', 'RESIN_CAD_GEOMETRY_MISMATCH');
}

function combineMeshes(meshes) {
  const count = meshes.reduce((sum, bytes) => sum + bytes.readUInt32LE(80), 0);
  if (!count || count > MAX_TRIANGLES || 84 + count * 50 > MAX_BYTES) throw fail('Combined CAD mesh exceeds its bound.', 'RESIN_CAD_LIMIT', 413);
  const bytes = Buffer.alloc(84 + count * 50); bytes.write('QuickPrint source-preserving FreeCAD tessellation'); bytes.writeUInt32LE(count, 80);
  let offset = 84;
  for (const mesh of meshes) { mesh.copy(bytes, offset, 84); offset += mesh.length - 84; }
  return bytes;
}

async function inspectReport(directory, report, source, tolerance, audit, auditBytes) {
  validateReport(report, source, tolerance);
  validateTransferAudit(audit, source); compareInventories(report, audit);
  if (report.transferAudit?.sha256 !== hash(auditBytes) || report.transferAudit?.bytes !== auditBytes.length) throw fail('CAD tessellation is not bound to the clean STEP transfer audit.', 'RESIN_CAD_TRANSFER_FAILED');
  const meshes = [], meshAudits = [];
  for (const solid of report.solids) {
    const bytes = await readBounded(await contained(directory, solid.artifact.fileName));
    if (bytes.length !== solid.artifact.bytes || hash(bytes) !== solid.artifact.sha256 || bytes.length !== 84 + bytes.readUInt32LE(80) * 50) throw fail('A tessellated CAD solid changed.', 'RESIN_CAD_CHANGED');
    const audit = auditResinMesh(bytes, { format: 'stl', units: 'mm' }); compareSolid(solid, audit, tolerance, report.originMm);
    meshes.push(bytes); meshAudits.push(audit);
  }
  const combined = combineMeshes(meshes), measurement = measureResinGeometry(combined, { format: 'stl', units: 'mm' });
  for (const axis of AXES) for (const side of ['min', 'max']) {
    const expected = report.cad.boundsMm[side][axis] - report.originMm[axis];
    if (Math.abs(measurement.sourceBounds[side][axis] - expected) > tolerance.linearDeflectionMm * 2 + float32Tolerance(expected)) throw fail('Combined tessellation changed the CAD assembly bounds.', 'RESIN_CAD_GEOMETRY_MISMATCH');
  }
  return { combined, measurement, meshAudits };
}

async function materializeCadWorkers(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('CAD workers require an absolute private work directory.', 'RESIN_CAD_CONFIGURATION');
  const result = {};
  for (const [key, source] of [['worker', WORKER], ['auditor', AUDITOR]]) {
    // readFile works for an Electron ASAR resource; native Python receives an
    // ordinary private copy and never needs to interpret an ASAR path.
    const bytes = await fs.readFile(source);
    if (!bytes.length || bytes.length > 1024 * 1024) throw fail('CAD worker resource size is invalid.', 'RESIN_CAD_CONFIGURATION');
    const filePath = path.join(directory, path.basename(source));
    await fs.writeFile(filePath, bytes, { flag: 'wx' });
    if (hash(await readBounded(filePath, 1024 * 1024)) !== hash(bytes)) throw fail('CAD worker extraction changed its content.', 'RESIN_CAD_CHANGED');
    result[key] = { filePath, bytes: bytes.length, sha256: hash(bytes) };
  }
  return result;
}

async function prepareResinCad({ inputPath, outputDir, freecadExecutable, cadAuditPath, timeoutMs = 900000, signal, linearDeflectionMm = 0.005, angularDeflectionRad = 0.1, run = runProcess, inspectRuntime } = {}) {
  if (![inputPath, outputDir].every(value => typeof value === 'string' && path.isAbsolute(value)) || !/\.(step|stp)$/i.test(inputPath)) throw fail('Choose an absolute STEP/STP source and managed output directory.', 'RESIN_CAD_CONFIGURATION', 400);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000 || !positive(linearDeflectionMm) || linearDeflectionMm < 0.0001 || linearDeflectionMm > 0.1 || !positive(angularDeflectionRad) || angularDeflectionRad < 0.01 || angularDeflectionRad > 0.5) throw fail('CAD time and tessellation tolerances are outside supported bounds.', 'RESIN_CAD_CONFIGURATION', 400);
  signal?.throwIfAborted();
  const source = await readBounded(inputPath), before = await providerManifest(freecadExecutable, cadAuditPath, inspectRuntime);
  await fs.mkdir(outputDir, { recursive: true });
  const directory = await fs.mkdtemp(path.join(outputDir, 'cad-'));
  const sourceCopy = path.join(directory, 'source.step'), meshDirectory = path.join(directory, 'meshes');
  await fs.writeFile(sourceCopy, source, { flag: 'wx' }); await fs.mkdir(meshDirectory);
  const scripts = await materializeCadWorkers(directory), workerCopy = scripts.worker.filePath, auditorCopy = scripts.auditor.filePath;
  const tolerance = { linearDeflectionMm, angularDeflectionRad };
  const auditReportPath = path.join(directory, 'step-transfer-audit.json');
  const auditLog = await run(before.python, ['-I', '-B', auditorCopy, '--input', sourceCopy, '--audit-runtime', cadAuditPath, '--output', auditReportPath], { timeoutMs, signal });
  await managedDirectory(outputDir, directory);
  const auditBytes = await readBounded(await contained(directory, 'step-transfer-audit.json'), 1024 * 1024);
  let audit; try { audit = JSON.parse(auditBytes); } catch { throw fail('STEP transfer audit is not valid JSON.', 'RESIN_CAD_TRANSFER_FAILED'); }
  validateTransferAudit(audit, source);
  for (const [name, expected] of Object.entries({ ...before.auditModulePaths, pythonExecutable: await fs.realpath(before.python) })) if (typeof audit.provider.modulePaths?.[name] !== 'string' || await fs.realpath(audit.provider.modulePaths[name]) !== await fs.realpath(expected)) throw fail('STEP auditor loaded an unexpected runtime module.', 'RESIN_CAD_PROVIDER_CHANGED');
  const log = await run(before.python, ['-I', '-B', workerCopy, '--input', sourceCopy, '--output-dir', meshDirectory, '--transfer-audit', auditReportPath, '--linear-deflection-mm', String(linearDeflectionMm), '--angular-deflection-rad', String(angularDeflectionRad)], { timeoutMs, signal });
  signal?.throwIfAborted();
  await managedDirectory(outputDir, directory); await managedDirectory(directory, meshDirectory);
  const reportPath = await contained(meshDirectory, 'cad-report.json'), reportBytes = await readBounded(reportPath, 1024 * 1024);
  let report; try { report = JSON.parse(reportBytes); } catch { throw fail('FreeCAD returned invalid CAD evidence JSON.', 'RESIN_CAD_EVIDENCE_INVALID', 502); }
  const after = await providerManifest(freecadExecutable, cadAuditPath, inspectRuntime);
  if (before.executableSha256 !== after.executableSha256 || !plain(report.provider?.modulePaths)) throw fail('The CAD provider changed during conversion.', 'RESIN_CAD_PROVIDER_CHANGED');
  for (const [name, expected] of Object.entries(before.modulePaths)) if (typeof report.provider.modulePaths[name] !== 'string' || await fs.realpath(report.provider.modulePaths[name]) !== expected) throw fail('FreeCAD loaded modules outside the configured provider.', 'RESIN_CAD_PROVIDER_CHANGED');
  const inspected = await inspectReport(meshDirectory, report, source, tolerance, audit, auditBytes);
  const filePath = path.join(directory, 'source-millimetres.stl'); await fs.writeFile(filePath, inspected.combined, { flag: 'wx' });
  if (hash(await readBounded(inputPath)) !== hash(source) || hash(await readBounded(sourceCopy)) !== hash(source)) throw fail('The original STEP source changed during conversion.', 'ORIGINAL_CHANGED', 409);
  signal?.throwIfAborted();
  const result = { schemaVersion: 1, kind: 'step-tessellation', sourceSha256: hash(source), sourceBytes: source.length, coordinateUnits: 'mm', sourceCopy, reportPath, reportSha256: hash(reportBytes), auditReportPath, auditReportSha256: hash(auditBytes), transferAudit: audit,
    filePath, sha256: hash(inspected.combined), bytes: inspected.combined.length, tolerance, originMm: report.originMm, cad: report.cad, solids: report.solids, meshAudits: inspected.meshAudits,
    measurement: inspected.measurement, tool: { name: 'FreeCAD CAD tessellation', version: `${report.provider.freecadVersion.slice(0, 3).join('.')} / OCCT ${report.provider.occVersion}`, executableSha256: before.executableSha256, binaryManifest: before.binaryManifest },
    embeddedUnitsConverted: true, createdAt: new Date().toISOString(), log: `${auditLog || ''}\n${log || ''}`.slice(-16384) };
  await fs.writeFile(path.join(directory, 'conversion.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  return result;
}

async function verifyResinCadGeometry(record, { source, directory } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !plain(record) || record.schemaVersion !== 1 || record.kind !== 'step-tessellation' || !Buffer.isBuffer(source) || record.sourceSha256 !== hash(source) || record.sourceBytes !== source.length || record.coordinateUnits !== 'mm' || record.embeddedUnitsConverted !== true || !HASH.test(record.tool?.executableSha256 || '') || !HASH.test(record.reportSha256 || '') || !HASH.test(record.sha256 || '') || !positive(record.tolerance?.linearDeflectionMm) || record.tolerance.linearDeflectionMm < 0.0001 || record.tolerance.linearDeflectionMm > 0.1 || !positive(record.tolerance?.angularDeflectionRad) || record.tolerance.angularDeflectionRad < 0.01 || record.tolerance.angularDeflectionRad > 0.5) throw fail('The saved CAD conversion no longer identifies this STEP source.', 'RESIN_CAD_CHANGED');
  for (const candidate of [record.sourceCopy, record.reportPath, record.auditReportPath, record.filePath]) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw fail('CAD evidence needs a managed file path.', 'RESIN_CAD_CHANGED');
    const relative = path.relative(directory, candidate);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw fail('CAD evidence is outside its job directory.', 'RESIN_CAD_CHANGED');
    let component = directory;
    for (const segment of relative.split(path.sep)) { component = path.join(component, segment); if ((await fs.lstat(component)).isSymbolicLink()) throw fail('CAD evidence cannot use symbolic links.', 'RESIN_CAD_CHANGED'); }
    const actual = path.relative(await fs.realpath(directory), await fs.realpath(candidate));
    if (actual.startsWith(`..${path.sep}`) || actual === '..' || path.isAbsolute(actual)) throw fail('CAD evidence resolves outside its job directory.', 'RESIN_CAD_CHANGED');
  }
  if (hash(await readBounded(record.sourceCopy)) !== hash(source)) throw fail('The saved STEP source changed.', 'RESIN_CAD_CHANGED');
  const reportBytes = await readBounded(record.reportPath, 1024 * 1024);
  if (hash(reportBytes) !== record.reportSha256) throw fail('The saved CAD inventory changed.', 'RESIN_CAD_CHANGED');
  let report; try { report = JSON.parse(reportBytes); } catch { throw fail('The saved CAD inventory is invalid.', 'RESIN_CAD_CHANGED'); }
  if (!isDeepStrictEqual(report.cad, record.cad) || !isDeepStrictEqual(report.solids, record.solids) || !isDeepStrictEqual(report.originMm, record.originMm)) throw fail('Saved CAD inventory claims differ from the report.', 'RESIN_CAD_CHANGED');
  const auditBytes = await readBounded(record.auditReportPath, 1024 * 1024);
  if (hash(auditBytes) !== record.auditReportSha256) throw fail('The saved STEP transfer audit changed.', 'RESIN_CAD_CHANGED');
  let audit; try { audit = JSON.parse(auditBytes); } catch { throw fail('The saved STEP transfer audit is invalid.', 'RESIN_CAD_CHANGED'); }
  if (!isDeepStrictEqual(audit, record.transferAudit)) throw fail('Saved STEP transfer audit claims changed.', 'RESIN_CAD_CHANGED');
  const inspected = await inspectReport(path.dirname(record.reportPath), report, source, record.tolerance, audit, auditBytes), combined = await readBounded(record.filePath);
  if (combined.length !== record.bytes || hash(combined) !== record.sha256 || !combined.equals(inspected.combined) || !isDeepStrictEqual(record.measurement, inspected.measurement) || !isDeepStrictEqual(record.meshAudits, inspected.meshAudits)) throw fail('The saved CAD mesh or measurements changed.', 'RESIN_CAD_CHANGED');
  return { bytes: combined, measurement: inspected.measurement };
}

module.exports = { prepareResinCad, verifyResinCadGeometry, materializeCadWorkers };
