# VISION

**AI-native CAD / CAE engineering studio.**

VISION turns a natural-language engineering request into a deterministic
build123d/OCCT script, exact B-Rep geometry, a Gmsh tetrahedral mesh, a SfePy
linear-elastic solve, and a traceable result. There are **no built-in model
presets**.

> Intent → build123d → OCCT B-Rep → Gmsh → SfePy → Evidence

---

## Architecture

| Layer | Implementation |
|---|---|
| UI | React 19, TypeScript, Vite, Three.js, Zustand |
| Agent | DeepSeek Chat Completions + native tool calling; local planner for material/load/analysis actions |
| CAD | build123d 0.11.1 + OCCT 7.9.3.1 (`cadquery-ocp-novtk`) |
| Mesh | Gmsh 4.15.2 |
| FEA | SfePy 2026.3, P1 tetrahedra, linear elasticity |
| Persistence | localStorage project library (`vision.project.library.v2`) |

The CAD/CAE backend runs as a local Python HTTP service. The browser only sends a
build123d script and engineering inputs; it never sends a fixed model id.

```text
User prompt
  → DeepSeek run_build123d
  → build123d script
  → OCCT STEP
  → Gmsh C3D4 mesh
  → SfePy solve
  → nodal displacement / von Mises
  → Three.js result field
```

## Start

Requires Node.js ≥ 20.19 and Python 3.10+.

```bash
npm install
python -m pip install -r server/requirements.txt
```

Terminal 1 — backend:

```bash
npm run backend
# http://127.0.0.1:8105
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

Without an API key there is no modeling fallback: the application deliberately
does not contain preset models.

## What works

- blank project; no model seed data
- arbitrary build123d Python → OCCT B-Rep
- exact volume, area, bounding box and mass metrics
- STL viewport ingestion
- Gmsh STEP → C3D4 mesh
- SfePy linear-elastic static solve
- nodal displacement and von Mises field
- face-based supports/loads (`x-min`, `x-max`, ...)
- analytic cantilever validation, live: currently **4.65%** error (8% limit)
- project persistence, DeepSeek streaming/tool-call loop, report export

## Validation

`POST /fea/validate` runs a 100 × 20 × 10 mm steel cantilever with P = 100 N and
compares the SfePy tip displacement against:

```text
delta = P L^3 / (3 E I)
```

Latest result: reference **0.095238 mm**, computed **0.099663 mm**, error
**4.65%**, 28,961 C3D4 elements → **PASS**.

## API

```text
GET  /health          backend/package versions
POST /cad/execute     { script, density_kg_m3 } → metrics + STL
POST /fea/solve       { script, material, supports, loads, mesh_size }
POST /fea/validate    live cantilever benchmark
```

The CAD script must assign its final shape to a top-level variable named
`result`.

## Tests

```bash
npm test          # 4/4
npm run typecheck
npm run build
```

## Limits

- No sketch constraints, NURBS/B-Rep feature history, fillets or assemblies in
  the UI yet; build123d itself supports them in the generated script.
- Face selection is by axis-aligned bounding boxes, not interactive face picking.
- Isotropic linear elasticity only; no contact, bolt preload, composite layup,
  fatigue, buckling or CFD.
- SfePy P1 tetrahedra; thin-wall and peak-stress results need mesh refinement.
- The backend executes arbitrary Python and is bound to loopback only. Do not
  expose it to untrusted users.

## Layout

```text
src/
  core/cad/          build123d/OCCT external model + STL transport
  core/fea/          result-field projection only
  services/          DeepSeek agent, engineering backend client, simulation
  state/             Zustand store and project persistence
  components/        workbench, viewport, panels, project center
  features/          lazy analysis workspace
server/
  engineering_server.py  HTTP endpoints
  fea_solver.py          Gmsh + SfePy solve subprocess
  fea_bench.py           standalone cantilever benchmark
```
