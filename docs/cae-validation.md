# CAE current-version validation

## 2026-10-24: production-worker verification and unified UI

The root workspace now includes **CAE 仿真** and **解析校核** alongside modeling.
The former configures and solves the current project. The latter calculates
independent rectangular beam/bar references and runs durable solver checks.
These operations have different meanings: a reference or benchmark does not
certify the current CAD part.

The extended check was submitted from the actual UI and completed as run
`14398a8b61ef4efdb00054b04b3a73c7`. The persisted report is in SQLite
`verification_runs`; a delivery copy is `screenshots/solver-check-20261024.json`.
The controller-owned worker calls production `fea_solver._solve_impl`, uses the
same pinned-package loading procedure as `native.py`, and verifies package
versions and source identity before/after execution. The legacy solver adds
Windows Store fallback paths; these are restored away after import, exactly as
in the production worker. This prevents the benchmark silently using system
NumPy/SciPy rather than the admitted project-local packages.

Inputs: rectangular 100 × 20 × 10 mm beam, E=210000 MPa, density=7850 kg/m³,
100 N total force, fixed X-min face. Poisson ratio is 0.3 except the exact axial
patch, where it is 0. Reference axial displacement is 0.000238095238 mm;
Euler–Bernoulli bending reference is 0.095238095238 mm. Axial stress is 0.5 MPa,
nominal bending stress 30 MPa, and mass 0.157 kg.

Unlike the older table below, the comparison measures the **free-end face's
area-weighted mean displacement component**, Ux for axial and |Uz| for bending.
The report separately retains maximum vector displacement. Different error
values between these tables are expected because the measurements differ.

| Case | Mesh / mm | Reference error | Relative residual | Force balance error | Meaning |
| --- | --- | --- | --- | --- | --- |
| Axial Direct | 4 | 0.913799% | 4.81e-14 | 2.04e-15 | passes 2% screening |
| Axial patch, ν=0 | 4 | 0.0000011% | 3.94e-14 | 1.05e-15 | passes 1e-6 relative threshold |
| Bending | 4 | **52.802120%** | 8.47e-12 | 3.75e-13 | coarse-grid diagnostic, fails 8% |
| Bending | 2 | **19.197928%** | 5.28e-11 | 8.68e-12 | coarse-grid diagnostic, fails 8% |
| Bending | 1 | 5.958007% | 2.38e-10 | 1.39e-11 | passes 8% screening |
| Axial auto-CG | 0.6 | 1.209497% | 9.51e-9 | 8.44e-10 | 166316 elements / 92931 DOFs, passes 2% |
| Bending | 0.8 | 5.097671% | 3.34e-10 | 2.55e-11 | passes 8% screening |

The axial patch additionally compares the entire displacement vector to
u=(F(x−xmin)/(EA),0,0), all recovered nodal von Mises values to 0.5 MPa, and
strain energy to Fδ/2. Relative errors were 2.27e-8, 0, and 9.76e-15 respectively.
This validates uniform stress recovery, not singular or arbitrary local stresses.

For Direct/CG, the actual first TetGen mesh is archived and replayed, with
identical nodes and boundary triangles. Relative differences: displacement
7.1809989e-9, stress 9.3740428e-9, energy 6.3339005e-13; CG residual 8.9727316e-9.
Mesh archive SHA256:
`6d959c6d410a7e4b9fcfed60ce90b284d3254f2b45cc88ad2d59604b3f02d053`.

The aggregate screening result passed. The coarse bending failures remain
visible and are explicitly diagnostic, rather than hidden or reported as passes.
The screening tolerances are declared software regression criteria; they are
not structural design acceptance limits. Small residuals establish algebraic
solution quality, not spatial discretization accuracy. Refinement here improves
displacement accuracy, but does not prove stress convergence. Fixed support
singularities, shear/3D effects versus beam assumptions, geometry-specific
boundary conditions and mesh quality still require project-specific checks.

Confirmed pinned runtime: NumPy 2.2.6, SciPy 1.15.3, scikit-fem 12.0.2, TetGen
0.8.4, CAD USD BRep 1.0.0. No numerical solver algorithm was changed in this batch.
Backend regression: 90 tests passed with native CAD/FEA enabled. Frontend: 56
tests passed. The new tests cover analytic units, invalid inputs, queue
idempotency, cancellation/recovery, project isolation, report conclusion
recomputation, stale environment rejection, LLM tool distinctions, and a real
standard suite with durable report recovery.

Primary implementation references:
[SciPy CG](https://docs.scipy.org/doc/scipy/reference/generated/scipy.sparse.linalg.cg.html),
[scikit-fem 3D elasticity example](https://github.com/kinnala/scikit-fem/blob/master/docs/examples/ex11.py).

## Earlier maximum-displacement checks

Verified on 2026-10-23 on Windows 11 x64. These are executions of the current
solver, rather than historical measurements from before the batched assembly
and CG changes. Solver implementation was not changed during verification.

## Local environment

The repository now has project-local CPython 3.13.2 in `.python313`:

| Dependency | Installed version |
| --- | --- |
| NumPy | 2.2.6 |
| SciPy | 1.15.3 |
| scikit-fem | 12.0.2 |
| TetGen | 0.8.4 |

CAD continues to use `.python312` and USD BRep 1.0.0. No system Python was
replaced. `pip check` passed. The setup script disables pip's unrelated version
check, which had left installation waiting after reporting successful installs.
The official runtime and pinned numerical wheels were installed using the
existing setup implementation, including its PyPI wheel SHA-256 checks.

## Numerical results

`scripts/test_native_engineering.py` passed all 13 CAD operation families,
native replay and selection checks, and all existing FEA cases: axial analytic
comparison, additive loads, native-face equivalence, enclosed cavity volume and
the complex flow manifold. The cavity retained 7,000 mm³ of material; the
76,955-element manifold had a relative force-balance error of 1.3863e-9.

`scripts/validate_fea.py` additionally checks the actual algorithm selected by
the current worker and records the following results:

| Case | Elements / DOFs | Algorithm | Analytic displacement error | Relative residual | Relative force-balance error |
| --- | --- | --- | --- | --- | --- |
| Axial, h=4 mm | 587 / 630 | Direct | 0.575% | 4.8052e-14 | 2.0356e-15 |
| Axial, h=0.6 mm | 166,316 / 92,931 | CG / Jacobi, 2,155 iterations | 1.099% | 9.5074e-9 | 8.4388e-10 |
| Cantilever, h=0.8 mm | 70,404 / 41,145 | Direct | 4.815% | 3.3386e-10 | 2.5537e-11 |

All three returned finite positive strain energy and the expected 20,000 mm³
volume. Axial comparisons use PL/(EA) with a 2% screening tolerance; bending
uses PL³/(3EI) with the existing 8% screening tolerance. The CG case crosses
both the 60,000-DOF switch and multiple 32,768-element assembly batches.

Machine-readable evidence is saved locally at
`server/.fea_runs/current-version-validation.json`, including library versions,
source SHA-256 values, iteration counts, numerical evidence and timing. It is
ignored by Git together with individual worker request/response/log files.
The tested `fea_solver.py` SHA-256 is
`3f37c4987091fefb2e3b47fb849b0e1c05af04d55ea5c3082d33e0491ecf4668`.

## Application integration

`npm run test:native-ui` (historical v1 script, since retired) passed with a real loopback backend and headless Edge:
native face selection, two resultant loads, actual FEM results, recalculation
state, annotations and readable layouts at 1440, 1024 and 600 px. No page
JavaScript errors were reported. The initial sandboxed launch failed before
health readiness; the permitted local-runtime launch passed.

`npm run test:backend` also passed: Vite automatically starts its local backend,
stops only its owned process, reuses an existing backend, and returns diagnostic
JSON 503 when that backend stops.

## Reproduce

```powershell
.python312/python.exe scripts/setup_native.py --fea
.python313/python.exe -m pip --disable-pip-version-check check
.python313/python.exe scripts/test_native_engineering.py
.python313/python.exe scripts/validate_fea.py
npm run test:core-ui
npm run test:backend
```

## Limits

This verifies the listed cases and current direct/CG paths, including batched
basis construction and compact mesh-boundary extraction. It does not establish
arbitrary-model convergence, local stress accuracy, million-element capacity,
peak-memory bounds or nonlinear/contact/multiphysics capability. The two axial
meshes do not establish mesh independence: their maximum displacement errors
are not monotonically decreasing. These checks are not a same-mesh
direct-versus-CG comparison. The 600-second timeout and admission failure
behavior have not been deliberately triggered by this run.

## 2026-10-24：同网格对照与弯曲细化

新增 `scripts/validate_same_grid.py`，直接调用同一套生产组装与边界处理，首轮归档 TetGen 网格，次轮从归档读取，分别强制直接法和 CG/Jacobi；不通过重新生成两个网格代替同网格对照。生产入口仍按原 DOF 阈值自动选择算法。

实测归档网格为 210 节点、587 四面体，CG 277 次迭代：

| 比较项 | 相对差异 |
| --- | ---: |
| 完整位移向量 L2 | 7.1809989e-9 |
| 完整节点平均 von Mises 向量 L2 | 9.3740428e-9 |
| 应变能 | 6.3339005e-13 |

直接法相对残差 4.80516e-14，CG 相对残差 8.97273e-9。两次求解位置与边界三角形索引完全一致。网格归档及 SHA 保存在 [验证记录](../screenshots/fea-same-grid-20261024T011505.json)，对应 `.npz` 位于同目录。

同一悬臂梁在横向 100 N 合力下，对 Euler–Bernoulli 端位移参考值 0.0952380952 mm 做三档细化：

| 网格尺寸 / mm | 四面体数 | 最大位移 / mm | 相对参考误差 |
| --- | ---: | ---: | ---: |
| 4 | 587 | 0.0451538894 | 52.5884% |
| 2 | 4,488 | 0.0771795060 | 18.9615% |
| 1 | 35,851 | 0.0898268874 | 5.6818% |

这说明该算例的位移随细化趋近参考，也表明粗网格可能严重偏硬；不能把轴向梁的约 0.70% 误差套用于弯曲。尚未证明网格无关、局部应力收敛或任意几何准确性。表中的峰值节点平均应力仍随细化变化，固定端局部峰值不作为收敛认证。

```powershell
.python313/python.exe scripts/validate_same_grid.py
```
