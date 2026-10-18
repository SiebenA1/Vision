# Architecture

## 1. Design position

VISION treats language as an **intent layer**, not as an authoritative geometry kernel or solver. Every sentence is compiled into a typed `AgentAction`. The executor validates units and writes to a single model document. The model document is the source of truth; geometry, mesh, results and reports are derived artifacts with fingerprints.

This separation is deliberate:

- Language is probabilistic and might be replaced by an LLM.
- Geometry and FEA must remain deterministic and reproducible.
- A result must be invalidatable when its input model changes.
- UI components can be loaded and disposed independently.

## 2. Runtime layers

```text
┌────────────────────────────────────────────────────────────┐
│ Presentation                                               │
│ React 19 · Vite 8 · Three.js · CSS2D · custom design system│
│ lazy: AnalysisWorkspace, OptimizationWorkspace, report     │
└──────────────────────────────┬─────────────────────────────┘
                               │ Zustand selectors / actions
┌──────────────────────────────▼─────────────────────────────┐
│ Application state                                          │
│ ModelDocument · history/future · geometry/result provenance│
│ chat · overlays · view mode · optimization state          │
└──────────────┬─────────────────────────────┬───────────────┘
               │                             │
┌──────────────▼─────────────┐  ┌────────────▼───────────────┐
│ Geometry pipeline          │  │ Agent pipeline             │
│ Manifold WASM              │  │ NLU → AgentPlan            │
│ feature evaluator          │  │ typed tools → executor     │
│ watertight mesh + metrics  │  │ explanations / report      │
└──────────────┬─────────────┘  └────────────┬───────────────┘
               │ triangle soup               │ runStudy()
┌──────────────▼─────────────────────────────▼───────────────┐
│ FEA Worker                                                 │
│ conservative voxel C3D8 · connectivity · BCs · PCG         │
│ stress recovery · equilibrium · validation                 │
└──────────────┬─────────────────────────────────────────────┘
               │ AnalysisResult
┌──────────────▼─────────────────────────────────────────────┐
│ Evidence layer                                             │
│ field projection · result cards · convergence · report      │
└────────────────────────────────────────────────────────────┘
```

## 3. Model document

`src/core/types.ts` defines the persisted contract:

- `ModelDocument` contains schema, identity, units, material, design variables, feature descriptors, supports, loads, mesh settings, metadata.
- `DesignVariable` stores bounds, step, group, role. It is both UI metadata and optimization design space.
- `AnalysisResult` stores mesh statistics, solver statistics, equilibrium, field arrays, warnings, provenance hash.
- `ValidationResult` stores an analytic benchmark.
- `OptimizationResult` stores candidate set, baseline, recommended design, convergence/verification state.

The model has a stable `schema: 'vision.model/1'`. The feature descriptors are intentionally declarative: `buildGeometry()` maps variable values to exact operations. This makes the CAD history inspectable without serializing the intermediate kernel objects.

## 4. Geometry build

`src/core/geometry/kernel.ts`

1. Load `manifold-3d` once; call `setup()`.
2. Read variables and sanitize feature-level constraints (clamp thickness, radius, hole size).
3. Build:
   - rounded-rectangle back plate contour → extrude → rotate/translate;
   - rounded-tip arm contour → extrude in Z;
   - two triangular gusset prisms mirrored in Y;
   - boss cylinder;
   - four mounting-hole cylinders in X;
   - two lightening holes in X through the back plate;
   - pin bore through the boss.
4. Union positives, subtract cutters.
5. Read `getMesh()` into copied typed arrays; read volume, surface area, bounding box.
6. Dispose tracked kernel objects.
7. Return `GeometryData` plus a build log.

The main thread owns geometry because Three.js needs the same triangle data for display. The FEA worker receives **copies** of positions/indices; it does not share WASM memory with the main thread.

### Geometry fingerprint

All variable values are hashed with FNV-1a to an 8-hex uppercase fingerprint. Results store this fingerprint. When variables change, a new result is marked `STALE` until re-solved. This is intentionally coarse but effective: it prevents silently mixing results from different geometries.

## 5. Voxel meshing

`src/core/fea/mesher.ts`

### 5.1 Inside test

The mesh is a watertight triangle soup. Node containment uses a +Z ray parity test:

- build a 2D XY bucket index over triangles,
- for each grid column, intersect only bucket candidates,
- sort and deduplicate crossing z-values,
- a node is inside iff the number of crossings below it is odd,
- a tiny deterministic jitter avoids coplanar/edge degeneracy.

### 5.2 Element inclusion

Current policy is **conservative**: an element is kept iff all 8 corners are inside. This guarantees a conforming brick mesh and never adds material outside the CAD boundary. It does under-cut tangent/curved boundaries, which is reported as a volume discrepancy warning.

To remove isolated artifacts:

- union-find over elements sharing nodes,
- keep the largest nodal-connectivity component,
- rebuild active nodes/elements.

### 5.3 Fixed cell size

The study uses `h = 3.0 mm` (`MeshSettings.cellSizeMm`). This is critical for optimization: if h were derived from a target element count, changing thickness would change h and therefore change the discrete mesh topology between candidates, producing non-physical jumps in SF. Fixed h keeps the grid alignment stable while bounds remain comparable.

The max cell cap (180k) protects the browser from pathological models.

### 5.4 Boundary conditions

- Support: active nodes within a tolerance of the active min/max on the selected face; all 3 DOFs fixed.
- Load: active nodes in an outer band of ~2.2 cells; resultant distributed equally. The outer band avoids single-layer stress concentrations at the load introduction.
- This is an idealization. Bolts, contact, preload and foundation compliance are not represented.

### 5.5 Quality metrics

- regular bricks → scaled Jacobian 1.0, aspect ratio 1.0, zero negative-volume elements;
- active node ratio, active element count, discretised volume;
- volume discrepancy vs exact CAD volume, reported to the user.

## 6. Linear static solver

`src/core/fea/hex8.ts`, `solver.ts`

### Element formulation

Trilinear Hex8 shape functions with 2×2×2 Gauss integration. The element stiffness is precomputed once for the uniform cell size and reused matrix-free:

```text
K_e = ∫ Bᵀ D B dV
D   = isotropic 3D elasticity matrix (E, ν)
```

The B matrix uses engineering shear strains. The Jacobian is 3×3, inverted at each Gauss point.

### Assembly-free PCG

- Element DOFs are precomputed into `Int32Array`.
- Global stiffness is never assembled as a sparse matrix.
- Each PCG iteration gathers 24 local DOFs, multiplies by `K_e`, scatters results.
- Dirichlet DOFs are zeroed in every matvec; RHS is zeroed there.
- Jacobi preconditioner uses assembled element diagonals.

This keeps memory predictable and allows 5k–6k element solves in a browser Worker in seconds.

### Recovery and checks

- Nodal displacement.
- Element-centroid stress → nodal average for visualization.
- von Mises yield safety factor.
- Reaction force from `K·u` at fixed DOFs; relative equilibrium error.
- Strain energy `0.5 uᵀf`.
- PCG residual and convergence status.

### Validation

`validateCantilever()` builds a **structured** beam mesh (independent of the voxel geometry path) and compares tip deflection to the Euler-Bernoulli analytic solution. It is intentionally an end-to-end solver test, not just a unit test.

Current validation result: analytic 0.09524 mm, computed 0.09162 mm, error 3.80%, limit 8%.

## 7. Field visualization

Results are discrete nodal fields on a voxel mesh. The CAD surface has a different topology. `src/core/fea/fieldProjection.ts`:

1. Hash active nodes into a spatial bucket grid.
2. For each CAD vertex, search nearby buckets.
3. Inverse-distance interpolate displacement and scalar value from nearby nodes.
4. Map scalar through a seven-stop color ramp.
5. Apply deformation × display scale to the CAD vertex.

This gives a smooth field over the original CAD geometry while remaining explicitly labelled **NODAL PROJECTION**. It is a visualization aid, not a new solution field. The maximum marker uses the actual element-centroid maximum.

## 8. Optimization

`src/core/optimization/optimizer.ts`

1. Compute 6 boundary quantiles + baseline.
2. Create up to 3 `SimulationClient` workers.
3. Evaluate candidates with a bounded concurrency pool.
4. Rebuild exact CAD geometry per candidate for objective mass.
5. Collect feasible candidates (SF and displacement constraints).
6. Refine between the lightest feasible candidate and its lower neighbor (65%, 88%).
7. Sort feasible candidates by mass; verify up to 3 at the same fixed h.
8. If a fine verification fails, fall back to the next candidate.
9. Return candidate set and recommendation with failure notes.

The implementation intentionally does **not** use a surrogate. Every reported candidate has a real C3D8 solve. The cost is runtime; the benefit is traceability. A future version can add a calibrated response surface behind the same interface.

## 9. UI composition and lazy loading

- React entry: `src/App.tsx`.
- Main shell: top bar, tool rail, model panel, stage, copilot, result strip.
- `AnalysisWorkspace` and `OptimizationWorkspace` are `React.lazy()` imports.
- `SimulationClient` creates the worker only on first solve.
- Report module is dynamically imported on export.
- Three.js scene is a single WebGL canvas per mounted viewport; analysis reuses the same `SceneViewport` component.

Design system: warm paper panels, graphite viewport, signal orange for actions, lime for AI/positive states, mono for engineering numerics. No UI framework; CSS is split into tokens, base, panels, workspaces.

## 10. Security / privacy

- No network calls for geometry, solver, report, or agent planning.
- Manifold WASM and fonts are bundled locally.
- The app cannot read local files; STL/OBJ export is generated from current in-memory geometry.
- If an LLM planner is added, it must call the same typed tools and be subject to user confirmation and audit logging. It must never send raw geometry by default.

## 11. Extension points

- `Planner` interface: replace `parseEngineeringPrompt` with an LLM tool-calling adapter.
- `MaterialSpec`: add temperature-dependent tables and allowables.
- `mesher`: swap voxel C3D8 for tetra/shell mesher; keep `VoxelMesh`-like contract or introduce a generic `FeMesh`.
- `solver`: assemble sparse matrix or use WASM multigrid for larger jobs.
- `AnalysisResult`: add modal/thermal result kinds.
- `ModelDocument`: add assemblies, mates, manufacturing constraints.
- `SceneViewport`: add picking/probing and section cuts.

## 12. Performance notes

- Baseline solve: ~5.3k C3D8, 24k DOF, ~870 PCG iterations, ~4.5 s in Node and ~10 s in headless Edge/Software WebGL.
- Optimization: 9 candidate FE jobs, ~90 s in headless Edge with 3 parallel workers.
- Main-thread geometry rebuild: ~60–80 ms.
- The limiting cost is PCG iterations and Worker serialisation, not rendering.

## 13. Known architectural debt

- `voxelMesh` is a large synchronous Worker function; it should be streamed/progressed per slice for very large grids.
- No cancellation token for solves; long jobs keep the worker busy.
- `AnalysisResult` carries full fields; for many studies, fields should be stored separately or compressed.
- Model persistence is in memory; no project save/load yet.
- The deterministic planner has limited coverage; ambiguous prompts fall back to a capability message.
