"""Snapshot implementation and numerical runtime identity at job admission."""
import hashlib
import importlib.metadata
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def profile(kind):
    files = ["backend/vision/native.py", "backend/vision/runtime.py", "backend/vision/storage.py", "backend/vision/changes.py",
             "backend/vision/validation.py", "server/usd_brep_worker.py", 'backend/vision/code_modules.py']
    if kind == "fea":
        files.extend(["server/fea_solver.py", "server/fea_contract.py", "server/cad_artifacts.py",
                      "server/engineering_server.py", "backend/vision/studies.py", "backend/vision/fields.py"])
    usd = next((distribution.version for distribution in importlib.metadata.distributions(path=[str(ROOT / ".python312/Lib/site-packages")])
                if str(distribution.metadata["Name"] or "").lower().replace("_", "-") == "usd-brep"), None)
    if usd is None:
        raise ValueError("project-local USD BRep runtime is unavailable; run scripts/setup_native.py --fea")
    packages = {"usd-brep": usd}
    if kind == "fea":
        packages.update({name: importlib.metadata.version(name) for name in ("numpy", "scipy", "scikit-fem", "tetgen")})
    return {"files": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}, "packages": packages}


def execution_settings(kind):
    from server.fea_settings import get_max_elements
    return {"profile": profile(kind), "max_elements": get_max_elements() if kind == "fea" else None,
            "memory_limit_mib": memory_budget()}


def memory_budget():
    value = os.environ.get("VISION_WORKER_MEMORY_MIB") or ("4096" if os.name == "nt" else "")
    if not value:
        return None
    if os.name != "nt" or not value.isdigit() or not 128 <= int(value) <= 65536:
        raise ValueError("VISION_WORKER_MEMORY_MIB requires Windows and an integer in [128, 65536]")
    return int(value)
