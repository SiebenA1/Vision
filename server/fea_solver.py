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
) -> tuple[nm.ndarray, float, float]:
    axis, limit, sign, _ = _face_axis(face, bbox)
    span = bbox[3] - bbox[0] if axis == 0 else bbox[4] - bbox[1] if axis == 1 else bbox[5] - bbox[2]
    exact_tol = max(1e-6, span * 1e-5)
    coords = points[tris, axis]
    exact = tris[nm.all(nm.abs(coords - limit) <= exact_tol, axis=1)]
    area = sum(_triangle_area(points, tri) for tri in exact)
    if area > 0:
        return exact, float(area), exact_tol
    # Curved or sharp-end topology may not have a triangulated facet exactly on
    # the extreme plane. Select the boundary band around the extreme.
    band = max(1e-4, span * 0.01)
    centroids = points[tris].mean(axis=1)[:, axis]
    near = tris[sign * (centroids - limit) >= -band]
    area = sum(_triangle_area(points, tri) for tri in near)
    if area > 0:
        return near, float(area), band
    raise ValueError(
        f"load face {face} has no boundary facets within {band:.4f} mm; "
        f"bbox={bbox}"
    )


def _clean_stl(source: Path, target: Path) -> dict[str, int]:
    """Weld duplicate vertices and remove duplicate/degenerate triangles.

    Boolean results can contain coincident tessellation triangles at a seam.
    An edge shared by four triangles makes Gmsh's surface classification fail
    before it can create a volume. This is a conservative topology cleanup.
    """
    import struct

    data = source.read_bytes()
    if len(data) < 84:
        raise ValueError("STL is empty or truncated")
    count = struct.unpack_from("<I", data, 80)[0]
    if 84 + count * 50 != len(data):
        target.write_bytes(data)
        return {"triangles": count, "removed": 0}
    coords = []
    for index in range(count):
        offset = 84 + index * 50 + 12
        values = struct.unpack_from("<9f", data, offset)
        coords.append((values[0:3], values[3:6], values[6:9]))
    if not coords:
        raise ValueError("STL has no triangles")
    xs = [p[0] for tri in coords for p in tri]
    ys = [p[1] for tri in coords for p in tri]
    zs = [p[2] for tri in coords for p in tri]
    diag = math.dist((min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs)))
    eps = max(1e-6, diag * 1e-6)

    def key(point: tuple[float, float, float]) -> tuple[int, int, int]:
        return (
            round(point[0] / eps),
            round(point[1] / eps),
            round(point[2] / eps),
        )

    vertex_index: dict[tuple[int, int, int], int] = {}
    vertices: list[tuple[float, float, float]] = []
    triangles: list[tuple[int, int, int]] = []
    seen: set[tuple[int, int, int]] = set()
    removed = 0
    for tri in coords:
        indices = []
        for point in tri:
            k = key(point)
            if k not in vertex_index:
                vertex_index[k] = len(vertices)
                vertices.append((float(point[0]), float(point[1]), float(point[2])))
            indices.append(vertex_index[k])
        if len(set(indices)) != 3:
            removed += 1
            continue
        signature = tuple(sorted(indices))
        if signature in seen:
            removed += 1
            continue
        seen.add(signature)
        triangles.append((indices[0], indices[1], indices[2]))

    edge_counts: dict[tuple[int, int], int] = {}
    for a, b, c in triangles:
        for u, v in ((a, b), (b, c), (c, a)):
            edge = (u, v) if u < v else (v, u)
            edge_counts[edge] = edge_counts.get(edge, 0) + 1
    non_manifold = [edge for edge, count in edge_counts.items() if count > 2]
    max_incidence = max(edge_counts.values(), default=0)

    payload = bytearray(b"VISION cleaned STL".ljust(80, b" "))
    payload += struct.pack("<I", len(triangles))
    for a, b, c in triangles:
        pa, pb, pc = vertices[a], vertices[b], vertices[c]
        ux, uy, uz = pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]
        vx, vy, vz = pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
        payload += struct.pack(
            "<12fH",
            nx / length, ny / length, nz / length,
            *pa, *pb, *pc, 0,
        )
    target.write_bytes(payload)
    return {
        "triangles": len(triangles),
        "removed": removed,
        "nonManifoldEdges": len(non_manifold),
        "maxEdgeIncidence": max_incidence,
        "firstNonManifoldEdge": (
            [vertices[non_manifold[0][0]], vertices[non_manifold[0][1]]]
            if non_manifold
            else None
        ),
    }


def _mesh_from_stl(stl_path: Path, mesh_path: Path, mesh_size: float) -> dict[str, Any]:
    """Tetrahedralize a cleaned STL with TetGen.

    Gmsh's STL surface reparametrization rejects some valid NURBS tessellations
    ("Wrong topology of boundary mesh for parametrization"). TetGen consumes the
    triangle PLC directly, so it does not need to rebuild CAD surfaces first.
    """
    import struct

    import tetgen

    data = stl_path.read_bytes()
    count = struct.unpack_from("<I", data, 80)[0]
    vertex_index: dict[tuple[float, float, float], int] = {}
    points: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    for index in range(count):
        offset = 84 + index * 50 + 12
        values = struct.unpack_from("<9f", data, offset)
        tri = []
        for corner in range(3):
            point = values[corner * 3 : corner * 3 + 3]
            key = (round(point[0], 6), round(point[1], 6), round(point[2], 6))
            if key not in vertex_index:
                vertex_index[key] = len(points)
                points.append((float(point[0]), float(point[1]), float(point[2])))
            tri.append(vertex_index[key])
        if len(set(tri)) == 3:
            faces.append(tuple(tri))
    vertices = nm.asarray(points, dtype=nm.float64)
    triangles = nm.asarray(faces, dtype=nm.int32)
    lo = vertices.min(axis=0)
    hi = vertices.max(axis=0)
    diag = float(nm.linalg.norm(hi - lo))
    h = max(mesh_size, diag / 140.0)
    gen = tetgen.TetGen(vertices, triangles)
    nodes, tets, _, _ = gen.tetrahedralize(
        switches=f"pq1.8a{max(0.01, h**3):.6f}",
        quality=True,
        steinerleft=200000,
        quiet=True,
    )
    nodes = nm.asarray(nodes, dtype=nm.float64)
    tets = nm.asarray(tets, dtype=nm.int64)
    if tets.size == 0:
        raise ValueError("TetGen produced no tetrahedra")
    # Extract boundary triangles from tet faces occurring exactly once.
    face_owner: dict[tuple[int, int, int], list[tuple[int, int, int]]] = {}
    for tet in tets:
        a, b, c, d = (int(v) for v in tet)
        for face in ((a, b, c), (a, b, d), (a, c, d), (b, c, d)):
            key = tuple(sorted(face))
            face_owner.setdefault(key, []).append(face)
    boundary = [items[0] for items in face_owner.values() if len(items) == 1]
    tris = nm.asarray(boundary, dtype=nm.int64)
    with mesh_path.open("w", encoding="ascii") as handle:
        handle.write("MeshVersionFormatted 1\nDimension 3\n")
        handle.write(f"Vertices\n{len(nodes)}\n")
        for x, y, z in nodes:
            handle.write(f"{x:.9f} {y:.9f} {z:.9f} 0\n")
        handle.write(f"Tetrahedra\n{len(tets)}\n")
        for a, b, c, d in tets:
            handle.write(f"{a + 1} {b + 1} {c + 1} {d + 1} 0\n")
        handle.write(f"Triangles\n{len(tris)}\n")
        for a, b, c in tris:
            handle.write(f"{a + 1} {b + 1} {c + 1} 0\n")
        handle.write("End\n")
    return {
        "vertices": nodes,
        "tets": tets,
        "tris": tris,
        "h": h,
        "bbox": [float(lo[0]), float(lo[1]), float(lo[2]), float(hi[0]), float(hi[1]), float(hi[2])],
    }


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
    stl_base64: str,
    material: dict[str, Any],
    supports: list[dict[str, Any]],
    loads: list[dict[str, Any]],
    mesh_size: float = 4.0,
) -> dict[str, Any]:
    import base64

    run_dir = WORK_ROOT / f"run_{uuid.uuid4().hex[:10]}"
    run_dir.mkdir(parents=True, exist_ok=True)
    stl_path = run_dir / "model.stl"
    stl_path.write_bytes(base64.b64decode(stl_base64))
    clean_path = run_dir / "model_clean.stl"
    cleanup = _clean_stl(stl_path, clean_path)
    if cleanup["nonManifoldEdges"] > 0:
        edge = cleanup.get("firstNonManifoldEdge")
        raise ValueError(
            "STL has non-manifold topology: "
            f"{cleanup['nonManifoldEdges']} edge(s) are shared by more than 2 triangles "
            f"(max incidence {cleanup['maxEdgeIncidence']}; first edge {edge}). "
            "This is a boolean/tessellation seam, not a mesh-size problem. "
            "Union the touching bodies or regenerate the B-Rep so every edge has exactly 2 triangles."
        )
    mesh_path = run_dir / "model.mesh"
    mesh = _mesh_from_stl(clean_path, mesh_path, max(0.5, mesh_size))
    points = mesh["vertices"]
    tets = mesh["tets"]
    tris = mesh["tris"]
    bbox = mesh["bbox"]

    support = next((item for item in supports if item.get("enabled", True)), None) or supports[0]
    load = next((item for item in loads if item.get("enabled", True)), None) or loads[0]
    fixed_face = str(support.get("face", "x-min"))
    load_face = str(load.get("face", "x-max"))
    fixed_desc = _face_condition(fixed_face, bbox, _face_axis(fixed_face, bbox)[3])
    selected, area, load_band = _select_load_triangles(points, tris, load_face, bbox)
    load_desc = _face_condition(load_face, bbox, load_band)
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
        "stlCleanup": cleanup,
    }

def solve(
    stl_base64: str,
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
                "stlBase64": stl_base64,
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
        payload["stlBase64"],
        payload.get("material", {}),
        payload.get("supports", []),
        payload.get("loads", []),
        float(payload.get("mesh_size", 4.0)),
    )
    Path(sys.argv[2]).write_text(json.dumps(response), encoding="utf-8")
