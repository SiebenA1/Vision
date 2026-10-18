# VISION local engineering backend

The backend is a **generic execution service**, not a model library. The caller
supplies an NVIDIA USD BRep script; the worker executes it, returns exact NURBS
B-Rep metrics and a tessellated STL. The same STL is tetrahedralized with TetGen
volume mesh for SfePy analysis. No wheel, blade, bracket or other model preset
is registered.

## Stack

| Layer | Package | License |
|---|---|---|
| CAD kernel | NVIDIA USD BRep 1.0.0 (`usd-brep`) | Apache-2.0 |
| CAD worker Python | CPython 3.12 | PSF |
| HTTP/FEA Python | CPython 3.13 | PSF |
| Mesh | TetGen 0.8.4 | AGPL-3.0 |
| FEM | SfePy 2026.3 | BSD-3-Clause |

The `usd-brep` wheel currently supports CPython 3.12 only. The HTTP service runs
on 3.13 and invokes `.python312/python.exe` for CAD scripts. Override the worker
interpreter with `VISION_USD_PYTHON`.

## Install

```powershell
# HTTP/FEA runtime (Python 3.13)
python -m pip install -r requirements.txt

# CAD worker (Python 3.12)
python -m pip install usd-brep==1.0.0
```

## Run

```powershell
$env:VISION_ENGINEERING_PORT='8111'
python server/engineering_server.py
```

Health:

```powershell
curl http://127.0.0.1:8111/health
```

Expected:

```json
{
  "ok": true,
  "cad_kernel": "NVIDIA USD BRep",
  "usd_brep": "1.0.0",
  "usd_python": "...\\.python312\\python.exe"
}
```

## CAD contract

The script must import `usd_brep` and assign a `Brep` to `result`:

```python
import usd_brep as u
body = u.create_box((0, 0, 0), 100, 20, 10)
hole = u.create_cylinder((30, 10, -1), 6, 12)
result = u.boolean_difference(body, hole)
```

Booleans consume their inputs. The worker tessellates the final Brep and writes a
binary STL. `POST /cad/execute` returns `vision.cad/2`, exact metrics and the STL
base64.

## FEA

`POST /fea/solve` accepts the STL base64, material, face supports/loads and mesh
size. It reads the triangle PLC directly in TetGen, creates
a C3D4 volume mesh, and runs SfePy linear elasticity.

`POST /fea/validate` runs the 3D cantilever benchmark against
`delta = PL^3 / (3EI)`. Current error: about **4.82%** at 70,404 C3D4 elements,
within the 8% tolerance. The benchmark is computed live.

## Security

Both workers execute arbitrary local Python with the current user's authority.
Bind to loopback only. This is a local engineering tool, not a sandbox.
