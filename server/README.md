# Local engineering backend

Run from the repository root:

```powershell
python scripts/setup_native.py --fea
npm run backend
```

The HTTP process uses project-local Python 3.13, TetGen 0.8.4, scikit-fem 12 and SciPy. A separate Python 3.12 worker imports USD BRep 1.0.0; set `VISION_USD_PYTHON` to override the CAD interpreter. `VISION_ENGINEERING_PORT` overrides port 8111.

`engineering_server.py` owns the HTTP contract; `usd_brep_worker.py` owns native modeling, API discovery and trimmed-face queries; `cad_artifacts.py` stores immutable geometry; `fea_contract.py` validates studies; `fea_solver.py` meshes and solves using scikit-fem.

The complete modeling, artifact, region, cavity, setup and endpoint contracts are documented in [USD BRep integration](../docs/usd-brep-integration.md). Public Python modeling APIs are callable from scripts; final output supports Brep, a Brep sequence or named Brep dictionary. Numerical analysis supports multiple fixed regions and multiple resultant loads with a common isotropic material.

```powershell
.python313/python.exe scripts/test_native_engineering.py
python -m unittest discover -s tests -p "test_*.py"
```

The numerical regression executes real CAD and FEM. API discovery and successful geometry generation do not certify arbitrary engineering designs. There is no implicit bonding, contact, shell, nonlinear or fluid solver. Workers execute arbitrary local Python: this is a local execution service, not a sandbox. Bind to loopback only.
