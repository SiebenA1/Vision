"""Gmsh + SfePy cantilever benchmark."""
from __future__ import annotations

import json
import os
import subprocess
import sys

import gmsh
import meshio

L = 100.0
B = 20.0
H = 10.0
P = 100.0
E = 210_000.0
NU = 0.3
H_MESH = 1.5
WORK = os.path.join(os.getcwd(), "server", ".fea_tmp")


def build_mesh(path: str) -> None:
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.model.add("beam")
    gmsh.model.occ.addBox(0, 0, 0, L, B, H)
    gmsh.model.occ.synchronize()
    gmsh.option.setNumber("Mesh.CharacteristicLengthMax", H_MESH)
    gmsh.option.setNumber("Mesh.CharacteristicLengthMin", H_MESH * 0.5)
    gmsh.model.mesh.generate(3)
    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    tag_to_index = {int(tag): index for index, tag in enumerate(node_tags)}
    vertices = [coords[i * 3 : i * 3 + 3] for i in range(len(node_tags))]
    _, tet_nodes = gmsh.model.mesh.getElementsByType(4)
    tets = [
        [tag_to_index[int(tag)] + 1 for tag in tet_nodes[i * 4 : i * 4 + 4]]
        for i in range(len(tet_nodes) // 4)
    ]
    _, tri_nodes = gmsh.model.mesh.getElementsByType(2)
    triangles = [
        [tag_to_index[int(tag)] + 1 for tag in tri_nodes[i * 3 : i * 3 + 3]]
        for i in range(len(tri_nodes) // 3)
    ]
    with open(path, "w", encoding="ascii") as handle:
        handle.write("MeshVersionFormatted 1\nDimension 3\n")
        handle.write(f"Vertices\n{len(vertices)}\n")
        for x, y, z in vertices:
            handle.write(f"{x:.9f} {y:.9f} {z:.9f} 0\n")
        handle.write(f"Tetrahedra\n{len(tets)}\n")
        for a, b, c, d in tets:
            handle.write(f"{a} {b} {c} {d} 0\n")
        handle.write(f"Triangles\n{len(triangles)}\n")
        for a, b, c in triangles:
            handle.write(f"{a} {b} {c} 0\n")
        handle.write("End\n")
    gmsh.finalize()


def write_problem(path: str, mesh_path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(
            f"""from sfepy.mechanics.matcoefs import stiffness_from_youngpoisson

filename_mesh = r"{mesh_path}"
regions = {{
    'Omega': 'all',
    'Fixed': ('vertices in (x < 0.001)', 'facet'),
    'Load': ('vertices in (x > {L - 0.001})', 'facet'),
}}
materials = {{
    'solid': ({{'D': stiffness_from_youngpoisson(3, {E}, {NU}),
                'traction': [[0.0], [0.0], [{-P / (B * H)}]]}},),
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
options = {{'output_dir': r"{os.path.dirname(path)}"}}
"""
        )


def solve() -> dict:
    os.makedirs(WORK, exist_ok=True)
    mesh_path = os.path.join(WORK, "beam.mesh")
    problem_path = os.path.join(WORK, "beam_problem.py")
    build_mesh(mesh_path)
    write_problem(problem_path, mesh_path)
    result = subprocess.run(
        [sys.executable, "-m", "sfepy.scripts.simple", problem_path, "--filename", "beam_result"],
        cwd=WORK,
        capture_output=True,
        text=True,
        timeout=240,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stdout + "\n" + result.stderr)
    vtk_path = os.path.join(WORK, "beam.vtk")
    mesh = meshio.read(vtk_path)
    u = mesh.point_data.get("u")
    if u is None:
        raise RuntimeError(f"no displacement field; point_data={list(mesh.point_data)}")
    x = mesh.points[:, 0]
    tip = x >= L - 1e-5
    tip_uz = float(u[tip, 2].mean())
    return {
        "nodes": int(len(mesh.points)),
        "tets": int(sum(len(cb.data) for cb in mesh.cells if cb.type == "tetra")),
        "tip_uz": tip_uz,
    }


def main() -> None:
    result = solve()
    I = B * H**3 / 12.0
    analytic = P * L**3 / (3.0 * E * I)
    error = abs(abs(result["tip_uz"]) - analytic) / analytic * 100.0
    print(
        json.dumps(
            {
                **result,
                "analytic_tip_mm": analytic,
                "error_percent": error,
                "passed": error <= 8.0,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
