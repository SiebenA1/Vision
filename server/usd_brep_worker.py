"""NVIDIA USD BRep geometry worker (CPython 3.12).

The main backend runs on Python 3.13 (Gmsh/SfePy). The usd-brep wheel is only
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


def execute(script: str, density: float) -> dict[str, Any]:
    namespace: dict[str, Any] = {"__name__": "__vision_usd_brep__"}
    exec(compile(script, "<usd-brep-script>", "exec"), namespace, namespace)
    result = namespace.get("result")
    if result is None:
        raise ValueError("usd_brep script must assign a Brep to a top-level variable named 'result'")
    if not isinstance(result, usd_brep.Brep):
        raise TypeError(f"result must be usd_brep.Brep, got {type(result).__name__}")

    volume = float(result.volume())
    area = float(result.area())
    bbox_min, bbox_max = result.bounding_box()
    size = [float(bbox_max[i] - bbox_min[i]) for i in range(3)]
    diag = math.dist(bbox_min, bbox_max)
    tolerance = max(0.01, diag * 0.00035)
    poly = usd_brep.tessellate(
        result,
        chord_height_tolerance=tolerance,
        curve_angle_tolerance_deg=10.0,
        surface_angle_tolerance_deg=10.0,
    )
    arrays = poly.to_mesh_arrays()
    out_dir = Path(sys.argv[2]).parent if len(sys.argv) > 2 else Path.cwd()
    stl_path = out_dir / "model.stl"
    triangles = _write_stl(stl_path, arrays)
    stl = stl_path.read_bytes()

    metrics: dict[str, Any] = {
        "volume_mm3": volume,
        "area_mm2": area,
        "mass_kg": volume * 1e-9 * density,
        "density_kg_m3": density,
        "bbox_mm": {
            "min": [float(v) for v in bbox_min],
            "max": [float(v) for v in bbox_max],
            "size": size,
        },
        "center_mm": [
            float((bbox_min[i] + bbox_max[i]) / 2.0) for i in range(3)
        ],
        "triangles": triangles,
        "tessellation_tolerance_mm": tolerance,
        "kernel": f"usd-brep/{getattr(usd_brep, '__version__', '1.0.0')}",
    }
    return {
        "schema": "vision.cad/2",
        "metrics": metrics,
        "stlBase64": base64.b64encode(stl).decode("ascii"),
        "stlBytes": len(stl),
    }


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: usd_brep_worker.py request.json response.json")
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    try:
        payload = execute(
            str(request.get("script", "")),
            float(request.get("density_kg_m3", 2700.0)),
        )
        Path(sys.argv[2]).write_text(json.dumps(payload), encoding="utf-8")
    except Exception as exc:
        Path(sys.argv[2]).write_text(
            json.dumps({"error": str(exc), "trace": traceback.format_exc(limit=12)}),
            encoding="utf-8",
        )
        raise


if __name__ == "__main__":
    main()
