"""Validate the current direct and CG paths; retain numerical evidence as JSON.

Run with .python313/python.exe scripts/validate_fea.py.
"""
import hashlib
import importlib.metadata
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from engineering_server import _box_stl_base64
from fea_solver import solve


def main():
    output = ROOT / "server/.fea_runs/current-version-validation.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    evidence = {
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "python": sys.version,
        "platform": platform.platform(),
        "versions": {name: importlib.metadata.version(name) for name in
                     ("numpy", "scipy", "scikit-fem", "tetgen")},
        "sourceSha256": {name: hashlib.sha256((ROOT / "server" / name).read_bytes()).hexdigest()
                         for name in ("fea_solver.py", "fea_contract.py", "fea_settings.py")},
        "cases": [],
        "passed": False,
    }
    material = {"E": 210000, "nu": .3, "rho": 7850, "yieldStrength": 235}
    supports = [{"face": "x-min", "enabled": True}]
    stl = _box_stl_base64()
    axial_reference = 100 * 100 / (210000 * 20 * 10)
    bending_reference = 100 * 100 ** 3 / (3 * 210000 * (20 * 10 ** 3 / 12))
    fields = ("nodes", "elements", "dofs", "h", "solverMethod", "solverAlgorithm",
              "preconditioner", "iterations", "converged", "relativeResidual",
              "reaction", "appliedForce", "equilibriumError", "strainEnergyMj",
              "volume_mm3", "mass_kg", "maxDisplacement", "maxVonMises",
              "quality", "meshMs", "solveMs")
    try:
        for name, h, direction, reference, tolerance, algorithm in (
            ("axial-direct", 4, [1, 0, 0], axial_reference, .02, "Direct"),
            ("axial-cg", .6, [1, 0, 0], axial_reference, .02, "CG"),
            ("cantilever", .8, [0, 0, -1], bending_reference, .08, None),
        ):
            result = solve(stl, material, supports,
                           [{"face": "x-max", "enabled": True, "vector": direction,
                             "magnitude": 100}], h, expected_volume=20000)
            case = {"name": name, **{key: result[key] for key in fields},
                    "referenceDisplacementMm": reference,
                    "relativeDisplacementError": abs(result["maxDisplacement"] - reference) / reference,
                    "tolerance": tolerance}
            evidence["cases"].append(case)
            assert result["converged"], case
            assert result["relativeResidual"] < 1e-6, case
            assert result["equilibriumError"] < 1e-6, case
            assert result["strainEnergyMj"] > 0, case
            assert abs(result["volume_mm3"] - 20000) / 20000 < 1e-6, case
            assert case["relativeDisplacementError"] < tolerance, case
            if algorithm:
                assert result["solverAlgorithm"] == algorithm, case
            if algorithm == "CG":
                assert result["dofs"] > 60000 and result["iterations"] > 0, case
                assert result["preconditioner"] == "Jacobi", case
            print(f"PASS {name}: {result['elements']} elements, {result['dofs']} DOFs, "
                  f"{result['solverAlgorithm']}, displacement error "
                  f"{case['relativeDisplacementError']:.3%}", flush=True)
        coarse, fine = evidence["cases"][:2]
        assert fine["h"] < coarse["h"] and fine["elements"] > coarse["elements"]
        evidence["passed"] = True
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        evidence["finishedAt"] = datetime.now(timezone.utc).isoformat()
        output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Evidence: {output}", flush=True)


if __name__ == "__main__":
    main()
