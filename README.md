# VISION

AI-native CAD / CAE engineering studio. Natural-language intent becomes editable NVIDIA USD BRep geometry, explicit engineering loads, and reproducible numerical evidence. No built-in model presets.

## Start

On Windows x64, install Node.js ≥ 20.19 and Python 3, then run the standalone launcher from the repository:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1
```

The launcher checks and reuses existing frontend, v2 and native dependencies, including installations made before this launcher existed. Missing dependencies are installed; USD BRep 1.0.0 uses project-local CPython 3.12 and TetGen / scikit-fem / SciPy use CPython 3.13. A successful existing-environment check records configuration hashes without reinstalling. Later launches install only if dependencies are missing, the recorded dependency configuration changes, or `-Reinstall` is supplied. Installation requires network access. It creates `.env` from `.env.example` only if absent and never replaces an existing `.env`. Use `-SetupOnly` to configure without starting, `-CheckOnly` to verify without installing or starting, or `-Reinstall` to rerun dependency setup. Optional local semantic-memory models are configured separately with `scripts/setup_memory.py`.

`npm run dev` automatically starts or reuses the v2 core on loopback port 8112, then serves the UI on port 4173. Stopping Vite stops only a core it started. `npm run preview` uses the same lifecycle. Set `VISION_CORE_PORT` for another managed port or `VISION_CORE_WORKSPACE` for another data directory (default `.vision-workspace`). Set `VISION_CORE_URL` in the environment or `.env` for an independently managed core; this disables automatic startup. An unreachable core returns a diagnostic JSON 503. `npm run core` remains available for independent v2 operation. The unused legacy engineering, DeepSeek and model-status proxies have been removed; `npm run backend` is retained only for direct legacy API debugging. Set `DEEPSEEK_API_KEY` for AI conversation; manual modeling and analysis do not require it.

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

See [the current Mermaid architecture atlas](docs/architecture-current.md) for the implemented v2 architecture, Agent–LLM interaction, context and engineering data flows, task/turn/job state machines, and persistence relationships.

The [development plan](docs/development-plan.md) defines the roadmap. The
[development status](docs/development-status.md) distinguishes implemented v2
features from remaining acceptance work.

## New engineering workspace (development preview)

The current application uses the durable engineering core and a single desktop-style workspace:

```powershell
.python313/python.exe -m pip --disable-pip-version-check install -r backend/requirements.txt
npm run dev
```

Vite automatically starts or reuses the v2 core; no second terminal is required. Open `http://127.0.0.1:4173/`. This workspace persists project
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
