#!/usr/bin/env python3
"""Trusted, headless FreeCAD STEP inspection and per-solid tessellation.

Run only with the configured FreeCAD installation's isolated Python (-I). The
caller supplies a private STEP copy and a fresh output directory, enforces the
process timeout, and independently validates this report and every STL. This is
not a STEP schema validator or an intersection/printability certification.
"""

import argparse
import array
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import sys


MIB = 1024 * 1024
MAX_SOURCE_BYTES = 100 * MIB
MAX_OUTPUT_BYTES = 100 * MIB
MAX_REPORT_BYTES = MIB
MAX_SOLIDS = 128
MAX_FACES = 50000
MAX_TRIANGLES = 250000
MAX_ENTITIES = 500000
MAX_REFERENCES = 3000000
MAX_TREE_NODES = 100000
MAX_TREE_DEPTH = 64
EXTERNAL_ENTITY = re.compile(
    rb"\b(?:[A-Z0-9_]*EXTERNAL[A-Z0-9_]*|DOCUMENT_FILE|DOCUMENT_REFERENCE|"
    rb"APPLIED_DOCUMENT_REFERENCE)\s*\(", re.IGNORECASE)
ENTITY_REF = re.compile(rb"#([0-9]+)")
ENTITY_DEF = re.compile(rb"\s*#([0-9]+)\s*=\s*(.+)\Z", re.DOTALL)
IDENTIFIER = re.compile(rb"[A-Z_][A-Z0-9_]*\s*\(", re.IGNORECASE)
UNICODE_END = re.compile(rb"\\X0\\", re.IGNORECASE)


class CadError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise CadError(code, message)


def finite(value, label, positive=False):
    value = float(value)
    require(math.isfinite(value) and (not positive or value > 0),
            "CAD_INVALID_NUMBER", label + " must be finite" + (" and positive" if positive else ""))
    return 0.0 if value == 0 else value


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_source(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink(),
            "CAD_INVALID_INPUT", "STEP input must be a regular file, not a symbolic link")
    require(0 < info.st_size <= MAX_SOURCE_BYTES, "CAD_SOURCE_LIMIT", "STEP input exceeds the source byte limit")
    with path.open("rb") as source:
        data = source.read(MAX_SOURCE_BYTES + 1)
    require(0 < len(data) <= MAX_SOURCE_BYTES, "CAD_SOURCE_LIMIT", "STEP input exceeds the source byte limit")
    return data


def _mask_p21(data):
    """Mask comments/strings, validating their P21 escapes before scanning refs.

    Names and URI-looking text inside strings are data, not entity types. P21
    escaped Unicode never becomes executable syntax. XML, edition-3 reference
    sections, and external-resource entities are deliberately unsupported.
    """
    masked = bytearray(data)
    size, index = len(data), 0
    while index < size:
        byte = data[index]
        if data[index:index + 2] == b"/*":
            end = data.find(b"*/", index + 2)
            require(end >= 0, "CAD_STEP_SYNTAX", "Unterminated STEP comment")
            masked[index:end + 2] = b" " * (end + 2 - index)
            index = end + 2
        elif byte == 39:
            start = index
            index += 1
            closed = False
            while index < size:
                byte = data[index]
                if byte == 39:
                    if index + 1 < size and data[index + 1] == 39:
                        index += 2
                    else:
                        index += 1
                        closed = True
                        break
                elif byte == 92:
                    upper = data[index:index + 4].upper()
                    if data[index:index + 2] == b"\\\\":
                        index += 2
                    elif upper[:3] == b"\\S\\":
                        require(index + 3 < size and 32 <= data[index + 3] <= 126,
                                "CAD_STEP_SYNTAX", "Invalid STEP shifted string character")
                        index += 4
                    elif len(upper) == 4 and upper[0:2] == b"\\P" and 65 <= upper[2] <= 73 and upper[3] == 92:
                        index += 4
                    elif upper[:3] == b"\\X\\":
                        digits = data[index + 3:index + 5]
                        require(len(digits) == 2 and re.fullmatch(rb"[0-9A-Fa-f]{2}", digits) is not None,
                                "CAD_STEP_SYNTAX", "Invalid STEP hexadecimal string escape")
                        index += 5
                    elif upper in (b"\\X2\\", b"\\X4\\"):
                        ending = UNICODE_END.search(data, index + 4)
                        require(ending is not None, "CAD_STEP_SYNTAX", "Unterminated STEP Unicode string escape")
                        end = ending.start()
                        digits = data[index + 4:end]
                        width = 4 if upper == b"\\X2\\" else 8
                        require(len(digits) > 0 and len(digits) % width == 0 and
                                re.fullmatch(rb"[0-9A-Fa-f]+", digits) is not None,
                                "CAD_STEP_SYNTAX", "Invalid STEP Unicode string escape")
                        try:
                            bytes.fromhex(digits.decode("ascii")).decode("utf-16-be" if width == 4 else "utf-32-be")
                        except (ValueError, UnicodeError):
                            raise CadError("CAD_STEP_SYNTAX", "Invalid STEP Unicode code point") from None
                        index = end + 4
                    else:
                        raise CadError("CAD_STEP_SYNTAX", "Unsupported STEP string escape")
                else:
                    require(32 <= byte <= 126, "CAD_STEP_SYNTAX", "STEP strings must use Part 21 character escapes")
                    index += 1
            require(closed, "CAD_STEP_SYNTAX", "Unterminated STEP string")
            masked[start:index] = b" " * (index - start)
        else:
            require(byte in (9, 10, 13) or 32 <= byte <= 126,
                    "CAD_STEP_SYNTAX", "Input must be an ASCII Part 21 STEP file")
            require(byte != 92, "CAD_STEP_SYNTAX", "STEP escapes are permitted only inside strings")
            index += 1
    return masked


def inspect_p21(data):
    masked = _mask_p21(data)
    require(EXTERNAL_ENTITY.search(masked) is None, "CAD_EXTERNAL_REFERENCE",
            "STEP external-resource entities are unsupported")
    require(b"@" not in masked and b"!" not in masked, "CAD_STEP_UNSUPPORTED",
            "STEP external values and user-defined entity types are unsupported")
    definitions = set()
    references = array.array("I")
    state, start, solid_definitions = "magic", 0, 0
    for ending in re.finditer(b";", masked):
        statement = bytes(masked[start:ending.start()]).strip()
        start = ending.end()
        upper = statement.upper()
        if state == "magic":
            require(upper == b"ISO-10303-21", "CAD_STEP_SYNTAX", "Expected a Part 21 STEP header")
            state = "header_start"
        elif state == "header_start":
            require(upper == b"HEADER", "CAD_STEP_SYNTAX", "Expected a STEP HEADER section")
            state = "header"
        elif state == "header":
            if upper == b"ENDSEC":
                state = "data_start"
            else:
                require(re.match(rb"(?:FILE_DESCRIPTION|FILE_NAME|FILE_SCHEMA)\s*\(", upper) is not None,
                        "CAD_STEP_UNSUPPORTED", "Unsupported STEP header record")
        elif state == "data_start":
            require(upper == b"DATA", "CAD_STEP_UNSUPPORTED", "Only one classic STEP DATA section is supported")
            state = "data"
        elif state == "data":
            if upper == b"ENDSEC":
                state = "end"
                continue
            definition = ENTITY_DEF.fullmatch(statement)
            require(definition is not None, "CAD_STEP_SYNTAX", "Invalid STEP entity record")
            number = int(definition.group(1))
            require(0 < number <= 0xFFFFFFFF and number not in definitions,
                    "CAD_STEP_SYNTAX", "Duplicate or out-of-range STEP entity ID")
            definitions.add(number)
            require(len(definitions) <= MAX_ENTITIES, "CAD_ENTITY_LIMIT", "STEP entity count exceeds the limit")
            body = definition.group(2)
            require(body.startswith(b"(") or IDENTIFIER.match(body) is not None,
                    "CAD_STEP_SYNTAX", "Invalid STEP entity type")
            depth = 0
            for byte in body:
                if byte == 40:
                    depth += 1
                    require(depth <= 128, "CAD_STEP_LIMIT", "STEP aggregate nesting exceeds the limit")
                elif byte == 41:
                    depth -= 1
                    require(depth >= 0, "CAD_STEP_SYNTAX", "Unbalanced STEP entity aggregate")
            require(depth == 0, "CAD_STEP_SYNTAX", "Unbalanced STEP entity aggregate")
            require(body.count(b"#") == len(ENTITY_REF.findall(body)),
                    "CAD_STEP_SYNTAX", "Invalid STEP entity reference")
            for reference in ENTITY_REF.finditer(body):
                referenced = int(reference.group(1))
                require(0 < referenced <= 0xFFFFFFFF, "CAD_STEP_SYNTAX", "Out-of-range STEP entity reference")
                references.append(referenced)
                require(len(references) <= MAX_REFERENCES, "CAD_ENTITY_LIMIT", "STEP reference count exceeds the limit")
            if re.search(rb"\b(?:MANIFOLD_SOLID_BREP|FACETED_BREP|BREP_WITH_VOIDS)\s*\(", body, re.IGNORECASE):
                solid_definitions += 1
        elif state == "end":
            require(upper == b"END-ISO-10303-21", "CAD_STEP_UNSUPPORTED", "Unsupported STEP section or trailing data")
            state = "done"
        else:
            raise CadError("CAD_STEP_SYNTAX", "Trailing content after the STEP end marker")
    require(state == "done" and not bytes(masked[start:]).strip(),
            "CAD_STEP_SYNTAX", "Incomplete STEP file or trailing content")
    require(definitions and all(reference in definitions for reference in references),
            "CAD_STEP_DANGLING_REFERENCE", "STEP references an undefined entity")
    require(solid_definitions > 0, "CAD_STEP_UNSUPPORTED", "STEP must contain supported BREP solid definitions")
    return solid_definitions


def bounds(shape):
    box = shape.optimalBoundingBox(False, False)
    low = {axis: finite(getattr(box, axis.upper() + "Min"), "CAD bounds") for axis in "xyz"}
    high = {axis: finite(getattr(box, axis.upper() + "Max"), "CAD bounds") for axis in "xyz"}
    require(all(high[axis] > low[axis] for axis in "xyz"), "CAD_DEGENERATE", "CAD solid must have three positive extents")
    return {"min": low, "max": high}


def near(actual, expected, label):
    tolerance = max(1e-7, abs(expected) * 1e-10)
    require(abs(actual - expected) <= tolerance, "CAD_TRANSLATION_CHANGED_GEOMETRY", label + " changed during translation")


def read_transfer_audit(path, source_sha, source_bytes):
    require(path.is_absolute(), "CAD_TRANSFER_AUDIT_INVALID", "An absolute transfer audit path is required")
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and 0 < info.st_size <= MAX_REPORT_BYTES,
            "CAD_TRANSFER_AUDIT_INVALID", "Transfer audit must be a bounded regular file")
    data = path.read_bytes()
    require(len(data) <= MAX_REPORT_BYTES, "CAD_TRANSFER_AUDIT_INVALID", "Transfer audit exceeds the byte limit")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "CAD_TRANSFER_AUDIT_INVALID", "Transfer audit has duplicate JSON keys")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise CadError("CAD_TRANSFER_AUDIT_INVALID", "Transfer audit has non-finite JSON numbers")

    report = json.loads(data, object_pairs_hook=unique_object, parse_constant=invalid_constant)
    require(isinstance(report, dict) and report.get("schemaVersion") == 1 and
            report.get("sourceSha256") == source_sha and report.get("sourceBytes") == source_bytes and
            report.get("coordinateUnits") == "mm", "CAD_TRANSFER_AUDIT_INVALID", "Transfer audit is not bound to this STEP source")
    diagnostics = report.get("diagnostics", {})
    require(isinstance(diagnostics, dict) and all(type(diagnostics.get(key)) is int and diagnostics[key] == 0
            for key in ("loadFailureCount", "loadWarningCount", "transferFailureCount", "transferWarningCount")) and
            type(diagnostics.get("rootCount")) is int and diagnostics["rootCount"] > 0 and
            diagnostics.get("transferredRootCount") == diagnostics["rootCount"] and
            type(diagnostics.get("shapeCount")) is int and diagnostics["shapeCount"] > 0,
            "CAD_TRANSFER_AUDIT_INVALID", "Native STEP load and transfer diagnostics must be complete and clean")
    cad = report.get("cad", {})
    require(isinstance(cad, dict) and type(cad.get("solidCount")) is int and 0 < cad["solidCount"] <= MAX_SOLIDS and
            cad.get("nonSolidLeafCount") == 0 and type(cad.get("faceCount")) is int and 0 < cad["faceCount"] <= MAX_FACES and
            isinstance(cad.get("solids"), list) and len(cad["solids"]) == cad["solidCount"],
            "CAD_TRANSFER_AUDIT_INVALID", "Transfer audit has no complete solid inventory")
    return cad, {"sha256": digest(data), "bytes": len(data)}


def compare_transfer_inventory(audit, metrics, cad_bounds):
    def same_number(actual, expected):
        if isinstance(expected, bool) or not isinstance(expected, (int, float)) or not math.isfinite(expected):
            return False
        return abs(actual - expected) <= max(1e-6, abs(expected) * 1e-8)

    def same_bounds(actual, expected):
        return isinstance(expected, dict) and all(isinstance(expected.get(edge), dict) and
                all(isinstance(expected[edge].get(axis), (int, float)) and not isinstance(expected[edge][axis], bool) and
                    math.isfinite(expected[edge][axis]) and abs(actual[edge][axis] - expected[edge][axis]) <=
                    max(1e-6, abs(actual[edge][axis]) * sys.float_info.epsilon * 16,
                        abs(expected[edge][axis]) * sys.float_info.epsilon * 16) for axis in "xyz")
                for edge in ("min", "max"))

    def same_solid(actual, expected):
        return (isinstance(expected, dict) and actual["faceCount"] == expected.get("faceCount") and
                actual["shellCount"] == expected.get("shellCount") and same_bounds(actual["boundsMm"], expected.get("boundsMm")) and
                all(same_number(actual[key], expected.get(key)) for key in ("volumeMm3", "areaMm2")))

    require(audit["solidCount"] == len(metrics) and audit["faceCount"] == sum(item["faceCount"] for item in metrics) and
            same_bounds(cad_bounds, audit.get("boundsMm")) and
            all(same_number(sum(item[key] for item in metrics), audit.get(key)) for key in ("volumeMm3", "areaMm2")),
            "CAD_IMPORT_DISAGREEMENT", "Independent native import inventories or global CAD measurements disagree")
    remaining = list(audit["solids"])
    for solid in metrics:
        match = next((index for index, candidate in enumerate(remaining) if same_solid(solid, candidate)), None)
        require(match is not None, "CAD_IMPORT_DISAGREEMENT", "Independent native import solid measurements disagree")
        remaining.pop(match)


def solid_metrics(shape):
    require(shape.isValid(), "CAD_INVALID_SHAPE", "CAD solid is invalid")
    require(shape.isClosed(), "CAD_OPEN_SOLID", "CAD solid is not closed")
    require(len(shape.Shells) == 1, "CAD_CAVITY_UNSUPPORTED", "CAD solids with internal void shells are unsupported")
    face_count = len(shape.Faces)
    require(face_count > 0, "CAD_EMPTY_SOLID", "CAD solid has no faces")
    return {"valid": True, "closed": True, "shellCount": 1, "faceCount": face_count,
            "boundsMm": bounds(shape), "volumeMm3": finite(shape.Volume, "CAD volume", True),
            "areaMm2": finite(shape.Area, "CAD area", True)}


def collect_solids(shape):
    solids, other_leaves, nodes = [], 0, 0
    stack = [(shape, 0)]
    while stack:
        current, depth = stack.pop()
        nodes += 1
        require(nodes <= MAX_TREE_NODES and depth <= MAX_TREE_DEPTH,
                "CAD_TREE_LIMIT", "CAD assembly structure exceeds the limit")
        if current.ShapeType == "Solid":
            solids.append(current)
            require(len(solids) <= MAX_SOLIDS, "CAD_SOLID_LIMIT", "CAD solid count exceeds the limit")
        elif current.ShapeType in ("Compound", "CompSolid"):
            children = current.childShapes(True, True)
            if not children:
                other_leaves += 1
            stack.extend((child, depth + 1) for child in reversed(children))
        else:
            other_leaves += 1
    require(other_leaves == 0, "CAD_NON_SOLID_GEOMETRY", "STEP contains non-solid geometry outside its solids")
    require(solids, "CAD_EMPTY_SHAPE", "STEP contains no solids")
    return solids


def inspect_binary_stl(path, expected_triangles):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_size <= MAX_OUTPUT_BYTES,
            "CAD_OUTPUT_LIMIT", "Invalid or oversized STL artifact")
    data = path.read_bytes()
    require(len(data) >= 84 and struct.unpack_from("<I", data, 80)[0] == expected_triangles and
            len(data) == 84 + 50 * expected_triangles,
            "CAD_INVALID_STL", "Native mesh writer did not produce the expected binary STL")
    for offset in range(84, len(data), 50):
        values = struct.unpack_from("<12f", data, offset)
        require(all(math.isfinite(value) for value in values), "CAD_INVALID_STL", "STL contains non-finite coordinates")
        a, b, c = values[3:6], values[6:9], values[9:12]
        ab = [b[i] - a[i] for i in range(3)]
        ac = [c[i] - a[i] for i in range(3)]
        cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
        require(any(value != 0 for value in cross), "CAD_STL_PRECISION_LOSS", "STL triangle collapsed at float32 precision")
    return {"fileName": path.name, "bytes": len(data), "sha256": digest(data)}


def write_report(output, report):
    data = (json.dumps(report, allow_nan=False, ensure_ascii=True, separators=(",", ":")) + "\n").encode("utf-8")
    require(len(data) <= MAX_REPORT_BYTES, "CAD_REPORT_LIMIT", "CAD report exceeds the byte limit")
    temporary, final = output / ".cad-report.json.tmp", output / "cad-report.json"
    with temporary.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    # A hard link publishes the fully written file atomically without replacing
    # an existing destination on either Windows or POSIX.
    os.link(temporary, final)
    temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--linear-deflection-mm", required=True, type=float)
    parser.add_argument("--angular-deflection-rad", required=True, type=float)
    parser.add_argument("--transfer-audit", required=True)
    args = parser.parse_args()
    linear = finite(args.linear_deflection_mm, "Linear deflection", True)
    angular = finite(args.angular_deflection_rad, "Angular deflection", True)
    require(1e-6 <= linear <= 1 and 1e-4 <= angular <= 1,
            "CAD_INVALID_TOLERANCE", "Tessellation tolerance is outside the supported bounds")
    source, output = Path(args.input), Path(args.output_dir)
    require(source.is_absolute() and output.is_absolute() and source.suffix.lower() in (".step", ".stp"),
            "CAD_INVALID_INPUT", "Absolute STEP input and output paths are required")
    require(not output.is_symlink(), "CAD_INVALID_OUTPUT", "Output directory cannot be a symbolic link")
    output.mkdir(exist_ok=True)
    require(output.is_dir() and not any(output.iterdir()), "CAD_INVALID_OUTPUT", "Output directory must be fresh and empty")
    before = read_source(source)
    source_sha = digest(before)
    source_solid_definitions = inspect_p21(before)
    # Part.read may silently omit an untransferable STEP root. Independently
    # clean load/transfer diagnostics and matching solid inventories are needed.
    transfer_inventory, transfer_audit = read_transfer_audit(Path(args.transfer_audit), source_sha, len(before))
    # Isolated bundled Python has no site/user imports. FreeCAD initializes its
    # own native paths; its import must precede Part and MeshPart.
    sys.path.insert(0, str(Path(sys.executable).parent))
    import FreeCAD as App
    App.ParamGet("User parameter:BaseApp/Preferences/Mod/Part/General").SetInt("ReadSurfaceCurveMode", 0)
    import Part
    import MeshPart
    shape = Part.read(str(source))
    require(shape.isValid(), "CAD_INVALID_SHAPE", "Imported CAD root is invalid")
    solids = collect_solids(shape)
    # This catches missing simple roots; it is deliberately not a claim of a
    # complete schema/transfer audit for arbitrary STEP assembly graphs.
    require(len(solids) >= source_solid_definitions, "CAD_INCOMPLETE_IMPORT", "Native import retained fewer solids than STEP BREP definitions")
    metrics = [solid_metrics(solid) for solid in solids]
    require(sum(item["faceCount"] for item in metrics) <= MAX_FACES,
            "CAD_FACE_LIMIT", "CAD face count exceeds the limit")
    cad_bounds = bounds(shape)
    compare_transfer_inventory(transfer_inventory, metrics, cad_bounds)
    origin = dict(cad_bounds["min"])
    total_triangles, total_output, reports = 0, 0, []
    for index, (solid, original) in enumerate(zip(solids, metrics)):
        translated = solid.copy()
        translated.translate(App.Vector(-origin["x"], -origin["y"], -origin["z"]))
        moved = solid_metrics(translated)
        require(moved["faceCount"] == original["faceCount"], "CAD_TRANSLATION_CHANGED_GEOMETRY", "Translation changed the CAD face count")
        near(moved["volumeMm3"], original["volumeMm3"], "CAD volume")
        near(moved["areaMm2"], original["areaMm2"], "CAD area")
        for edge in ("min", "max"):
            for axis in "xyz":
                near(moved["boundsMm"][edge][axis], original["boundsMm"][edge][axis] - origin[axis], "CAD bounds")
        mesh = MeshPart.meshFromShape(Shape=translated, LinearDeflection=linear,
                                      AngularDeflection=angular, Relative=False, Segments=True)
        triangle_count = int(mesh.CountFacets)
        total_triangles += triangle_count
        require(0 < triangle_count and total_triangles <= MAX_TRIANGLES,
                "CAD_TRIANGLE_LIMIT", "Tessellated triangle count is empty or exceeds the limit")
        require(mesh.countSegments() == original["faceCount"], "CAD_INCOMPLETE_MESH", "Tessellation did not retain every CAD face")
        coverage, face_counts = bytearray(triangle_count), []
        for face in range(original["faceCount"]):
            segment = mesh.getSegment(face)
            require(segment, "CAD_INCOMPLETE_MESH", "A CAD face has no mesh triangles")
            face_counts.append(len(segment))
            for triangle in segment:
                require(isinstance(triangle, int) and 0 <= triangle < triangle_count and not coverage[triangle],
                        "CAD_INCOMPLETE_MESH", "CAD face mesh segments overlap or contain invalid triangles")
                coverage[triangle] = 1
        require(all(coverage), "CAD_INCOMPLETE_MESH", "CAD face segments omit mesh triangles")
        artifact_path = output / ("solid-%04d.stl" % (index + 1))
        # Reserve our fixed artifact name exclusively before the native writer.
        with artifact_path.open("xb"):
            pass
        mesh.write(Filename=str(artifact_path), Format="STL")
        artifact = inspect_binary_stl(artifact_path, triangle_count)
        total_output += artifact["bytes"]
        require(total_output <= MAX_OUTPUT_BYTES, "CAD_OUTPUT_LIMIT", "Aggregate STL bytes exceed the limit")
        reports.append({"index": index, **original, "meshedFaceCount": len(face_counts),
                        "triangleCount": triangle_count, "faceTriangleCounts": face_counts, "artifact": artifact})
    require(digest(read_source(source)) == source_sha, "CAD_SOURCE_CHANGED", "STEP input changed during processing")
    report = {"schemaVersion": 1, "sourceSha256": source_sha, "sourceBytes": len(before),
              "coordinateUnits": "mm", "originMm": origin, "transferAudit": transfer_audit,
              "tolerance": {"linearDeflectionMm": linear, "angularDeflectionRad": angular},
              "provider": {"freecadVersion": [str(value) for value in App.Version()],
                           "occVersion": str(Part.OCC_VERSION), "pythonVersion": sys.version.split()[0],
                           "modulePaths": {"FreeCAD": str(App.__file__), "Part": str(Part.__file__),
                                           "MeshPart": str(MeshPart.__file__), "pythonExecutable": sys.executable}},
              "cad": {"solidCount": len(solids), "nonSolidLeafCount": 0, "valid": True,
                      "boundsMm": cad_bounds, "volumeMm3": sum(item["volumeMm3"] for item in metrics),
                      "areaMm2": sum(item["areaMm2"] for item in metrics)}, "solids": reports}
    write_report(output, report)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = error.code if isinstance(error, CadError) else "CAD_WORKER_FAILED"
        message = str(error).replace("\r", " ").replace("\n", " ")[:2000]
        sys.stderr.write(json.dumps({"schemaVersion": 1, "status": "error", "code": code, "message": message}, ensure_ascii=True) + "\n")
        sys.exit(1)
