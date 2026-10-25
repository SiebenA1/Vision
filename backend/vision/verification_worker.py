"""Isolated, controller-owned benchmark worker using the production solver."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backend.vision.storage import packed
from backend.vision.verification import solver_profile
from backend.vision.benchmarks import run_suite


if __name__ == "__main__":
    if sys.stdin.readline().strip() != "start":
        raise SystemExit("controller handshake missing")
    directory = Path(sys.argv[2])
    def receipt(value):
        path = directory / "receipt.tmp"
        path.write_text(packed(value), encoding="utf-8")
        path.replace(directory / "receipt.json")
    try:
        job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
        expected = job["input"]["execution"]["profile"]
        if solver_profile() != expected:
            raise ValueError("implementation changed since verification submission")
        report = run_suite(directory, job["suite"], expected, job["input"]["execution"]["max_elements"])
        if solver_profile() != expected:
            raise ValueError("implementation changed during verification")
        receipt({"result": report})
    except Exception as error:
        receipt({"error": f"{type(error).__name__}: {error}"})
        raise
