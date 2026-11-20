#!/usr/bin/env python3
"""Independent STEP load/transfer audit; never import FreeCAD in this process.

The caller pins/hashes the isolated OCP runtime, supplies a private source copy,
and independently validates this source-bound receipt. Warnings are rejected
conservatively, including native repair/transfer warnings on otherwise valid CAD.
"""

import argparse
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import stat
import sys


MAX_SOURCE = 100 * 1024 * 1024
MAX_REPORT = 1024 * 1024
MAX_SOLIDS = 128
MAX_FACES = 50000


class AuditError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise AuditError(code, message)


def finite(value, positive=False):
    value = float(value)
    require(math.isfinite(value) and (not positive or value > 0),
            "CAD_AUDIT_INVALID_GEOMETRY", "CAD measurements must be finite and nondegenerate")
    return 0.0 if value == 0 else value


def read_source(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and 0 < info.st_size <= MAX_SOURCE,
            "CAD_AUDIT_INVALID_INPUT", "Input must be a bounded regular STEP file")
    with path.open("rb") as stream:
        data = stream.read(MAX_SOURCE + 1)
    require(0 < len(data) <= MAX_SOURCE, "CAD_AUDIT_INVALID_INPUT", "STEP source exceeds its byte limit")
    require(data.lstrip().startswith(b"ISO-10303-21;"), "CAD_AUDIT_INVALID_INPUT", "Only Part 21 STEP input is supported")
    return data


def checks(iterator):
    failures, warnings, entries = 0, 0, 0
    iterator.Start()
    while iterator.More():
        check = iterator.Value()
        failures += int(check.NbFails())
        warnings += int(check.NbWarnings())
        entries += 1
        require(entries <= 500000, "CAD_AUDIT_LIMIT", "Native diagnostic entries exceed the limit")
        iterator.Next()
    return failures, warnings


def publish(path, report):
    data = (json.dumps(report, allow_nan=False, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
    require(len(data) <= MAX_REPORT, "CAD_AUDIT_LIMIT", "Transfer audit report exceeds the byte limit")
    temporary = path.with_name("." + path.name + ".tmp")
    with temporary.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.link(temporary, path)
    temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--audit-runtime", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source, runtime, output = Path(args.input), Path(args.audit_runtime), Path(args.output)
    require(source.is_absolute() and runtime.is_absolute() and output.is_absolute() and
            source.suffix.lower() in (".step", ".stp"),
            "CAD_AUDIT_INVALID_INPUT", "Absolute STEP, runtime and output paths are required")
    require(runtime.is_dir() and not runtime.is_symlink() and output.parent.is_dir() and
            not output.exists() and not output.is_symlink(),
            "CAD_AUDIT_INVALID_INPUT", "Configured runtime and fresh report path are required")
    before = read_source(source)
    source_sha = hashlib.sha256(before).hexdigest()
    sys.path.insert(0, str(runtime))
    import OCP
    import OCP.OCP as binding
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.TopoDS import TopoDS_Iterator
    from OCP.TopAbs import TopAbs_SOLID, TopAbs_FACE, TopAbs_SHELL, TopAbs_COMPOUND, TopAbs_COMPSOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    require("FreeCAD" not in sys.modules, "CAD_AUDIT_RUNTIME_CONFLICT", "OCP and FreeCAD must run in separate processes")
    reader = STEPControl_Reader()
    require(Interface_Static.SetCVal_s("xstep.cascade.unit", "MM") and
            Interface_Static.SetIVal_s("read.surfacecurve.mode", 0),
            "CAD_AUDIT_CONFIGURATION", "Cannot pin native STEP unit/import settings")
    require(reader.ReadFile(str(source)) == IFSelect_RetDone,
            "CAD_AUDIT_LOAD_FAILED", "Native STEP reader could not load the complete input")
    load_failures, load_warnings = checks(reader.WS().ModelCheckList(True))
    require(load_failures == 0 and load_warnings == 0, "CAD_AUDIT_LOAD_DIAGNOSTICS",
            "Native STEP load diagnostics are not clean (failures=%d, warnings=%d)" % (load_failures, load_warnings))
    reader.SetSystemLengthUnit(1.0)
    require(reader.SystemLengthUnit() == 1.0, "CAD_AUDIT_CONFIGURATION", "Native STEP target coordinate unit is not millimetres")
    root_count = int(reader.NbRootsForTransfer())
    require(0 < root_count <= 500000, "CAD_AUDIT_ROOTS", "STEP has no translatable roots or exceeds the root limit")
    transferred = int(reader.TransferRoots())
    transfer_failures, transfer_warnings = checks(reader.WS().TransferReader().LastCheckList())
    shape_count = int(reader.NbShapes())
    require(transferred == root_count and shape_count > 0 and transfer_failures == 0 and transfer_warnings == 0,
            "CAD_AUDIT_TRANSFER_DIAGNOSTICS",
            "Native STEP transfer is incomplete or has diagnostics (roots=%d/%d, failures=%d, warnings=%d)" %
            (transferred, root_count, transfer_failures, transfer_warnings))
    shape = reader.OneShape()
    require(not shape.IsNull() and BRepCheck_Analyzer(shape).IsValid(),
            "CAD_AUDIT_INVALID_GEOMETRY", "Native STEP transfer returned invalid or empty geometry")

    def count(current, kind):
        result, explorer = 0, TopExp_Explorer(current, kind)
        while explorer.More():
            result += 1
            require(result <= MAX_FACES, "CAD_AUDIT_LIMIT", "CAD topology exceeds the limit")
            explorer.Next()
        return result

    def bounds(current):
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(current, box, False, False)
        low, high = box.CornerMin(), box.CornerMax()
        result = {"min": {axis: finite(getattr(low, axis.upper())()) for axis in "xyz"},
                  "max": {axis: finite(getattr(high, axis.upper())()) for axis in "xyz"}}
        require(all(result["max"][axis] > result["min"][axis] for axis in "xyz"),
                "CAD_AUDIT_INVALID_GEOMETRY", "CAD solid must have three positive extents")
        return result

    solids, non_solid, nodes = [], 0, 0
    stack = [(shape, 0)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        require(nodes <= 100000 and depth <= 64, "CAD_AUDIT_LIMIT", "CAD assembly hierarchy exceeds the limit")
        kind = current.ShapeType()
        if kind == TopAbs_SOLID:
            solids.append(current)
            require(len(solids) <= MAX_SOLIDS, "CAD_AUDIT_LIMIT", "CAD solid count exceeds the limit")
        elif kind in (TopAbs_COMPOUND, TopAbs_COMPSOLID):
            iterator = TopoDS_Iterator(current, True, True)
            children = []
            while iterator.More():
                children.append(iterator.Value())
                require(len(children) <= 100000, "CAD_AUDIT_LIMIT", "CAD assembly children exceed the limit")
                iterator.Next()
            if not children:
                non_solid += 1
            stack.extend((child, depth + 1) for child in reversed(children))
        else:
            non_solid += 1
    require(solids and non_solid == 0, "CAD_AUDIT_NON_SOLID", "STEP contains empty or non-solid geometry outside its solids")
    descriptors, face_count = [], 0
    for index, solid in enumerate(solids):
        require(BRepCheck_Analyzer(solid).IsValid(), "CAD_AUDIT_INVALID_GEOMETRY", "Transferred solid is invalid")
        shell_count = count(solid, TopAbs_SHELL)
        require(shell_count == 1, "CAD_AUDIT_CAVITY_UNSUPPORTED", "CAD solids with internal void shells are unsupported")
        faces = count(solid, TopAbs_FACE)
        face_count += faces
        require(faces > 0 and face_count <= MAX_FACES, "CAD_AUDIT_LIMIT", "CAD face count exceeds the limit")
        volume, area = GProp_GProps(), GProp_GProps()
        BRepGProp.VolumeProperties_s(solid, volume, True, False, False)
        BRepGProp.SurfaceProperties_s(solid, area, False, False)
        descriptors.append({"index": index, "faceCount": faces, "shellCount": shell_count,
                            "boundsMm": bounds(solid), "volumeMm3": finite(volume.Mass(), True),
                            "areaMm2": finite(area.Mass(), True)})
    require(hashlib.sha256(read_source(source)).hexdigest() == source_sha,
            "CAD_AUDIT_SOURCE_CHANGED", "STEP source changed during transfer inspection")
    report = {"schemaVersion": 1, "sourceSha256": source_sha, "sourceBytes": len(before), "coordinateUnits": "mm",
              "provider": {"ocpVersion": str(OCP.__version__),
                           "distributionVersion": importlib.metadata.version("cadquery-ocp-novtk"),
                           "modulePaths": {"OCP": str(OCP.__file__), "bindingModule": str(binding.__file__),
                                           "pythonExecutable": sys.executable}},
              "diagnostics": {"loadFailureCount": load_failures, "loadWarningCount": load_warnings,
                              "transferFailureCount": transfer_failures, "transferWarningCount": transfer_warnings,
                              "rootCount": root_count, "transferredRootCount": transferred, "shapeCount": shape_count},
              "cad": {"solidCount": len(solids), "nonSolidLeafCount": 0, "faceCount": face_count,
                      "boundsMm": bounds(shape), "volumeMm3": sum(item["volumeMm3"] for item in descriptors),
                      "areaMm2": sum(item["areaMm2"] for item in descriptors), "solids": descriptors}}
    publish(output, report)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = error.code if isinstance(error, AuditError) else "CAD_AUDIT_FAILED"
        message = str(error).replace("\r", " ").replace("\n", " ")[:2000]
        sys.stderr.write(json.dumps({"schemaVersion": 1, "status": "error", "code": code, "message": message}, ensure_ascii=True) + "\n")
        sys.exit(1)
