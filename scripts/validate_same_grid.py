"""Direct/CG equivalence on one archived TetGen mesh; bending refinement study."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
import numpy as np
import fea_solver as solver
from engineering_server import _box_stl_base64


def main():
    output = ROOT / "screenshots"
    output.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    record = {"time": stamp, "solver_sha256": hashlib.sha256((ROOT / 'server/fea_solver.py').read_bytes()).hexdigest(), "passed": False}
    material = {"E": 210000, "nu": .3, "rho": 7850, "yieldStrength": 235}
    supports = [{"face": "x-min", "enabled": True}]
    stl = _box_stl_base64()
    def solve(h, vector, method="auto"):
        return solver._solve_impl(stl, material, supports, [{"face": "x-max", "enabled": True, "vector": vector, "magnitude": 100}], h,
            expected_volume=20000, surface_topology=True, linear_solver=method)
    try:
        with tempfile.TemporaryDirectory(prefix="same-grid-", dir=output) as folder:
            solver.WORK_ROOT = Path(folder)
            original = solver._mesh_from_stl
            mesh_path = output / f"fea-same-grid-{stamp}.npz"
            def archive(*args):
                mesh = original(*args)
                np.savez_compressed(mesh_path, vertices=mesh["vertices"], tets=mesh["tets"], tris=mesh["tris"],
                    bbox=np.asarray(mesh["bbox"]), h=np.asarray(mesh["h"]))
                return mesh
            with patch.object(solver, "_mesh_from_stl", side_effect=archive):
                direct = solve(4, [1, 0, 0], "direct")
            def restore(*_args):
                with np.load(mesh_path, allow_pickle=False) as saved:
                    return {"vertices": saved["vertices"].copy(), "tets": saved["tets"].copy(), "tris": saved["tris"].copy(),
                            "bbox": tuple(saved["bbox"]), "h": float(saved["h"])}
            with patch.object(solver, "_mesh_from_stl", side_effect=restore):
                iterative = solve(4, [1, 0, 0], "cg")
            assert direct["positions"] == iterative["positions"]
            assert direct["surfaceTriangles"] == iterative["surfaceTriangles"]
            u, v = np.array(direct["displacement"]), np.array(iterative["displacement"])
            displacement_error = float(np.linalg.norm(u-v) / np.linalg.norm(u))
            stress_error = float(np.linalg.norm(np.array(direct["vonMises"])-iterative["vonMises"]) / np.linalg.norm(direct["vonMises"]))
            energy_error = abs(direct["strainEnergyMj"]-iterative["strainEnergyMj"]) / direct["strainEnergyMj"]
            record["same_grid"] = {"mesh_archive": mesh_path.name, "sha256": hashlib.sha256(mesh_path.read_bytes()).hexdigest(),
                "nodes": direct["nodes"], "elements": direct["elements"], "direct_algorithm": direct["solverAlgorithm"], "cg_algorithm": iterative["solverAlgorithm"],
                "iterations": iterative["iterations"], "relative_displacement_difference": displacement_error, "relative_stress_difference": stress_error,
                "relative_energy_difference": energy_error, "direct_residual": direct["relativeResidual"], "cg_residual": iterative["relativeResidual"]}
            assert displacement_error < 1e-5 and stress_error < 1e-4 and energy_error < 1e-6, record["same_grid"]
            reference = 100 * 100**3 / (3 * 210000 * (20 * 10**3 / 12))
            cases = []
            for h in (4, 2, 1):
                result = solve(h, [0, 0, -1])
                cases.append({"h": h, "elements": result["elements"], "nodes": result["nodes"], "max_displacement_mm": result["maxDisplacement"],
                    "max_stress_mpa": result["maxVonMises"], "relative_residual": result["relativeResidual"], "equilibrium_error": result["equilibriumError"],
                    "relative_displacement_error": abs(result["maxDisplacement"]-reference) / reference})
            record["bending_refinement"] = {"reference_mm": reference, "cases": cases, "local_stress_convergence": "not_established"}
            assert cases[-1]["relative_displacement_error"] < .12
            assert cases[-1]["relative_displacement_error"] < cases[0]["relative_displacement_error"]
            record["passed"] = True
    finally:
        path = output / f"fea-same-grid-{stamp}.json"
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(record, ensure_ascii=False, indent=2))
        print("Evidence:", path)


if __name__ == "__main__":
    main()
