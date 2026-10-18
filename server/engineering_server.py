#!/usr/bin/env python3
"""
VISION local engineering backend.

This is intentionally a *generic* CAD execution service, not a model library:
the caller supplies a build123d Python script, the backend executes it, returns
exact OCCT metrics and a tessellated STL for the viewport. No geometry presets
are registered here.

Security: this binds loopback only and executes arbitrary Python with the
current user's authority. It is a local engineering tool, not a sandbox.
"""
from __future__ import annotations

import base64
import json
import math
import os
import sys
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

HOST = os.environ.get("VISION_ENGINEERING_HOST", "127.0.0.1")
PORT = int(os.environ.get("VISION_ENGINEERING_PORT", "8101"))

try:
    from build123d import import_step, export_stl  # noqa: F401
    import build123d as b3d
    BUILD123D_OK = True
except Exception:  # pragma: no cover - reported by /health
    b3d = None
    BUILD123D_OK = False


def _json_default(value: Any) -> Any:
    try:
        return list(value)
    except Exception:
        return str(value)


def _as_part(result: Any) -> Any:
    if hasattr(result, "part"):
        return result.part
    return result


def _metrics(part: Any) -> dict[str, Any]:
    bbox = part.bounding_box()
    return {
        "volume_mm3": float(part.volume),
        "area_mm2": float(part.area),
        "bbox_mm": {
            "min": [float(bbox.min.X), float(bbox.min.Y), float(bbox.min.Z)],
            "max": [float(bbox.max.X), float(bbox.max.Y), float(bbox.max.Z)],
            "size": [float(bbox.size.X), float(bbox.size.Y), float(bbox.size.Z)],
        },
        "center_mm": [float(part.center().X), float(part.center().Y), float(part.center().Z)],
    }


def execute_script(script: str, density: float | None = None) -> dict[str, Any]:
    if not BUILD123D_OK:
        raise RuntimeError("build123d is not installed on the backend Python")
    namespace: dict[str, Any] = {"__name__": "__vision_cad__"}
    exec(compile(script, "<build123d-script>", "exec"), namespace, namespace)
    if "result" not in namespace:
        raise ValueError("build123d script must assign the final shape to a variable named 'result'")
    part = _as_part(namespace["result"])
    if part is None:
        raise ValueError("result is empty")
    metrics = _metrics(part)
    if density is not None and density > 0:
        metrics["mass_kg"] = metrics["volume_mm3"] * 1e-9 * density
        metrics["density_kg_m3"] = density
    with tempfile.NamedTemporaryFile(suffix=".stl", delete=False) as handle:
        stl_path = handle.name
    try:
        export_stl(part, stl_path)
        with open(stl_path, "rb") as handle:
            stl = handle.read()
    finally:
        try:
            os.unlink(stl_path)
        except OSError:
            pass
    return {
        "schema": "vision.cad/1",
        "metrics": metrics,
        "stlBase64": base64.b64encode(stl).decode("ascii"),
        "stlBytes": len(stl),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "VisionEngineering/0.1"

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False, default=_json_default).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            versions: dict[str, Any] = {
                "ok": BUILD123D_OK,
                "build123d": getattr(b3d, "__version__", None) if BUILD123D_OK else None,
                "python": sys.version.split()[0],
            }
            try:
                import OCP  # type: ignore

                versions["ocp"] = OCP.__version__
            except Exception:
                versions["ocp"] = None
            try:
                import gmsh  # type: ignore

                versions["gmsh"] = gmsh.__version__ if hasattr(gmsh, "__version__") else "installed"
            except Exception:
                versions["gmsh"] = None
            self._send(200, versions)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/cad/execute":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 4 * 1024 * 1024:
                raise ValueError("invalid request size")
            body = json.loads(self.rfile.read(length))
            script = str(body.get("script", ""))
            if not script.strip():
                raise ValueError("script is empty")
            density = body.get("density_kg_m3")
            density_value = float(density) if density is not None else None
            self._send(200, execute_script(script, density_value))
        except Exception as exc:
            self._send(400, {
                "error": str(exc),
                "trace": traceback.format_exc(limit=6),
            })

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[engineering] " + fmt % args + "\n")


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"VISION engineering backend on http://{HOST}:{PORT}", flush=True)
    print(f"build123d={BUILD123D_OK} python={sys.version.split()[0]}", flush=True)
    server.serve_forever()
