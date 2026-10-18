# VISION

**AI-native CAD / CAE engineering studio.**

VISION turns a natural-language engineering request into a deterministic
NVIDIA USD BRep script, NURBS B-Rep geometry, a TetGen tetrahedral mesh, a SfePy
linear-elastic solve, and traceable evidence. There are **no built-in model
presets**.

> Intent → NVIDIA USD BRep → TetGen → SfePy → Evidence

---

## Architecture

| Layer | Implementation |
|---|---|
| UI | React 19, TypeScript, Vite, Three.js, Zustand |
| Agent | DeepSeek Chat Completions + native tool calling |
| CAD kernel | NVIDIA USD BRep 1.0.0 (NURBS B-Rep, Apache-2.0) |
| CAD worker | CPython 3.12 + `usd-brep` |
| Mesh | TetGen 0.8.4 (triangle PLC → C3D4 tetrahedra) |
| FEA | SfePy 2026.3, P1 tetrahedra, linear elasticity |
| Persistence | localStorage project library (`vision.project.library.v2`) |

The usd-brep wheel is published for **CPython 3.12 only**, so CAD scripts run in
an isolated worker. The HTTP backend and TetGen/SfePy run on Python 3.13.

```text
User prompt
  → DeepSeek run_usd_brep
  → NVIDIA USD BRep script
  → exact NURBS B-Rep
  → tessellated STL
  → TetGen C3D4 mesh
  → SfePy solve
  → nodal displacement / von Mises
  → Three.js result field
```

## Start

Requires Node.js ≥ 20.19, Python 3.13, and a separate Python 3.12 for the
usd-brep worker.

```bash
npm install
python -m pip install -r server/requirements.txt
```

Install the NVIDIA CAD worker:

```powershell
# CPython 3.12 is required by the usd-brep wheel
python -m pip install usd-brep==1.0.0
```

The default worker path is `.python312/python.exe`. Override it with
`VISION_USD_PYTHON` if your 3.12 interpreter lives elsewhere.

Terminal 1 — backend:

```bash
npm run backend
# http://127.0.0.1:8111
```

Terminal 2 — frontend:

```bash
npm run dev
# http://127.0.0.1:4173
```

Configure a DeepSeek API key in the UI or `.env`:

```env
DEEPSEEK_API_KEY=sk-...
```

Without a key there is no modeling fallback: the application deliberately has
no preset models.

## CAD script contract

A script must import `usd_brep` and assign a `Brep` to `result`:

```python
import usd_brep as u

body = u.create_box((0, 0, 0), 100, 20, 10)
hole = u.create_cylinder((30, 10, -1), 6, 12)
result = u.boolean_difference(body, hole)
```

Booleans consume their inputs; use `body.copy()` when a body is reused.
The worker tessellates `result` to STL and computes exact volume, area, bbox and
mass. Units are mm.

## What works

- blank project; no model seed data
- arbitrary NVIDIA USD BRep Python → NURBS B-Rep
- exact volume, area, bounding box and mass metrics
- STL viewport ingestion
- TetGen triangle-PLC → C3D4 volume mesh
- SfePy linear-elastic static solve
- nodal displacement and von Mises field
- face-based supports/loads (`x-min`, `x-max`, ...)
- analytic cantilever validation, live: currently **4.82%** error (8% limit)
- project persistence, DeepSeek streaming/tool-call loop, report export
- geometry edits update the **active project in place** unless the user
  explicitly requests a new project

## Validation

`POST /fea/validate` runs a 100 × 20 × 10 mm steel cantilever with P = 100 N and
compares the SfePy tip displacement against:

```text
delta = P L^3 / (3 E I)
```

Latest result: reference **0.095238 mm**, computed **0.088122 mm**, error
**4.82%**, 70,404 C3D4 elements → **PASS**.

## API

```text
GET  /health          kernel/package versions
POST /cad/execute     { script, density_kg_m3 } → metrics + STL
POST /fea/solve       { stlBase64, material, supports, loads, mesh_size }
POST /fea/validate    live cantilever benchmark
```

## Tests

```bash
npm test          # 4/4
npm run typecheck
npm run build
```

Browser regression:

```bash
node scripts/sfepy-mock-test.mjs
node scripts/same-project-test.mjs
```

## Limits

- Face selection is by axis-aligned bounding boxes, not interactive face picking.
- Isotropic linear elasticity only; no contact, bolt preload, composite layup,
  fatigue, buckling or CFD.
- TetGen consumes the tessellated USD BRep triangle PLC directly; thin walls
  and sharp edges require mesh refinement.
- SfePy P1 tetrahedra; peak stress is screening evidence, not certification.
- The backend executes arbitrary local Python and is bound to loopback only.

## Layout

```text
src/
  core/cad/          external model + STL transport
  core/fea/          result-field projection only
  services/          DeepSeek agent, engineering backend client, simulation
  state/             Zustand store and project persistence
  components/        workbench, viewport, panels, project center
  features/          lazy analysis workspace
server/
  engineering_server.py  HTTP endpoints
  usd_brep_worker.py     CPython 3.12 NVIDIA CAD worker
  fea_solver.py          TetGen + SfePy solve subprocess
  examples/              usd_brep examples
```
