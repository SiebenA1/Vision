"""Generic TetGen + scikit-fem linear-elastic solve for USD BRep STL geometry.

This module is intentionally a solver backend, not a model library. Geometry is
supplied by a caller-provided USD BRep script; boundary conditions are selected
from the model's face ids (x-min, x-max, ...).
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import uuid
import threading
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

from fea_contract import validate_study
from fea_settings import get_max_elements, validate_max_elements
import numpy as nm

WORK_ROOT = Path(__file__).resolve().parent / ".fea_runs"
SOLVE_TIMEOUT_SECONDS = 600
_SOLVE_SLOT = threading.BoundedSemaphore(1)


class FeaBusyError(RuntimeError):
    status_code = 503
    code = "FEA_BUSY"


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
        raise ValueError("expected an exact-length binary STL")
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
    open_edges = sum(count == 1 for count in edge_counts.values())
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
        "openEdges": open_edges,
        "nonManifoldEdges": len(non_manifold),
        "maxEdgeIncidence": max_incidence,
        "firstNonManifoldEdge": (
            [vertices[non_manifold[0][0]], vertices[non_manifold[0][1]]]
            if non_manifold
            else None
        ),
    }


def _mesh_from_stl(stl_path: Path, mesh_path: Path, mesh_size: float, holes=None, max_elements=None) -> dict[str, Any]:
    """Tetrahedralize a cleaned STL with TetGen.

    Gmsh's STL surface reparametrization rejects some valid NURBS tessellations
    ("Wrong topology of boundary mesh for parametrization"). TetGen consumes the
    triangle PLC directly, so it does not need to rebuild CAD surfaces first.
    """
    import struct

    import tetgen

    max_elements = get_max_elements() if max_elements is None else validate_max_elements(max_elements)

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
    h = mesh_size
    gen = tetgen.TetGen(vertices, triangles)
    for point in holes or []:
        gen.add_hole(point)
    nodes, tets, _, _ = gen.tetrahedralize(
        switches=f"pq1.8a{h**3:.12g}",
        quality=True,
        steinerleft=200000,
        quiet=True,
    )
    nodes = nm.asarray(nodes, dtype=nm.float64)
    tets = nm.asarray(tets, dtype=nm.int64)
    if tets.size == 0:
        raise ValueError("TetGen produced no tetrahedra")
    if len(tets) > max_elements:
        raise ValueError(
            f"生成了 {len(tets):,} 个四面体，超过当前上限 {max_elements:,}。"
            "请增大网格尺寸，或设置 VISION_FEA_MAX_ELEMENTS 后重启后端以调整上限。"
        )
    corners = nodes[tets]
    determinants = nm.einsum('ij,ij->i', corners[:, 1] - corners[:, 0], nm.cross(corners[:, 2] - corners[:, 0], corners[:, 3] - corners[:, 0]))
    if not nm.isfinite(determinants).all() or nm.any(nm.abs(determinants) < 1e-16):
        raise ValueError("TetGen produced a degenerate or non-finite tetrahedron")
    negative = determinants < 0
    tets[negative, :2] = tets[negative, 1::-1]
    # Compact arrays avoid millions of Python tuples/lists on fine meshes.
    del corners, determinants, negative
    all_faces = tets[:, [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]]].reshape(-1, 3)
    canonical = nm.sort(all_faces, axis=1)
    unique_faces, first, incidence = nm.unique(canonical, axis=0, return_index=True, return_counts=True)
    if nm.any(incidence > 2):
        raise ValueError("volume mesh has a face shared by more than two tetrahedra")
    tris = all_faces[first[incidence == 1]].copy()
    del all_faces, canonical, unique_faces, first, incidence
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
    holes=None, expected_volume=None, max_elements=None,
) -> dict[str, Any]:
    import base64

    active_supports, active_loads = validate_study(material, supports, loads, mesh_size)
    import time
    build_started = time.perf_counter()
    run_dir = WORK_ROOT / f"run_{uuid.uuid4().hex[:10]}"
    run_dir.mkdir(parents=True, exist_ok=True)
    stl_path = run_dir / "model.stl"
    stl_path.write_bytes(base64.b64decode(stl_base64, validate=True))
    clean_path = run_dir / "model_clean.stl"
    cleanup = _clean_stl(stl_path, clean_path)
    if cleanup["openEdges"]:
        raise ValueError(f"STL has {cleanup['openEdges']} open edges; volume analysis requires closed solids")
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
    mesh = _mesh_from_stl(clean_path, mesh_path, mesh_size, holes, max_elements)
    mesh_ms = (time.perf_counter() - build_started) * 1000
    points = mesh["vertices"]
    tets = mesh["tets"]
    tris = mesh["tris"]
    bbox = mesh["bbox"]

    native_regions = [item["region"] for item in active_supports + active_loads if item.get("region", {}).get("type") == "cad-face"]
    native_masks = {}
    if native_regions:
        import tempfile
        import cad_artifacts
        from engineering_server import run_cad_worker
        for region in native_regions:
            # Each selector carries its immutable artifact identity. The HTTP layer
            # checks it matches the study's selected geometry before meshing.
            with tempfile.TemporaryDirectory(prefix="select-", dir=WORK_ROOT) as temp:
                selection = run_cad_worker({"operation": "select_faces", "source_usd": str(cad_artifacts.artifact_path(region["artifactId"]) / "model.usda"),
                                            "source_breps": [str(cad_artifacts.artifact_path(region["artifactId"]) / f"body-{i}.brep") for i in range(len(json.loads(cad_artifacts.read_file(region["artifactId"], "manifest.json"))["bodies"]))],
                                            "points": points.tolist(), "regions": [region]}, temp)
            mask = nm.zeros(len(points), dtype=bool)
            mask[selection["selections"][0]] = True
            native_masks[json.dumps(region, sort_keys=True)] = mask

    def region_nodes(item, load=False):
        region = item.get("region")
        if region:
            if region["type"] == "cad-face":
                mask = native_masks[json.dumps(region, sort_keys=True)]
            elif region["type"] == "box":
                mask = nm.all((points >= nm.asarray(region["min"])) & (points <= nm.asarray(region["max"])), axis=1)
            else:
                mask = nm.linalg.norm(points - nm.asarray(region["center"]), axis=1) <= region["radius"]
        else:
            axis, limit, sign, band = _face_axis(item["face"], bbox)
            if load:
                _, _, band = _select_load_triangles(points, tris, item["face"], bbox)
            mask = sign * (points[:, axis] - limit) >= -band - 1e-8
        # Select full boundary facets whose vertices all satisfy the region.
        selected = tris[nm.all(mask[tris], axis=1)]
        nodes = nm.unique(selected) if load else nm.flatnonzero(mask)
        if not len(nodes) or (load and not len(selected)):
            raise ValueError(f"empty boundary region: {item.get('name', item.get('face', 'custom'))}")
        return nodes, selected

    fixed_sets = [region_nodes(item)[0] for item in active_supports]
    fixed_nodes = nm.unique(nm.concatenate(fixed_sets))
    # Every disconnected component requires sufficient constraints; never silently bond parts.
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    rows = nm.repeat(tets[:, 0], 3)
    cols = tets[:, 1:].reshape(-1)
    graph = coo_matrix((nm.ones(len(rows)), (rows, cols)), shape=(len(points), len(points)))
    _, labels = connected_components(graph, directed=False)
    for component in nm.unique(labels):
        anchors = fixed_nodes[labels[fixed_nodes] == component]
        if len(anchors) < 3 or nm.linalg.matrix_rank(points[anchors] - points[anchors[0]]) < 2:
            raise ValueError("a mesh component has insufficient fixed nodes to restrain rigid-body motion")
    nodal_forces = nm.zeros((len(points), 3))
    boundary_evidence = []
    applied = nm.zeros(3)
    area = 0.0
    for index, nodes in enumerate(fixed_sets):
        key = f"Fixed{index}"
        boundary_evidence.append({"kind": "support", "name": active_supports[index].get("name", key), "nodes": len(nodes)})
    for index, load in enumerate(active_loads):
        nodes, selected = region_nodes(load, load=True)
        if nm.intersect1d(nodes, fixed_nodes).size:
            raise ValueError("a load region overlaps fixed nodes; choose a separate physical loading surface")
        selected_area = sum(_triangle_area(points, tri) for tri in selected)
        if selected_area <= 0:
            raise ValueError("load selection has zero area")
        force = nm.asarray(load["vector"], dtype=float)
        force = force / nm.linalg.norm(force) * load["magnitude"]
        applied += force
        area += selected_area
        for tri in selected:
            nodal_forces[tri] += force * (_triangle_area(points, tri) / selected_area / 3)
        boundary_evidence.append({"kind": "load", "name": load.get("name", f"Load{index}"), "nodes": len(nodes),
                                  "facets": len(selected), "areaMm2": selected_area, "force": force.tolist()})
    E, nu = float(material["E"]), float(material["nu"])
    import time
    from skfem import MeshTet, Basis, ElementTetP1, ElementVector, asm, condense, solve as solve_linear
    from skfem.models.elasticity import linear_elasticity, lame_parameters
    solve_started = time.perf_counter()
    tetra_mesh = MeshTet(points.T, tets.T, sort_t=False)
    # P1 tetrahedral strain is constant: one quadrature point integrates
    # homogeneous linear elasticity exactly, without four copies of the fields.
    batch_size = 32768
    basis = Basis(tetra_mesh, ElementVector(ElementTetP1()), intorder=1,
                  elements=nm.arange(min(batch_size, len(tets))), disable_doflocs=True)
    form = linear_elasticity(*lame_parameters(E, nu))
    print(f"assembly: {len(tets)} elements, {basis.N} DOFs", flush=True)
    stiffness = None
    for start in range(0, len(tets), batch_size):
        batch_basis = basis if start == 0 else Basis(
            tetra_mesh, basis.elem, mapping=basis.mapping, quadrature=basis.quadrature,
            dofs=basis.dofs, elements=nm.arange(start, min(start + batch_size, len(tets))),
            disable_doflocs=True,
        )
        chunk = asm(form, batch_basis)
        stiffness = chunk if stiffness is None else stiffness + chunk
        del chunk, batch_basis
    rhs = nm.zeros(basis.N)
    rhs[basis.nodal_dofs] = nodal_forces.T
    fixed_dofs = basis.nodal_dofs[:, fixed_nodes].reshape(-1)
    iterations = None
    algorithm = "Direct"
    preconditioner = "Direct"
    if basis.N > 60000:
        from scipy.sparse.linalg import cg, LinearOperator
        reduced, reduced_rhs, displacement, free_dofs = condense(stiffness, rhs, D=fixed_dofs)
        diagonal = reduced.diagonal()
        if not nm.isfinite(diagonal).all() or nm.any(diagonal <= 0):
            raise RuntimeError("invalid stiffness diagonal; inspect material, mesh and constraints")
        inverse_diagonal = 1.0 / diagonal
        conditioning = LinearOperator(reduced.shape, matvec=lambda vector: inverse_diagonal * vector, dtype=float)
        iterations = 0
        algorithm, preconditioner = "CG", "Jacobi"
        print(f"solve: CG/Jacobi, {len(free_dofs)} free DOFs", flush=True)
        def count_iteration(_solution):
            nonlocal iterations
            iterations += 1
            if iterations % 250 == 0:
                print(f"CG iteration {iterations}", flush=True)
        solution, info = cg(reduced, reduced_rhs, M=conditioning, rtol=1e-8, atol=0.0,
                            maxiter=10000, callback=count_iteration)
        if info != 0:
            raise RuntimeError(f"CG did not converge (status={info}, iterations={iterations}); inspect constraints, mesh quality and refinement size")
        displacement[free_dofs] = solution
        del reduced, reduced_rhs, conditioning, solution
    else:
        print("solve: sparse direct", flush=True)
        displacement = solve_linear(*condense(stiffness, rhs, D=fixed_dofs))
    if not nm.isfinite(displacement).all():
        raise RuntimeError("the linear system returned a non-finite displacement; verify component constraints")
    residual = stiffness @ displacement - rhs
    free = nm.setdiff1d(nm.arange(basis.N), fixed_dofs)
    relative_residual = float(nm.linalg.norm(residual[free]) / max(nm.linalg.norm(rhs), 1e-12))
    if relative_residual > 1e-6:
        raise RuntimeError(f"linear solve residual exceeds tolerance: {relative_residual}")
    reaction = residual[basis.nodal_dofs[:, fixed_nodes]].sum(axis=1)
    equilibrium_residual = reaction + applied
    equilibrium_error = float(nm.linalg.norm(equilibrium_residual) / sum(load["magnitude"] for load in active_loads))
    energy = float(0.5 * displacement @ (stiffness @ displacement))
    solve_ms = (time.perf_counter() - solve_started) * 1000
    u = displacement[basis.nodal_dofs].T
    vtk_points, vtk_tets = points, tets
    _, von_mises, _ = _stress_from_displacement(vtk_points, vtk_tets, u, E, nu)
    disp_mag = nm.linalg.norm(u, axis=1)
    imax = int(nm.argmax(von_mises))
    dmax = int(nm.argmax(disp_mag))
    volume = 0.0
    for tet in tets:
        a, b, c, d = points[tet]
        volume += abs(float(nm.dot(b - a, nm.cross(c - a, d - a))) / 6.0)
    if expected_volume and abs(volume - expected_volume) / expected_volume > 0.05:
        raise ValueError("mesh volume differs from native CAD volume by more than 5%; inspect cavities, overlap and tessellation")
    corners = points[tets]
    jacobians = []
    for corner in range(4):
        other = [index for index in range(4) if index != corner]
        edges = corners[:, other] - corners[:, corner, None, :]
        determinant = nm.abs(nm.einsum('ij,ij->i', edges[:, 0], nm.cross(edges[:, 1], edges[:, 2])))
        jacobians.append(nm.sqrt(2.0) * determinant / nm.prod(nm.linalg.norm(edges, axis=2), axis=1))
    quality = {"minScaledJacobian": float(nm.min(jacobians)), "negativeElements": 0}
    yield_strength = float(material.get("yieldStrength", material.get("yield", 276.0)))
    max_vm = float(von_mises[imax])
    return {
        "schema": "vision.fea/1",
        "appliedForce": applied.tolist(),
        "boundaries": boundary_evidence,
        "solveMs": solve_ms,
        "solverMethod": "scikit-fem",
        "solverAlgorithm": algorithm,
        "preconditioner": preconditioner,
        "iterations": iterations,
        "meshMs": mesh_ms,
        "quality": quality,
        "relativeResidual": relative_residual,
        "converged": True,
        "strainEnergyMj": energy,
        "reaction": reaction.tolist(),
        "equilibriumResidual": equilibrium_residual.tolist(),
        "equilibriumError": equilibrium_error,
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
    holes=None, expected_volume=None,
) -> dict[str, Any]:
    """Run native meshing and solving in a child process."""
    validate_study(material, supports, loads, mesh_size)
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
                "mesh_size": mesh_size, "holes": holes, "expected_volume": expected_volume,
                "max_elements": get_max_elements(),
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(sys.path)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    if not _SOLVE_SLOT.acquire(blocking=False):
        raise FeaBusyError("已有网格或求解任务运行中，请等待其结束后再提交；重复提交会增加内存压力。")
    import time
    started = time.perf_counter()
    try:
        with (run / "stdout.log").open("w", encoding="utf-8") as stdout, (run / "stderr.log").open("w", encoding="utf-8") as stderr:
            proc = subprocess.run(
                [sys.executable, "-X", "utf8", str(Path(__file__).resolve()), str(request_path), str(output_path)],
                cwd=str(run), env=env, stdout=stdout, stderr=stderr, text=True,
                timeout=SOLVE_TIMEOUT_SECONDS,
            )
        (run / "execution.json").write_text(json.dumps({"returncode": proc.returncode,
            "elapsedSeconds": time.perf_counter() - started}), encoding="utf-8")
    except subprocess.TimeoutExpired as exc:
        (run / "execution.json").write_text(json.dumps({"error": "FEA_TIMEOUT",
            "elapsedSeconds": time.perf_counter() - started}), encoding="utf-8")
        raise TimeoutError(f"本次计算超过 {SOLVE_TIMEOUT_SECONDS} 秒，求解进程已终止。请适当放粗网格或分区分析；诊断记录：{run.name}") from exc
    finally:
        _SOLVE_SLOT.release()
    if proc.returncode != 0:
        failure = {}
        if output_path.exists():
            try:
                failure = json.loads(output_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        error = (run / "stderr.log").read_text(encoding="utf-8", errors="replace")[-4000:]
        detail = failure.get("error") or error or '未输出错误详情，请查看该记录的 stdout.log 和系统内存状态。'
        raise RuntimeError(f"求解未完成（代码 {proc.returncode}，记录 {run.name}）：{detail}")
    return json.loads(output_path.read_text(encoding="utf-8"))


if __name__ == "__main__" and len(sys.argv) == 3:
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    try:
        response = _solve_impl(
            payload["stlBase64"], payload.get("material", {}), payload.get("supports", []),
            payload.get("loads", []), float(payload.get("mesh_size", 4.0)),
            holes=payload.get("holes"), expected_volume=payload.get("expected_volume"),
            max_elements=payload.get("max_elements"),
        )
    except Exception as exc:
        Path(sys.argv[2]).write_text(json.dumps({"error": str(exc), "errorType": type(exc).__name__}, ensure_ascii=False), encoding="utf-8")
        raise
    Path(sys.argv[2]).write_text(json.dumps(response, ensure_ascii=False), encoding="utf-8")
