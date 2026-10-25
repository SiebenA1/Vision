# VISION

AI-native CAD / CAE engineering studio. Natural-language intent becomes editable NVIDIA USD BRep geometry, explicit engineering loads, and reproducible numerical evidence. No built-in model presets.

## Start

Node.js ≥ 20.19 and Python are required. On Windows, install project-local native runtimes once:

```powershell
npm install
python scripts/setup_native.py --fea
npm run dev
```

The setup installs USD BRep 1.0.0 in CPython 3.12 and TetGen / scikit-fem / SciPy in CPython 3.13 without changing system Python. `npm run dev` automatically checks and starts the local backend on loopback port 8111 before serving the UI on port 4173. An already-running healthy backend is reused; stopping Vite stops only a backend it started. The frontend fails if its port is occupied instead of silently switching ports. `npm run backend` remains available for independent backend operation.

Set `VISION_ENGINEERING_PORT` to use another managed local port. Set `VISION_ENGINEERING_URL` in the environment or `.env` to connect to an independently managed backend; this disables automatic startup. An unreachable backend returns a diagnostic JSON 503; the Agent stops the turn instead of repeatedly submitting CAD calls. Configure DeepSeek in the UI or with `DEEPSEEK_API_KEY` for conversational modeling. Manual USD import, script editing, and analysis do not require an AI key.

## Native modeling and analysis

- Runtime discovery of the installed public Python API: functions, classes, methods, enums and documentation. The Agent queries this same interface.
- Single solids, sheets, named multi-body results, scalar parameters, precise tessellation settings and incremental editing from original BRep artifacts.
- Immutable native BRep + USD + per-body STL + topology + source artifacts; USD and geometry-package import/export.
- Multiple supports and resultant loads; native trimmed BRep faces, box/sphere regions or bounding-box extreme faces; explicit analysis-body selection.
- TetGen tetrahedra → scikit-fem P1 elasticity → SciPy sparse solve, with actual residuals, reactions, force balance, energy and mesh evidence.
- Simplified workbench with advanced controls shown on demand, readable text, input provenance, stale-job rejection and undo.

```python
length = parameters.setdefault('length', 100)
result = {'base': u.create_box((0, 0, 0), length, 20, 10),
          'cap': u.create_cylinder((0, 40, 0), 10, 8)}
```

The worker supplies `u`, `parameters`, and imported `parts`. Final results must be Brep objects or a sequence/dictionary of Breps. Curves and surfaces are available for intermediate construction. Booleans can consume inputs; copy reused bodies.

See [the integration contract](docs/usd-brep-integration.md) for API coverage, source replay, topology lifetimes, cavity seeds and limitations; [architecture](docs/architecture.md) and [engineering method](docs/engineering-method.md) describe implementation and evidence.

See [the current core code map](docs/core-code-map.md) for the active workspace entry, backend responsibilities and legacy-code cleanup boundaries.

The [development plan](docs/development-plan.md) defines the roadmap. The
[development status](docs/development-status.md) distinguishes implemented v2
features from remaining acceptance work.

## New engineering workspace (development preview)

The current application uses the durable engineering core and a single desktop-style workspace:

```powershell
.python313/python.exe -m pip --disable-pip-version-check install -r backend/requirements.txt
npm run core
# In a second terminal:
npm run dev
```

Open `http://127.0.0.1:4173/`. This workspace persists project
revisions, native CAD/FEA jobs and artifacts in `.vision-workspace`. It includes
explicit study settings, requirements with source records, numerical assessment,
reports, semantic object bindings, version restoration and full project bundles.
It rejects stale writes and invalidated native face bindings. Closing the page
does not cancel a submitted job. See [core instructions](backend/README.md).

The header has **建模**, **CAE 仿真** and **解析校核** views with the same project
navigation, theme and assistant sidebar. CAE uses the current project's saved
material, supports, loads and mesh; the verification view provides independent
beam formulas and persistent production-solver checks, including mesh refinement
and same-grid Direct/CG comparison. See [current accuracy results](docs/cae-validation.md):
coarse P1 bending meshes can have large displacement errors despite tiny residuals.

The root URL is the only workbench entry. Saved `?workspace=v2` and former
prototype links resolve to this same application. The independent prototype
page has been removed. The sections below describe legacy v1 APIs unless stated
otherwise; legacy browser data can be explicitly imported using the workbench.

## HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /health` | Actual native import and package versions |
| `GET /cad/capabilities?q=&offset=0` | Paginated public API discovery |
| `POST /cad/execute` | Script, build options, source artifact → native artifact + preview |
| `POST /cad/import` | USD or geometry ZIP → native artifact |
| `GET /cad/artifacts/<id>/<file>` | Download USD, native geometry package and related files |
| `POST /fea/solve` | Artifact/body selection or legacy STL + material + regions + mesh size |
| `POST /fea/validate` | Live analytic cantilever comparison |

## Verification

```powershell
npm test
npm run build
npm run test:python
npm run test:measurements
npm run test:native
npm run test:backend
npm run test:core-ui
```

`test:core-ui` uses a disposable workspace and local Microsoft Edge to verify
project creation, real CAD, saved study settings, real FEA, reload and responsive
layout. It starts its own backend and Vite server on ports 8116 and 4177.
Python suites retain regression coverage for the durable core, conversation,
modeling recovery, memory, topology, artifact publication and solver contracts.
Set `VISION_TEST_NATIVE_CORE=1` to include the opt-in native lifecycle and solver
checks. No test command above calls a remote language model by default.

The native suite covers 13 CAD operation families, multi-body replay, parameters,
trimmed-face queries, axial elasticity, additive forces, enclosed cavities and a
flow-manifold static solve. Replayable examples live in `server/examples/`.
See [cleanup boundaries and retained checks](docs/project-cleanup.md).

## Boundaries

Current direct and CG numerical verification, installed runtime versions and
reproduction commands are recorded in [CAE validation](docs/cae-validation.md).

Public API access does not mean every input or every API combination is validated. Current physics is homogeneous isotropic linear static elasticity with solid tetrahedra. Sheets are modeled and displayed but cannot use shell analysis. There is no assembly mating, automatic contact/bonding, plasticity, fatigue, buckling, modal analysis or CFD. Native face references must be rebound after geometry changes. Package export contains geometry artifacts; export project JSON separately for current application settings.

The durable core persists projects, jobs, results and conversations in `.vision-workspace`; browser editor drafts remain local. Cancellation and recovery are managed by the core controller. Native workers execute local Python with the user's authority; services must remain bound to loopback.
