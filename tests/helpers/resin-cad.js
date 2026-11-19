'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareResinCad, verifyResinCadGeometry } = require('../../src/slicing/resin-cad');

// Intentionally synthetic protocol input: no native decoder runs in these
// fixtures. Mesh evidence is real closed geometry, checked by the real auditor.
const STEP = Buffer.from("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Owned fake-provider protocol fixture'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const AXES = ['x', 'y', 'z'];
const object = values => Object.fromEntries(AXES.map((axis, index) => [axis, values[index]]));
function boxTriangles(origin = [0,0,0], dimensions = [2,3,4]) {
  const points = [[0,0,0], [1,0,0], [1,1,0], [0,1,0], [0,0,1], [1,0,1], [1,1,1], [0,1,1]].map(point => point.map((value, axis) => origin[axis] + dimensions[axis] * value));
  return [[0,2,1], [0,3,2], [4,5,6], [4,6,7], [0,1,5], [0,5,4], [1,2,6], [1,6,5], [2,3,7], [2,7,6], [3,0,4], [3,4,7]].map(face => face.map(index => [...points[index]]));
}
function binaryStl(triangles) {
  const bytes = Buffer.alloc(84 + triangles.length * 50); bytes.write('Owned fake FreeCAD tessellation protocol fixture'); bytes.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, index) => triangle.forEach((point, vertex) => point.forEach((value, axis) => bytes.writeFloatLE(value, 84 + index * 50 + 12 + vertex * 12 + axis * 4))));
  return bytes;
}

async function createCadFixture(root, initialHooks = {}) {
  const installation = path.join(root, 'fake-freecad'), bin = path.join(installation, 'bin'), lib = path.join(installation, 'lib');
  await fs.mkdir(bin, { recursive: true }); await fs.mkdir(lib, { recursive: true });
  for (const name of ['FreeCADCmd.exe', 'python.exe', 'TKernel.dll', 'TKBRep.dll', 'TKMesh.dll', 'TKDESTEP.dll', 'FreeCAD.pyd', 'MeshPart.pyd']) await fs.writeFile(path.join(bin, name), `Owned fake installation ${name}`);
  await fs.writeFile(path.join(lib, 'Part.pyd'), 'Owned fake installation Part.pyd');
  const modulePaths = { FreeCAD: await fs.realpath(path.join(bin, 'FreeCAD.pyd')), Part: await fs.realpath(path.join(lib, 'Part.pyd')), MeshPart: await fs.realpath(path.join(bin, 'MeshPart.pyd')), pythonExecutable: await fs.realpath(path.join(bin, 'python.exe')) };
  const auditRuntime = path.join(root, 'fake-audit-site'), ocp = path.join(auditRuntime, 'OCP'), distribution = path.join(auditRuntime, 'cadquery_ocp_novtk-8.0.1.1.0.dist-info');
  await fs.mkdir(ocp, { recursive: true }); await fs.mkdir(distribution);
  const binding = path.join(ocp, 'OCP.cp311-win_amd64.pyd');
  await fs.writeFile(path.join(ocp, '__init__.py'), '# Owned fake OCP package\n'); await fs.writeFile(binding, 'Owned fake OCP binding');
  await fs.writeFile(path.join(distribution, 'METADATA'), 'Metadata-Version: 2.1\nName: cadquery-ocp-novtk\nVersion: 8.0.1.1.0\n');
  const auditModulePaths = { OCP: await fs.realpath(path.join(ocp, '__init__.py')), bindingModule: await fs.realpath(binding), pythonExecutable: modulePaths.pythonExecutable };
  // Explicit internal dependency injection, like the fake process runner. The
  // production runtime inspector never accepts this synthetic installation.
  const inspectRuntime = async runtimePath => {
    if (path.resolve(runtimePath) !== path.resolve(auditRuntime)) throw new Error('Fixture runtime path mismatch.');
    const files = [auditModulePaths.OCP, auditModulePaths.bindingModule, path.join(distribution, 'METADATA')].sort();
    const binaryManifest = [];
    for (const filename of files) { const bytes = await fs.readFile(filename); binaryManifest.push({ name: path.relative(auditRuntime, filename).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) }); }
    return { modulePaths: { OCP: auditModulePaths.OCP, bindingModule: auditModulePaths.bindingModule }, binaryManifest };
  };
  const options = { inputPath: path.join(root, 'owned-source.step'), outputDir: path.join(root, 'cad-output'), freecadExecutable: path.join(bin, 'FreeCADCmd.exe'), cadAuditPath: auditRuntime, timeoutMs: 10000 };
  await fs.writeFile(options.inputPath, STEP);
  const hooks = { ...initialHooks }, calls = [];
  const descriptors = [{ origin: [10,20,30], dimensions: [2,3,4] }, { origin: [15,22,31], dimensions: [1,2,1] }];
  const run = async (executable, args, processOptions) => {
    calls.push({ executable, args: [...args], options: processOptions });
    processOptions.signal?.throwIfAborted();
    if (hooks.failure) throw hooks.failure;
    const value = flag => args[args.indexOf(flag) + 1];
    const inputPath = value('--input'), source = await fs.readFile(inputPath);
    const solids = hooks.descriptors || descriptors;
    const minimum = AXES.map((_, axis) => Math.min(...solids.map(solid => solid.origin[axis]))), maximum = AXES.map((_, axis) => Math.max(...solids.map(solid => solid.origin[axis] + solid.dimensions[axis])));
    if (path.basename(args.find(argument => /\.py$/i.test(argument)) || '') === 'resin-cad-transfer-audit.py') {
      const output = value('--output');
      const inventory = solids.map((solid, index) => { const [x,y,z] = solid.dimensions; return { index, faceCount: 6, shellCount: 1, boundsMm: { min: object(solid.origin), max: object(solid.origin.map((value, axis) => value + solid.dimensions[axis])) }, volumeMm3: x*y*z, areaMm2: 2*(x*y+y*z+x*z) }; });
      const audit = { schemaVersion: 1, sourceSha256: hash(source), sourceBytes: source.length, coordinateUnits: 'mm',
        provider: { ocpVersion: '8.0.1.1', distributionVersion: '8.0.1.1.0', modulePaths: { ...auditModulePaths } },
        diagnostics: { loadFailureCount: 0, loadWarningCount: 0, transferFailureCount: 0, transferWarningCount: 0, rootCount: 1, transferredRootCount: 1, shapeCount: 1 },
        cad: { solidCount: solids.length, nonSolidLeafCount: 0, faceCount: solids.length * 6, boundsMm: { min: object(minimum), max: object(maximum) }, volumeMm3: inventory.reduce((sum, solid) => sum + solid.volumeMm3, 0), areaMm2: inventory.reduce((sum, solid) => sum + solid.areaMm2, 0), solids: inventory } };
      const context = { executable, args, processOptions, inputPath, source, output, audit, auditModulePaths, options, async writeAudit() { await fs.writeFile(output, JSON.stringify(audit)); } };
      if (hooks.mutateAudit) await hooks.mutateAudit(audit, context);
      await context.writeAudit(); if (hooks.afterAuditWrite) await hooks.afterAuditWrite(context);
      return 'Owned fake independent STEP transfer audit completed.';
    }
    const outputDir = value('--output-dir');
    const tolerance = { linearDeflectionMm: Number(value('--linear-deflection-mm')), angularDeflectionRad: Number(value('--angular-deflection-rad')) };
    const report = { schemaVersion: 1, sourceSha256: hash(source), sourceBytes: source.length, coordinateUnits: 'mm', tolerance, originMm: object(minimum),
      cad: { valid: true, nonSolidLeafCount: 0, solidCount: solids.length, boundsMm: { min: object(minimum), max: object(maximum) }, volumeMm3: 0, areaMm2: 0 }, solids: [],
      provider: { freecadVersion: ['1','1','1','fake-protocol-only'], occVersion: '7.9.3', pythonVersion: '3.11.15', modulePaths: { ...modulePaths } } };
    if (args.includes('--transfer-audit')) { const audit = await fs.readFile(value('--transfer-audit')); report.transferAudit = { sha256: hash(audit), bytes: audit.length }; }
    await fs.mkdir(outputDir, { recursive: true });
    const reportPath = path.join(outputDir, 'cad-report.json');
    const context = { executable, args, processOptions, inputPath, outputDir, source, report, reportPath, modulePaths, options,
      async writeSolid(index, triangles) {
        const bytes = binaryStl(triangles), artifact = report.solids[index].artifact;
        await fs.writeFile(path.join(outputDir, artifact.fileName), bytes);
        artifact.bytes = bytes.length; artifact.sha256 = hash(bytes); report.solids[index].triangleCount = triangles.length;
        return bytes;
      },
      async writeReport() { await fs.writeFile(reportPath, JSON.stringify(report)); },
    };
    for (let index = 0; index < solids.length; index++) {
      const solid = solids[index], [x,y,z] = solid.dimensions, volumeMm3 = x * y * z, areaMm2 = 2 * (x*y + y*z + x*z);
      report.cad.volumeMm3 += volumeMm3; report.cad.areaMm2 += areaMm2;
      report.solids.push({ index, valid: true, closed: true, shellCount: 1, faceCount: 6, meshedFaceCount: 6, faceTriangleCounts: [2,2,2,2,2,2], triangleCount: 12,
        boundsMm: { min: object(solid.origin), max: object(solid.origin.map((value, axis) => value + solid.dimensions[axis])) }, volumeMm3, areaMm2,
        artifact: { fileName: `solid-${String(index + 1).padStart(4, '0')}.stl` } });
      await context.writeSolid(index, boxTriangles(solid.origin.map((value, axis) => value - minimum[axis]), solid.dimensions));
    }
    if (hooks.mutateReport) await hooks.mutateReport(report, context);
    await context.writeReport();
    if (hooks.afterWrite) await hooks.afterWrite(context);
    return 'Owned fake FreeCAD worker completed; no native process was invoked.';
  };
  const prepare = input => prepareResinCad({ ...options, ...input, run, inspectRuntime });
  return { STEP, options, bin, lib, auditRuntime, modulePaths, auditModulePaths, hooks, calls, run, inspectRuntime, prepare,
    implementation: { prepareResinCad: prepare, verifyResinCadGeometry },
    verify: (record, source = STEP) => verifyResinCadGeometry(record, { source, directory: options.outputDir }) };
}

module.exports = { STEP, hash, boxTriangles, binaryStl, createCadFixture };
