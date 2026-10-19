# VISION architecture

Updated 2026-10-19. The engineering loop is intent → editable native geometry → explicit study → deterministic calculation → evidence → revision.

## Runtime responsibilities

| Layer | Responsibility |
|---|---|
| React / Three.js | Geometry and result display; optional advanced controls; no geometry or FEM substitute |
| Zustand | Model and study state, undo, project lifecycle and stale-result invalidation |
| Agent | Discover native API, construct Python, configure a study atomically, invoke tools and explain their receipts |
| HTTP service (Python 3.13) | Validate transport contracts, manage immutable artifacts, invoke isolated workers |
| USD BRep worker (Python 3.12) | Native modeling, parameters, multi-body geometry, topology, serialization and trimmed-face queries |
| TetGen / scikit-fem / SciPy | Volume mesh, P1 linear elasticity, sparse solve, stress recovery and equilibrium evidence |

## Native geometry as authority

`vision.cad/3` retains original per-body BRep data alongside USD exchange geometry, STL preview, topology, source, parameters and precision. Content-addressed artifacts commit only after successful construction. Incremental operations load original native Breps, avoiding repeated conversion through tessellation. Runtime public API discovery avoids a handwritten subset of modeling functions.

The frontend stores artifact references instead of large native previews in localStorage, and restores previews on demand. Storage failures produce notifications. Imported packages are read as geometry and never automatically execute stored source. Full application project JSON remains separate from geometry-package export.

## Study and result integrity

Studies explicitly select solid bodies, multiple supports and multiple loads. Regions use native trimmed-face references or geometric selectors. Face IDs belong to an immutable artifact; changed geometry invalidates old references and requires rebinding. Every disconnected mesh component needs independent sufficient constraints; bodies are never implicitly bonded.

Geometry and study identities are separate. Native SHA-256, artifact identity, precision, selected bodies, material and regions enter provenance. Full serialized input and task generation protect asynchronous commits; project switching and cancellation propagate through Agent turns and solve requests. Failed or stale operations do not overwrite the current document. Geometry and study edits support undo.

Numerical responses validate dimensions, finite fields and solver evidence before adoption. Unsupported evidence remains nullable. Results project only onto surfaces participating in the solve. Reports carry the native source identity, study, boundary counts, applied forces and actual available numerical evidence.

Large systems use batched assembly and Jacobi-preconditioned CG instead of direct factorization, with actual algorithm and iteration metadata. Numerical job admission is serialized, worker execution has a 600-second budget, and the proxy waits longer than the worker. These latest changes remain untested at the user's request; prior numerical measurements do not validate the new iterative path.

## Remaining limits

- Script parameters are editable and replayable; there is no general constrained sketch solver or parameter-feature dependency graph.
- Multi-body geometry is supported; assembly mates, contact and material assignments per body are not implemented.
- Surface Breps are supported for CAD; shell/beam elements and multiphysics require additional numerical implementations.
- Native face selection is through the topology list, without interactive viewport picking or permanent topology naming after edits.
- HTTP requests remain synchronous; frontend cancellation does not terminate backend subprocesses. Production long jobs need a job API and explicit retention/resource policies.
- Chat and solved fields are not persisted; backend geometry artifacts must accompany projects moved between machines. Numerical reproducibility also depends on library versions, mesher decisions and hardware.

See [integration and validation](usd-brep-integration.md) and [engineering method](engineering-method.md). Native regression exercises real installed CAD and FEM dependencies; mocked frontend tests establish state/contract correctness, not numerical accuracy.
