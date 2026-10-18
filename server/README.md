# VISION local engineering backend

This is the local open-source CAD/CAE backend. It is a **generic
execution service**, not a model library. The caller supplies a build123d
script; the backend runs OCCT, returns exact B-Rep metrics and an STL for the
viewport. No wheel, blade, bracket or other model is registered as a preset.

## Stack

| Layer | Package | License |
|---|---|---|
| B-Rep CAD | build123d 0.11.1 + OCCT 7.9.3.1 (`cadquery-ocp-novtk`) | Apache-2.0 / LGPL-2.1 with OCCT exception |
| Mesh preflight | Gmsh 4.15.2 Python | GPL-2.0-or-later |
| FEM | SfePy 2026.3 + Gmsh 4.15.2 | BSD-3-Clause / GPL-2.0-or-later |

The Docker toolchain selected earlier is the intended production deployment, but
the Docker daemon is unavailable in the current environment. This native backend
is the verified local equivalent.

## Install and run

```bash
python -m pip install -r server/requirements.txt
python server/engineering_server.py
```

Default endpoint: `http://127.0.0.1:8105`. Override with
`VISION_ENGINEERING_HOST` / `VISION_ENGINEERING_PORT`.

```bash
curl http://127.0.0.1:8105/health
```

## Execute a CAD script

```bash
curl -s http://127.0.0.1:8105/cad/execute \
  -H 'content-type: application/json' \
  -d '{"script":"from build123d import *\nresult = Box(20, 30, 40)","density_kg_m3":2700}'
```

The script must assign its final `Part`, `Solid`, `Compound` or `BuildPart` to a
top-level variable named `result`. The response contains:

- `metrics.volume_mm3`, `area_mm2`, `bbox_mm`, `center_mm`, optional `mass_kg`;
- `stlBase64` for the viewer/FEA voxelizer.

`server/examples/wheel_rim.py` is a 9-spoke wheel **example script**, not a
backend preset. It is executed exactly like any user/LLM-generated script.

## Security

The endpoint executes arbitrary Python with the current user's authority. Bind
it to loopback only. Do not expose it to untrusted callers or mount secrets into
the process. A container boundary is the next step for multi-user deployments.

## Migration status

The frontend now calls the native CAD and FEA backend. src/core/fea retains
only field projection; the previous C3D8/PCG solver, mesher, worker and client
have been removed. Remaining limitations are face selection by axis-aligned
bounding boxes, isotropic materials, and no contact/fatigue/composite layups.

## FEA backend

The local backend also exposes `POST /fea/solve` and `POST /fea/validate`.

`/fea/solve` accepts a build123d script, material properties, face-based supports,
face/vector loads and a mesh size. It runs:

```text
build123d -> STEP -> Gmsh C3D4 mesh -> SfePy linear elasticity
```

The response contains nodal positions, displacement, von Mises and extrema.

`/fea/validate` runs the 3D cantilever benchmark against
`delta = PL^3 / (3EI)`. The current measured error is about 7.2% at h = 1.5 mm,
within the 8% tolerance. This is a live benchmark, not a hard-coded number.
