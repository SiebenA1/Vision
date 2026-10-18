"""Generic Gmsh + SfePy linear-elastic solve for build123d/OCCT geometry.

This module is intentionally a solver backend, not a model library. Geometry is
supplied by a caller-provided build123d script; boundary conditions are selected
from the model's face ids (x-min, x-max, ...).
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

# The Windows Store Python keeps pip user packages in a versioned LocalCache
# directory that is not always on sys.path for subprocess-style launches.
if os.name == "nt":
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Packages"
    if local.is_dir():
        for candidate in local.glob("PythonSoftwareFoundation.Python.3.13_*/LocalCache/local-packages/Python313/site-packages"):
            if str(candidate) not in sys.path:
                sys.path.insert(0, str(candidate))

import gmsh
import meshio
import numpy as nm

WORK_ROOT = Path(__file__).resolve().parent / ".fea_runs"


def _face_axis(face: str, bbox: list[float]) -> tuple[int, float, int, float]:
    if face.startswith("x"):
        axis, span = 0, bbox[3] - bbox[0]
        limit = bbox[3] if face.endswith("max") else bbox[0]
    elif face.startswith("y"):
        axis, span = 1, bbox[4] - bbox[1]
        limit = bbox[4] if face.endswith("max") else bbox[1]
    else:
        axis, span = 2, bbox[5] - bbox[2]
        limit = bbox[5] if face.endswith("max") else bbox[2]
    sign = 1 if face.endswith("max") else -1
    return axis, limit, sign, max(1e-4, span * 0.01)


def _face_condition(face: str, bbox: list[float], band: float) -> str:
    axis, limit, sign, _ = _face_axis(face, bbox)
    op = ">" if sign > 0 else "<"
    bound = limit - band if sign > 0 else limit + band
    return f"{'xyz'[axis]} {op} {bound}"


def _select_load_triangles(
    points: nm.ndarray,
    tris: nm.ndarray,
    face: str,
    bbox: list[float],
    band: float,
) -> tuple[nm.ndarray, float]:
    axis, limit, sign, _ = _face_axis(face, bbox)
    coords = points[tris, axis]
    exact = tris[nm.all(sign * (coords - limit) >= -band, axis=1)]
    area = sum(_triangle_area(points, tri) for tri in exact)
    if area > 0:
        return exact, float(area)
    # Curved or sharp-end topology may not have a triangulated facet exactly on
    # the extreme plane. Select the boundary band around the extreme.
    centroids = points[tris].mean(axis=1)[:, axis]
    near = tris[sign * (centroids - limit) >= -band]
    area = sum(_triangle_area(points, tri) for tri in near)
    if area > 0:
        return near, float(area)
    raise ValueError(
        f"load face {face} has no boundary facets within {band:.4f} mm; "
        f"bbox={bbox}"
    )


def _mesh_from_step(step_path: Path, mesh_path: Path, mesh_size: float) -> dict[str, Any]:
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("vision")
        gmsh.model.occ.importShapes(str(step_path))
        gmsh.model.occ.synchronize()
        bounds = gmsh.model.getBoundingBox(-1, -1)
        diag = math.dist(bounds[:3], bounds[3:])
        h = max(mesh_size, diag / 70.0)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", h)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", h * 0.55)
        gmsh.model.mesh.generate(3)
        node_tags, coords, _ = gmsh.model.mesh.getNodes()
        tag_to_index = {int(tag): index for index, tag in enumerate(node_tags)}
        vertices = nm.asarray(coords, dtype=nm.float64).reshape((-1, 3))
        _, tet_nodes = gmsh.model.mesh.getElementsByType(4)
        tets = nm.asarray(tet_nodes, dtype=nm.int64).reshape((-1, 4))
        tets = nm.vectorize(tag_to_index.get)(tets)
        _, tri_nodes = gmsh.model.mesh.getElementsByType(2)
        tris = nm.asarray(tri_nodes, dtype=nm.int64).reshape((-1, 3))
        tris = nm.vectorize(tag_to_index.get)(tris)
        with mesh_path.open("w", encoding="ascii") as handle:
            handle.write("MeshVersionFormatted 1\nDimension 3\n")
            handle.write(f"Vertices\n{len(vertices)}\n")
            for x, y, z in vertices:
                handle.write(f"{x:.9f} {y:.9f} {z:.9f} 0\n")
            handle.write(f"Tetrahedra\n{len(tets)}\n")
            for a, b, c, d in tets:
                handle.write(f"{a + 1} {b + 1} {c + 1} {d + 1} 0\n")
            handle.write(f"Triangles\n{len(tris)}\n")
            for a, b, c in tris:
                handle.write(f"{a + 1} {b + 1} {c + 1} 0\n")
            handle.write("End\n")
        return {
            "vertices": vertices,
            "tets": tets,
            "tris": tris,
            "h": h,
            "bbox": [float(v) for v in bounds],
        }
    finally:
        gmsh.finalize()


def _triangle_area(points: nm.ndarray, tri: nm.ndarray) -> float:
    a, b, c = points[tri[0]], points[tri[1]], points[tri[2]]
    return float(0.5 * nm.linalg.norm(nm.cross(b - a, c - a)))


def _stress_from_displacement(
    points: nm.ndarray,
    tets: nm.ndarray,
    u: nm.ndarray,
    E: float,
    nu: float,
) -> tuple[nm.ndarray, nm.ndarray, int]:
    lam = E * nu / ((1 + nu) * (1 - 2 * nu))
    mu = E / (2 * (1 + nu))
    D = nm.zeros((6, 6))
    D[:3, :3] = lam
    D[0, 0] = D[1, 1] = D[2, 2] = lam + 2 * mu
    D[3, 3] = D[4, 4] = D[5, 5] = mu
    nodal_stress = nm.zeros((len(points), 6))
    counts = nm.zeros(len(points))
    for tet in tets:
        X = nm.ones((4, 4))
        X[:, 1:] = points[tet]
        try:
            inv = nm.linalg.inv(X)
        except nm.linalg.LinAlgError:
            continue
        grads = inv[1:, :]
        B = nm.zeros((6, 12))
        for i in range(4):
            gx, gy, gz = grads[:, i]
            B[0, i * 3] = gx
            B[1, i * 3 + 1] = gy
            B[2, i * 3 + 2] = gz
            B[3, i * 3] = gy
            B[3, i * 3 + 1] = gx
            B[4, i * 3 + 1] = gz
            B[4, i * 3 + 2] = gy
            B[5, i * 3] = gz
            B[5, i * 3 + 2] = gx
        ue = u[tet].reshape(12)
        stress = D @ (B @ ue)
        nodal_stress[tet] += stress
        counts[tet] += 1
    mask = counts > 0
    nodal_stress[mask] /= counts[mask, None]
    sxx, syy, szz, sxy, sxz, syz = nodal_stress.T
    vm = nm.sqrt(
        0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2)
        + 3 * (sxy**2 + sxz**2 + syz**2)
    )
    return nodal_stress, vm, int(mask.sum())


def _solve_impl(
    script: str,
    material: dict[str, Any],
    supports: list[dict[str, Any]],
    loads: list[dict[str, Any]],
    mesh_size: float = 4.0,
) -> dict[str, Any]:
    from build123d import export_step

    run_dir = WORK_ROOT / f"run_{uuid.uuid4().hex[:10]}"
    run_dir.mkdir(parents=True, exist_ok=True)
    namespace: dict[str, Any] = {"__name__": "__vision_fea__"}
    exec(compile(script, "<build123d-script>", "exec"), namespace, namespace)
    if "result" not in namespace:
        raise ValueError("build123d script must assign `result`")
    result = namespace["result"]
    part = result.part if hasattr(result, "part") else result
    step_path = run_dir / "model.step"
    export_step(part, str(step_path))
    mesh_path = run_dir / "model.mesh"
    mesh = _mesh_from_step(step_path, mesh_path, max(0.5, mesh_size))
    points = mesh["vertices"]
    tets = mesh["tets"]
    tris = mesh["tris"]
    bbox = mesh["bbox"]

    support = next((item for item in supports if item.get("enabled", True)), None) or supports[0]
    load = next((item for item in loads if item.get("enabled", True)), None) or loads[0]
    fixed_face = str(support.get("face", "x-min"))
    load_face = str(load.get("face", "x-max"))
    _, _, _, load_band = _face_axis(load_face, bbox)
    fixed_desc = _face_condition(fixed_face, bbox, _face_axis(fixed_face, bbox)[3])
    load_desc = _face_condition(load_face, bbox, load_band)
    selected, area = _select_load_triangles(points, tris, load_face, bbox, load_band)
    if area <= 0:
        raise ValueError(f"load face {load_face} has no boundary area")
    force = nm.asarray(load.get("vector", [0, 0, -1]), dtype=nm.float64)
    force = force / max(1e-12, nm.linalg.norm(force)) * float(load.get("magnitude", 0))
    traction = force / area

    E = float(material.get("E", 68900.0))
    nu = float(material.get("nu", 0.33))
    config = run_dir / "problem.py"
    config.write_text(
        f"""from sfepy.mechanics.matcoefs import stiffness_from_youngpoisson

filename_mesh = r"{mesh_path}"
regions = {{
    'Omega': 'all',
    'Fixed': ('vertices in ({fixed_desc})', 'facet'),
    'Load': ('vertices in ({load_desc})', 'facet'),
}}
materials = {{
    'solid': ({{'D': stiffness_from_youngpoisson(3, {E}, {nu}),
                'traction': [[{traction[0]}], [{traction[1]}], [{traction[2]}]]}},),
}}
fields = {{'u': ('real', 'vector', 'Omega', 1)}}
variables = {{
    'u': ('unknown field', 'u', 0),
    'v': ('test field', 'u', 'u'),
}}
ebcs = {{'Fixed': ('Fixed', {{'u.all': 0.0}})}}
equations = {{
    'balance': 'dw_lin_elastic.2.Omega(solid.D, v, u) = dw_surface_ltr.2.Load(solid.traction, v)',
}}
solvers = {{
    'ls': ('ls.auto_direct', {{}}),
    'newton': ('nls.newton', {{'i_max': 1, 'eps_a': 1e-10}}),
}}
options = {{'output_dir': r"{run_dir}"}}
""",
        encoding="utf-8",
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(sys.path)
    proc = subprocess.run(
        [sys.executable, "-m", "sfepy.scripts.simple", str(config), "--filename", "study"],
        cwd=run_dir,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stdout + "\n" + proc.stderr)
    vtk_path = run_dir / "model.vtk"
    vtk = meshio.read(vtk_path)
    u = nm.asarray(vtk.point_data["u"], dtype=nm.float64)
    vtk_points = nm.asarray(vtk.points, dtype=nm.float64)
    vtk_tets = nm.asarray(
        next(cell.data for cell in vtk.cells if cell.type == "tetra"), dtype=nm.int64
    )
    _, von_mises, _ = _stress_from_displacement(vtk_points, vtk_tets, u, E, nu)
    disp_mag = nm.linalg.norm(u, axis=1)
    imax = int(nm.argmax(von_mises))
    dmax = int(nm.argmax(disp_mag))
    volume = 0.0
    for tet in tets:
        a, b, c, d = points[tet]
        volume += abs(float(nm.dot(b - a, nm.cross(c - a, d - a))) / 6.0)
    yield_strength = float(material.get("yieldStrength", material.get("yield", 276.0)))
    max_vm = float(von_mises[imax])
    return {
        "schema": "vision.fea/1",
        "nodes": int(len(vtk_points)),
        "elements": int(len(vtk_tets)),
        "dofs": int(len(vtk_points) * 3),
        "h": float(mesh["h"]),
        "volume_mm3": volume,
        "mass_kg": volume * 1e-9 * float(material.get("rho", 2700.0)),
        "maxVonMises": max_vm,
        "maxVonMisesLocation": [float(v) for v in vtk_points[imax]],
        "maxDisplacement": float(disp_mag[dmax]),
        "maxDisplacementLocation": [float(v) for v in vtk_points[dmax]],
        "safetyFactor": yield_strength / max_vm if max_vm > 1e-9 else 1e9,
        "positions": nm.asarray(vtk_points, dtype=nm.float32).ravel().tolist(),
        "displacement": nm.asarray(u, dtype=nm.float32).ravel().tolist(),
        "vonMises": nm.asarray(von_mises, dtype=nm.float32).ravel().tolist(),
        "supportArea": 0.0,
        "loadArea": float(area),
    }

def solve(
    script: str,
    material: dict[str, Any],
    supports: list[dict[str, Any]],
    loads: list[dict[str, Any]],
    mesh_size: float = 4.0,
) -> dict[str, Any]:
    """Run the solve in a child process (Gmsh requires the main thread)."""
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    run = WORK_ROOT / f"request_{uuid.uuid4().hex[:10]}"
    run.mkdir(parents=True, exist_ok=True)
    request_path = run / "request.json"
    output_path = run / "response.json"
    request_path.write_text(
        json.dumps(
            {
                "script": script,
                "material": material,
                "supports": supports,
                "loads": loads,
                "mesh_size": mesh_size,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(sys.path)
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(request_path), str(output_path)],
        cwd=str(run),
        env=env,
        capture_output=True,
        text=True,
        timeout=360,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stdout or "") + "\n" + (proc.stderr or ""))
    return json.loads(output_path.read_text(encoding="utf-8"))


if __name__ == "__main__" and len(sys.argv) == 3:
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    response = _solve_impl(
        payload["script"],
        payload.get("material", {}),
        payload.get("supports", []),
        payload.get("loads", []),
        float(payload.get("mesh_size", 4.0)),
    )
    Path(sys.argv[2]).write_text(json.dumps(response), encoding="utf-8")
