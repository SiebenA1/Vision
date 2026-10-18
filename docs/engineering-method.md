# Engineering Method & Verification Notes

This document defines the assumptions and numerical methods behind the current VISION prototype. It is deliberately explicit about what is and is not engineering evidence.

## 1. Units and conventions

| Quantity | Unit |
|---|---|
| length | mm |
| force | N |
| stress / modulus | MPa = N/mm² |
| density | kg/m³ |
| mass | kg |
| energy | mJ = N·mm |
| displacement | mm |

- Global axes: X = arm span, Y = bracket width, Z = vertical (Z-up).
- The back plate is at `x = 0`; the arm extends toward `+X`.
- The support face in the example is `x-min` (back face), 6 DOF fixed.
- The load is a downward (`-Z`) resultant on the outer `x-max` node band.

## 2. Materials

`MaterialSpec` fields:

```text
E        Young's modulus (MPa)
nu       Poisson ratio
rho      density (kg/m³)
yield    yield strength (MPa)
ultimate ultimate strength (MPa)
alpha    coefficient of thermal expansion (1/K)
```

Current materials: AL 6061-T6, AL 7075-T6, AISI 4340, Ti-6Al-4V, PA12-GF. Values are nominal room-temperature isotropic data for preliminary sizing, not certified allowables. PA12-GF is marked as an equivalent isotropic model.

Mass is always computed from exact CAD volume:

```text
m = V_CAD [mm³] × 1e-9 × ρ [kg/m³]
```

## 3. Geometry

The example is a parameterised bracket with rounded plate contours and robust mesh booleans. The CAD volume is read from Manifold; it is not inferred from the voxel mesh. The geometry hash is derived from all variable values:

```text
hash = FNV1a("key:value|...")
```

The result is marked stale when the current geometry hash differs from the result hash.

## 4. FE discretisation

### 4.1 Element

8-node trilinear hexahedron (C3D8), full 2×2×2 Gauss integration.

Natural node order:

```text
0 (-1,-1,-1)   1 (+1,-1,-1)   2 (+1,+1,-1)   3 (-1,+1,-1)
4 (-1,-1,+1)   5 (+1,-1,+1)   6 (+1,+1,+1)   7 (-1,+1,+1)
```

Shape functions:

```text
N_i(ξ,η,ζ) = 1/8 (1 + ξ_i ξ)(1 + η_i η)(1 + ζ_i ζ)
```

Physical gradients:

```text
∂N/∂x = J^-T ∂N/∂ξ
```

with the 3×3 Jacobian evaluated at each Gauss point.

### 4.2 Constitutive matrix

Isotropic linear elasticity:

```text
λ = Eν / ((1+ν)(1−2ν))
μ = E / (2(1+ν))
```

Voigt order: `[xx, yy, zz, xy, yz, zx]`; engineering shear strains. The shear diagonal of D is μ.

### 4.3 Element stiffness

```text
K_e = Σ_gp Bᵀ D B det(J_gp)
```

For the uniform cubical grid, `K_e` is computed once at `h` and reused. Element connectivity and DOF maps are precomputed.

### 4.4 Mesh policy

- Fixed `h = 3.0 mm` for the current study (avoids h changes between optimization candidates).
- A node is inside with odd ray parity against a watertight triangle soup.
- Conservative element inclusion: retain only if all eight corners are inside.
- Largest connected component retained; isolated voxel islands removed.
- Load distributed on an outer band of 2.2 cells.
- Active face extent, not CAD bounding box, is used for BC node selection. This prevents empty load sets when a tangent tip is under-cut by voxelisation.

### 4.5 Discretisation error

Because the CAD boundary is curved/slanted and voxels are axis-aligned, the discrete volume is smaller than the CAD volume. Current example:

```text
V_CAD     ≈ 200.1 cm³
V_voxel   ≈ 0.72 × V_CAD
ΔV        ≈ 28%
```

The UI/report emits a warning. This is a **real limitation**. It affects local stress and compliance; the result is a screening-level estimate, not a certified stress report.

The `h-convergence` action reruns the solve at `0.72 h` and reports the relative change in maximum displacement. Do not ignore a large delta.

## 5. Boundary conditions

### Support

Selected face `x-min`: all active nodes within tolerance of the active minimum x. All three translational DOFs fixed. This idealises a bolted/welded back plate as a rigid foundation.

### Load

Resultant `F = 600 N` downward on the `x-max` face. Nodes in the outer band receive equal shares:

```text
f_node = F / N_band
```

The outer-band distribution is a deliberate stabilisation; it is not a bolt or pin contact model. The load face is identified on the discrete active domain, so a coarse boundary cannot silently produce zero load nodes.

## 6. Solution and checks

### PCG

Matrix-free Jacobi-preconditioned conjugate gradient.

Convergence:

```text
||r|| / ||f|| ≤ 1e-4
```

The residual norm can temporarily increase on ill-conditioned meshes; convergence is judged by the final relative residual. Iteration cap is 2,400.

### Equilibrium

At fixed DOFs:

```text
R = K u
R_total = Σ_fixed R
residual = F_applied + R_total
relative_error = ||residual|| / ||F_applied||
```

The sign convention is physical support reaction. Current example equilibrium error is ~2e-5.

### Stress

Element-centroid stress:

```text
ε = B u_e
σ = D ε
σ_vm = sqrt(1/2[(σx−σy)² + (σy−σz)² + (σz−σx)²] + 3(τxy² + τyz² + τzx²))
```

Nodal values are arithmetic averages of adjacent element-centroid values for display. The maximum used for SF is the maximum element-centroid value, not a smoothed display value.

### Safety factor

```text
SF = σ_yield / max(σ_vm, ε)
```

SF is a yield initiation indicator only. It is not a fatigue, buckling, fracture or joint failure criterion.

## 7. Solver verification

Analytic cantilever:

```text
L = 100 mm, b = 20 mm, h = 10 mm, P = 100 N, E = 210,000 MPa, ν = 0.3
I = b h³ / 12
δ_tip = P L³ / (3 E I)
```

Current run:

```text
analytic  = 0.09524 mm
computed  = 0.09162 mm
error     = 3.80%
tolerance = 8%
status    = PASS
```

This benchmark uses a structured beam mesh and the same solver path, so it catches assembly, BC, PCG and recovery bugs. It does not validate the voxel boundary approximation.

## 8. Optimization method

Objective:

```text
minimize m_CAD(x)
subject to SF(x) ≥ SF_target
           δmax(x) ≤ δ_limit
           x_min ≤ x ≤ x_max
```

Algorithm:

1. Evaluate baseline and six boundary/quantile values with up to 3 Worker clients.
2. Compute exact CAD mass per candidate.
3. Retain feasible candidates.
4. Refine between the lightest feasible value and its lower (infeasible) neighbor at 65% and 88%.
5. Sort feasible candidates by mass; verify up to 3 at the same fixed h.
6. On verification failure, fall back to the next candidate.
7. Report all candidates, including rejects and failed runs.

Limitations:

- Single variable per run.
- No gradient, no global optimum guarantee.
- Candidate set depends on quantiles and the lower/upper bracket.
- Mesh topology still changes with geometry, so SF is non-smooth; fixed h reduces but does not eliminate this.
- Verification uses the same fixed h, not a fully converged mesh.

## 9. AI agent boundary

VISION supports two planners:

- **DeepSeek** (`deepseek-flash` / `deepseek-v4-pro`) with streaming tool calls and optional thinking mode.
- **Local deterministic planner** as a fallback.

The LLM is not part of the numerical method. It may:

- choose a registered engineering tool and supply parameters;
- request a solver run;
- summarize tool results;
- propose a next action.

It may not:

- invent stress, displacement, SF, mass, mesh or validation values;
- bypass tool validation;
- alter the solver, mesh policy or material definitions;
- write arbitrary files or execute arbitrary code;
- claim an optimization result before the async search completes.

Every numerical value in a final answer must originate from a `tool` message containing the current solver result. Tool result JSON includes the model state and result provenance so the model can reason about staleness.

DeepSeek thinking `reasoning_content` is displayed in a collapsible block for transparency, but it is **not** engineering evidence. It is model reasoning and may be wrong. The signed report is generated only from the solver result, not from the chat transcript.

If the LLM is unavailable or returns an error, the local planner executes the same validated tools. If both fail, the error is preserved in the conversation and the model state is not mutated beyond successful tool calls.

Security: the browser calls a local same-origin gateway; the upstream target is fixed; server-side keys never reach the browser. See [architecture.md](architecture.md#9-deepseek-integration).

## 10. Report contents

`src/core/report/report.ts` emits:

- project identity, revision, units, timestamp;
- material and load case;
- full parameter table;
- mesh/solver details and convergence;
- equilibrium table;
- maxima and locations;
- validation benchmark;
- automatic warnings;
- limitations;
- model hash, run ID and signature lines.

The report is only generated from the current in-memory result. If the model hash does not match the geometry hash, the UI marks the result stale and the agent re-solves before exporting.

## 11. How to reproduce

```bash
npm test
```

Tests cover:

- watertight geometry and positive volume;
- volume change after a parameter edit;
- analytic cantilever validation;
- bracket solve with equilibrium check;
- Chinese/English planning.

Browser verification scripts under `scripts/` are optional and use a locally installed Edge via Playwright Core. They are not part of the runtime and are not required to use the app.

## 12. Engineering sign-off checklist

Before using a result for anything beyond a demo:

- [ ] Confirm `h` convergence (run `h 收敛校核`; delta should be small and documented).
- [ ] Inspect volume discrepancy warning; if > ~10%, refine or use a conformal mesh.
- [ ] Check load introduction band and support idealisation against the real joint.
- [ ] Verify yield allowable and temperature; consider fatigue, buckling, bearing, bolt tear-out.
- [ ] Confirm material certificate and lot-specific properties.
- [ ] Add test correlation and safety factors per the applicable standard.
- [ ] Have a qualified engineer review and sign the report.

The current prototype cannot replace this checklist.
