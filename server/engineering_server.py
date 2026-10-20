#!/usr/bin/env python3
"""VISION local engineering backend.

CAD geometry is authored with NVIDIA USD BRep (NURBS B-Rep). The usd-brep wheel
currently requires CPython 3.12, so CAD scripts run in an isolated worker while
this HTTP service runs on Python 3.13 with TetGen/scikit-fem.

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
import time
import functools
import socket
from urllib.parse import urlsplit, parse_qs
import cad_artifacts
from fea_contract import validate_study
from fea_settings import get_max_elements
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

HOST = os.environ.get("VISION_ENGINEERING_HOST", "127.0.0.1")
PORT = int(os.environ.get("VISION_ENGINEERING_PORT", "8111"))
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


def run_cad_worker(request, directory):
    if not USD_PYTHON.is_file():
        raise RuntimeError(f"CAD runtime not found: {USD_PYTHON}. Run python scripts/setup_native.py or configure VISION_USD_PYTHON.")
    directory = Path(directory)
    request_path, response_path = directory / "request.json", directory / "response.json"
    request_path.write_text(json.dumps(request, allow_nan=False), encoding="utf-8")
    worker_env = os.environ.copy()
    worker_env.pop("PYTHONPATH", None)
    worker_env.pop("PYTHONHOME", None)
    proc = subprocess.run([str(USD_PYTHON), str(USD_WORKER), str(request_path), str(response_path)],
                          cwd=directory, env=worker_env, capture_output=True, text=True, timeout=240)
    if not response_path.is_file():
        raise RuntimeError((proc.stdout or "")[-4000:] + (proc.stderr or "")[-4000:])
    payload = json.loads(response_path.read_text(encoding="utf-8"))
    if proc.returncode or "error" in payload:
        raise RuntimeError(payload.get("error") or proc.stderr[-4000:])
    return payload


@functools.lru_cache(maxsize=1)
def cad_capabilities():
    with tempfile.TemporaryDirectory(prefix="vision-probe-", dir=ROOT) as temp:
        return run_cad_worker({"operation": "capabilities"}, temp)


def execute_usd_brep(script, density=None, options=None, source_artifact=None, usd_bytes=None):
    if not script.strip() and not source_artifact and not usd_bytes:
        raise ValueError("provide a script or native USD source")
    with tempfile.TemporaryDirectory(prefix="vision-usd-", dir=ROOT) as temp:
        folder = Path(temp)
        source = None
        if source_artifact:
            source = folder / "input.usda"
            source.write_bytes(cad_artifacts.read_file(source_artifact, "model.usda"))
        elif usd_bytes:
            source = folder / "input.usd"
            source.write_bytes(usd_bytes)
        options = dict(options or {})
        if source_artifact:
            options["source_names"] = [body["name"] for body in json.loads(cad_artifacts.read_file(source_artifact, "manifest.json"))["bodies"]]
        source_breps = None
        if source_artifact:
            artifact_dir = cad_artifacts.artifact_path(source_artifact)
            source_breps = [str(artifact_dir / f"body-{i}.brep") for i in range(len(options["source_names"]))]
            if not all(Path(path).is_file() for path in source_breps):
                source_breps = None
        request = {"source_breps": source_breps, "script": script, "density_kg_m3": 2700 if density is None else density,
                   "options": options or {}, "source_usd": str(source) if source else None}
        payload = run_cad_worker(request, folder)
        (folder / "source.py").write_text(script, encoding="utf-8")
        # Persist replay metadata without a path into the soon-to-be-removed temp folder.
        request["source_usd"] = "model.usda" if source else None
        request["source_breps"] = None
        (folder / "request.json").write_text(json.dumps(request, allow_nan=False), encoding="utf-8")
        manifest = {key: value for key, value in payload.items() if key not in {"stlBase64", "stlBytes"}}
        manifest = cad_artifacts.publish(folder, manifest)
        return {**payload, "artifactId": manifest["artifactId"]}


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

    def do_GET(self):
        path = urlsplit(self.path)
        try:
            if path.path in {"/health", "/cad/capabilities"}:
                if path.path == "/cad/capabilities":
                    data = cad_capabilities()
                    query = parse_qs(path.query).get("q", [""])[0].lower()
                    if query:
                        data = {**data, "entries": [entry for entry in data["entries"]
                                if query in entry["symbol"].lower() or query in entry["documentation"].lower()]}
                    total = len(data["entries"])
                    offset = max(0, int(parse_qs(path.query).get("offset", ["0"])[0]))
                    self._send(200, {**data, "entries": data["entries"][offset:offset + 16], "total": total,
                                     "nextOffset": offset + 16 if offset + 16 < total else None})
                    return
                try:
                    probe = cad_capabilities()
                    ready, version, error = True, probe["version"], None
                except Exception as exc:
                    ready, version, error = False, None, str(exc)
                versions = {"ok": ready, "cad_kernel": "NVIDIA USD BRep", "usd_brep": version,
                            "usd_python": str(USD_PYTHON), "python": sys.version.split()[0], "error": error,
                            "max_elements": get_max_elements(), "process_id": os.getpid()}
                for name in ("tetgen", "scikit-fem"):
                    try:
                        from importlib.metadata import version as package_version
                        versions[name] = package_version(name)
                    except Exception:
                        versions[name] = None
                self._send(200, versions)
                return
            pieces = path.path.strip("/").split("/")
            if len(pieces) == 4 and pieces[:2] == ["cad", "artifacts"]:
                identity, filename = pieces[2:]
                data = cad_artifacts.archive(identity) if filename == "archive.zip" else cad_artifacts.read_file(identity, filename)
                self.send_response(200)
                self.send_header("Content-Type", "application/json" if filename == "manifest.json" else "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                if filename != "manifest.json":
                    self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.end_headers()
                self.wfile.write(data)
                return
            self._send(404, {"error": "not found"})
        except FileNotFoundError as exc:
            self._send(404, {"error": str(exc)})
        except Exception as exc:
            self._send(400, {"error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/cad/execute", "/cad/import", "/fea/solve", "/fea/validate"}:
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if self.path == "/fea/validate":
                from fea_solver import solve as solve_fea

                started = time.perf_counter()
                result = solve_fea(
                    _box_stl_base64(),
                    {"E": 210000, "nu": 0.3, "rho": 7850, "yieldStrength": 235},
                    [{"face": "x-min", "enabled": True}],
                    [{"face": "x-max", "vector": [0, 0, -1], "magnitude": 100, "enabled": True}],
                    0.8,
                )
                moment = 20.0 * 10.0**3 / 12.0
                reference = 100.0 * 100.0**3 / (3.0 * 210000.0 * moment)
                computed = float(result["maxDisplacement"])
                error = abs(computed - reference) / reference * 100.0
                self._send(200, {
                    "caseId": "cantilever-3d-tetgen-skfem",
                    "name": "3D cantilever / TetGen + scikit-fem",
                    "reference": reference,
                    "computed": computed,
                    "errorPercent": error,
                    "passed": error <= 8.0,
                    "tolerancePercent": 8.0,
                    "formula": "PL^3 / (3EI)",
                    "meshElements": result["elements"],
                    "solveMs": (time.perf_counter() - started) * 1000,
                })
                return
            if length <= 0 or length > 32 * 1024 * 1024:
                raise ValueError("invalid request size")
            body = json.loads(self.rfile.read(length))
            if self.path == "/fea/solve":
                validate_study(body.get("material"), body.get("supports"), body.get("loads"), body.get("mesh_size", 4.0))
                from fea_solver import solve as solve_fea

                for item in body["supports"] + body["loads"]:
                    region = item.get("region", {})
                    if region.get("type") == "cad-face" and region.get("artifactId") != body.get("artifactId"):
                        raise ValueError("native face selection belongs to a different geometry artifact; rebind it")
                stl_data = str(body.get("stlBase64", ""))
                if body.get("artifactId"):
                    identity = body["artifactId"]
                    manifest = json.loads(cad_artifacts.read_file(identity, "manifest.json"))
                    requested = body.get("bodyIds")
                    selected_ids = requested if requested is not None else [part["id"] for part in manifest["bodies"] if part["kind"] == "solid"]
                    if not isinstance(selected_ids, list) or not selected_ids or len(set(selected_ids)) != len(selected_ids):
                        raise ValueError("select at least one unique solid body for analysis")
                    known = {part["id"]: part for part in manifest["bodies"]}
                    chunks, count = [], 0
                    holes = []
                    expected_volume = 0.0
                    for selected_id in selected_ids:
                        if selected_id not in known or known[selected_id]["kind"] != "solid":
                            raise ValueError("FEA body selection contains an unknown body or sheet; shell analysis is unavailable")
                        part = known[selected_id]
                        if part.get("materialCensus", {}).get("void_count", 0) and not part.get("holePoints"):
                            raise ValueError("enclosed cavities require mesh_holes = {part_name: [(x,y,z), ...]} in the CAD script to preserve voids")
                        holes.extend(part.get("holePoints", []))
                        expected_volume += part["volume_mm3"]
                        part_data = cad_artifacts.read_file(identity, part["stlFile"])
                        count += struct.unpack_from("<I", part_data, 80)[0]
                        chunks.append(part_data[84:])
                    if len(selected_ids) > 1:
                        with tempfile.TemporaryDirectory(prefix="vision-separation-", dir=ROOT) as temp:
                            run_cad_worker({"operation": "validate_separation",
                                "source_breps": [str(cad_artifacts.artifact_path(identity) / f"{part_id}.brep") for part_id in selected_ids],
                                "clearance_mm": manifest["settings"]["tolerance_mm"] * 2}, temp)
                    stl_data = base64.b64encode(b"VISION study".ljust(80, b" ") + struct.pack("<I", count) + b"".join(chunks)).decode("ascii")
                if not body.get("artifactId"):
                    holes, expected_volume = [], None
                result = solve_fea(
                    stl_data,
                    body.get("material", {}),
                    body.get("supports", []),
                    body.get("loads", []),
                    float(body.get("mesh_size", 4.0)),
                    holes=holes, expected_volume=expected_volume,
                )
                result["surfaceStlBase64"] = stl_data
                result["artifactId"] = body.get("artifactId")
                self._send(200, result)
                return
            script = str(body.get("script", ""))
            usd_bytes = None
            if self.path == "/cad/import":
                usd_bytes = base64.b64decode(body.get("dataBase64", ""), validate=True)
                if body.get("format") == "zip":
                    usd_bytes = cad_artifacts.import_archive(usd_bytes)
            density = body.get("density_kg_m3")
            density_value = float(density) if density is not None else None
            self._send(200, execute_usd_brep(script, density_value, body.get("options"), body.get("sourceArtifact"), usd_bytes))
        except Exception as exc:
            self._send(504 if isinstance(exc, TimeoutError) else getattr(exc, "status_code", 400), {
                "error": str(exc),
                "code": "FEA_TIMEOUT" if isinstance(exc, TimeoutError) else getattr(exc, "code", "ENGINEERING_ERROR"),
                "trace": traceback.format_exc(limit=8),
            })

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[backend] " + (fmt % args) + "\n")


class EngineeringHTTPServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR permits multiple listeners on the same address;
    # requests can then reach an obsolete backend with different settings.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main() -> None:
    server = EngineeringHTTPServer((HOST, PORT), Handler)
    print(f"VISION engineering backend on http://{HOST}:{PORT}")
    print(f"CAD kernel=NVIDIA USD BRep python={USD_PYTHON}")
    print(f"FEA=TetGen+scikit-fem python={sys.version.split()[0]}")
    print(f"FEA max_elements={get_max_elements():,} (environment override or local settings)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
