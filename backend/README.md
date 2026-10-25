# VISION engineering core v2

Application core for the single workbench entry. Legacy implementation sources
remain for migration and regression work. This service owns its
own workspace; it never silently imports or overwrites legacy projects.

```powershell
.python313/python.exe -m pip --disable-pip-version-check install -r backend/requirements.txt
.python313/python.exe -m backend.vision --port 8112
npm run dev
```

Open the [workbench](http://127.0.0.1:4173/) or
[API documentation](http://127.0.0.1:8112/docs). Vite proxies `/api/v2` to port
8112; set `VISION_CORE_URL` to use another independently managed core.
Default data directory is `.vision-workspace`; override with `--workspace PATH`.
For local semantic memory, install `backend/requirements-memory.txt` and run
`.python313/python.exe scripts/setup_memory.py` once. Open “工程记忆与上下文”
in the conversation pane to review/correct memory and inspect compiled context.
See [hierarchical memory](../docs/hierarchical-memory.md).
The desktop-style workbench places modeling in the center and conversation on
the right. Global appearance/layout preferences are persisted in SQLite through
`/api/v2/ui-settings`; [desktop workspace](../docs/desktop-workspace.md) describes
the navigation, unified settings and existing engineering tools.
Only one controller may own a workspace. CAD uses the existing Python 3.12
worker; CAE invokes the verified calculation function directly inside a managed
Python 3.13 worker, without nesting the old synchronous scheduler.

Current implementation:

- Immutable project revisions, optimistic head checks, idempotent command receipts.
- Explicit study configuration; no implicit default loads on a new project.
- Durable CAD/FEA jobs, cancellation, timeouts and interrupted-job recovery.
- Windows Job Objects own the complete worker process tree.
- Atomic artifact-directory publication, SHA-256 manifests and file validation.
- Native BRep, USD, STL and compressed numerical fields remain on disk.
- Successful late CAD results cannot overwrite a newer project head.
- Jobs/results can be queried after restarting the application.
- Separate browser workbench with native preview, explicit study editor, job
  phases, cancellation, history, candidate adoption and result downloads.
- Checksummed project bundles with consistent SQLite snapshots; recovery into
  an empty workspace preserves revisions, artifacts, sources and job records.
- Explicit legacy-model preview/copy without executing imported scripts.
- Source-backed requirements, deterministic pass/fail/unknown assessment and
  Markdown reports tied to a specific revision and numerical runtime.
- Stable engineering-object identity with explicit native topology binding;
  geometry changes invalidate old bindings and block dependent solves.
- Viewport body/face/edge selection resolves mesh hits against trimmed native
  BRep boundaries; ambiguous hits require explicit selection. Native outlines
  and area/length queries share the same artifact-scoped identity.
- A separate bounded read-only query lane stays available during CAD/FEA jobs.
- Windows native process trees have an aggregate committed-memory budget,
  captured in admitted job inputs and result provenance.
- Parameterized script replay uses the original input geometry, rather than
  repeatedly applying an incremental transformation to its own output.
- Local script/study/requirement recovery copies keep their original revision
  and independent per-page identities; restoration never submits work.
- Read-only build-impact preview identifies known binding and evidence changes;
  an optional digest ties admission to the reviewed script and settings.

API requests use snake_case except native study region fields, which retain the
existing CAD/CAE contract. Create a project with `command_id`, `idempotency_key`
and `name`. Mutating project requests additionally carry `expected_head`.
Build with `/api/v2/projects/{id}/build`, configure `/study`, then submit `/solve`.
Build/solve return HTTP 202 and a persistent job ID. Poll `/api/v2/jobs/{id}`;
events are available at `/events?after=SEQ`. Cancellation uses `/cancel` and is
independent of the current project head. History and restoration are available
at `/revisions` and `/restore`.

`/projects/{id}/build/preview` accepts the same build request and never executes
the script. It reports known dependency changes and explicitly leaves output
topology unknown. The workbench requires this review before modifying existing
geometry. Pass the returned `digest` as `expected_impact_digest` on `/build` to
reject changed inputs with 409; this field is optional for existing API callers.
It is a consistency check, not an authorization token or script sandbox.

Browser editing copies use localStorage and are excluded from project bundles.
They require the same browser origin and retained site storage, and do not
replace backend revisions or backups. Restore a copy explicitly after reload;
stale base revisions continue to conflict. Each page writes its own copy so
parallel tabs do not overwrite one another. Storage failures are shown in the UI.

Explicit `body_ids` selections require the current geometry's `body_artifact_id`
when saving a study. Rebuilding geometry invalidates this scope even if body
numbers repeat. Reconfirm current solids through the workbench before solving;
rebinding a face alone does not repair an outdated body selection. Omitting
`body_ids` selects all closed solids rather than retaining a fixed body identity.

CAD completion auto-adopts only if its input revision is still the project
head. FEA completion creates historical evidence for its exact input revision,
without changing the model. A failed, cancelled or timed-out job never adopts
geometry. Service shutdown terminates active native workers; interrupted jobs
are not automatically replayed. Queued jobs remain queued for the next start.

Read-only topology queries use `/projects/{id}/inspect`, with `revision_id`,
`artifact_id`, and either a `selection` list or a `pick` containing `kind`,
`point` and `tolerance_mm`. Responses retain the exact revision/artifact and
return candidates rather than guessing among ambiguous native boundaries.
The query lane permits one active query, caps execution at 15 seconds and
returns 503 on contention or 504 on timeout. It does not create revisions/jobs.

On Windows, new CAD/FEA attempts default to a 4096 MiB process-tree memory
budget. Set `VISION_WORKER_MEMORY_MIB` to an integer from 128 to 65536 before
starting the core to change the budget. Interactive queries use 1024 MiB.
These are aggregate committed-byte limits, not RSS measurements or a total
application memory guarantee. A failed allocation may raise `MemoryError`;
failure never adopts geometry. The controller and browser are outside these
native worker limits. Other platforms do not yet enforce an equivalent hard
process-tree memory budget; setting this variable there is rejected.
The mechanism uses [Windows Job Object limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information).

Verification:

```powershell
.python313/python.exe -m unittest discover -s tests -p test_workspace_v2.py
$env:VISION_TEST_NATIVE_CORE='1'
.python313/python.exe -m unittest discover -s tests -p test_workspace_v2.py
Remove-Item Env:VISION_TEST_NATIVE_CORE
npm run test:core-ui
```

The native test builds a real beam, solves axial elasticity, reads result fields
after reopening, checks failure isolation, and cancels a real child process tree.
It also queries trimmed-face holes and ambiguous boundaries, verifies the
interactive lane during a long build, and exercises inherited Windows memory
limits plus recovery after native allocation failure.
It uses an isolated temporary workspace. Tests without the API dependencies skip
this module, allowing the separate CAD runtime to retain its existing suite.

Not implemented yet: legacy memory migration, automatic topology matching,
broad model quality evaluation, full alternative branches/decisions, optimization, equivalent
hard memory limits on other platforms, and release packaging.
The workbench remains an opt-in development preview; the default v1 workbench
has separate storage and lifecycle semantics. Project packages currently cap
compressed size at 32 MiB and expanded size at 128 MiB. Imported results remain
historical evidence until recomputed in the current environment.
See [development status](../docs/development-status.md) for remaining acceptance work.
The process boundary manages resources; CAD scripts still execute trusted local
Python and are not an untrusted-code sandbox.

New v2 solves now publish `surface.bin` with indexed FEM boundary triangles,
displacement and nodal-averaged stress, plus boundary indices in `field.npz`.
The workbench renders displacement/stress and explicit deformation scaling,
using the FEM node indices rather than nearest-point projection onto CAD STL.
Only currently verified evidence can color the current geometry; stale inputs
remove the overlay, and native picking is disabled while displaying fields.
Interactive limits are 500,000 boundary vertices / 1,000,000 triangles; larger
results remain downloadable, without silent decimation. Old results without
boundary topology need recomputation. The legend shows boundary-node ranges,
which may differ from all-node maxima in the numerical summary.

Study forms and JSON edit the same draft, retaining precise/semantic regions.
Saving still requires the draft's original head; forms do not commit implicitly.
Read-only `GET /projects/{id}/compare?left=...&right=...` checks two immutable
revisions' material, loads, supports, selected bodies, requirements, CAD precision,
mesh strategy and verified evidence. Incompatible/missing evidence suppresses
deltas and ranking. This is the comparison foundation, not full branching.
Storage-full API failures return HTTP 507; injected SQLite commit/full-copy
tests verify rollback, no partial artifact publication, and safe retry. These
fixtures do not establish hardware power-loss durability.

## Persistent local and model tasks

The v2 workbench exposes **持久任务**. A local task consists of a
raw source statement and an explicit JSON tool plan. The statement is retained
for provenance; it is not automatically converted into actions by a model.
Use “从当前编辑器生成计划” to prepare a plan from explicitly edited CAD/study
inputs, then review and submit it. Unsubmitted task forms are not saved across
reloads. Submitted tasks and tool checkpoints live in SQLite and survive page
closure and service restart. Local mode does not call an external provider.
DeepSeek mode accepts natural-language instructions, choosing one typed tool
per response. It uses the official endpoint, backend `DEEPSEEK_API_KEY` or root
`.env`, and the approved scope in [model connection](../docs/model-connection.md).
The UI displays data scope, credential status, budgets and provider receipts.

Plans allow build preview, geometry construction, study configuration, solve,
assessment, source search, bounded script reads, native inspection and a question
that pauses execution. Tools reuse the existing command/CAS and native job
paths. A task allows at most 24 steps and 1–8 native jobs (default 3); at most
eight tasks can be active. Corrections check both the original task epoch and
project head, cancel owned pending jobs and fence all old writes in the same
transaction as command execution. A completed plan is not an engineering pass.
Tool failure, stale head and budget exhaustion pause for explicit correction.

New API routes under `/api/v2`:

- `POST/GET /projects/{project}/tasks`: submit/list local plans.
- `POST /projects/{project}/model-tasks` and `/tasks/{task}/correct-model`:
  start/correct a DeepSeek task. Transport failure pauses without auto-retry.
- `GET /tasks/{task}` and `/tasks/{task}/input`: checkpoints and original input.
- `POST /tasks/{task}/correct` and `/tasks/{task}/cancel`: epoch-checked control.
- `GET /tasks/{task}/context`: inspect the local compiled context and its digest.
- `GET /projects/{project}/sources/search?q=...`: project-scoped FTS5 retrieval.
- `POST /projects/{project}/sources/forget`: logically delete a source and its
  derived sources, stop related tasks, redact their plans/checkpoints and remove
  retrieval entries. Tasks that consumed the source in retrieval receipts are
  stopped/redacted too; a concurrent retrieval cannot restore deleted excerpts
  to a checkpoint. Already committed designs/artifacts and exported backups
  remain; this is not forensic secure erasure of SQLite pages or backups.

Context includes the current document, raw statement, at most eight retrieved
source excerpts, and complete recent instruction/receipt groups within a
60,000-character budget. Sources remain statements rather than verified
numerical evidence. Search uses lexical terms and Chinese bigrams, rebuilding
the project's source index on demand; large-history performance is unmeasured.

SQLite schema 4 includes task/checkpoint tables and FTS5. Opening schema 1/2/3 makes
an online SQLite backup before upgrading under controller ownership. Project
bundle format 4 includes tasks and accepts format 2/3 imports. Imported active
plans are paused and native jobs are not replayed automatically.

```powershell
$env:VISION_TEST_NATIVE_CORE='1'
npm run test:tasks
npm run test:model-tasks
Remove-Item Env:VISION_TEST_NATIVE_CORE
npm run test:core-ui
```

See [model connection](../docs/model-connection.md) for transport budgets,
secret configuration, live replay commands and data scope.
