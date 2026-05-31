# Codemaster — Architecture

> A stateful, always-on **codebase inspector** for TypeScript/React repos.
> It indexes the project, watches the filesystem, keeps a live TypeScript
> Language Service warm, and answers structural + semantic + refactor
> queries for **AI agents** — densely, and without lying.

---

## 1. North star & non-goals

**The one invariant: never lie to the agent.**

Agents are slow and patient (5–60 s per call is fine) but ruthless about trust.
The moment a tool's answer contradicts what the agent finds by grepping, the
agent abandons the tool and falls back to its proven stack forever. So:

- **Consistency ≫ speed.** Correctness is the product. Latency is a budget, not a goal.
- **Every fact is proof-carrying.** A claim ships with the exact `file:line` span
  and verbatim source text that proves it, so the agent can confirm without re-grepping.
- **Uncertainty is explicit and first-class.** `unresolved` / `partial` / `dynamic`
  are real answers. "Not found" is never confused with "couldn't determine."
- **Output is for agents, not humans.** Maximally dense, coded, minimal noise.
  Tokens are the scarce resource.
- **Correct + honest beats instantaneous.** Agents mutate, then call seconds later —
  we exploit that slack instead of building database-grade synchronization. Honesty is
  upheld by verifying freshness on read (§3, §8), never by locks.
- **Responsive under concurrency.** One front door serves many agents across many
  workspaces; the orchestrator only routes and never blocks. Each workspace's heavy work is
  isolated — its own process in `process` mode (§2), with an `in-process` mode for easy
  debugging.

**Non-goals:** a human IDE, a linter, a language-agnostic universal index,
runtime/execution analysis, AI inside the tool. Codemaster is deterministic
plumbing that makes agents cheaper and more correct.

---

## 2. Process topology

```
agent ──MCP tool──▶ orchestrator (daemon) ──host──▶ workspace engine ──▶ dense reply
                    front door · routing ·          vfs + graph + live TS LS +
                    repo registry · lifecycle       indexers + primitives (one workspace)
```

- **`codemaster` global bin** — entry point (`npx codemaster`, or installed).
- **Orchestrator (the daemon)** — one long-lived front-door process speaking MCP/IPC. It
  holds **no project data**: a `repoId → workspace` registry, request routing (resolves the
  target workspace from the client `cwd` or an explicit `root`), lifecycle (spawn / idle-TTL
  kill / restart), and a cross-workspace **memory governor** (§9). Its heap stays small and
  its loop never blocks — it only routes.
- **Workspace engine** — the whole machine for **one workspace** (a repo, or a monorepo
  root): vfs, the structural graph (behind a `GraphStore`, §5-L2), the live TS LS, indexers,
  watcher, primitives, recipes. Everything for that workspace runs **together in one memory
  space**, so semantic queries walk the AST and the graph with **zero serialization**. Only
  a small `{verb, query}` request and a small dense result cross the boundary to it — the
  AST and graph never do.
- **Host — the transport seam, and the process toggle** ([`src/daemon/host.ts`](src/daemon/host.ts)).
  The orchestrator reaches an engine through a `ProjectHost` with two interchangeable
  implementations, set by `config.daemon.isolation`:
  - **`in-process`** _(default at this stage)_ — the engine runs inside the orchestrator; a
    host call is a direct in-memory call. One process, one heap — trivial to debug, no IPC.
    Tradeoff: a heavy synchronous call blocks the shared loop (fine for dev: one agent, one repo).
  - **`process`** — one **child process per workspace** + an IPC round-trip. Own heap + GC,
    own `--max-old-space-size`, OS reclaims all memory on kill, crash-isolation, real
    cross-workspace parallelism, non-blocking orchestrator. For scale.

  The engine is written **once, transport-agnostic**; flipping the mode never touches engine code.

- **CLI** — same front door, for humans/debugging.
- **IPC** — local socket, **newline-delimited JSON** — readable while we debug the tool (§18).

The boundary sits where data flow is **thin** — between workspaces (which share nothing) and
at the front door — never through the tight LS↔graph↔AST coupling, which stays in-process.

Rationale: a single daemon amortizes the expensive warm state (TS programs) across
every agent call in a session, instead of paying cold-start per invocation.

---

## 3. The trust contract (consistency engineering)

This is the section that the rest of the design serves.

1. **Type/semantic answers come only from the live LS.** `resolve` / `refs` /
   assignability are computed against the Language Service synced to the current
   VFS state — **never** from a possibly-stale serialized snapshot. The snapshot
   accelerates structural navigation; it is never the oracle for types.

2. **Proof-carrying results.** Every fact carries `Span[]` (file, range, verbatim
   text). See [`src/core/result.ts`](src/core/result.ts). An agent that can verify
   cheaply will trust; one that can't, won't.

3. **Honest uncertainty.** `Confidence = certain | partial | unresolved | dynamic`,
   carried **per hop** (`trace`) and **per site** (`refs`), not just per answer. A
   dynamic-dispatch hop (callback, computed key, untyped boundary) is **flagged** at the
   step it occurs, not silently bridged or dropped. Orthogonally, edges and hops carry
   **provenance** — `syntactic` / `type` / `heuristic` (+ which adapter) — so an
   adapter-inferred relationship is never mistaken for a proven structural fact.

4. **No silent truncation.** Capped result sets always report `{ shown, total, hint }`.
   Truncation that looks like completeness is a form of lying.

5. **Freshness is verified on read, never assumed from the watcher.** The honesty
   guarantee does **not** ride on the file watcher — watchers miss events, and the
   common case for an agent is a `git checkout` / rebase / stash bulk change, where
   `fs.watch` silently drops them and leaves a populated tree behind an empty
   pending-set. So the check is **repo-global, not answer-scoped** — an answer-scoped
   check would miss a file that _should_ have been in a find-all result but wasn't, which
   is itself a completeness lie (§3.6). Every query takes a cheap whole-repo fingerprint —
   `git rev-parse HEAD` **plus** `git status --porcelain` (adds/removes/dirty in one
   call), with a file-mtime rollup (a per-query stat-walk, so in-place edits aren't missed) as the
   non-git fallback. On drift, the changed set comes
   from `git diff --name-only` (not the answer's touch-set); we reindex-on-read or attach a
   `FreshnessNote`. **This global check is the correctness guarantee; the watcher is only
   an optimization** that keeps the read path usually-already-fresh. A fingerprint, not a
   lock — see §8.

6. **Report capability, not just data.** Every response says plainly what we did and
   what we couldn't — a query that only partially resolved, a recipe that applied to 3 of
   5 sites, an adapter that isn't enabled, a target we couldn't reach. If we can't do
   something, we say so outright so the agent falls back to its own means. We never dress
   a partial or failed result as complete. (The agent leaving for grep is fine; the agent
   _trusting a lie_ is fatal.) **This includes our own crashes:** every call to an external
   tool (the TS LS, git, ast-grep, prettier, the filesystem) is wrapped, and a failure
   returns an explicit `ToolFailure` ("internal tool `X` failed — can't perform this
   operation"), `data` empty — never an exception that escapes to the agent, never a guessed
   result in its place. The daemon stays up; the agent gets an honest "couldn't", not a
   stack trace or a fabrication.

7. **Self-honesty harness** (see §16): the differential test that matters is
   **structural tier vs semantic tier agreement**, not refs-vs-grep.

---

## 4. Parsing model — one grammar, two depths

> **No tree-sitter — the TypeScript compiler serves both tiers.**

Two parsers can disagree, and a syntactic-vs-semantic disagreement is precisely the lie
this project must never tell. One grammar, two depths:

| Tier          | Source                                           | Cost                                         | Authoritative for                                                                                     |
| ------------- | ------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Syntactic** | `ts.createSourceFile` per file (no type-checker) | cheap, per-file, incremental, error-tolerant | symbols, imports/exports, JSX elements **+ literal attribute values**, call sites, comments, raw text |
| **Semantic**  | `LanguageService` / `Program` (lazy)             | heavy, whole-program                         | types, references, resolution, signatures, members, assignability, data-flow                          |

Both come from the **same grammar**, so the cheap structural index and the
expensive semantic oracle can never contradict each other on what the code _is_.
Non-TS assets are handled by purpose-built parsers where TS has nothing to say:
SCSS via `postcss`/`postcss-scss`, locale files as JSON. (Tree-sitter returns only
if we ever must index a language the TS parser can't read.)

---

## 5. Layered architecture (the "lego")

Bottom → top. Each layer depends only on those below it.

### L0 — Foundation (ported from `front-renamer`, generalized to long-lived)

`front-renamer` already solved the hard parts of safe edits over a VFS-backed LS.
We **port** its modules (not depend on the npm package) and make them persistent:

> **Every tool that interprets the project runs the project's _own_ version.** `typescript`,
> `prettier`, and the project's `tsconfig` / configs are resolved from the inspected repo's
> `node_modules` (the `front-renamer` approach); codemaster's bundled copies are a fallback
> only, and a header reports which is active. Answering with a different TS than the project
> compiles with would mean different diagnostics — i.e. a lie.

- **`vfs`** — in-memory overlay over the real FS. Powers zero-write dry-runs _and_
  backs the LS host. Shared by reads and edits.
- **`ts-host`** — builds and owns the long-lived `LanguageService` over the VFS host;
  incremental; resolves the project's own `typescript`/`tsconfig` (`paths`/`baseUrl`),
  bundled TS as fallback.
- **`module-resolve`** — import/path resolution incl. tsconfig aliases.
- **`text-edits`** — span-based edits, atomic application, conflict detection.
- **`git`** — root detection, dirty-tree gate, blame, log, snapshot/rollback.
- **`prettier`** — project prettier for post-edit formatting.

### L1 — Indexers (each authoritative in its zone)

Incremental, fed by the watcher:

- **structural** (TS syntactic AST) — the graph's backbone.
- **scss** (postcss-scss, **syntactic only**) — class declarations + literal usages in
  consumers. It does _not_ resolve `@use`/`@forward` or compute values, so cross-module
  orphan checks are reported `partial`, not asserted; computed-property work needs real
  `sass` (§19).
- **i18n** — keys from locale JSON, `t('…')` usages (template literals flagged `dynamic`),
  missing/orphan keys.
- **schema** — generated `schema.d.ts` → endpoint cards (input/response/path/query/body).

### L1 — Semantic query layer (the type oracle)

- **semantic** — the live LS query surface (`resolve` / `refs` / assignability / `impl`).
  Not an index: it answers from the warm `LanguageService` on demand — the ground truth for
  types (§3.1), never a cached snapshot.

### L1.5 — Framework adapters (plugins, autodetected + config-gated)

The generic core knows nothing about your stack; an adapter teaches it. An adapter
**enriches the graph during indexing** with framework nodes/edges (routes, `invalidates`
edges, stores) and declares the `list` registries it owns; it **self-registers at the
daemon** (the composition root). The `list` and `trace` primitives read only the graph and
the `AdapterRegistry` interface ([`src/core/adapter.ts`](src/core/adapter.ts)) — they never
import a concrete adapter, so the dependency points inward and **adding a framework changes
neither the core nor the primitives**. Shipping targets: TanStack Router (routes),
react-query (mutations/queries/queryKeys/invalidations), zustand (stores), forms,
component/dialog conventions.

### L2 — Graph & store

- **`GraphStore`** ([`src/index/store.ts`](src/index/store.ts)) — the access seam: store,
  update, and serve the graph through query methods (`get`, `nodesByKind`, `edgesFrom`,
  `commit`…). _Where_ it keeps the graph is hidden, so the backend can change — in-memory
  maps today, SQLite / off-heap on a huge workspace (§9) — without touching a consumer. Like
  tree-sitter, consumers get results and readonly views, never the raw representation. The
  in-memory backend is **copy-on-write per file shard**: `commit` synchronously builds the
  next version sharing every unchanged shard and replacing only the changed file's, so a swap
  is O(changed) in heap (§8). (Secondary indexes — `NodeId`→node, by-kind — are rebuilt with
  the same per-shard sharing.)
- **In-memory graph** ([`src/core/graph.ts`](src/core/graph.ts)) — the default backend's
  representation and the runtime source of truth for _structure_. Nodes are a
  **discriminated union** on `kind`: first-party
  kinds (`file`, `symbol`, `jsxElement`, `import`, `cssClass`, `i18nKey`) carry typed
  fields; framework concepts (route, store, mutation…) arrive as the generic `adapter`
  kind + an open `adapterKind`. Edges carry `provenance`. The one open "extras" bag (on
  adapter nodes / edges) is typed `Record<string, JsonValue>`, never `unknown`. **It holds
  no type fact** that could go stale — those are resolved live.
- **Persistence** — the graph lives in **memory** and is the runtime source of truth; disk
  is only a warm-start cache, never read to answer a query. It is flushed **lazily** —
  debounced after a quiet window, on idle, and on graceful shutdown — **never per change**,
  so an edit storm coalesces into one write, not thousands (SSD-safe by construction). The
  snapshot is **sharded per source file** (`nodes/<file>.json` + a small `manifest.json` of
  file → version + commit), so a changed file rewrites only its small shard — O(changed),
  not O(graph), never a monolith rewrite. A stale or partial snapshot is safe: on boot the
  §3.5 / §8 reconciliation re-indexes anything changed since the manifest, so an unflushed
  change at a crash only lengthens warm-start, never lies. JSON for now (§18); SQLite is the
  maturity option. The store is an accelerator, never the type oracle.
- **Freshness ledger** — per-file version stamps + git commit; the pending-reindex set.
  (`indexVersion` is the global swap counter; `fileVersions` holds the per-file stamps.)

### L3 — Core primitives (six universal verbs)

See [`src/primitives/contracts.ts`](src/primitives/contracts.ts). Small, composable,
proof-carrying, handle-addressable. **This is the lego.**

| Verb      | Does                                                                                                                      | Backed by           |
| --------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `search`  | find symbols / text / JSX by rich filters                                                                                 | structural index    |
| `resolve` | expanded type, signature, members, assignability                                                                          | **live LS**         |
| `refs`    | find-usages, faceted (call/jsx/import/type/read/write/impl)                                                               | **live LS**         |
| `trace`   | control- **and** data-flow (field→render/mutation/cacheKey/http, prop-through-tree, mutation→invalidation, type-widening) | LS + graph edges    |
| `list`    | domain registries (dialogs/routes/mutations/stores/endpoints…)                                                            | graph + registry    |
| `edit`    | refactors + codemods, dry-run-first                                                                                       | L0 + codemod engine |

Two notes. **`trace`/`list` read the graph and the `AdapterRegistry`, never a concrete
adapter** — an adapter folds its contribution in as _static_ nodes/edges at index time
(e.g. `invalidates`), so `trace` just follows graph edges and needs no runtime adapter
logic (keeps the §5-L1.5 seam honest). And the six compose under **`batch`** — one
round-trip carrying many requests, run against a single consistent graph version, `edit`s
last (§11).

### L4 — Recipes (thin composites)

"One call = full answer" tools, implemented **purely by composing L3** — they save
tokens, they don't add capability: `component_card`, `feature_map`, `mount_path`,
`find_unused_props`, `i18n_lookup`, `scss_class_diff`, `api_endpoint`, `why_this_line`,
`recent_changes`, `changed_since_branch`, `refactor_extract_container`, `impact`
(type-aware blast radius — the real type errors a change would cause, not just call edges),
`affected` (which tests a changed set touches, via the import graph).

### L5 — Surface

- **MCP tools** (see §11) + **output formatter** (see §12).

---

## 6. SymbolId & handles

`SymbolId` ([`src/core/ids.ts`](src/core/ids.ts)) is an **opaque, per-file-version-scoped**
handle encoding `(repoId, file, name, kind, fileVersion)`. It lets an agent chain
`search → resolve → refs → edit` without re-searching.

> **Bound to the file's version, with proof-carrying rebind.** A handle binds to _its
> file's_ version (`Graph.fileVersions`), not the global `indexVersion` — so a change to
> some _other_ file never stales it (essential when an agent thinks for 5–60 s between
> calls; a global binding would make the chain single-use). When the handle's own file
> _has_ changed, the verb re-locates the symbol and computes the answer against its
> current home, reporting the move on `Result.handle`
> (`{ status: 'rebound', to, proof, confidence }`) — **stated, never silent**.
>
> The `proof` span shows a symbol of that name/kind sits at `to` _now_ — proof of
> **location, not identity**. So the rebind carries a **`confidence`**: `certain` only with
> structural-continuity evidence; otherwise `partial`/`unresolved` + a note ("a symbol of
> this name/kind is here now; can't prove it's the one you held"). We never claim identity
> we can't prove — the exact lie this protocol exists to prevent. A cross-file move
> (`moveFile`/`extractSymbol`) is a `rebound` whose `to` is in the new file; `{ status:
'gone' }` means truly absent, not merely moved.

> **Branded identity primitives.** Beyond `SymbolId`, a small family of branded types
> (`RepoRelPath`, `Glob`, `RepoId`, `NodeId`, `IndexVersion`, `FileVersion` —
> [`src/core/brands.ts`](src/core/brands.ts)) makes category errors compile errors: a glob
> where a path is wanted, a per-file version where the global one is. Inputs arrive as
> plain strings and are branded at the boundary (zod / the indexer); config stays plain
> for authoring ergonomics.

---

## 7. Edit / refactor / codemod model

Dry-run is the default; `apply: true` is explicit. JSON recipes, zod-validated
with fail-fast `did you mean "…"?` errors (the `front-renamer` ergonomic). Git-aware:
refuses a dirty tree on apply, pre/post-typecheck, atomic, auto-rollback. Recipes are
designed so **an agent can author them blind, without reading docs** — the schema +
inline examples in the tool description are the documentation.

Two **distinct** edit families — conflating them is a code-rewriting lie:

- **Symbol-anchored** (`renameSymbol`, `moveFile`, `extractSymbol`, `changeSignature`):
  resolve the symbol through the **LS**, then edit its **semantic references**.
  Never fired from a textual/shape match.
- **Shape-based** (`codemod`): an **ast-grep** structural pattern (`<X prop={$V}>`).
  Operates on syntactic shape and **never claims to target a symbol** — so it can't
  accidentally rewrite a same-named unrelated binding.

> **Resync after our own writes.** On `apply`, `edit` swaps in a new graph version and
> marks the touched files dirty for the LS — **no locks, no synchronous barrier** (§8). It
> leans on the
> same read-time freshness check as everything else (§3.5, §8): the next query `stat()`s
> what it touches and reindexes if needed, so a double-fire from the watcher (seeing our
> own writes) or a missed event is **self-correcting**, not a stale window to defend.

---

## 8. Index lifecycle, watcher, freshness

> **The read path is the source of correctness; the watcher is an optimization** (§3.5).
> A query first takes a **repo-global** change fingerprint — `git rev-parse HEAD` +
> `git status --porcelain`, with a file-mtime stat-walk as the non-git fallback — against the
> version the index recorded. Being repo-global, it catches a file the answer _omitted_
> but shouldn't have (a watcher-missed add), not just files it touched. Drift → reindex the
> changed set from `git diff --name-only` (usually small: cheap) or, if that blows the
> latency budget (huge change, cold tier), return the answer with a `FreshnessNote`. Either
> way, never silent-stale. A fingerprint, **not** a per-file locking scheme.

- **Watcher** (debounced, optimization) → re-parse changed files (syntactic tier, cheap)
  → patch the graph → mark touched files dirty. It keeps the read path usually-fresh so
  the on-read check is normally a no-op; when it misses events, the on-read check covers us.
- **Semantic tier is lazy:** dirty files are recomputed on the next query that needs
  them, not eagerly. The LS is told which files changed; it reuses everything else.
- **Warm-start:** on daemon boot, load the snapshot, diff against the FS by mtime/hash,
  reindex only what changed. The snapshot is also re-validated on read, so one taken
  from a since-changed tree is caught, not trusted.
- **Concurrency.** The unit of isolation is the **workspace engine**. In `process` mode
  each runs in its own process → real **cross-workspace parallelism** and a non-blocking
  orchestrator. Within one workspace the engine is single-threaded and **serializes its own
  requests** (the TS LS is synchronous and non-reentrant anyway), so a cheap `search` may
  wait behind that workspace's heavy `trace` — acceptable: one agent rarely double-fires the
  same repo, and other workspaces are untouched. Inside the engine the graph is **immutable**,
  and the mechanism is deliberately simple: a **reader pins the version on request entry**
  (captures the `Graph` reference once and reads only from it, never re-reading `current`
  across an `await`), so a watcher swap mid-request can't tear its view. A **writer**
  (re-index, `edit`) does a **synchronous** build-and-swap of the single `current` pointer —
  atomic in one-threaded Node, bumping `indexVersion` — so writes never interleave (no
  write-lock) and never block readers; the old version is GC'd once its last reader finishes.
  The `readonly` graph types ([`src/core/graph.ts`](src/core/graph.ts)) are compile-time only;
  the runtime guarantee is **build-new-never-mutate-old**, with the `GraphStore` seam keeping
  the maps off consumers — so no `Object.freeze` is needed.
- **The orchestrator never blocks.** Many agents share one front door; it only routes, so a
  heavy call in one workspace cannot freeze the others (in `process` mode it is a different
  process entirely). Verbs are `Promise`-returning by contract precisely so a host call —
  a direct in-process call, or an IPC round-trip — is transparent. (`in-process` mode
  collapses everything onto one loop and one heap: a heavy call _does_ block there — the
  accepted price of a trivially debuggable dev default; `process` mode restores isolation.)

---

## 9. Memory & lifecycle

> **Decision (the dominant operational risk).** A live LS over 50k files is gigabytes of
> RAM and a slow warm; co-locating the graph with it (so queries don't serialize) makes the
> whole **workspace engine** the heavy thing. Cold start in minutes is acceptable; OOM is
> not — so each engine is isolated and killable, and that is how memory stays bounded.

- **Lazy spin-up** — a workspace engine is created on the first request for that repo
  (via its `ProjectHost`, §2); its LS warms lazily within it, on the first _semantic_ query.
- **Idle-TTL eviction** — after `daemon.idleEvictionMinutes` with no requests, the
  orchestrator **disposes the host**: in `process` mode that kills the child process and the
  OS reclaims **everything** (graph + LS) at once; in `in-process` mode it drops references
  for GC. A later request re-spawns and re-warms (snapshot warm-start + `.tsbuildinfo` keep
  that cheap).
- **Memory governor** — the orchestrator knows every workspace process and its RSS, so it
  evicts the LRU workspace when the total crosses a machine budget, protecting the user's
  box. (Meaningful in `process` mode.)
- **Monorepo = one engine, not one-per-package** — a single workspace process whose TS layer
  runs one `Program` per package `tsconfig` wired by **project-reference redirects** (what
  `tsserver` does), so each package keeps its own `compilerOptions` and cross-package
  references resolve in-memory — a flat single-options Program would be a lie (§19). Its heap
  is inherently large — tamed by a per-process `--max-old-space-size`, the memory governor,
  OS-reclaim-on-kill, and (if it ever bites) an off-heap `GraphStore` (§5-L2).

---

## 10. Configuration

`codemaster.config.ts` ([example](examples/codemaster.config.example.ts)), typed via
`defineConfig` so autocomplete _is_ the documentation. Intentionally **fat** — every
codebase has its own conventions — but every **section** is optional; enabling one may
require its key fields (`i18n` needs `locales`, `schema` needs `entrypoint`). Sections:
`index` (globs/ignore/packages/tsconfig), `i18n` (locales,
function names, template-literal handling), `scss` (module globs, import style),
`schema` (entrypoint, generator), `adapters` (which to enable), `output` (verbosity,
limits), `daemon` (idle eviction), `debug` (trace namespaces, log cap). The file is
loaded and **validated with zod** — an unknown key or wrong type fails fast with a
pointed message, not a deep crash. With no config at all it still works: defaults honor
`.gitignore` (nested + `!` negation), and always skip `node_modules`/`dist`/`build`/`.next`
and files > 1 MB. See [`src/config/config.ts`](src/config/config.ts).

---

## 11. MCP surface (lean by design)

> **Decision.** Every tool schema + its examples is loaded into the agent's context
> **every session, forever** — a fixed token tax that can cost more than the greps it
> saves. So the surface stays small:

- The **six verbs** (`search`, `resolve`, `refs`, `trace`, `list`, `edit`).
- **`batch`** — one tool carrying a list of requests (any mix of the six verbs); results
  come back in order, all reads sharing one consistent graph version. Saves an agent that
  already knows what it needs N round-trips.
- **`status`** — the first-contact manifest: active adapters, index counts, freshness,
  and a terse cheat-sheet of available recipes for _this_ repo. Teaches recipes
  **dynamically**, so they cost zero standing context.
- **`recipe`** — a single dispatcher tool taking a recipe `name` (enum) + args, instead
  of N fat recipe tools.
- A _small, deliberately chosen_ set of recipes (e.g. `component_card`) may be promoted
  to top-level tools if their value justifies the standing-context cost.

Usage guidance ships in the MCP `initialize` response — **not** an instructions file bolted
into `CLAUDE.md`/`AGENTS.md` — and it steers the agent to **query codemaster directly
rather than delegate to file-reading sub-agents** (the index already did that work; a
sub-agent grep/read loop just repeats it). `status` carries the same steer per repo.

---

## 12. Output format

Ultra-dense, coded, agent-first (the `front-renamer` house style: short codes +
one-line legend + sectioned summary). Rules:

- Always emit clickable `file:line`.
- Default cap with explicit `… N more (filter: …)` — never silent.
- `verbosity = terse | normal | full` and a `fields` selector let the agent dial
  token cost.
- `format=json` for machine composition (agent feeding one call into another).
- The default text mode carries the proof spans compactly; `terse` may elide span
  text and keep only `file:line` (the agent can re-`resolve` for the full span).
- **Size to the answer, not the file count:** when several results are interchangeable
  (near-duplicate implementations), show one in full and collapse the rest to signatures.

---

## 13. Debug & observability (for the agents building this tool)

Codemaster will mostly be _built and maintained by agents_. They need to see inside it —
richly, but compactly (debug output spends tokens too).

- **Namespaced traces, `debug`-library style.** Each subsystem logs under a namespace:
  `ipc`, `daemon`, `repo`, `watcher`, `index:structural|scss|i18n|schema`, `graph`,
  `ls` (lifecycle), `ls:resolve`, `ls:refs`, `adapter:<name>`, `primitive:<verb>`,
  `edit:plan`, `edit:apply`, `resync`, `eviction`, `snapshot`, `format`, `mcp`. Enabled
  by `CODEMASTER_DEBUG=ls:*,watcher,-eviction` (wildcards, `-` excludes), a config
  `debug` field, or **hot-toggled at runtime** over CLI/IPC (`codemaster debug ls:* on`)
  — the daemon lives, so you flip tracing on, reproduce, grep, flip off, no restart.

- **Correlation id via `AsyncLocalStorage`.** Every line is auto-tagged with the
  request's `req#N`, threaded through async hops by ALS — _not_ passed through every
  signature (concurrent calls would smear it). So `grep 'req#42' debug.log` yields the
  complete trace of one call. The single most useful debugging affordance.

- **One compact, greppable line per event:**

  ```
  12:00:01.234 req#42 primitive:search mode=symbol q=Button hits=1 3ms
  12:00:01.235 req#42 ls:resolve Button@src/Button.tsx:1 cache=miss 12ms
  12:00:01.236 req#42 resync touched=[src/a.ts] action=mark-dirty
  ```

  `k=v` pairs are machine-greppable (`grep cache=miss`, `grep 'ns=watcher'`); timings
  inline; big payloads elided with a length marker (`type=…(214ch)`), `--debug-full`
  expands.

- **Sinks, in priority order:** (1) a **rotating, size-capped** greppable log at
  `~/.codemaster/<repoId>/debug.log` — the primary surface the dev agent greps;
  (2) **stderr** for CLI runs. **Never stdout** — stdout is the agent-facing payload;
  mixing corrupts MCP. (3) An **opt-in, off-by-default** per-call `debug` flag returns
  that call's trace inline in a delimited trailer — off by default because it spends the
  _using_ agent's tokens for the _building_ agent's benefit (wrong pocket).

- **Self-describing & cheap-when-off.** `status` (and `debug:topics`) lists every
  namespace, so an agent discovers what to enable without docs. A disabled namespace
  no-ops after a single set-membership check and never builds its `k=v` strings — zero
  hot-path cost.

See [`src/core/debug.ts`](src/core/debug.ts).

---

## 14. Dependencies

- **`typescript`** — resolved from the target project (bundled fallback). LS + checker
  for both tiers.
- **`@ast-grep/napi`** — syntactic structural match/rewrite for shape-based codemods
  and JSX-shape `search`.
- **`postcss` + `postcss-scss`** — SCSS module analysis.
- **`diff`** — unified diffs for edit previews.
- **`chokidar`** — debounced file watching.
- **`@modelcontextprotocol/sdk`** — the MCP facade.
- **`zod`** — runtime validation at the boundaries where serialized/external data enters:
  config load, MCP tool args + edit recipes, IPC messages, snapshot envelope. Internal
  typed data is trusted — only the edges are guarded.
- **(ported) `front-renamer`** — L0 foundation + structural-refactor recipes.

No `ts-morph` (raw compiler API, as in `front-renamer`). No tree-sitter (§4).

---

## 15. Repository layout

```
codemaster/
  ARCHITECTURE.md            ← this file
  README.md
  package.json  tsconfig.json  .gitignore
  examples/
    codemaster.config.example.ts
  src/
    README.md                # module map & dependency contract (imports flow downward)
    bin.ts                   # CLI / entry → daemon or MCP
    core/
      brands.ts              # branded primitives: RepoRelPath, Glob, RepoId, NodeId, versions
      json.ts                # JsonValue — open bags are JSON, never `unknown`
      span.ts                # Loc, Span, Confidence, Provenance — proof primitives (leaf)
      result.ts              # proof-carrying envelope (Fact, FreshnessNote, ToolFailure, Result)
      ids.ts                 # SymbolId (per-file-version) + proof-carrying rebind
      graph.ts               # immutable, discriminated node/edge model (structure only)
      adapter.ts             # Adapter + AdapterRegistry seam (§5 L1.5)
      debug.ts               # namespaced tracing, AsyncLocalStorage req#N (§13)
    config/
      config.ts              # CodemasterConfig + defineConfig
    foundation/              # ported front-renamer: vfs, ts-host, module-resolve,
                             #   text-edits, git, prettier
    index/                   # store.ts (GraphStore — backend hidden), snapshot, freshness, watcher
    indexers/
      structural/  scss/  i18n/  schema/
    adapters/                # tanstack-router, react-query, zustand, ... (plugins)
    semantic/                # live LS query layer (resolve / refs / assignability)
    primitives/
      contracts.ts           # the six verb interfaces
      search.ts resolve.ts refs.ts trace.ts list.ts edit.ts
    refactor/                # ported front-renamer engine + ast-grep codemod engine
    recipes/                 # component_card, feature_map, ... (compose primitives)
    mcp/                     # MCP facade, self-describing tool defs, recipe dispatcher
    daemon/                  # orchestrator: front door, routing, lifecycle, governor + host.ts
    format/                  # dense formatter, codes, json mode
  test/
    README.md                # test layout (strategy in §16)
    helpers/                 # project() VFS mount, oracles (ripgrep, cold Program), scenario runner
    fixtures/
      _typings/              # shared .d.ts stubs (react, tanstack, zustand…) — no npm install
      inline/                # map → VFS project helpers
      repos/                 # committed mini-projects (monorepo, scss, i18n, dynamic-dispatch…)
      scenarios/             # *.scenario.ts transcripts (stateful sequences)
    differential/            # the oracle-backed invariants (§16)
    golden/                  # output snapshots
  docs/
    plan.md                  # implementation checklist (§17)
    about-ru.md              # long-form human guide (RU) — the "why" + big picture
    wishlist.md              # parked ideas, not yet scoped
```

---

## 16. Testing & honesty harness

Because "never lie" is the product, **every test needs an independent oracle** —
fixtures are only inputs; the comparison to ground truth is the test.

**Oracles.** `search --text` → ripgrep (we must be a superset). `resolve`/types →
a fresh-from-cold `ts.Program`. `refs` → the LS itself, compared **cold-rebuild vs
warm-daemon** (validating `refs` against `findReferences` when `refs` _is_
`findReferences` is circular — see the invariants below). `edit` → `git`
(byte-exact rollback) + `tsc --noEmit` on the result. Format → golden snapshots.

**Fixtures — mostly no folders.** The engine runs on a VFS, so most "projects" are
mounted from an in-memory map and run the full pipeline hermetically, in milliseconds,
with **no `npm install`** (framework surface comes from tiny `.d.ts` stubs in
`test/fixtures/_typings/`):

```ts
const p = project({
  'tsconfig.json': '{"compilerOptions":{"jsx":"react-jsx","strict":true}}',
  'src/Button.tsx': 'export const Button = (x:{size:string}) => <button>{x.size}</button>;',
  'src/App.tsx': 'import {Button as B} from \'./Button\'; export const App = () => <B size="lg"/>;',
});
// refs must include the aliased <B/> usage — grep would miss it:
assertRefs(await p.refs('Button@src/Button.tsx'), ['src/Button.tsx', 'src/App.tsx']);
```

Committed **repo folders** (`test/fixtures/repos/`) are reserved for realistic cases —
monorepo, large graphs, MCP end-to-end — and deliberately cover the traps the tool must
not lie about: aliased imports / re-exports / barrels, type-only imports, JSX with
literal/spread/computed props, **same-named symbols in different scopes**, dynamic
dispatch (must flag `dynamic`/`partial`), cross-package refs, compound/nested/orphan
SCSS classes, template-literal i18n keys.

**`refs ⊇ grep` does not hold** — semantic refs and textual matches are different sets,
neither a superset (grep hits comments, strings, `obj.Foo` on an unrelated type, `FooBar`
without a word boundary; the LS catches `import {Foo as F}` … `<F/>` that grep misses).
The harness rests on invariants that do:

1. **`search --text` ⊇ ripgrep** — by construction. Property-tested.
2. **Structural ⟷ semantic agreement** _(load-bearing)_ — where the
   `ts.createSourceFile` index and the LS overlap (a JSX usage, a symbol def), they
   **must agree**. Disagreement = the exact lie we forbid; fails CI loudly.
3. **Proof-span validity** — every emitted `Span.text` equals the live source at its
   range (the 1-based `Loc` ↔ 0-based TS-offset boundary is the usual culprit). A drifted
   span is a lie; asserted on every fixture query.
4. **Freshness honesty** _(guards the §3.5 / §8 read-time backstop — the highest-value
   scenario)_ — with the watcher silenced: mutate a file; **add** a file a find-all answer
   should include (e.g. a new `<Button/>` user); and `git checkout` another branch. After
   each, query: the answer must be reindexed-correct or carry a `FreshnessNote`, **never**
   silent-stale — including the _omitted-file_ case (a result missing an entry it should
   have had), which an answer-scoped check would miss.
5. **`cold == warm`** — for any state reached by a sequence of edits/mutations, the warm
   daemon's answer equals a cold-booted daemon's on the same files. Cheap regression
   insurance against incremental-index drift (not a defended microsecond invariant).
6. **Edit safety** — dry-run leaves `git status` clean; `diff(dry-run) == diff(apply)`;
   post-apply `tsc` clean; rollback restores byte-exact prior state.
7. **`refs` golden** — pinned against the LS on fixtures (regression net, not a
   correctness proof).
8. **Format golden** — dense-output stability. **Never the only assertion** for a
   correctness claim; always paired with an oracle.

**Determinism (an architecture requirement).** Scenario tests must not `sleep`. The
daemon takes injectable seams: a `clock` (no `Date.now`), a `watcher` interface (tests
call `fileChanged(path)` / `flushWatcher()` directly instead of awaiting real chokidar
events), and a `forceEvict` hook for the LS LRU. Real chokidar gets one separate smoke
test.

**Tooling:** `node:test` + `node:assert`, no heavy framework — matching the project's
lean-deps stance. **Pyramid:** unit (inline-VFS) · differential (oracle-backed, the
invariants above) · integration scenarios (`*.scenario.ts`) · edit-safety (git-backed) ·
golden · MCP end-to-end. CI gates hardest on invariants 1–6.

---

## 17. MVP roadmap

- **Phase 0 — Foundation.** Daemon + IPC + MCP facade + repo resolution; port L0 from
  `front-renamer`; structural indexer + watcher + read-time freshness backstop (§3.5/§8)
  - in-memory graph + snapshot; `status`; output formatter; debug subsystem (§13);
    honesty harness skeleton (§16).
- **Phase 1 — `search`** (A). Symbol/text/JSX with filters; stable `SymbolId`.
- **Phase 2 — `resolve` + `refs`** (B). Live LS query layer; assignability; the
  structural⟷semantic agreement test goes green.
- **Phase 3 — structural `edit`** (E). Port `front-renamer` engine behind `edit`;
  dry-run/apply; resync ownership (§7).
- **Phase 4 — recipes** (L4). `component_card`, `find_unused_props`, `impact` (type-aware
  blast radius), etc. — pure composition, big token wins, no new capability.
- **Phase 5 — i18n + scss** (C/D) indexers + their recipes.
- **Phase 6 — adapters + `list`** (G) and **git recipes** (I) incl. `affected` (changed
  files → tests).
- **Phase 7 — shape codemods** (F). ast-grep engine + declarative recipes.
- **Phase 8 — `trace` data-flow** (H). The hardest; stands on everything above;
  heavily proof-carrying and `partial`/`dynamic`-marked.

---

## 18. Formats & open questions

Wire and on-disk formats are plain, readable JSON: seeing exactly what crosses a channel
or sits in a snapshot is worth more than saved bytes here. Compact framing is an option
to reach for later, not a goal.

- **IPC** — newline-delimited JSON.
- **Snapshots** — JSON, **sharded per source file** (a change rewrites one small shard, not
  the monolith), flushed lazily — debounced / idle / shutdown, never per change (§5-L2).
  SQLite is the maturity option if write/read churn ever demands it.
- **i18n template-literal keys** — flagged `dynamic`, never guessed.

Open questions (no answer committed):

- **Recipe promotion** — which recipes, if any, earn a top-level MCP tool vs the `recipe`
  dispatcher (§11); decided per real usage once recipes exist.
- **Windows IPC** — unix socket today; named-pipe parity if it's wanted.

---

## 19. Platform & runtime — decisions for Phase 0

Where the design meets the OS and Node it must be explicit, because Phase 0 ships the daemon,
IPC, repo resolution, structural index, and the freshness backstop — the exact surfaces these
live on. (Surfaced by a runtime-soundness review.)

- **Path canonicalization (`RepoRelPath`)** — one minting chokepoint normalizes: forward
  slashes always; case-fold on case-insensitive volumes (APFS/NTFS — detected, not assumed),
  preserve case on case-sensitive ones; a fixed `realpath` symlink policy (pnpm / workspace
  symlinks). It is the graph key and part of `SymbolId`, so two spellings of one file must
  brand to one value, or freshness and `refs`/`rebind` silently misfire (§3.5, §6).
- **Non-git freshness is best-effort; git is the strong guarantee.** `git status --porcelain`
  handles racy-clean (re-hash on mtime tie); the non-git mtime fallback must copy that — size
  - mtime, treating a file within the FS mtime-resolution window of the recorded stamp as
    dirty (hash-on-tie) — else a same-tick edit is silently missed on coarse FS (HFS+, FAT,
    some network mounts). (§3.5, §8)
- **Monorepo LS = project references, not a flat Program.** One engine/process, but its TS
  layer runs one `Program` per package `tsconfig` wired by project-reference redirects (what
  `tsserver` does), so each package keeps its own `compilerOptions`. (§9; reconciles about-ru §10.)
- **Watcher is best-effort and must degrade, not crash.** chokidar 4 uses per-directory
  `fs.watch` on Linux → `ENOSPC` past `fs.inotify.max_user_watches` on large trees. Catch the
  watcher `error`, fall back to read-time-only freshness (still correct, §3.5), surface it in
  `status`, cap with polling on huge trees.
- **SCSS analysis is syntactic** (`postcss-scss` — a CST, not a resolved module graph or
  computed values): cross-`@use`/`@forward` orphan checks are `partial`; computed-property
  work needs real `sass`/dart-sass. (§5-L1, wishlist)
- **Daemon singleton.** Two concurrent launches converge on one daemon: atomic
  bind-or-connect (or a lockfile), unlink a stale socket after a liveness probe on
  `EADDRINUSE`, loser connects to the winner. (§2)
- **IPC endpoint portability.** Socket at a short, hashed path (a long `$HOME` or macOS
  `/var/folders` `os.tmpdir()` can blow `sun_path`'s ~104/108-byte limit) with a length
  assertion at bind. Add a `Transport` seam (mirroring `ProjectHost`) so a Windows named-pipe
  impl drops in later. (§2, §18)
- **`process`-mode child bootstrap.** Specify the child entry script and how it loads the
  engine when codemaster is global / `npx` (its `__dirname` is not in the project); how it
  resolves the **project's own TS** (resolve-from-project-root, passed as an arg — §5-L0);
  `--max-old-space-size` set at spawn from the governor budget; orphan-child reaping if the
  orchestrator is `SIGKILL`ed. (§2, §9)
- **Eviction is graceful.** Idle-TTL and the memory governor evict with `SIGTERM` → drain +
  flush → `SIGKILL` on timeout, so a normal eviction keeps its warm-start snapshot; hard-kill
  is the OOM emergency only. (§9)
- **No mid-call cancellation.** A synchronous LS call can't be interrupted; an abandoned query
  is dropped only _between_ serialized requests, never mid-call. (§8)
- **Graph immutability mechanism.** A reader **pins the version on request entry** (never
  re-reads `current` across an `await`); a writer does a **synchronous** build-and-swap of the
  single `current` pointer (atomic in one-threaded Node), so writes never interleave; old
  versions GC when their last reader finishes. The in-memory backend is **copy-on-write per
  file shard** (a commit is O(changed) in heap, not O(graph)). `readonly` is compile-time
  only — the runtime guarantee is build-new-never-mutate-old + the `GraphStore` seam hiding
  the maps; **no `Object.freeze`**. (§8, §5-L2)
- **Editor temp churn.** Atomic-save renames and swap/backup files (`.swp`, `~`, `.tmp`) are
  debounced, rename-over is treated as modify, and editor temp patterns join the default
  ignore set. (§10)

**Forward risk (state now; does not bite TS 6.x).** The semantic tier assumes the project's
own `typescript` exposes an **in-process, synchronous JS `LanguageService`** (§3.1, §5-L0).
The native (Go) TypeScript port may not — a project on it would break "drive the project's own
TS over our VFS host," needing that TS's own server protocol instead.
