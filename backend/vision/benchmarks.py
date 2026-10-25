"""Real production-solver checks against independently calculated bar/beam references."""
from datetime import datetime, timezone
import hashlib
import math
from pathlib import Path
import sys
from unittest.mock import patch

from .runtime import ROOT
from .verification import beam_reference


def case_passed(case):
    return (case["converged"] is True and case["relative_residual"] < 1e-6 and case["equilibrium_error"] < 1e-6
        and case["strain_energy_mj"] > 0 and abs(case["volume_mm3"] - 20000) / 20000 < 1e-6
        and abs(case["mass_kg"] - .157) / .157 < 1e-6 and case["applied_force_error"] < 1e-10
        and case["relative_error"] < case["tolerance"] and case["algorithm"] == case["expected_algorithm"]
        and (case["id"] != "axial-patch" or (case["affine_displacement_error"] < 1e-6 and case["stress_error"] < 1e-6 and case["energy_error"] < 1e-6)))


def acceptance(report):
    def finite(value):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("non-finite solver verification evidence")
        if isinstance(value, dict):
            for child in value.values():
                finite(child)
        if isinstance(value, list):
            for child in value:
                finite(child)
    finite(report)
    expected = {"axial-direct", "axial-patch", "bending-4", "bending-2", "bending-1"}
    if report.get("suite") == "extended":
        expected |= {"axial-cg", "bending-0.8"}
    elif report.get("suite") != "standard":
        raise ValueError("unknown verification suite")
    cases = report.get("cases", [])
    if len(cases) != len(expected) or {case.get("id") for case in cases} != expected:
        raise ValueError("incomplete solver verification cases")
    for case in cases:
        required = case["id"] not in ("bending-4", "bending-2")
        target = 1e-6 if case["id"] == "axial-patch" else .02 if case["id"].startswith("axial") else .08
        if case.get("acceptance_case") is not required or case.get("tolerance") != target:
            raise ValueError("invalid verification acceptance criteria")
        bending = case["id"].startswith("bending")
        mesh = float(case["id"].split("-")[1]) if bending else .6 if case["id"] == "axial-cg" else 4
        expected_algorithm = "CG" if case["id"] == "axial-cg" else "Direct"
        reference = beam_reference(case["inputs"])["displacement_mm"]
        if (case["mesh_mm"] != mesh or case["expected_algorithm"] != expected_algorithm
            or case["kind"] != ("cantilever" if bending else "axial")
            or case["reference_mm"] != reference or case["computed_mm"] < 0
            or abs(case["relative_error"] - abs(case["computed_mm"] - reference) / reference) > 1e-12):
            raise ValueError("invalid verification measurement")
        for key in ("relative_residual", "equilibrium_error", "applied_force_error", "relative_error"):
            if case[key] < 0:
                raise ValueError("negative error norm")
        if case.get("passed") is not case_passed(case):
            raise ValueError("invalid verification case conclusion")
    same = report["same_grid"]
    for key in ("relative_displacement_difference", "relative_stress_difference", "relative_energy_difference", "cg_residual"):
        if same[key] < 0:
            raise ValueError("negative same-grid error norm")
    equivalence = (same["identical_nodes"] is True and same["identical_surface"] is True
        and same["direct_algorithm"] == "Direct" and same["cg_algorithm"] == "CG"
        and same["relative_displacement_difference"] < 1e-5 and same["relative_stress_difference"] < 1e-4
        and same["relative_energy_difference"] < 1e-6 and same["cg_residual"] < 1e-6)
    if same.get("passed") is not equivalence:
        raise ValueError("invalid same-grid conclusion")
    bending = sorted((case for case in cases if case["id"].startswith("bending")), key=lambda case: -case["mesh_mm"])
    improved = bending[-1]["relative_error"] < bending[0]["relative_error"]
    return all(case["passed"] for case in cases if case["acceptance_case"]) and equivalence and improved


def run_suite(directory, suite, profile, max_elements):
    import numpy as np
    import scipy
    import skfem
    import tetgen
    sys.path.insert(0, str(ROOT / "server"))
    original_path = sys.path[:]
    try:
        import fea_solver as solver
    finally:
        # Match native.py: legacy Windows Store fallback paths must not replace
        # the admitted, project-local numerical packages during verification.
        sys.path[:] = original_path
    versions = {"numpy": np.__version__, "scipy": scipy.__version__, "scikit-fem": skfem.__version__, "tetgen": tetgen.__version__}
    if versions != {key: profile["packages"][key] for key in versions}:
        raise ValueError("loaded benchmark packages differ from admitted production runtime")
    from engineering_server import _box_stl_base64
    solver.WORK_ROOT = Path(directory) / "solver"
    solver.WORK_ROOT.mkdir(exist_ok=True)
    stl = _box_stl_base64()
    material = {"E": 210000, "nu": .3, "rho": 7850, "yieldStrength": 235}
    supports = [{"face": "x-min", "enabled": True}]
    inputs = {"length_mm": 100., "width_mm": 20., "height_mm": 10., "elastic_modulus_mpa": 210000., "force_n": 100., "density_kg_m3": 7850.}
    report = {"schema": "vision.solver-check/1", "suite": suite, "profile": profile, "python": sys.version,
        "started_at": datetime.now(timezone.utc).isoformat(), "cases": [],
        "scope": "矩形等截面梁、均匀各向同性线弹性、小变形、全固定端及端面总合力。",
        "limitations": ["解析梁解是相应理想化模型的参考，不是任意三维零件的精确解。", "粗P1四面体在弯曲下可明显偏硬，低残差不等于低离散误差。", "网格位移误差改善不证明局部应力收敛；固定边界附近可能存在应力奇异性。", "此校核不替代当前工程的工况确认、求解与设计指标校核。"]}
    def solve(mesh, bending=False, method="auto", nu=.3):
        return solver._solve_impl(stl, {**material, "nu": nu}, supports,
            [{"face": "x-max", "enabled": True, "vector": [0, 0, -1] if bending else [1, 0, 0], "magnitude": 100}], mesh,
            expected_volume=20000, surface_topology=True, linear_solver=method, max_elements=max_elements)
    def evidence(name, result, bending=False, nu=.3):
        positions = np.array(result["positions"]).reshape(-1, 3)
        displacement = np.array(result["displacement"]).reshape(-1, 3)
        triangles = np.array(result["surfaceTriangles"]).reshape(-1, 3)
        face = triangles[np.all(np.isclose(positions[triangles, 0], positions[:, 0].max(), rtol=0, atol=1e-5), axis=1)]
        corners = positions[face]
        areas = np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1) / 2
        if not len(face) or not np.isclose(areas.sum(), 200, rtol=1e-5):
            raise ValueError("benchmark free-end area does not match the rectangular reference")
        component = 2 if bending else 0
        computed = abs(float(np.dot(areas, displacement[face, component].mean(axis=1)) / areas.sum()))
        reference = beam_reference({**inputs, "kind": "cantilever" if bending else "axial"})
        case = {"id": name, "kind": "cantilever" if bending else "axial", "poisson_ratio": nu,
            "formula": reference["formula"], "inputs": reference["inputs"], "reference_mm": reference["displacement_mm"],
            "computed_mm": computed, "max_displacement_mm": result["maxDisplacement"],
            "measurement": "自由端面按面积加权的平均位移分量" + (" |Uz|" if bending else " Ux"),
            "relative_error": abs(computed - reference["displacement_mm"]) / reference["displacement_mm"],
            "mesh_mm": result["h"], "elements": result["elements"], "nodes": result["nodes"], "dofs": result["dofs"],
            "algorithm": result["solverAlgorithm"], "expected_algorithm": "CG" if name == "axial-cg" else "Direct",
            "iterations": result["iterations"], "converged": result["converged"], "relative_residual": result["relativeResidual"],
            "equilibrium_error": result["equilibriumError"], "reaction_n": result["reaction"], "applied_force_n": result["appliedForce"],
            "applied_force_error": float(np.linalg.norm(np.array(result["appliedForce"]) - np.array([0, 0, -100] if bending else [100, 0, 0])) / 100),
            "strain_energy_mj": result["strainEnergyMj"], "volume_mm3": result["volume_mm3"], "mass_kg": result["mass_kg"],
            "max_stress_mpa": result["maxVonMises"], "tolerance": 1e-6 if name == "axial-patch" else .08 if bending else .02,
            "acceptance_case": name not in ("bending-4", "bending-2")}
        if name == "axial-patch":
            exact = np.zeros_like(displacement)
            exact[:, 0] = (positions[:, 0] - positions[:, 0].min()) * 100 / (210000 * 200)
            case["affine_displacement_error"] = float(np.linalg.norm(displacement - exact) / np.linalg.norm(exact))
            case["stress_error"] = float(np.max(np.abs(np.array(result["vonMises"]) - .5)) / .5)
            case["energy_error"] = abs(result["strainEnergyMj"] - reference["strain_energy_mj"]) / reference["strain_energy_mj"]
        case["passed"] = case_passed(case)
        report["cases"].append(case)
        print(f"stage: {name}, error={case['relative_error']:.3%}", flush=True)
    original_mesher = solver._mesh_from_stl
    mesh_file = Path(directory) / "mesh.npz"
    def archive_mesh(*args):
        mesh = original_mesher(*args)
        np.savez_compressed(mesh_file, vertices=mesh["vertices"], tets=mesh["tets"], tris=mesh["tris"], bbox=np.array(mesh["bbox"]), h=mesh["h"])
        return mesh
    print("stage: axial direct and archived mesh", flush=True)
    with patch.object(solver, "_mesh_from_stl", side_effect=archive_mesh):
        direct = solve(4)
    evidence("axial-direct", direct)
    def restore_mesh(*_args):
        with np.load(mesh_file, allow_pickle=False) as mesh:
            return {"vertices": mesh["vertices"].copy(), "tets": mesh["tets"].copy(), "tris": mesh["tris"].copy(), "bbox": tuple(mesh["bbox"]), "h": float(mesh["h"])}
    print("stage: same-grid CG comparison", flush=True)
    with patch.object(solver, "_mesh_from_stl", side_effect=restore_mesh):
        cg = solve(4, method="cg")
    u, v = np.array(direct["displacement"]), np.array(cg["displacement"])
    same = {"mesh_sha256": hashlib.sha256(mesh_file.read_bytes()).hexdigest(), "identical_nodes": direct["positions"] == cg["positions"],
        "identical_surface": direct["surfaceTriangles"] == cg["surfaceTriangles"], "direct_algorithm": direct["solverAlgorithm"], "cg_algorithm": cg["solverAlgorithm"],
        "relative_displacement_difference": float(np.linalg.norm(u - v) / np.linalg.norm(u)),
        "relative_stress_difference": float(np.linalg.norm(np.array(direct["vonMises"]) - cg["vonMises"]) / np.linalg.norm(direct["vonMises"])),
        "relative_energy_difference": abs(direct["strainEnergyMj"] - cg["strainEnergyMj"]) / direct["strainEnergyMj"],
        "cg_residual": cg["relativeResidual"], "iterations": cg["iterations"]}
    same["passed"] = (same["identical_nodes"] and same["identical_surface"] and same["direct_algorithm"] == "Direct" and same["cg_algorithm"] == "CG"
        and same["relative_displacement_difference"] < 1e-5 and same["relative_stress_difference"] < 1e-4 and same["relative_energy_difference"] < 1e-6 and same["cg_residual"] < 1e-6)
    report["same_grid"] = same
    evidence("axial-patch", solve(4, nu=0), nu=0)
    for mesh in (4, 2, 1):
        print(f"stage: bending refinement h={mesh} mm", flush=True)
        evidence(f"bending-{mesh}", solve(mesh, bending=True), bending=True)
    if suite == "extended":
        print("stage: production auto-CG above 60000 DOFs", flush=True)
        evidence("axial-cg", solve(.6))
        evidence("bending-0.8", solve(.8, bending=True), bending=True)
    report["passed"] = acceptance(report)
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    return report
