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
python -m unittest discover -s tests -p "test_*.py"
.python313/python.exe scripts/test_native_engineering.py
npm run test:native-ui
npm run test:backend
```

The real native suite covers 13 CAD operation families, multi-body replay, parameters, trimmed-face queries, axial elasticity, additive forces, enclosed cavities and a flow-manifold static solve. The native browser suite requires local Microsoft Edge; it starts its own loopback backend and Vite server on ports 8115 and 4175. It verifies native face selection, multiple loads, real FEM results, annotations and readable layouts at three widths. The [twisted blade](server/examples/twisted_blade_usd.py) and [flow manifold](server/examples/flow_manifold_usd.py) are replayable engineering examples, not certified designs or default presets.

## Boundaries

Public API access does not mean every input or every API combination is validated. Current physics is homogeneous isotropic linear static elasticity with solid tetrahedra. Sheets are modeled and displayed but cannot use shell analysis. There is no assembly mating, automatic contact/bonding, plasticity, fatigue, buckling, modal analysis or CFD. Native face references must be rebound after geometry changes. Package export contains geometry artifacts; export project JSON separately for current application settings.

Large previews are restored from backend artifacts rather than localStorage. Results and chat are not persisted. Client cancellation discards late responses but does not kill server jobs. The backend executes local Python with the user's authority and must remain bound to loopback.
