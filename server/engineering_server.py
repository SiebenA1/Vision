#!/usr/bin/env python3
"""VISION local engineering backend.

CAD geometry is authored with NVIDIA USD BRep (NURBS B-Rep). The usd-brep wheel
currently requires CPython 3.12, so CAD scripts run in an isolated worker while
this HTTP service runs on Python 3.13 with Gmsh/SfePy.

Security: loopback only. Both the CAD worker and the FEA worker execute arbitrary
local Python with the current user's authority.
"""
from __future__ import annotations

import base64
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HOST = os.environ.get("VISION_ENGINEERING_HOST", "127.0.0.1")
PORT = int(os.environ.get("VISION_ENGINEERING_PORT", "8109"))
ROOT = Path(__file__).resolve().parent
USD_PYTHON = Path(
    os.environ.get("VISION_USD_PYTHON", str(ROOT.parent / ".python312" / "python.exe"))
)
USD_WORKER = ROOT / "usd_brep_worker.py"


def _json_default(value: Any) -> Any:
    try:
        return list(value)
    except Exception:
        return str(value)


def _box_stl_base64(length: float = 100.0, width: float = 20.0, height: float = 10.0) -> str:
    x0, y0, z0 = -length / 2, -width / 2, -height / 2
    x1, y1, z1 = length / 2, width / 2, height / 2
    vertices = [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7),
    ]
    payload = bytearray(b"VISION benchmark".ljust(80, b" "))
    payload += struct.pack("<I", len(faces))
    for a, b, c in faces:
        payload += struct.pack("<3f", 0, 0, 0)
        for point in (vertices[a], vertices[b], vertices[c]):
            payload += struct.pack("<3f", *point)
        payload += struct.pack("<H", 0)
    return base64.b64encode(payload).decode("ascii")


def execute_usd_brep(script: str, density: float | None = None) -> dict[str, Any]:
    if not USD_PYTHON.is_file():
        raise RuntimeError(
            f"USD BRep worker Python not found at {USD_PYTHON}. "
            "Install CPython 3.12 and `pip install usd-brep`, or set VISION_USD_PYTHON."
        )
    with tempfile.TemporaryDirectory(prefix="vision-usd-", dir=str(ROOT)) as temp:
        temp_path = Path(temp)
        request_path = temp_path / "request.json"
        response_path = temp_path / "response.json"
        request_path.write_text(
            json.dumps(
                {
                    "script": script,
                    "density_kg_m3": float(density if density and density > 0 else 2700.0),
                }
            ),
            encoding="utf-8",
        )
        proc = subprocess.run(
            [str(USD_PYTHON), str(USD_WORKER), str(request_path), str(response_path)],
            cwd=str(temp_path),
            capture_output=True,
            text=True,
            timeout=240,
        )
        if not response_path.is_file():
            raise RuntimeError((proc.stdout or "") + "\n" + (proc.stderr or ""))
        payload = json.loads(response_path.read_text(encoding="utf-8"))
        if "error" in payload:
            raise RuntimeError(payload.get("trace") or payload["error"])
        return payload


class Handler(BaseHTTPRequestHandler):
    server_version = "VisionEngineering/0.2"

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
                "ok": USD_PYTHON.is_file(),
                "cad_kernel": "NVIDIA USD BRep",
                "usd_brep": "1.0.0",
                "usd_python": str(USD_PYTHON),
                "python": sys.version.split()[0],
            }
            try:
                import gmsh  # type: ignore

                versions["gmsh"] = gmsh.__version__
            except Exception:
                versions["gmsh"] = None
            try:
                import sfepy  # type: ignore

                versions["sfepy"] = getattr(sfepy, "__version__", "unknown")
            except Exception:
                versions["sfepy"] = None
            self._send(200, versions)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/cad/execute", "/fea/solve", "/fea/validate"}:
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if self.path == "/fea/validate":
                from fea_solver import solve as solve_fea

                result = solve_fea(
                    _box_stl_base64(),
                    {"E": 210000, "nu": 0.3, "rho": 7850, "yieldStrength": 235},
                    [{"face": "x-min", "enabled": True}],
                    [{"face": "x-max", "vector": [0, 0, -1], "magnitude": 100, "enabled": True}],
                    1.5,
                )
                moment = 20.0 * 10.0**3 / 12.0
                reference = 100.0 * 100.0**3 / (3.0 * 210000.0 * moment)
                computed = float(result["maxDisplacement"])
                error = abs(computed - reference) / reference * 100.0
                self._send(200, {
                    "caseId": "cantilever-3d-usdbrep-gmsh-sfepy",
                    "name": "3D cantilever / USD BRep + Gmsh + SfePy",
                    "reference": reference,
                    "computed": computed,
                    "errorPercent": error,
                    "passed": error <= 8.0,
                    "tolerancePercent": 8.0,
                    "formula": "PL^3 / (3EI)",
                    "meshElements": result["elements"],
                    "solveMs": 0,
                })
                return
            if length <= 0 or length > 32 * 1024 * 1024:
                raise ValueError("invalid request size")
            body = json.loads(self.rfile.read(length))
            if self.path == "/fea/solve":
                from fea_solver import solve as solve_fea

                result = solve_fea(
                    str(body.get("stlBase64", "")),
                    body.get("material", {}),
                    body.get("supports", []),
                    body.get("loads", []),
                    float(body.get("mesh_size", 4.0)),
                )
                self._send(200, result)
                return
            script = str(body.get("script", ""))
            if not script.strip():
                raise ValueError("script is empty")
            density = body.get("density_kg_m3")
            density_value = float(density) if density is not None else None
            self._send(200, execute_usd_brep(script, density_value))
        except Exception as exc:
            self._send(400, {
                "error": str(exc),
                "trace": traceback.format_exc(limit=8),
            })

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[backend] " + (fmt % args) + "\n")


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"VISION engineering backend on http://{HOST}:{PORT}")
    print(f"CAD kernel=NVIDIA USD BRep python={USD_PYTHON}")
    print(f"FEA=Gmsh+SfePy python={sys.version.split()[0]}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
