# Architecture

## 1. Design position

VISION treats language as an **intent layer**, not as an authoritative geometry kernel or solver. Every sentence is compiled into a typed `AgentAction`, either by DeepSeek tool calling or by the deterministic local planner. The executor validates units and writes to a single model document. The model document is the source of truth; geometry, mesh, results and reports are derived artifacts with fingerprints.

This separation is deliberate:

- Language is probabilistic; geometry and FEA must remain deterministic.
- A result must be invalidatable when its input model changes.
- UI components can be loaded and disposed independently.
- The LLM never produces numerical evidence; it only chooses validated tools and explains their results.
- When DeepSeek is unavailable, the deterministic planner keeps the workspace operable.

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
│ Manifold WASM              │  │ DeepSeek stream + tools    │
│ feature evaluator          │  │ or deterministic fallback  │
│ watertight mesh + metrics  │  │ typed tools → executor     │
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
                          ▲
                          │ same-origin /api/deepseek/*
┌─────────────────────────┴──────────────────────────────────┐
│ Local Vite gateway                                          │
│ fixed DeepSeek target · SSE pass-through · env key inject   │
│ no arbitrary URL · local status endpoint                    │
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

### 3.1 Project library

`ProjectRecord` wraps a model with identity and timestamps. The store keeps:

- `projects: ProjectRecord[]`
- `activeProjectId: string`
- the active `model` (the editable working copy)

Persistence uses two localStorage keys (`vision.project.library.v1`, `vision.project.active.v1`). The active project is synced after a debounce whenever the model signature changes, and on `beforeunload`. Switching projects:

1. saves the current working model into its project record,
2. loads a clone of the target record into the store,
3. resets derived state (geometry, analysis, optimization, history, view mode),
4. adds a project seed message to the chat and resets DeepSeek conversation history,
5. rebuilds geometry from the target model.

The UI exposes switching, creation from the current model, duplication, delete, rename, JSON import/export, and double-click open. This is intentionally a local project library, not a server-backed collaboration system.

Derived artifacts are never persisted with the project. On reload, the model is restored but geometry and results are rebuilt on demand.

### 3.2 Blank projects and starter solids

A project can be created in `template: 'empty'` mode. In this state it has no features and no variables. `rebuildGeometry()` short-circuits to a clean empty state instead of treating it as an error, and `SceneViewport` clears the previous project’s mesh, annotations, ground and grid.

The model panel and the empty viewport offer three parameterized starters:

| Template | Variables | Default topology |
|---|---|---|
| `plate` | length, width, thickness | solid rectangular plate |
| `block` | length, width, height | solid block |
| `cylinder` | diameter, height | 64-segment cylinder |

`createStarterModel()` populates variables, a single feature descriptor, a bottom fixed support and a top downward load. `src/core/geometry/kernel.ts` has a dedicated primitive builder; `empty` and `bracket` remain separate paths. This is intentionally not a freeform sketcher: the blank project is a zero-geometry starting point with a controlled parametric base.

The blank state does not auto-inherit the previous project's geometry or results; browser tests assert the old mesh is cleared.

### 3.3 CSG feature graph and natural-language modeling

For non-bracket topology the model can use `template: 'csg'` with:

```ts
interface SolidFeature {
  id: string;
  shape: 'box' | 'cylinder' | 'sphere';
  operation: 'add' | 'subtract' | 'intersect';
  position: Vec3;
  rotation: Vec3;  // degrees
  size: Vec3;      // box
  radius: number;  // cylinder / sphere
  height: number;  // cylinder
  axis: 'x' | 'y' | 'z';
  enabled: boolean;
}
```

`buildCsgGeometry()` evaluates features in order:

1. build the primitive at the origin;
2. orient the cylinder to its axis;
3. apply Euler rotation;
4. translate to its center;
5. apply union, difference or intersection to the running body.

All intermediate solids are tracked and disposed. The mesh, bounding box, volume, area and hash are produced from the final Manifold body. The hash includes template, variables and every CSG feature parameter, so any transform or boolean change invalidates old FE results.

The brake-pedal preset (`createBrakePedalModel`) is a 16-feature graph: wall plate, four bolt holes, two side cheeks, lower cross brace, two gussets, pivot boss and bore, two lightening holes, pedal lever and pedal pad. A natural-language prompt maps to `generate_preset`; the local planner handles the brake-pedal phrase, while DeepSeek can also call `generate_preset` and `add_solid_feature`.

The feature builder UI edits the same graph. It is deliberately CSG, not a NURBS B-Rep sketcher: there are no sketch constraints, lofts, sweeps, fillets or assemblies yet. The app labels this boundary in the README and UI rather than presenting the result as a production CAD kernel.

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

## 9. DeepSeek integration

### 9.1 Transport

The browser calls same-origin `/api/deepseek/*`. `vite.config.ts` installs a fixed-target proxy:

```text
browser → /api/deepseek/chat/completions
        → https://api.deepseek.com/chat/completions
```

This avoids browser CORS restrictions and prevents the client from choosing an arbitrary upstream (SSRF guard). If `DEEPSEEK_API_KEY` is present in the Vite process environment, the proxy injects `Authorization` and overrides any browser credential. Otherwise the browser-supplied key is forwarded.

`GET /api/llm/status` is served by a small Vite plugin and reports whether a server key exists. It never returns the key. It is available in both `vite dev` and `vite preview`.

### 9.2 Models and request shape

Supported model IDs follow the current DeepSeek docs:

- `deepseek-flash`
- `deepseek-v4-pro`

Request body includes:

```json
{
  "model": "deepseek-flash",
  "messages": [],
  "tools": [],
  "tool_choice": "auto",
  "stream": true,
  "stream_options": { "include_usage": true },
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high",
  "temperature": 0.25,
  "max_tokens": 8192
}
```

Thinking mode ignores temperature by design. The UI exposes thinking on/off, effort (`low/high/max`), streaming, model, temperature, max tokens and key configuration.

### 9.3 Streaming parser

`src/core/llm/client.ts`:

- reads `response.body` with `ReadableStreamDefaultReader`,
- decodes UTF-8 incrementally,
- parses `data:` SSE lines,
- accumulates `delta.content`, `delta.reasoning_content`, and incremental `delta.tool_calls` by index,
- merges fragmented tool names/arguments,
- captures usage from the final chunk,
- supports `AbortSignal` for stop generation.

### 9.4 Tool loop

`src/services/deepseekAgent.ts` runs up to six rounds:

1. Send system + conversation + tools.
2. Stream reasoning/content into the chat message.
3. If tool calls arrive, append the assistant tool-call message, execute tools sequentially, append each tool result, and continue.
4. If no tool calls remain, commit the final assistant answer.

Each tool result includes a compact authoritative state snapshot: variables, material, load, support, geometry hash/mass, latest result metrics, warnings, analysis status. This lets the next model round reason about what actually changed.

The tool loop is guarded by runtime validation:

- JSON arguments are parsed and validated.
- Variable keys, material IDs, faces and numeric ranges are checked.
- Face values outside the enum are rejected.
- Unknown tools produce an error tool message, not code execution.

### 9.5 Thinking-mode reasoning replay

DeepSeek's docs require that, when `tools` is present, the complete `reasoning_content` of previous assistant turns is passed back. Otherwise the API returns HTTP 400. The integration therefore maintains a module-level `deepseekHistory` containing the exact assistant/tool messages, not a display-only reconstruction. The system prompt is refreshed with current model state at each user turn; the conversation history is preserved and trimmed only at user-turn boundaries.

### 9.6 Failure and fallback

- No key -> local deterministic planner.
- Gateway unreachable -> status shows offline; local planner.
- 401/402/429/5xx/network error -> UI error, toast, then local planner fallback.
- User stop -> `AbortSignal` cancels the request; no fallback.
- Tool errors are returned to the model; if the turn still fails, the UI preserves the error trace.

Numerical claims are always grounded in tool result JSON. The model is explicitly prohibited from inventing solver values.

Official references used for the adapter:

- [DeepSeek API — first call](https://api-docs.deepseek.com/)
- [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion)
- [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)
- [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)

## 10. UI composition and lazy loading

- React entry: `src/App.tsx`.
- Main shell: top bar, tool rail, model panel, stage, copilot, result strip.
- `AnalysisWorkspace` and `OptimizationWorkspace` are `React.lazy()` imports.
- `SimulationClient` creates the worker only on first solve.
- Report module is dynamically imported on export.
- Three.js scene is a single WebGL canvas per mounted viewport; analysis reuses the same `SceneViewport` component.

Design system: warm paper panels, graphite viewport, signal orange for actions, lime for AI/positive states, mono for engineering numerics. No UI framework; CSS is split into tokens, base, panels, workspaces.

## 11. Security / privacy

- Geometry, meshing, FEA, optimization, STL and report generation stay in the browser. The only optional outbound traffic is DeepSeek chat through the local gateway.
- The DeepSeek prompts contain model variables, material/BC/load data, geometry metrics and solver summaries. They do **not** contain raw triangle arrays or the API key in chat content.
- The gateway has a fixed upstream target; the client cannot redirect it to an arbitrary URL.
- A server-side `DEEPSEEK_API_KEY` is never sent to the browser. Browser-entered keys stay in `sessionStorage` by default; optional `localStorage` persistence is clearly marked.
- Tool arguments are reparsed and validated. The model cannot execute arbitrary code or write files; only the registered tool executor can mutate the model or download a generated report.
- The app cannot read local files. STL export is generated from in-memory geometry.
- For production deployment, terminate TLS at a reverse proxy, authenticate users, rate-limit the LLM endpoint, redact logs, and use server-side keys.

## 12. Extension points

- Add an MCP tool adapter and human-in-the-loop approval for destructive actions; the current tool schema is already typed.
- Add a persistent, auditable LLM conversation store; current reasoning replay is in-memory per page session.
- `MaterialSpec`: add temperature-dependent tables and allowables.
- `mesher`: swap voxel C3D8 for tetra/shell mesher; keep `VoxelMesh`-like contract or introduce a generic `FeMesh`.
- `solver`: assemble sparse matrix or use WASM multigrid for larger jobs.
- `AnalysisResult`: add modal/thermal result kinds.
- `ModelDocument`: add assemblies, mates, manufacturing constraints.
- `SceneViewport`: add picking/probing and section cuts.

## 13. Performance notes

- Baseline solve: ~5.3k C3D8, 24k DOF, ~870 PCG iterations, ~4.5 s in Node and ~10 s in headless Edge/Software WebGL.
- Optimizer: 9 candidate FE jobs, ~90 s in headless Edge with 3 parallel workers.
- DeepSeek turn latency is network/model dependent; local tool execution adds solve time. Streaming keeps the assistant responsive, but a `run_analysis` tool blocks the next model round until the solver returns.
- Main-thread geometry rebuild: ~60–80 ms.
- The limiting cost is PCG iterations and Worker serialisation, not rendering.

## 14. Known architectural debt

- `voxelMesh` is a large synchronous Worker function; it should be streamed/progressed per slice for very large grids.
- No cancellation token for solves; long jobs keep the worker busy.
- `AnalysisResult` carries full fields; for many studies, fields should be stored separately or compressed.
- Model persistence is in memory; no project save/load yet.
- The deterministic planner has limited coverage; ambiguous prompts fall back to a capability message.
- DeepSeek conversation history (including reasoning_content) is in memory and lost on reload; no server-side session store yet.
- No per-user token budget or cost guard yet; settings expose per-session usage only.
- The local Vite gateway is suitable for local development/preview. Production requires a hardened reverse proxy with auth, rate limiting and audit logs.
- Tool calls currently execute immediately; a production system should add explicit confirmation for destructive operations (report export, large optimization runs, model reset).
