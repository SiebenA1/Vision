"""NVIDIA USD BRep geometry worker (CPython 3.12).

The main backend runs on Python 3.13 (TetGen/scikit-fem). The usd-brep wheel is only
published for CPython 3.12, so CAD scripts are executed in this isolated worker.
It returns exact B-Rep metrics plus a binary STL produced from the NVIDIA
tessellator.
"""
from __future__ import annotations

import base64
import json
import math
import struct
import sys
import traceback
from pathlib import Path
from typing import Any

import usd_brep


def _triangles(arrays: dict[str, Any]):
    points = arrays["points"]
    stream = arrays["faces"]
    cursor = 0
    while cursor < len(stream):
        count = int(stream[cursor])
        cursor += 1
        indices = [int(v) for v in stream[cursor : cursor + count]]
        cursor += count
        for index in range(1, count - 1):
            yield points[indices[0]], points[indices[index]], points[indices[index + 1]]


def _write_stl(path: Path, arrays: dict[str, Any]) -> int:
    count = 0
    with path.open("wb") as handle:
        handle.write(b"VISION USD BRep".ljust(80, b" "))
        handle.write(struct.pack("<I", 0))
        payload = bytearray()
        for a, b, c in _triangles(arrays):
            ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
            vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            payload += struct.pack(
                "<12fH",
                nx / length, ny / length, nz / length,
                a[0], a[1], a[2],
                b[0], b[1], b[2],
                c[0], c[1], c[2],
                0,
            )
            count += 1
        handle.seek(80)
        handle.write(struct.pack("<I", count))
        handle.write(payload)
    return count


def capabilities():
    """Discover the installed wheel, including callable/class docs in all public groups."""
    import importlib.metadata
    import inspect
    groups = {"usd_brep": usd_brep}
    for name in dir(usd_brep):
        value = getattr(usd_brep, name)
        if not name.startswith("_") and inspect.ismodule(value) and value.__name__.startswith(("usd_brep", "_omni_solid")):
            groups[name] = value
    entries = []
    for group, module in groups.items():
        for name in sorted(dir(module)):
            if name.startswith("_"):
                continue
            value = getattr(module, name)
            if not callable(value):
                continue
            entries.append({"group": group, "name": name, "symbol": f"{group}.{name}",
                            "kind": "type" if isinstance(value, type) else "function",
                            "documentation": inspect.getdoc(value) or ""})
            if isinstance(value, type):
                for member_name in dir(value):
                    if member_name.startswith("_") and member_name != "__init__":
                        continue
                    member = getattr(value, member_name)
                    entries.append({"group": group, "name": f"{name}.{member_name}", "symbol": f"{group}.{name}.{member_name}",
                                    "kind": "method" if callable(member) else "property",
                                    "documentation": inspect.getdoc(member) or str(member)})
    return {"schema": "vision.cad.capabilities/1", "version": importlib.metadata.version("usd-brep"),
            "python": sys.version.split()[0], "groups": sorted(groups), "entries": entries,
            "outputs": ["solid", "sheet", "multi-body", "USD", "STL", "topology"],
            "solver": {"analysis": ["linear-static"], "contact": False, "shellElements": False}}


def _number(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{name} must be finite in [{low}, {high}]")
    return float(value)


def _bbox(item):
    lo, hi = item.bounding_box()
    return {"min": [float(v) for v in lo], "max": [float(v) for v in hi],
            "size": [float(hi[i] - lo[i]) for i in range(3)]}


def execute(script, density, options=None, source_usd=None, source_breps=None):
    import hashlib
    import importlib.metadata
    import time
    started = time.perf_counter()
    options = options or {}
    density = _number(density, "density", 1e-12, 1e9)
    tolerance = _number(options.get("tolerance_mm", 0.05), "tolerance_mm", 1e-5, 10)
    angle = _number(options.get("angle_deg", 10), "angle_deg", 0.1, 45)
    accuracy = _number(options.get("relative_accuracy", 1e-5), "relative_accuracy", 1e-8, 1e-1)
    out_dir = Path(sys.argv[2]).parent if len(sys.argv) > 2 else Path.cwd()
    parts = {}
    if source_usd or source_breps:
        loaded = [usd_brep.Brep.read_from_file(path) for path in source_breps] if source_breps else usd_brep.usd.import_breps(source_usd)
        for index, brep in enumerate(loaded):
            names = options.get("source_names", [])
            parts[names[index] if index < len(names) else f"body_{index + 1}"] = brep
    namespace = {"__name__": "__vision_usd_brep__", "u": usd_brep, "parts": parts,
                 "parameters": options.get("parameters", {})}
    if script.strip():
        exec(compile(script, "<usd-brep-script>", "exec"), namespace, namespace)
        result = namespace.get("result")
    else:
        result = parts
    if isinstance(result, usd_brep.Brep):
        result = {"body_1": result}
    elif isinstance(result, (list, tuple)):
        result = {f"body_{i + 1}": body for i, body in enumerate(result)}
    if not isinstance(result, dict) or not result:
        raise ValueError("result must be a Brep, a nonempty list of Breps, or a name -> Brep dictionary; convert curves/surfaces to sheet Breps or solids before export")
    if any(not isinstance(name, str) or not isinstance(body, usd_brep.Brep) for name, body in result.items()):
        raise ValueError("each named output must be a Brep (solid or sheet)")
    if len({id(body) for body in result.values()}) != len(result):
        raise ValueError("reused output handles must be copied, not aliased")
    if options.get("heal", False):
        for body in result.values():
            usd_brep.heal_brep(body)
    bodies = []
    for index, (name, body) in enumerate(result.items()):
        body.write_to_file(str(out_dir / f"body-{index}.brep"))
        solid = bool(body.is_manifold_solid())
        bounds = _bbox(body)
        volume = float(body.volume(accuracy)) if solid else 0.0
        area = sum(float(face.area(accuracy)) for face in body.faces())
        if not all(math.isfinite(v) for v in [volume, area, *bounds["min"], *bounds["max"]]) or (solid and volume <= 0):
            raise ValueError(f"invalid metrics for body {name}")
        poly = usd_brep.tessellate(body, chord_height_tolerance=tolerance,
                                  curve_angle_tolerance_deg=angle, surface_angle_tolerance_deg=angle)
        arrays = poly.to_mesh_arrays()
        filename = f"body-{index}.stl"
        triangles = _write_stl(out_dir / filename, arrays)
        faces = []
        for face_index, face in enumerate(body.faces()):
            faces.append({"id": f"body-{index}/face-{face_index}", "index": face_index,
                          "bbox_mm": _bbox(face), "area_mm2": float(face.area(accuracy))})
        edges = [{"id": f"body-{index}/edge-{i}", "index": i,
                  "bbox_mm": _bbox(edge), "length_mm": float(edge.length())}
                 for i, edge in enumerate(body.edges())]
        bodies.append({"id": f"body-{index}", "name": name, "kind": "solid" if solid else "sheet",
                       "manifold": solid, "materialCensus": body.material_census() if solid else None,
                       "holePoints": namespace.get("mesh_holes", {}).get(name, []), "volume_mm3": volume, "area_mm2": area,
                       "mass_kg": volume * 1e-9 * density, "bbox_mm": bounds,
                       "triangles": triangles, "stlFile": filename, "faces": faces, "edges": edges})
    # Each body's native BRep is preserved. No implicit union or assembly bonding.
    usd_brep.usd.export_breps(list(result.values()), str(out_dir / "model.usda"))
    # Stream body triangles into one display STL without duplicating a large mesh in Python lists.
    import shutil
    count = sum(body["triangles"] for body in bodies)
    with (out_dir / "preview.stl").open("wb") as output:
        output.write(b"VISION multi-body".ljust(80, b" ") + struct.pack("<I", count))
        for body in bodies:
            with (out_dir / body["stlFile"]).open("rb") as source:
                source.seek(84)
                shutil.copyfileobj(source, output)
    if not count:
        raise ValueError("tessellation produced no triangles")
    lo = [min(body["bbox_mm"]["min"][i] for body in bodies) for i in range(3)]
    hi = [max(body["bbox_mm"]["max"][i] for body in bodies) for i in range(3)]
    version = importlib.metadata.version("usd-brep")
    manifest = {"schema": "vision.cad/3", "kernelVersion": version, "bodies": bodies,
                "parameters": namespace.get("parameters", {}),
                "settings": {"tolerance_mm": tolerance, "angle_deg": angle, "relative_accuracy": accuracy},
                "buildMs": (time.perf_counter() - started) * 1000,
                "nativeSha256": hashlib.sha256(b"".join((out_dir / f"body-{i}.brep").read_bytes() for i in range(len(bodies)))).hexdigest(),
                "warnings": ["Face and edge IDs are scoped to this artifact; rebind study regions after geometry edits."]}
    stl = (out_dir / "preview.stl").read_bytes()
    manifest["metrics"] = {"volume_mm3": sum(body["volume_mm3"] for body in bodies),
                           "area_mm2": sum(body["area_mm2"] for body in bodies),
                           "mass_kg": sum(body["mass_kg"] for body in bodies),
                           "bbox_mm": {"min": lo, "max": hi, "size": [hi[i] - lo[i] for i in range(3)]},
                           "center_mm": [(lo[i] + hi[i]) / 2 for i in range(3)],
                           "triangles": count, "tessellation_tolerance_mm": tolerance,
                           "kernel": f"usd-brep/{version}"}
    return {**manifest, "stlBase64": base64.b64encode(stl).decode("ascii"), "stlBytes": len(stl)}


def validate_separation(request):
    """Prevent a combined PLC from silently bonding distinct selected parts."""
    breps = [usd_brep.Brep.read_from_file(path) for path in request["source_breps"]]
    clearance = float(request["clearance_mm"])
    for index, a in enumerate(breps):
        alo, ahi = a.bounding_box()
        for b in breps[index + 1:]:
            blo, bhi = b.bounding_box()
            if any(ahi[axis] + clearance < blo[axis] or bhi[axis] + clearance < alo[axis] for axis in range(3)):
                continue
            relation = usd_brep.queries.brep_relationship(a, b)
            if relation["relationship"] != "separate" or relation["distance"] <= clearance:
                raise ValueError("selected bodies touch, overlap, contain one another or have insufficient tessellation clearance; contact/bonding is not implemented. Explicitly union bonded material or analyze parts separately")
    return {"separate": True}


def select_faces(request):
    import re
    breps = [usd_brep.Brep.read_from_file(path) for path in request["source_breps"]] if request.get("source_breps") else usd_brep.usd.import_breps(request["source_usd"])
    points = request["points"]
    selections = []
    for region in request["regions"]:
        tolerance = _number(region["toleranceMm"], "toleranceMm", 1e-7, 10)
        selected = set()
        for identity in region["faceIds"]:
            match = re.fullmatch(r"body-([0-9]+)/face-([0-9]+)", identity)
            if not match:
                raise ValueError("invalid native face identity")
            body_index, face_index = map(int, match.groups())
            if body_index >= len(breps) or face_index >= len(breps[body_index].faces()):
                raise ValueError("native face no longer exists; rebind the study")
            face = breps[body_index].faces()[face_index]
            lo, hi = face.bounding_box()
            for index, point in enumerate(points):
                if all(lo[axis] - tolerance <= point[axis] <= hi[axis] + tolerance for axis in range(3)):
                    _, distance = face.closest_point(tuple(point))
                    if distance <= tolerance:
                        selected.add(index)
        selections.append(sorted(selected))
    return {"selections": selections}


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: usd_brep_worker.py request.json response.json")
    request_path, output = Path(sys.argv[1]), Path(sys.argv[2])
    request = json.loads(request_path.read_text(encoding="utf-8-sig"))
    try:
        if request.get("operation") == "validate_separation":
            payload = validate_separation(request)
        elif request.get("operation") == "select_faces":
            payload = select_faces(request)
        elif request.get("operation") == "capabilities":
            payload = capabilities()
        else:
            payload = execute(str(request.get("script", "")), request.get("density_kg_m3", 2700),
                              request.get("options", {}), request.get("source_usd"), request.get("source_breps"))
        output.write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    except Exception as exc:
        output.write_text(json.dumps({"error": str(exc), "trace": traceback.format_exc(limit=12)}), encoding="utf-8")
        raise


if __name__ == "__main__":
    main()
