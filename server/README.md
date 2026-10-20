# Local engineering backend

Run from the repository root:

```powershell
python scripts/setup_native.py --fea
npm run backend
```

The HTTP process uses project-local Python 3.13, TetGen 0.8.4, scikit-fem 12 and SciPy. A separate Python 3.12 worker imports USD BRep 1.0.0; set `VISION_USD_PYTHON` to override the CAD interpreter. `VISION_ENGINEERING_PORT` overrides port 8111.

The volume mesh defaults to a 1,000,000-element admission limit. To change it, stop the existing backend and launch a new one from a terminal with a positive integer environment value:

```powershell
$env:VISION_FEA_MAX_ELEMENTS='3000000'
npm run backend
```

This raises the example limit to 3,000,000 tetrahedra. Alternatively, persist a local default in the Git-ignored `server/fea_settings.local.json`:

```json
{ "max_elements": 3500000 }
```

The environment overrides this file; without either setting the default is one million. Each solve snapshots the effective limit into its request JSON and passes it explicitly to the worker. `/health` and the startup log report the effective limit; `/health` also identifies the serving process. Worker errors use UTF-8 JSON, with tracebacks retained in UTF-8 logs.

Changing the limit does not change mesh size, the TetGen Steiner-point budget, or the solve timeout. The check occurs after TetGen returns, so it is not a mesher memory cap. Higher limits increase memory and runtime requirements. An already-running backend reused by Vite retains its original environment until restarted.

`engineering_server.py` owns the HTTP contract; `usd_brep_worker.py` owns native modeling, API discovery and trimmed-face queries; `cad_artifacts.py` stores immutable geometry; `fea_contract.py` validates studies; `fea_solver.py` meshes and solves using scikit-fem.

The complete modeling, artifact, region, cavity, setup and endpoint contracts are documented in [USD BRep integration](../docs/usd-brep-integration.md). Public Python modeling APIs are callable from scripts; final output supports Brep, a Brep sequence or named Brep dictionary. Numerical analysis supports multiple fixed regions and multiple resultant loads with a common isotropic material.

```powershell
.python313/python.exe scripts/test_native_engineering.py
python -m unittest discover -s tests -p "test_*.py"
```

The numerical regression executes real CAD and FEM. API discovery and successful geometry generation do not certify arbitrary engineering designs. There is no implicit bonding, contact, shell, nonlinear or fluid solver. Workers execute arbitrary local Python: this is a local execution service, not a sandbox. Bind to loopback only.
# 工程记忆

本地 `/memory/*` 接口使用标准库 SQLite，默认持久化至 `server/.agent_memory/memory.sqlite3`（Git 忽略），可设置 `VISION_MEMORY_DB`。`/health` 的 `memory_schema` 应为 `vision.memory/1`。数据库保存在本地磁盘；不要放到网络共享盘。

接口包括 `context`、`event`、`intent`、`remember`、`search`、`source`、`list`、`change`、`checkpoint`、`export`，均采用 POST 和工程不可变快照作用域。记忆在 agent 内部运行，无前端管理界面；区分用户原话、agent 任务理解与有效执行结果，不接受 LLM 自报的实测记录。参见 [实施说明](../docs/agent-memory-implementation.md) 与 `npm run test:agent-memory`。
