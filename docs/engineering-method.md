# Engineering method and evidence

## Units and geometry

Units are mm, N, MPa (N/mm²), kg; strain energy is N·mm (mJ). Geometry is NVIDIA USD BRep, stored natively per body and exported as USD. Final bodies may be solids or sheets. Volume and area are native numerical integrals at the configured accuracy, rather than mathematically exact symbolic values. Default absolute tessellation tolerance is 0.05 mm with a 10° angular tolerance.

CAD mass = native volume × 1e-9 × current material density. FEA mass uses tetrahedral mesh volume. These quantities need not be identical. Analysis rejects more than 5% volume mismatch when native expected volume is provided.

## Meshing and regions

STL cleanup welds vertices, removes duplicate/degenerate triangles and rejects open or non-manifold edges; it is not a general self-intersection proof. TetGen uses a triangle PLC and produces P1/C3D4 tetrahedra. Requested h controls maximum tetrahedral volume h³, without implicit 0.5 mm or diagonal/140 clamping; it is not a guaranteed maximum edge length. TetGen has a Steiner-point budget. The post-meshing admission limit defaults to one million elements and can be changed with the positive integer environment variable `VISION_FEA_MAX_ELEMENTS` before restarting the backend. It does not cap TetGen's own peak memory or change the solve timeout.

The ignored `server/fea_settings.local.json` can persist `max_elements` when no environment override is present. The service records the effective limit in every numerical request and passes it explicitly to the worker, avoiding reliance on the worker's fallback environment. Startup logs and `/health` expose the effective limit; child errors and logs use explicit UTF-8 encoding.

Closed internal voids require explicit `mesh_holes` seeds; a native void census without seeds is rejected. Through-holes open to the exterior do not need void seeds. Negative tetrahedral orientation is normalized, and degenerate elements are rejected.

Multiple fixed and resultant-load regions are supported. Each fixed node constrains three translations; solid P1 elements have no independent rotational DOFs. Regions may be box/sphere selections, six bounding-box extreme faces or artifact-scoped native trimmed faces. Native selection uses `Face.closest_point` after bounding-box filtering; tolerance must cover surface tessellation error. A load selects full boundary triangles whose three vertices belong to the region. Resultant force is distributed by actual triangle area with consistent one-third nodal contributions.

All disconnected components must have enough non-collinear anchors. Fixed/load overlap is rejected. The solver does not infer contact, bonding or mates. Selected solids share one material.

## Linear elasticity and evidence

scikit-fem assembles three-dimensional isotropic P1 elasticity with Lamé parameters λ=Eν/((1+ν)(1−2ν)), μ=E/(2(1+ν)). SciPy solves the condensed sparse system. E, density and yield strength must be positive and finite; −1<ν<0.5. The study is small-strain linear static elasticity.

Assembly uses batches of 32,768 elements and one-point quadrature, which integrates homogeneous P1 tetrahedral elasticity exactly. Systems above 60,000 total DOFs use SciPy CG with Jacobi preconditioning; smaller systems use sparse direct factorization. CG requires relative tolerance 1e-8, at most 10,000 iterations, and the same final free-DOF residual check. The backend admits one numerical job at a time, records stdout/stderr and execution diagnostics per request, and terminates a solve after 600 seconds. The engineering proxy allows 900 seconds to include native geometry preflight. The independent analytic benchmark is now manual, avoiding an extra solve after each user analysis.

These latest memory, iterative-solver, timeout and admission changes have not been tested, as requested by the user. The numerical records below were collected before those changes and are historical regression evidence, not validation of the new CG path.

Follow-up source and log review on 2026-10-20 found three successful manual-run records from 2026-10-19: 547,903 elements / 302,436 DOFs in about 87 seconds, and two 518,354-element runs in about 82–83 seconds, all with process exit code zero. These local records show successful executions of the earlier CG implementation; they are not an automated regression or a general convergence guarantee. The follow-up changes restrict basis construction to each assembly batch, reuse global DOF metadata, disable unused DOF locations, and extract boundary faces with compact NumPy arrays. Those follow-up changes have not been executed or tested.

The service computes free-DOF relative residual, reactions from Ku−f, reaction plus applied-force equilibrium residual, strain energy, actual timing, oriented mesh volume and a normalized scaled-Jacobian indicator. Relative residual above 1e-6 fails. Missing alternative quality metrics remain unknown, and success does not establish local stress convergence.

Element stresses are recovered from tetrahedral displacement gradients, averaged onto nodes, and converted to von Mises. A reported hotspot is a nodal averaged-field extreme, not an integration-point peak. Viewport interpolation onto participating surfaces is for display.

## Refinement and validation

h refinement performs two real solves with requested sizes h and h/1.8, and checks that actual h decreases and element count increases. Displacement difference is |δfine−δcoarse|/max(|δfine|,1e-12). Two levels do not prove mesh independence or stress convergence.

`POST /fea/validate` runs an independent 100×20×10 mm steel cantilever against PL³/(3EI), with a configured 8% screening tolerance. The current h=0.8 mm regression produced 70,404 elements and 0.0906521 mm versus 0.0952381 mm (4.82% error). Its live error must be read from each run.

The executable native regression additionally checks axial displacement PL/(EA), additive forces, native-face equivalence on the same geometry, enclosed void volume and a multi-bore flow manifold. The current axial run gave 0.0002367263 mm versus 0.0002380952 mm (about 0.58%). The manifold run used 76,955 elements and gave normalized force-balance error about 1.93e-12. These are regression results for those inputs, not general solver certification.

## Scope and traceability

Geometry changes invalidate native face references. Material, body selection, region and mesh changes invalidate old results. Reports check the current study fingerprint. Cancellation rejects late responses but does not kill native processes.

The synchronous solve endpoint does not stream stage percentages. The UI therefore uses indeterminate progress until the response arrives. During recalculation, retained results are explicitly marked as the previous run; completion publishes the new result, ready state and progress cleanup atomically. Reports wait for an active run rather than silently exporting its predecessor.

Agent analysis, explanations and report export share the same current-result guard: status must be ready, inputs must match, and no current failure or stale flag may remain. A failed baseline does not automatically schedule a queued refinement. Backend startup and exit logs are retained in `server/.fea_runs/backend.log`; these diagnostic files remain local and ignored by Git.

Default safety-factor and displacement thresholds are screening values, not universal design criteria. Contact, plasticity, composites, fatigue, buckling, modal, shell/beam and fluid/thermal analyses remain unsupported. See [the integration contract](usd-brep-integration.md) for executable setup and examples.
