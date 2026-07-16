# Codemaster — Architecture

> A stateful, always-on **codebase inspector** for TypeScript/React repos.
> A workspace engine loads a flat federation of **plugins** (one per domain — TS, SCSS,
> i18n, schema, framework adapters), watches the filesystem, keeps a live TypeScript
> Language Service warm inside the `ts` plugin, and answers agent queries through
> **ops** that compose plugins — densely, and without lying.

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
- **Never hang.** A hang is the _worst_ failure — worse than a wrong answer or a crash: it halts
  the agent entirely (no result, no fallback, all work stops). Every operation completes or fails
  within a bounded time; on overrun it returns an honest `ToolFailure{tool:'timeout'}` ("couldn't
  in N s — fall back"), never spins. No unbounded loop, no per-call work that scales with repo
  size. The latency budget above assumes _termination_ — see §19 for what is and isn't cancellable.

**Non-goals:** a human IDE, a linter, a language-agnostic universal index,
runtime/execution analysis, AI inside the tool. Codemaster is deterministic
plumbing that makes agents cheaper and more correct.

---

## 2. Process topology

```
agent ──MCP tool──▶ orchestrator (daemon) ──host──▶ workspace engine ──▶ dense reply
                    front door · routing ·          plugins (ts/scss/i18n/…/adapters) +
                    repo registry · lifecycle       ops (compose plugins)  (one workspace)
```

- **`codemaster` global bin** — entry point (`npx codemaster`, or installed).
- **Orchestrator (the daemon)** — one long-lived front-door process speaking MCP/IPC. It
  holds **no project data**: a `repoId → engine` registry, request routing (resolves the
  target workspace per request from the client `cwd` or an explicit `root` — a batch may
  span sibling repos), lifecycle (spawn / idle-TTL kill / path-existence eviction /
  restart), and a cross-workspace **memory governor** (§9). Its heap stays small and it
  only routes — the one exception is a **cross-root `sql` join**, which evaluates the
  engines' already-projected, ephemeral rows (thin data, never project state) in a
  transient in-memory SQLite at the front door (§11).
  **Machine-wide singleton (spec-daemon-singleton).** One daemon per user serves every
  `codemaster mcp` client: each `mcp` invocation is a thin **bridge** (a dumb stdio↔socket
  proxy holding no project state) that connects to the daemon over a unix socket, or — finding
  none — atomically spawns one and converges (bind-or-connect, §19). The warm LS(es) are thus
  amortized across all connections, not duplicated per worktree. The daemon idle-self-exits
  (zero open bridges, TTL) and unlinks its socket. **Honest scope:** a bridge's loop never
  blocks (no heavy work), so its stdin-EOF is always processed and a per-request reply deadline
  yields an honest `ToolFailure` if the daemon stalls — but a **permanently wedged daemon**
  (accepts-but-never-replies / a wedged sync loop holding the socket) is _not_ reaped here; that
  needs process-mode engine isolation + kill-on-deadline (§9, separate roadmap), though the
  user-facing **management verbs** (`codemaster daemon start|stop|restart|status`,
  spec-daemon-cli) give a manual path: a bounded socket-probe `status`, a control-message
  `stop` (graceful; honest "kill pid X" if the daemon is wedged past the deadline), and
  `restart` — the "pick up new code" command that kills the stale-code daemon so the next
  bridge spawns a fresh one. The internal long-lived process is spawned as `codemaster daemon
serve` (split from the management verbs). The
  `--in-process` flag bypasses the socket and serves a local orchestrator directly (debug /
  self-dev), carrying its own idle self-exit.
- **Workspace engine** — the whole machine for **one workspace** (a repo, or a monorepo
  root): all registered **plugins** (`ts`, `scss`, `i18n`, `schema`, framework adapters)
  with their internal state, plus the **ops** that compose them. Everything for that
  workspace runs **together in one memory space**, so an op can hop between plugins with
  zero serialization. Only a small `{op, args}` request and a small dense result cross the
  boundary to it — plugin internals never do.
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

The boundary sits where data flow is **thin** — between workspaces (which share nothing)
and at the front door — never inside the engine, where plugins and ops hop with zero
serialization through direct calls.

Rationale: a single daemon amortizes the expensive warm state (the `ts` plugin's LS
chiefly) across every agent call in a session, instead of paying cold-start per
invocation.

---

## 3. The trust contract (consistency engineering)

This is the section that the rest of the design serves.

1. **Each plugin is the only oracle for its domain, and never serves stale.** Type and
   semantic answers come from the `ts` plugin's live LS — synchronized to the current
   VFS state, not from a serialized snapshot; SCSS facts come from the `scss` plugin's
   current postcss parse; i18n keys come from the `i18n` plugin's current JSON state;
   adapter contributions come from their owning plugin's current scan. **A cached answer
   may exist inside a plugin only if it is rigorously invalidated against current file
   state**; serving an answer the plugin's own oracle would now contradict is the exact
   lie this contract forbids. (The `ts` plugin's whole-program _syntactic_ scan memos —
   `literalCalls`, `callArgShapes`, `functionDeclarations` — are such caches, each keyed on
   `projectVersion()`, which every reindex/overlay bumps, so they are invalidated against current
   state by construction. The OOM-survival syntactic-search surface memo (§5-L2, `syntactic-cache.ts`)
   is a second sanctioned cache with a DIFFERENT invalidation authority: it deliberately does NOT ride
   `projectVersion` — that stamp bumps only on a host reindex, which never fires for a re-modified
   untracked / member-only file the §10 scan surface includes — so it keys on a per-read repo-state
   fingerprint (HEAD ⊕ porcelain ⊕ a content hash of the bounded dirty+untracked set), invalidated
   against current disk on every read. A future opt-in plugin-internal _semantic_ memo with sound
   invalidation is a deferred wishlist item; not Phase 0.)

2. **Proof-carrying results.** Every fact carries `Span[]` (file, range, verbatim
   text). See [`src/core/result.ts`](src/core/result.ts). An agent that can verify
   cheaply will trust; one that can't, won't.

3. **Honest uncertainty.** `Confidence = certain | partial | unresolved | dynamic`,
   carried **per hop** (in trace ops) and **per site** (in find-usages ops), not just
   per answer. A dynamic-dispatch hop (callback, computed key, untyped boundary) is
   **flagged** at the step it occurs, not silently bridged or dropped. Orthogonally,
   edges and hops carry **provenance** — `syntactic` / `type` / `heuristic` (+ which
   adapter plugin) — so an adapter-inferred relationship is never mistaken for a proven
   structural fact.

4. **No silent truncation.** Capped result sets always report `{ shown, total, hint }`.
   Truncation that looks like completeness is a form of lying.

5. **Freshness is verified on read, never assumed from the watcher.** The honesty
   guarantee does **not** ride on the file watcher — watchers miss events, and the
   common case for an agent is a `git checkout` / rebase / stash bulk change, where
   `fs.watch` silently drops them and leaves a populated tree behind an empty
   pending-set. So the check is **repo-global, not answer-scoped** — an answer-scoped
   check would miss a file that _should_ have been in a find-all result but wasn't, which
   is itself a completeness lie (§3.4). Every query takes a cheap whole-repo fingerprint —
   `git rev-parse HEAD` **plus** `git status --porcelain` (adds/removes/dirty in one
   call), with a file-mtime rollup as the non-git fallback — a **bounded, burst-coalesced**
   stat-walk (never follows a symlink, is depth/entry/time-capped per §1, and is not re-run at
   repo scale on every op — a short debounce reuses the prior fingerprint within a ~1s window,
   so a same-second non-git edit is best-effort, §19). On drift, the changed set comes
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

7. **Self-honesty harness** (see §16): every plugin is tested against an independent
   oracle for its domain; every cross-plugin op is tested for correctness on assembled
   fixtures, never against grep.

---

## 4. Parsing model — one parser per domain

> **No tree-sitter. Each plugin owns its parser.**

Codemaster has no standalone "structural index" built ahead of the LanguageService — that
would be a parallel copy of what TS already parses, with its own staleness problem. Each
plugin owns the parser for its domain and is the only oracle for it:

| Domain             | Plugin              | Parser                                                           | Cost                                    |
| ------------------ | ------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| TypeScript / TSX   | `plugins/ts`        | TS `LanguageService` (AST + types)                               | AST lazy per-file; types lazy on demand |
| SCSS modules       | `plugins/scss`      | `postcss` + `postcss-scss` (CST only)                            | cheap, per-file, syntactic only (§19)   |
| Locale JSON        | `plugins/i18n`      | `ts.parseJsonText` (position-carrying JSON AST)                  | trivial; dotted-key flatten, spans      |
| Generated schema   | `plugins/schema`    | `ts.createSourceFile` AST over openapi-typescript `openapi.d.ts` | one-shot per session                    |
| Framework concepts | `plugins/<adapter>` | consumes `ts` plugin's API                                       | derived, no own parser                  |

For TypeScript specifically, the TS LS exposes both depths inside one engine: cheap
`SourceFile` access (already cached after first touch) for structural queries — symbols,
imports/exports, JSX elements + literal attribute values — and the type checker for
semantic ones (types, references, signatures, assignability). The `ts` plugin uses
both depths through one LS, so a "syntactic vs semantic" disagreement can never happen
within it — there is only one parser.

**Bounded exception — the LS-relocation rescue's second TS (§14).** The LS-driven symbol
relocations — `extract_symbol` ("Move to file" into a NEW dest) and `move_symbol` ("Move to file"
into an existing dest) — build their edits from a patched TypeScript fork
(`@cevek/typescript-extract-refactor-fix`) _only_ when the project's own LS throws one of the two
recognized internal assertions — `Expected symbol to be a module` (e.g. the moved block uses a
css-module member) or `Changes overlap` (overlapping edits, e.g. mutually-recursive symbols). This
does not break "one parser per domain": the fork
is an **edit producer, not a fact oracle** — its edits are verified by the **project's own** LS
post-typecheck (the §2.8 gate runs on `host.service`, never the fork), it is gated to the project's
TS major (a mismatch declines the rescue), and the provenance is surfaced (`rescued` → an envelope
note). An unavailable or failed rescue fails honestly with the `ts-ls` category — never a guessed
edit. No fact codemaster reports ever originates from the fork.

**Co-move pre-empt (upstream of the rescue).** A whole class of the `Changes overlap` / `Import
declaration conflicts with local declaration` shapes — co-moving mutually-referencing symbols into one
module, where the dest already imports the moved symbol or already declares its dependency — is
handled by two `move_symbol`/`extract_symbol` **normalizers** that run around the LS, not by the fork:
a **pre-strip** (`refactor/imports/strip-moved-preimport.ts`) removes the dest's un-aliased pre-import
of the moved symbol _before_ the LS runs (so the LS emits a clean single-edit instead of two
overlapping edits to one import statement), and a **self-import strip**
(`refactor/normalize/strip-self-import.ts`) drops the redundant `import … from '<self>'` the LS emits
_after_ into the dest. These stay within "reshape the LS's edit text" — no new oracle, the §2.8
typecheck + capture gate is still the backstop — so a co-move now completes in any step order without a
leaf-first reorder. The rescue fork still serves the residual overlap shapes these don't pre-empt.

**Not an exception — `@internal`-helper reuse on the same parser.** `search_symbol { syntactic: true }`
and `symbols_overview` (the OOM-survival discovery paths, §5-L2 / t-515730 / t-143952) parse files with the
**same** `ts.createSourceFile` (a shared surface build) and read them with the TS `@internal`
`getNamedDeclarations` helper (the declaration set) — both share the `createPatternMatcher` wrapper
(navto's own name matcher, project-agnostic — `syntactic-matcher.ts`) for their fuzzy match:
`search_symbol` for its query, `symbols_overview` for its optional `query` name filter (t-960572);
`symbols_overview` otherwise enumerates the whole surface. This is **not** a second parser
or a second oracle: there is one AST, produced by the one TS parser; the helpers only read it. It is
purely a note about **`@internal`-API stability** — the helpers are absent from the public
`typescript.d.ts`, so they are behind a single typed `as unknown as` boundary block (never `any`) and
**capability-guarded**: a TS bump that drops either makes the path return an honest `ToolFailure`
(never a crash or a guessed empty), and a shape drift is caught by the syntactic-⊇-navto oracle test.

Tree-sitter returns only if we ever must index a language the TS parser can't read.

---

## 5. Layered architecture — plugins + ops

> The domain layer is a **flat federation of plugins**. Each plugin owns its knowledge of
> one domain with its own internal storage; **ops** compose plugins to answer agent
> queries. There is **no central graph and no central store** — each plugin's data lives
> behind its own public API, and cross-tier joins are recipe-level work the op does in
> code, not a stored edge in a shared model.

Bottom → top. Imports flow downward only.

### L0 — Core (leaf)

[`src/core/`](src/core/) — types only, imports nothing internal:

- **`brands`** — `RepoRelPath`, `Glob`, `RepoId`, `FileVersion` — branded primitives (§19).
- **`span`** — `Loc`, `Span`, `Confidence`, `Provenance` — proof primitives.
- **`result`** — `Result<T>` envelope: `Fact`, `FreshnessNote`, `ToolFailure`, `Truncation`.
- **`ids`** — `SymbolId` (module-routed encoding) + proof-carrying rebind (§6).
- **`plugin`** — the `Plugin` interface + `PluginRegistry` — the single contract every
  domain module obeys.
- **`json`** — `JsonValue`.
- **`debug`** — namespaced tracing + `AsyncLocalStorage` `req#N` (§13).

### L0.5 — Common (pure logic, no I/O)

[`src/common/`](src/common/) — pure logic operating on core types; **no external tools,
no I/O, no timers** (a clock seam is the only "time" allowed). Imports `core/` only.
Everything above L0.5 can use it.

The bright-line: if a helper touches the filesystem, network, child processes, or
real-time directly, it belongs in `support/`. Otherwise — `common/`. This keeps the
junk-drawer pressure off `core/` ("types only") and `support/` ("external-tool
wrappers"), and gives every plugin and op the same shared vocabulary of pure helpers.

**Internal layout — strict.** Nothing lives at the root of `common/`; everything goes
into a topical subfolder, one concept per folder, one operation per file. No
`utils.ts` / `helpers.ts` / `misc.ts` — files are named by the operation
(`construct.ts`, `merge.ts`, `parse.ts`), not by the type of contents. When a
subfolder reaches ~5 files it gets split into sub-subfolders.

Initial topics (each populated as Phase 0+ work demands):

- **`result/`** — `Result.ok` / `Result.fail` / `Result.partial` constructors;
  `isOk` / `isFailure` narrowers; `mergeFreshness` / `combineFailures` aggregators.
- **`ids/`** — `SymbolId` codec (encode/decode the plugin-prefix-routed format).
- **`span/`** — `contains` / `intersects` / `equals`; `extractText` (1-based `Loc` ↔
  0-based offset bridge — the §16 invariant 1 hotspot).
- **`confidence/`** — `worstOf` and other reducers, used by per-hop trace aggregation.
- **`trace/`** — the domain-neutral trace-hop contract (`TraceNode` / `TraceHop` +
  `makeNode` / `makeHop` / `dedupHops`). Every `trace_*` op (§17 build order, Phase 6) emits this
  one shape; node identity is `SymbolId`-else-`kind@file:line:col`.
- **`fingerprint/`** — `FileFingerprint` shape + comparators with the §19 mtime-tie
  hash semantics. The currency every plugin's `freshness()` deals in.
- **`plugin-registry/`** — topological sort + cycle detection, the algorithm the
  `PluginRegistry` runs at init.
- **`async/`** — `Clock` interface (injectable seam for tests, §16); `debounce` /
  `deferred` / `withTimeout` built on top of `Clock`.
- **`debug-spec/`** — parse `'plugin:ts:*,watcher,-eviction'` into a matcher
  (`DebugSystem.configure` consumes this, §13).
- **`lru/`** — generic LRU map, used by the orchestrator's memory governor (§9) and
  anything else that needs bounded caching.

### L1 — Support (external-tool wrappers)

[`src/support/`](src/support/) — wrappers around external tools and I/O. Each tool
gets its own subfolder; same "one operation per file" rule as `common/`.

- **`git/`** — repo root, dirty-tree gate, `HEAD` + `--porcelain` fingerprint (§3.5),
  `diff --name-only`, blame, log, snapshot/rollback.
- **`prettier/`** — invoke the **project's own** prettier for post-edit formatting.
- **`text-edits/`** — span-based edits, atomic application, conflict detection.
- **`fs/`** — recursive file walking with a built-in ignore set (the **non-git fallback** — git
  `ls-files` is the `.gitignore`-aware listing the engine prefers); `realpath` canonicalization;
  `stat` → `FileFingerprint`.

> **Every tool that interprets the project runs the project's _own_ version** —
> `typescript` (inside `plugins/ts`) and `tsconfig` are resolved from the inspected repo's
> `node_modules`, with codemaster's bundled copy a fallback only, and the response reports
> which is active. Answering with a different `tsc` than the project compiles with would mean
> different diagnostics — a lie. `prettier` (here) is resolved from the project **with no
> bundled fallback**: restyling a repo that never opted into prettier (no install, or no
> config) with codemaster's copy would be the same kind of lie, so absent project prettier
> the file is written unformatted.

No domain knowledge here. Plugins use these; ops use these.

### L2 — Plugins (the only domain layer)

[`src/plugins/<id>/`](src/plugins/) — each plugin owns one knowledge domain. Plugin
internals are completely opaque to the rest of the system: they keep their data however
they please (in-memory map, typed arrays, an internal graph, whatever). The only public
contract is the methods they expose.

The `Plugin` interface ([`src/core/plugin.ts`](src/core/plugin.ts)):

```ts
interface Plugin {
  readonly id: string; // 'ts', 'scss', 'react-query', ...
  readonly version: string; // surfaced through status()
  readonly deps: readonly string[]; // plugin ids this plugin uses
  init(deps: PluginRegistry): Promise<void>; // bind dependencies
  dispose(): Promise<void>; // release resources
  freshness(): FreshnessFingerprint; // for §3.5 read-time check
  reindex(changed: readonly RepoRelPath[]): Promise<void>; // apply git-diff changed set
  pending(): readonly RepoRelPath[]; // surfaces in FreshnessNote.staleFiles
}
```

Beyond these life-cycle bits, **each plugin defines its own public methods**. There is
no enforced superset of methods — no "all plugins must have `findUsages`". Ops know
which methods each plugin provides through TypeScript types; no runtime feature
probing.

**Built-in plugins shipped with codemaster:**

- **`ts`** — the TypeScript plugin. Owns its own VFS (in-memory overlay), the long-lived
  `LanguageService` (the type oracle for §3.1), module resolution (`tsconfig`
  `paths`/`baseUrl`), and all TS-domain knowledge: symbols, imports, JSX usages, refs,
  types. LS warms **lazily** on the first semantic query — structural queries don't
  trigger warm. The heavyweight plugin: gigabytes for large projects (§9).
  **Multi-program (§9/§19).** The host loads the **primary** program (the root tsconfig —
  the mutation/typecheck target) plus the repo's **sibling** programs (adjacent `tsconfig.*.json`,
  transitive `references`, AND every `package.json`-anchored PACKAGE — a dir carrying its own
  `package.json`, whether a workspace-glob member or an ISOLATED nested package with no workspace
  manifest at all: the near-universal `tsconfig.test.json`, Vite's app/node split, a pnpm/vite
  monorepo's packages, build configs, a repo's whole `web/` frontend), each keeping its **own**
  `compilerOptions` (a flat single-options Program would be a lie). Siblings are discovered once and warmed **lazily** on the first cross-program
  read; the stock-TS programs share one `DocumentRegistry` so files common to two configs
  parse once. `find_usages` / `referenceSpans` / `importers_of` fan out across every program
  containing the target and merge+dedup the sites; `find_unused_exports` checks the primary
  first then fans out only for candidates dead-in-primary (cost short-circuit). So a symbol
  used only from a `test/**` file is honestly counted as used, not falsely reported dead.
  **`find_definition` resolves against the CONTAINING program** (`sourceFileAcross`, primary-first +
  lazy), not the primary only — so a declaration in a sibling / isolated-package program is located,
  not an opaque "Could not find source file" throw (t-773499). Unlike references (which merge across
  programs), a definition is a fixed set from the one program that owns the position, so a
  primary-resident target stays byte-identical.
  **`importers_of` MODULE-mode resolution honesty (§3.6).** The result carries `resolved`: a module
  spec that does NOT resolve to a file under the project's own resolution (a typo'd / out-of-project
  path) reads as a LOUD `module unresolved: X` — distinct from an honest resolved-0 (a real module
  nothing imports). A `0` under an unresolved arg is almost certainly a bad arg, never proof nothing
  depends on it; conflating the two would be the silent-0 lie the §3.6 honesty forbids. (An
  unresolvable spec that still has importers — a `.scss` path — matched them by LITERAL string, and
  says so.) Orthogonal to the undiscovered-program floor below, which independently caps a resolved-0.
  A `resolved:false` under a DEGENERATE primary (a broken / empty-`include` tsconfig covering 0 project
  files) is attributed to the empty program, NOT the arg — the op discloses "primary program covers no
  files" instead of the misleading "pass a repo-relative path" arg-blame steer (t-784222). The note is
  gated on `resolved:false`: an existing-file arg resolves via `ts.sys.fileExists` INDEPENDENT of the
  primary's file set, so under an empty primary it is `resolved:true` — a resolved-0 there falls through
  to the honest "0 importers", never a non-resolution claim beside `resolved:true`.
  **`importers_of` SUBTREE mode.** When the arg names a DIRECTORY (`ts.sys.directoryExists`, or a
  trailing slash) rather than a file, `importers_of` answers "who imports ANYTHING under this folder"
  — the "safe to delete this folder?" question — in one call. Detection is **directory-wins** (the
  dir check runs BEFORE module resolution, so an index-bearing folder is never collapsed to its
  barrel, which would silently drop the folder's deep importers — a §3.4 omission); a dir/file name
  collision resolves to the directory (name `foo.ts` for the file). Matching is by RESOLVED target
  path-containment under the tree (per-program options), **never** a raw-string compare. Importers
  partition into **external** (own file outside the tree = deletion BLOCKERS, the headline `blockers`
  count of distinct files) and **internal** (own file inside — counted + kept, non-blocking, never
  silently dropped). An import whose spec does NOT resolve to a file but whose relative-lexical target
  lands under the tree is FLAGGED `unconfirmed` (a `.scss` / unresolvable spec), never raw-matched
  (no false-LIVE). `safe` is true only when `blockers=0 ∧ complete (all programs scanned) ∧
unconfirmed=0`; the §3.4 undiscovered-program floor still applies. The affirmative `safe` verdict
  discloses the scan's limit — **static import/export only; a dynamic `import()`/`require()` of a
  file under the tree is NOT traced** (inherited from `importersOf`, as `affected` discloses the same
  for its transitive walk). Engine in `plugins/ts/importers-subtree.ts`.
  Discovery is adjacent-`tsconfig*.json` + transitive `references` + **packages** (`program/discover.ts`
  `packageConfigs`): a `tsconfig*.json` whose DIRECTORY holds a `package.json` — a workspace-glob member
  OR a truly ISOLATED nested package (its own tsconfig+package.json, NOT referenced and NOT a
  workspaces-glob member, t-865312). The `package.json` presence is the SOLE anchor (a workspace-glob
  match is NOT needed), because a repo whose entire frontend lives under a nested `web/` (its own
  tsconfig+package.json, no workspace manifest at all) otherwise floored every symbol op on that package:
  a bare-NAME query has no target file for the read-path nearest-config discovery to anchor on, so the
  program never loaded and the symbol read as "not found anywhere" (root-override was the only escape).
  A pnpm/vite monorepo wires packages by GLOB not `references`, so members are otherwise undiscovered
  too. Guards keep the anchor from over-indexing a foreign repo: a bare nested/fixture tsconfig WITHOUT a
  `package.json` is **not** slurped (→ stays undiscovered/floored, the `programs:` lever's job); a
  package.json dir under a §10-ignored path (`node_modules`/`dist`/`.claude`/…) never reaches discovery
  (the shared walk filters it upstream); a workspace-NEGATED (`!`-glob) dir is honored as an explicit
  exclusion; and the ROOT dir + the primary's own directory are never dir-packages (a root-level
  `tsconfig.test.json` is an adjacent glob-based sibling). Discovery is §19-bounded — the `package.json`
  probe rides the ONE cached repo walk, never a per-query repo-scale scan. **Member-stray INJECTION
  (`program/coverage.ts`, t-232769).** Here "member" means any discovered **package** (a workspace
  member OR an isolated nested package, t-865312) — the coverage machinery is package.json-anchored and
  treats them identically. A git-tracked TS-source file physically under a package's dir
  that the package's OWN tsconfig `include` omits (the near-universal `packages/x/scripts/smoke.ts`
  under `include:["src"]`) is a **stray-for-that-package**: it is INJECTED into that package's own
  `SingleProgram` file-set (`createSingleProgram` `injectedFiles`), so it compiles under the member's
  OWN compilerOptions and its alias imports (`@x/*`) resolve exactly as the member's src does — the
  file becomes SEARCH-surface, never a new type authority. **POLLUTION GATE:** a stray is injected ONLY
  when it is a plain external MODULE with no program-wide type-space augmentation — a file carrying
  `declare global`/`declare module '…'`, or a non-module SCRIPT (whose top-level decls are global),
  would once in the member's program SHIFT the reported type of the member's OWN src symbols
  (`expand_type` would show a type the member's real tsconfig never yields — the never-lie violation),
  so it is NOT injected and its member STAYS floored (honestly unsearched beats a lie about a src
  symbol's type). So a member is SUBTRACTED from the undiscovered floor once it covers ANYTHING (its
  own glob, a `references` hub, or an injected stray) AND has no un-injectable stray left unsearched; a
  member covering literally nothing (empty `include`, no refs, no files under its dir) stays floored.
  The stray set is source-derived (not tsconfig-derived), so the coverage memo also refreshes when a
  reindex sees a NEW git-tracked TS file land under a member dir — a warm daemon injects a just-added
  stray on the next query instead of missing its usage while reporting complete (a §3.4/§3.5 lie).
  The gate is the member's OWN glob, NOT the whole covered-union: a stray an ANCESTOR loose-root globs
  with the WRONG options (no member `paths`) is STILL injected into its member — else its aliases
  resolve only under the ancestor (they don't) and the usage is silently missed while the member
  un-floors (the wrong-options coverage lie). **The floor honesty rests on the CORRECT-RESOLUTION
  UNION**: a file counts as covered (→ subtract its config → allow `complete:true`) ONLY when a program
  with real compilerOptions (a member/sibling, or the primary when it HAS a config) — or an injected
  stray — searches it. The no-config FALLBACK primary (whole-repo glob, NO `paths`/`baseUrl`) is
  EXCLUDED from the union, so a file covered ONLY by it (aliases never resolved) never subtracts its
  config → stays floored, on ANY repo (not by fixture coincidence). A config whose entire glob ⊆ the
  correct-resolution union (a redundant base/extends config, e.g. `tsconfig.base.json`) is subtracted;
  a config globbing any uncovered or fallback-only file stays floored — never a claimed-complete result
  over a file no correct-options program searches (§3.4). The scope discriminator is the **§10 source
  surface** (the name-ignore set ∪ the project's own git-ignore), NOT tsconfig-membership: a file the
  project itself declares junk (gitignored, or under `node_modules`/`dist`/…) is OUT of scope and never
  a stray, while a git-tracked source file merely absent from every tsconfig is IN the surface →
  floored (unless owned+injected by a member). Coverage and the injecting `single.ts` apply the SAME
  §10 filter (symmetric with what the programs actually contain — no phantom strays). Coverage is a
  §19-bounded SYNTACTIC pass (parsed file-sets + `primary.fileNames()` when the primary has a config,
  no LS warm) over the shared repo walk, run once per undiscovered memo. A
  nested-package config reachable by none of the three is **not** loaded, so the read ops carry an honest floor — when any such
  **undiscovered** config exists (a one-time cached repo walk), `find_unused_exports` demotes every
  otherwise-`certain` claim to `partial`, and `find_usages` / `importers_of` / bare-NAME
  `find_definition` report a set-level `complete:false` + the **named** config + a `!!` LOWER-BOUND
  note (a count-only consumer sees the incompleteness without parsing prose) — never a silent
  false-`certain`-dead / a confident-`0` over a possibly-incomplete search, nor a confident single
  definition when a same-named symbol may live unindexed (§3.4/§3.6). (`find_definition`'s floor fires
  ONLY on a name-WITHOUT-a-file-pin: a `symbolId`/position/`name`+`file` target is an EXACT resolution
  where a cross-program twin is irrelevant, so it stays byte-identical — a floor there would dress a
  complete answer as partial.) **File-driven nearest-config discovery (read path).** Beyond
  the adjacent/`references` siblings, a READ whose target file's _nearest enclosing_ tsconfig is a
  nested config the loose-root primary globs WITHOUT its `paths`/`baseUrl` alias loads THAT config
  lazily as an extra read-only program (cached, idempotent, per-dir memoized — never a per-query
  repo walk, §19); the cross-program fan-out then merges its references, so a component used only via
  the nested alias is found, not falsely read as `0` usages. Loaded ONLY from read paths (the
  `find_usages` family via `findReferencesAcross(loadNearest:true)`, and `importers_of`); **WRITE
  paths (`rename_symbol` / `change_signature`) fan out over a BUILT-only containment set**
  (`builtContaining` — primary + siblings, never the file-driven programs), so a mutation's edit set
  is session-order-independent and consistent with the §2.8 gate (which runs over `built()`) — a
  read-path-loaded nested program can never add an un-gated rename/caller rewrite. The **primary
  stays the edit target** (the loose-root-monorepo wrong-primary-for-mutation cousin is a
  `task-manager` backlog residual). A loaded config is subtracted from the undiscovered set (no
  over-demotion). (Precise per-export discovery is the remaining `task-manager` backlog residual.)
  **Writes fan out too:** `rename_symbol` / `change_signature` compute their edit sites across
  every containing program (a `test/**` reference is rewritten, not left dangling) — but a rename
  whose TARGET DECLARATION is itself outside the primary is REFUSED with an actionable `root:<pkg>`
  redirect (t-773499): the capture-safety gate is structurally primary-only (`setOverlay`), so it
  cannot verify a foreign-anchored rename, and shipping a reduced-safety MUTATION when a fully
  capture-checked path exists (re-run with the owning package as `root`) is the wrong trade — a read
  (`find_definition`) still resolves the same target; only the write refuses. `move_file`
  / `extract_symbol` repoint sibling-only importers via a disk read, and the §2.8 typecheck gate
  runs the overlay check on **every affected program** + the disk baseline over the same set —
  so a cross-program dangle is caught, never a silent partial edit. A program is **affected** when
  it contains an edited file _or its glob would own one_ (existence-independent membership) — so the
  program owning a move/extract DEST joins the gate and a moved file erroneous under that dest
  tsconfig's _own_ compilerOptions (a divergent `lib`/`strict`) is refused, not only a dangling
  import; each program is overlaid with only the files it owns (baseline/overlay stay symmetric), and
  a SIBLING program whose LS throws degrades to a note (the PRIMARY's throw is never swallowed — it
  fails honestly). (Inside a `transaction` the
  write-site fan-out is gated off — a step's `PlanningOverlay` lives on the primary, so a sibling
  would read stale disk; the fanned gate still refuses a resulting dangle — backlog.) (The full
  monorepo project-reference _redirect_ graph stays roadmap; this is the
  discover-and-load-as-independent-programs step the usage/dead-code honesty needs.)
  **OOM-survival syntactic search (`searchSymbolSyntactic`, t-515730).** First-contact `search_symbol`
  (fuzzy) fans navto across ALL programs → can OOM a huge monorepo, and in `in-process` mode an OOM is
  uncatchable → kills the shared daemon. So `{syntactic:true}` is an opt-in path that answers WITHOUT
  building any program and NEVER warms the LS (the plugin stays cold): it parses the §10 git source
  surface with `ts.createSourceFile` and reads it with the `@internal` `getNamedDeclarations` +
  `createPatternMatcher` (§4 — same parser, capability-guarded). It is COMPLETE for declarations in
  git-tracked source UNDER the workspace root (≥ navto's recall there) but noisier (extra import /
  re-export sites; real declarations ranked first) and carries `provenance:'syntactic'`. **Honest
  scope (t-515730):** a git listing at the root cannot see a tsconfig `include`/`reference` reaching
  OUTSIDE the root, so such outside-root symbols are not scanned — the op DISCLOSES this positively
  ("scanned all git-tracked source under <root>; outside-root not covered — use the default"), never
  a false "never misses" (§3.6). A pre-emptive hint lives in the STATIC schema/notes (§11), since
  after an in-process OOM the daemon is dead and can't advise post-hoc. The parsed surface is memoized
  per-plugin-instance (`syntactic-cache.ts`) keyed on a repo-state fingerprint the syntactic path can
  trust — NOT `projectVersion` (which won't bump for a re-modified untracked / member-only file the
  §10 surface includes), so the hot path is O(changed+untracked), never a per-query whole-surface
  stat-walk (§1). The syntactic path leaves navto's default output untouched (navto at terse/normal
  stays byte-identical; `verbosity:'full'` adds an opt-in header-only decl preview per match, t-517121).
  **`symbols_overview` rides the same no-program surface (t-143952).** A first-contact ORIENTATION browse:
  a flat, comma-separated catalogue of the repo's TOP-LEVEL declared symbol NAMES (bare — no
  `file:line` decoration, so thousands fit), grouped per tsconfig. It reuses the SAME `surfaceSources`
  parse + `getNamedDeclarations` (`syntactic-catalogue.ts`, `listSymbols`) — no program build, NEVER
  warms the LS (OOM-safe, exactly where a name-addressed navto path OOMs). `exportedOnly` defaults on
  (the public surface, syntactic — an export/default modifier or a re-export specifier, evaluated
  across the name's node set so a separately-`export {X}`ed name is never dropped under a `kind`
  filter). The per-tsconfig GROUPING is a best-effort layer (`configMembership`,
  `program/config-membership.ts`): host-free + bounded (capped config count + globbed files + throw →
  a single flat `(all)` group), computed per call (never cached — the surface fingerprint can't see a
  `.json` edit, §3.5). A file included by several configs lands under ONE primary config (deepest-dir,
  base-`tsconfig.json` tie-break), flagged `(shared: also in …)`, never double-counted / dropped; the
  flat blob dedups globally. Same honest scope as the syntactic search (under-root only) + per-group
  caps with `+N more` and a verdict-first totals line (§3.4/§12). **Density render (t-757714):** group
  headers show the SHORT config label (the redundant standard `/tsconfig.json` basename dropped — dir
  kept, a variant basename like `tsconfig.test.json` and a root config preserved, so the short→full map
  stays unique/lossless); groups are ordered by name-count DESC (the real project surface leads, small
  fixture groups sink) with a path-asc tie-break (deterministic → cold == warm); and `duplicatesOnly`
  emits a one-line config LEGEND (`configs: A=…, B=…`, path-asc codes, verdict-first so the char-cap
  can't strip a code) with each collision referencing the codes (`name ×N (A|B)`) instead of repeating
  the long paths per row. The `note` is terse: the always-on line carries the ever-relevant honesty
  signals (syntactic-not-verified · outside-root-not-covered · pick→search) plus the exported-surface /
  `all` caveat; the histogram multi-bucket and `duplicatesOnly`-definition caveats are appended ONLY
  under their flag (no wall of prose when inactive) — every signal kept, none dropped silently (§3.4).
  **ORIENTATION FACETS (t-960572)** — five cheap views on that SAME one no-program pass (no extra scan,
  no LS warm), each OFF by default so the flat catalogue stays byte-stable: `query` (navto fuzzy name
  filter — the SHARED `createPatternMatcher`, `syntactic-matcher.ts`, that the syntactic search reuses;
  applied to each parsed name BEFORE the per-group cap, so a narrowed catalogue is still
  capped-with-honesty; a `query` whose @internal matcher is unavailable fails honestly, never a silent
  unfiltered dump); `summary`/`countsOnly` (a kind HISTOGRAM + per-config totals of the FULL
  post-filter set — never the capped body; MULTI-BUCKET: a value+type merged name counts in EACH kind
  bucket, so buckets may sum above the name-total — disclosed, no arbitrary "primary kind"); `kind` as
  a scalar OR an array (matches ANY listed kind); `duplicatesOnly` (only names with a REAL declaration
  in ≥2 files — the `find_usages {name}` ambiguity landmines; a barrel re-export adds no real decl so
  it is NOT a collision, rendered `name ×N (A|B)` against the config legend below); `subgroupByKind` (partition each tsconfig group
  into deterministic `config › kind` subsections, reusing the `symbol-catalogue-group` shape — no new
  render tag — with the shared-config flag preserved). `query` filtering rides the engine
  (`syntactic-catalogue.ts`); the histogram + collision aggregation are pure helpers in
  `ops/symbols-overview-facets.ts`; `kind[]` / `subgroupByKind` dispatch in the op (`ops/symbols-overview.ts`).
- **`scss`** — SCSS classes & their usages via `postcss-scss` CST. Syntactic only;
  `@use`/`@forward` cross-module checks are `partial` (§19).
- **`i18n`** — locale-JSON keys + `t('…')` usages (template literals flagged `dynamic`),
  missing/orphan keys.
- **`schema`** — generated openapi-typescript `openapi.d.ts` → endpoint cards (method/path/query/body/response).

**Framework plugins** (autodetected, config-gated, can be shipped by anyone):

- **`react`** — depends on `ts`. Component detection (a symbol returning JSX under React
  conventions), hook identification, dialog/sheet conventions, and the **unused-props**
  read-model: `component → declared props` (via the ts `firstParamTypeMembers` seam) vs
  `JSX-usage → passed props` (via the ts `jsxCallSites` seam), diffed with the §3 honesty
  demotion (a `{...spread}` / a factory or value reference like `memo(C)` / a capped site set
  makes the passed set unreadable → every verdict demotes to `partial`, never a false
  `certain`-dead). The "first param = props" and "what is a component" policies live here; both
  seams are framework-neutral on the `ts` plugin. `jsxCallSites` is a generic SYNTACTIC JSX scan
  (the `functionDeclarations` / `callArgShapes` precedent — JSX is a TS-language construct, not
  react policy); `firstParamTypeMembers` is a generic first-parameter TYPE-member read off the live
  checker (`getApparentType().getProperties()`, so `extends`/intersection flatten in) — not a memoized
  syntactic scan like that precedent. The react plugin also exposes a generic **`classify(target)`** seam —
  is the resolved declaration a component / hook / other, by the react conventions — which routes a
  trace op walking a declaration chain (`trace_invalidation` and `trace_prop_through_tree` today; the
  remaining Phase 6 trace ops sit on it). It resolves THROUGH the LS (`findDefinition` → match
  `functionDeclarations`), never an id-string compare, so two SymbolIds minted by different paths for
  one decl classify alike. The DOWN-the-tree walk (`trace_prop_through_tree`) adds one generic ts seam,
  `jsxChildSites` — the JSX a declaration's body renders, per-attr value signal + `{...spread}` flag,
  over-collecting callback / render-prop position so an indirect forward is not dropped (§3.4) — the
  inverse of the symbol-anchored `jsxCallSites`; classification stays op-level via `classify`.
- **`react-query`** — depends on `ts`. Mutations, queries, queryKeys, `invalidates` relations.
- **`tanstack-router`** — depends on `ts`. Routes.
- **`zustand`** — depends on `ts`. Stores.
- Others (forms, design-system component conventions, …) ship the same way.

**Plugin DAG.** Plugins form a strict DAG: `react-query` depends on `ts`, never vice
versa. The DAG is declared at plugin registration (the `deps` field) and enforced at
**runtime** — the `PluginRegistry` topologically sorts on init and refuses to register
cycles, and a `PluginRegistry.get<T>(id)` call to an undeclared `id` is a programming
error. A compile-time boundary rule (ESLint import-restrictions) lands once enough
plugins exist to make it pay (`src/README.md`); for now, TypeScript imports flow
downward through file paths but the cross-plugin edge set is enforced at runtime only.

Cross-tier facts (a TS file uses a SCSS class) live in the plugin that observes them —
the TS plugin sees imports and accesses; the SCSS plugin's `findUsages` asks the TS plugin
for them, not the other way around.

Why a flat federation:

- Plugin invalidation is **scoped to one plugin's data** — there is no cross-plugin
  cascade, no shared model that an unrelated change could ripple through.
- Framework plugins use **first-class native types** in their own modules — no open-bag
  `JsonValue` extras smuggled through a shared discriminated union.
- Each plugin picks its **own optimal internal data structure** (i18n is a flat map;
  SCSS has CSS-tree shape; react-query has its own mutation→query lattice). One
  discriminated union over all of them would lose fidelity for no gain.

### L3 — Ops (operations) — the public surface for agents

[`src/ops/`](src/ops/) — each op is a named, parameterized function
`(args) => Promise<Result<T>>` that composes one or more plugin calls into a coherent
answer. Ops live above all plugins and may call any of them — they sit at the top of every
order and are not bound by the plugin DAG.

Simple ops are 1-call passthroughs (`find_definition` → `ts.findDefinition`). Compound
ops orchestrate several plugins; for example `find_unused_scss_classes` calls
`ts.imports`, `ts.symbolAccesses`, `scss.classes`, set-diffs — **no shared store needed
for the join**, the op _is_ the join. Mutating ops (rename_symbol, codemod, move_file)
take an `apply` flag (and other flags for git-dirty handling, force, etc.); dry-run
returns a preview, apply commits writes (§7).

**Ops never bypass plugins to reach implementations.** A `rename_symbol` op cannot
peek into TS LS state directly; it calls `ts.renameSites(target, to)` and receives a
`Result`. This is what keeps plugins replaceable and the trust contract enforceable —
every `Result<T>` envelope's proof spans, freshness, and `ToolFailure` come up through
plugin boundaries, not from internal pokes.

A small number of ops ship by default:

| Op                         | Composes                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_definition`          | `ts.findDefinition` (or other plugin for non-TS handle)                                                                                                           |
| `find_usages`              | `ts.findUsages` (+ `support/text-search` for `text:true`)                                                                                                         |
| `search_symbol`            | `ts.searchSymbol` (LS navto); `{syntactic:true}` → `ts.searchSymbolSyntactic` (no-program AST scan, OOM-survival)                                                 |
| `expand_type`              | `ts.expandType`                                                                                                                                                   |
| `construction_sites`       | `ts` (type-aware "what object literals build type T")                                                                                                             |
| `list`                     | dispatches to the plugin owning the requested registry                                                                                                            |
| `symbols_overview`         | `ts.listSymbols` (no-program syntactic name catalogue; query/summary/duplicatesOnly/kind[]/subgroupByKind facets) + `ts.configMembership` (per-tsconfig grouping) |
| `trace_*` (invalidation/…) | walk plugin-to-plugin per hop, proof-carrying (§17 Ph 6)                                                                                                          |
| `rename_symbol`            | `ts.renameSites` + `support/text-edits` + `support/git`                                                                                                           |
| `move_file`                | `ts` plugin + `support/text-edits`                                                                                                                                |
| `extract_symbol`           | `ts` plugin + `support/text-edits`                                                                                                                                |
| `move_symbol`              | `ts` plugin (LS "Move to file") + `support/text-edits`                                                                                                            |
| `change_signature`         | `ts` plugin + `support/text-edits` + caller transforms                                                                                                            |
| `codemod`                  | ast-grep matcher + `support/text-edits`                                                                                                                           |
| `find_unused_scss_classes` | `ts` + `scss`                                                                                                                                                     |
| `find_unused_i18n_keys`    | `ts` + `i18n`                                                                                                                                                     |
| `find_phantom_deps`        | `ts` (node_modules-resolving bare imports) + `support/framework-detect` (per-package manifest deps join)                                                          |
| `transaction`              | ordered chain of mutating ops, one typecheck gate (§7)                                                                                                            |
| `impact`                   | `ts` (type-aware reference blast radius)                                                                                                                          |
| `impact_type_error`        | `ts` trial-edit overlay + cross-program typecheck                                                                                                                 |
| `affected`                 | `ts` import graph + `support/git`                                                                                                                                 |

The table is illustrative, not exhaustive — `status` is authoritative for the per-repo
op catalogue.

This list grows; the **dispatch shape never does** — see §11.

### L4 — Daemon

[`src/daemon/`](src/daemon/) — the orchestrator. One long-lived front-door process. Holds:

- The `repoId → engine` registry.
- The `ProjectHost` transport seam (§2): in-process or process-isolated, set by config.
- Engine lifecycle: lazy spin-up, idle-TTL eviction, **path-existence sweeper** (§9).
- Memory governor across engines.
- Plugin discovery + DAG validation at engine init.

### L5 — MCP facade

[`src/mcp/`](src/mcp/) — exposes **one tool per op** plus `status` and `batch` (§11):

- `<op>({ ...args, ...flags })` — one MCP tool per op (`find_usages`, `rename_symbol`, …),
  tool-name = op-name; args + flags are flat (no `name`/`args` envelope). The `inputSchema`
  is generated from the op's canonical zod `argsSchema`, so the tool-list IS the catalogue.
- `status()` — first-contact manifest: active plugins, per-op notes + concepts, freshness.
- `batch(requests)` — many ops in one round-trip (the `{name, args}` envelope persists here).

Each op is a first-class tool, its capability permanently in the agent's tool-list. The MCP
tool-list is the static **union** of every op (per-connection); an op whose plugin isn't
active for the resolved repo dispatches to an honest `unavailable` (no `tools/list_changed`
churn). `status` carries the per-repo deep dive (notes, concepts).

---

## 6. SymbolId & handles

`SymbolId` ([`src/core/ids.ts`](src/core/ids.ts)) is an **opaque, per-file-version-scoped,
plugin-routed** handle. It lets an agent chain `find_definition → find_usages →
rename_symbol` without re-searching.

**Module-routed encoding.** Every `SymbolId` carries the id of the plugin that owns it as
a prefix, so the dispatcher can route to the right plugin without inspecting the
referent:

```
ts:Button@src/Button.tsx:v7
scss:.button@src/styles/button.module.scss:v3
i18n:profile.greeting@locales/en.json:v2
route:/users@src/routes/users.tsx:v4
```

The format past the prefix is **plugin-private**: the `ts` plugin chooses its own
encoding, `scss` chooses its own, etc. Outside the owning plugin, a `SymbolId` is opaque.
There is no central registry of how a SymbolId is shaped — only of which plugin owns it.

> **Bound to the file's version, with proof-carrying rebind.** A handle binds to _its
> file's_ version (the owning plugin's per-file stamp), not anything global — so a change
> to some _other_ file never stales it (essential when an agent thinks for 5–60 s between
> calls; a global binding would make the chain single-use). When the handle's own file
> _has_ changed, the owning plugin re-locates the symbol and computes the answer against
> its current home, reporting the move on `Result.handle`
> (`{ status: 'rebound', to, proof, confidence }`) — **stated, never silent**.
>
> The `proof` span shows a symbol of that name/kind sits at `to` _now_ — proof of
> **location, not identity**. So the rebind carries a **`confidence`**: `certain` only with
> structural-continuity evidence; otherwise `partial`/`unresolved` + a note ("a symbol of
> this name/kind is here now; can't prove it's the one you held"). We never claim identity
> we can't prove — the exact lie this protocol exists to prevent. A cross-file move
> (e.g. `move_file` / `extract_symbol`) is a `rebound` whose `to` is in the new file;
> `{ status: 'gone' }` means absent **in this workspace root** — truly removed, or a handle
> minted in a _different_ root (SymbolIds are root-scoped: a `ts:` id carries its origin root, and
> resolving it against another root returns `gone` + "re-search here", never a cross-repo rebind).
> "gone" is never "merely moved within this root" — that is always a `rebound`.

**Each plugin owns its rebind.** There is no universal rebind algorithm. The `ts` plugin
rebinds through the LS (re-find symbol by name/kind in current AST); the `scss` plugin
rebinds by re-locating a class declaration in the current postcss CST; the `i18n` plugin
matches dotted keys. The §6 contract is the shape of the result, not the algorithm.

> **Branded identity primitives.** Beyond `SymbolId`, a small family of branded types
> (`RepoRelPath`, `Glob`, `RepoId`, `FileVersion` —
> [`src/core/brands.ts`](src/core/brands.ts)) makes category errors compile errors: a glob
> where a path is wanted, a file version where it shouldn't be. Inputs arrive as plain
> strings and are branded at the boundary (zod / the plugin's input layer); config stays
> plain for authoring ergonomics.

---

## 7. Edit / refactor / codemod model

Mutating ops take an `apply` flag (default `false`); `apply: true` is explicit. JSON args
zod-validated with fail-fast `did you mean "…"?` errors. Git-aware: refuses a dirty tree
on apply, pre/post-typecheck, atomic, auto-rollback. Op descriptors are designed so
**an agent can author them blind, without reading docs** — the schema + inline examples
in `status`'s op-catalogue are the documentation.

**Liberal intake at the arg boundary (Postel — applies to every op).** Two layers, only one
visible. The **canonical** per-op zod shape is the single advertised truth: it is what `status`
/ `argsHint` show and what every error cites — one canonical name per field, no alias clutter.
Behind it, an **invisible normalizer** (`src/ops/intake/`, run in `runOne` via
`daemon/resolve-args.ts` BEFORE the canonical parse) maps known off-canonical spellings to the
canonical shape: per-op aliases (`symbol`→`name`, `path`/`file`→`module`, `symbols`/`sites`→
`targets`, the `target`→`symbolId` SymbolId spelling, and the reverse of search*symbol/list's
`name`→`query`: a `query`→`name` — `name` for the flat-name ops, `module` withheld for
importers_of, see below); a **guarded cross-op alias** (`max_results`/`maxResults`→`limit`) that
fires only when the op actually declares the target field (`limit ∈ canonicalKeys`), so a
limit-less op leaves it to fail the gate rather than manufacture a stray key; scalar→array coercion
(a bare scalar on a field the op's schema declares as a pure array → a one-element array — **derived
from `argsSchema` itself** (`arrayFieldsOf` for top-level, `nestedArrayFieldsOf` one level into an
object field, e.g. `filter.pathExclude`), not a per-op allowlist, so it applies uniformly to every
op's array field and can't silently miss one; a `union` field that already accepts a scalar is left
untouched); a flat single target (`{name}`/`{symbolId}`/`{file+line+col}`) or a `{names:[…]}` list
collapsed into an op's canonical target-**array** field (`source.targets`), so the explore-style op
takes the same flat shape as every sibling lookup; OpFlag keys
mis-placed inside `args` lifted up to the request (type-validated), and a `name` string that is
really a `path:line:col` / `ts:…` SymbolId smart-parsed to the right field. The canonical schema
stays the **sole gate** — a key that is \_not* a known alias still fails (with a did-you-mean),
never silently stripped (a silent strip is an input-lost lie, §3). A key that denotes the wrong
**kind** of value is deliberately NOT aliased — `importers_of` takes a module PATH, so a `query`/`name`
(a symbol name, which never resolves to a path) hard-rejects with a pointed steer instead, since a
silent coercion would turn a loud `bad_args` into a misleading "0 importers" (§3.6). What the
normalizer rewrote on a given call is disclosed per-call as `Result.intake` (`interpreted:
symbol→name`), so the agent is never silently second-guessed. The alias metadata lives on
`OpDefinition.intake` and is **never** projected into `status`. (Scope: the normalizer is
dispatcher-level — `transaction` sub-steps, which validate against the op schema directly, are
canonical-only.)

Mutating ops carry additional flags beyond `apply`, e.g. `dirtyOk: false`, `force: false`,
`format: true` — each op publishes its full flag set via `status`.

Two **distinct** edit families — conflating them is a code-rewriting lie:

- **Symbol-anchored** (`rename_symbol`, `move_file`, `extract_symbol`, `move_symbol`,
  `change_signature`): the `ts` plugin resolves the symbol through its LS, then computes
  the semantic reference sites; the op rewrites only those. Never fired from a
  textual/shape match.
- **Shape-based** (`codemod`): an **ast-grep** structural pattern (`<X prop={$V}>`).
  Operates on syntactic shape and **never claims to target a symbol** — so it can't
  accidentally rewrite a same-named unrelated binding. Implemented at the op level over
  `support/text-edits`; does not need the `ts` plugin's semantic layer.

> **Resync after our own writes.** On `apply`, the mutating op writes through the `ts`
> plugin's VFS, which marks touched files dirty for the LS — **no locks, no synchronous
> barrier** (§8). It leans on the same read-time freshness check as everything else
> (§3.5, §8): the next op `stat()`s what it touches and the relevant plugin reindexes if
> needed, so a double-fire from the watcher (seeing our own writes) or a missed event is
> **self-correcting**, not a stale window to defend.

> **Capture-safety gate (`captures`).** The post-edit typecheck is necessary but **not
> sufficient**: a mutation that rewrites references/imports can make a rewritten site silently
> re-bind to a _different_, **type-compatible** symbol/module (a shadow, or a relinked import
> landing on a same-named export) — invisible to the typecheck and not a redeclaration the LS
> flags. So every mutating op runs a second, bounded gate: re-resolve the exact rewritten sites
> over the post-edit overlay and confirm each still binds to the SAME symbol it did before
> (rename = the LS reference set, both directions; move/extract = the project's own module
> resolution; codemod = the resolved declaration of each metavar-preserved identifier). Divergences
> surface as `captures: [{file:line:col, kind, detail}]` on the envelope — shown on dry-run, and
> **apply is refused** when non-empty, exactly like the typecheck gate. The #1 design risk is
> **over-refusal** (a false capture on a legitimate refactor is worse than the rare silent bug), so
> detection is conservative: a divergence is flagged only when positively proven, never fabricated.
> Shared helper: `plugins/ts/refactor/capture/`. (Residual gaps tracked in the `task-manager` backlog.)

---

## 8. Plugin lifecycle, watcher, freshness

> **The read path is the source of correctness; the watcher is an optimization** (§3.5).
> Every op takes a **repo-global** change fingerprint at entry — `git rev-parse HEAD` +
> `git status --porcelain`, with a file-mtime stat-walk as the non-git fallback — and asks
> each plugin it touches: "are you current?" Being repo-global, it catches a file the
> answer _omitted_ but shouldn't have (a watcher-missed add), not just files it touched.
> Drift → the affected plugins reindex the changed set from `git diff --name-only`
> (usually small: cheap), or the op returns its answer with a `FreshnessNote`. Either way,
> never silent-stale. A fingerprint, **not** a per-file locking scheme.

- **Per-plugin freshness.** Each plugin exposes `freshness(): FreshnessFingerprint` and
  decides what counts as "current" for its domain (e.g. `ts` plugin fingerprints
  tracked-file size+mtime+hash-on-tie; `scss` fingerprints the same for its glob; `i18n`
  fingerprints the locale-JSON file set). The op-entry guard composes the relevant
  plugins' fingerprints; on drift, the **plugins themselves** drive their reindex —
  there is no central reindex coordinator.
- **Watcher** (chokidar behind an injectable seam, debounced, optimization) → reports
  changed paths to subscribed plugins → each plugin patches its own internal state. The
  watcher keeps the read path usually-fresh so the on-read check is normally a no-op;
  when it misses events (large change, `git checkout`, watcher OS errors), the on-read
  check covers us.
- **Each plugin is in-memory only.** No disk persistence of plugin state. Cold start at
  every engine spawn is intentional: the worktree-spam agent workflow makes persistence
  net-negative (write garbage that the next worktree never reads — see §18 +
  `docs/wishlist.md` for opt-in disk persistence considerations).
- **Semantic-tier laziness inside the `ts` plugin.** Dirty files are recomputed on the
  next op that needs their types, not eagerly. The LS is told which files changed; it
  reuses everything else.
- **Concurrency. The unit of isolation is the workspace engine.** In `process` mode each
  runs in its own process → real cross-workspace parallelism and a non-blocking
  orchestrator. Within one workspace the engine is single-threaded and **serializes its
  own requests** (the TS LS is synchronous and non-reentrant anyway), so a cheap
  `find_definition` may wait behind that workspace's heavy `trace` — acceptable: one agent
  rarely double-fires the same repo, and other workspaces are untouched.
- **Per-plugin immutability is plugin-private.** Each plugin chooses whether its internal
  state is immutable + atomic-swap, or mutated in place between requests. The hard rule
  is only: a plugin must not tear a reader's view mid-call. The simplest pattern — same
  as before — is **build-new-never-mutate-old**: a reader captures the plugin's current
  state reference at request entry and reads only from it; a writer (reindex, mutating
  op) builds a new state and swaps the pointer synchronously. Whether the plugin uses
  copy-on-write per file, an internal graph, or typed arrays is its choice.
- **The orchestrator never blocks.** Many agents share one front door; it only routes,
  so a heavy call in one workspace cannot freeze the others (in `process` mode it is a
  different process entirely). Ops are `Promise`-returning by contract precisely so a host
  call — a direct in-process call, or an IPC round-trip — is transparent. (`in-process`
  mode collapses everything onto one loop and one heap: a heavy call _does_ block there —
  the accepted price of a trivially debuggable dev default; `process` mode restores
  isolation.)

---

## 9. Memory & lifecycle

> **Decision (the dominant operational risk).** A live LS over 50k files is gigabytes of
> RAM and a slow warm; the `ts` plugin owning it makes the whole **workspace engine** the
> heavy thing. Cold start in tens of seconds is acceptable; OOM is not — so each engine is
> isolated and killable, and that is how memory stays bounded.

- **Lazy spin-up** — a workspace engine is created on the first request for that repo
  (via its `ProjectHost`, §2); each plugin warms on its own first-touch (the `ts` plugin's
  LS warms lazily on the first _semantic_ op; `scss`/`i18n`/`schema`/adapters initialize
  on first relevant op or eagerly in their `init()`, plugin's choice).
- **Pre-warm size guard (resource-respect before the warm, t-333163).** The `ts` plugin's LS
  warm is the dominant memory risk (above), and a bare `search_symbol` fans navto across ALL
  programs — so on a huge monorepo the FIRST such call warms a gigabyte-scale program that (a)
  OOM-crashes the in-process daemon (an in-process OOM is uncatchable — §1) and (b) even in
  `process` mode squats that memory until idle-TTL eviction, for a throwaway discovery query
  `symbols_overview` answers with no warm. So a DEFAULT (navto) `search_symbol` CHEAPLY estimates
  the fan-out surface BEFORE warming — the count of git-tracked source files under root
  (`.ts/.tsx/.mts/.cts`, minus `.d.ts`), a cheap listing of the §10 git-source surface, never a
  program build, never the LS, never a `parseJsonConfigFileContent` tree-scan (§19-bounded —
  file-COUNT not bytes, since per-file sizing is the O(surface) hang-class §19 forbids). Over `config.ts.searchWarmMaxFiles`
  (default 4000 — codemaster ~629 files passes with headroom; a monorepo that OOM'd was ~6076) the
  op REFUSES with an honest, actionable redirect (browse via `symbols_overview`, then a targeted
  `find_definition`/`find_usages`; or `search_symbol {syntactic:true}` for an OOM-safe fuzzy scan)
  instead of warming — never a crash, never a silent squat. Scope is exactly the risky warm-with-a-
  cheap-alternative op: `search_symbol {syntactic:true}` is the sanctioned no-warm escape (never
  gated), `force:true` overrides per-call, and the SEMANTIC ops (`find_usages`/`find_definition`,
  which NEED the LS and have no cheap substitute) are NOT gated — their fix is process-isolation
  (§2). An estimate FAILURE (git hiccup) falls through to warm rather than over-refuse a legitimate
  search — the guard is an optimization, not a correctness gate.
- **Idle-TTL eviction** — after `daemon.idleEvictionMinutes` with no requests, the
  orchestrator **disposes the engine**: in `process` mode that kills the child process and
  the OS reclaims everything (plugin states + LS) at once; in `in-process` mode it drops
  references for GC. A later request re-spawns and pays a fresh cold start. There is no
  warm-start snapshot.
- **Path-existence sweeper** — a separate eviction trigger from idle TTL. Worktrees come
  and go (`git worktree remove`), and an engine whose `repoRoot` no longer exists on disk
  must be disposed even if no request has come for it. The orchestrator periodically
  `stat()`s each engine's `repoRoot` (and `.git`); if either is gone, dispose immediately
  (don't wait for idle TTL). On routing entry, a pre-flight `stat()` of the target's
  `repoRoot` covers the case where an agent calls into a deleted worktree.
- **Memory governor** — the orchestrator knows every workspace process and its RSS, so it
  evicts the LRU workspace when the total crosses a machine budget, protecting the user's
  box. (Meaningful in `process` mode.)
- **Monorepo = one engine, not one-per-package** — a single workspace process whose `ts`
  plugin runs one `Program` per package `tsconfig`, each keeping its own `compilerOptions`
  — a flat single-options Program would be a lie (§19). **Built today (§5-L2 / Task G):**
  the host loads the repo's tsconfigs (root + sibling `tsconfig.*.json` + `references` +
  every `package.json`-anchored package — a workspaces-glob member OR an isolated nested package,
  t-865312) as
  **independent** programs, and usages / dead-code fan out across them. **Roadmap:** wiring
  them with **project-reference redirects** (what `tsserver` does) so cross-package
  references resolve in-memory as one graph — not yet built; the independent-programs step is
  what the usage/dead-code honesty needs. Its heap is inherently large — tamed by a
  per-process `--max-old-space-size`, the memory governor, OS-reclaim-on-kill.

---

## 10. Configuration

`codemaster.config.ts` ([example](examples/codemaster.config.example.ts)), typed via
`defineConfig` so autocomplete _is_ the documentation. Intentionally **fat** — every
codebase has its own conventions — but every **section** is optional; enabling one may
require its key fields (`i18n` needs `locales`, `schema` needs `entrypoint`). Sections
are **per-plugin**, plus a few engine-wide ones:
`ts` (globs/ignore/packages/tsconfig override, `searchWarmMaxFiles` pre-warm guard §9), `i18n` (locales, function names,
template-literal handling), `scss` (module globs, import style), `schema` (entrypoint,
generator), `plugins` (which framework plugins to enable, autodetect overrides), `output`
(verbosity, limits), `daemon` (idle eviction, path-existence sweep interval), `debug`
(trace namespaces, log cap). The file is loaded and **validated with zod** — an unknown
key or wrong type fails fast with a pointed message, not a deep crash. With no config at
all it still works: `codemod` / text-search drive off git `ls-files` (the `.gitignore`-aware
listing — nested + `!` negation). The **TS program file-set** is the project's own tsconfig
`include` globs, then INTERSECTED with two exclusions so a loose `include: ["**/*"]` never indexes
junk as project symbols (a minified `dist/*.js` bundle surfacing as a symbol, a `.claude/worktrees`
copy phantom-doubling every declaration into a `find_usages` "ambiguous" — the never-lie violation):
(1) the ignored-**directory** names below (`node_modules`/`dist`/`.next`/`.claude`/… — a segment
match, NOT the `>1 MB`/editor-temp file filters, which stay on the `walkFiles` path) — the reliable
excluder for a nested VCS checkout (`.claude/worktrees/<id>`, a whole-tree copy with its OWN `.git`
the outer `.gitignore` can't see across the working-tree boundary); (2) the files git itself marks
ignored (a bounded SYNC
`git ls-files --others --ignored`, memoized once per structural reindex — never the LS hot path,
§19). Ignore-SEMANTICS, not tracked-only: tracked AND freshly-written untracked-not-ignored source
are both kept, only ignored files drop; a non-git root degrades to the name set. A file reached only
by an `import` is unaffected either way (TS still resolves an import INTO an excluded path — only
ROOT-globbed junk nothing imports drops out). The `scss`/`i18n`/`schema` plugins and the non-git
freshness fallback use ONLY the name-based ignore set — `node_modules`/`dist`/`build`/`.next`,
tool/agent state dirs (`.idea`/`.vscode`/`.claude`/…), and files > 1 MB — not a full
`.gitignore` evaluation (a repo gitignoring e.g. `generated/` would still have its SCSS indexed;
honoring arbitrary `.gitignore` in those plugins is a deferred follow-up). See
[`src/config/config.ts`](src/config/config.ts).

**Config changes apply automatically (not just at cold start).** The engine bakes its
plugin set + config-derived options from the config at spawn, so a config edit must
re-spawn it to take effect. The orchestrator takes a content fingerprint of the resolved
`codemaster.config.*` (the exact bytes `loadConfig` evaluated, stored at spawn) and, on
every request entry — the read path is the guarantee, not the watcher (§3.5) — compares
it against the current file; on drift it evicts the engine (§9) so the next request lazily
re-spawns from the fresh config. Edit, add-where-none, and remove are all covered. An
edit that breaks the config (syntax / zod) fails the re-spawn honestly — the prior engine
is already evicted, so the next request returns the actionable load error, never a
silently-stale plugin set; fixing the file recovers on the next request. An unreadable
fingerprint (a delete racing the read) is inconclusive and never evicts.

---

## 11. MCP surface (catalogue-in-the-tool-list by design)

> **Decision.** Every tool schema is loaded into the agent's context **every session** — a
> fixed token tax. We spend it deliberately: one MCP tool **per op**, so the capability
> catalogue lives permanently in the agent's tool-list. Agents are blind to an opaque
> `op({name})` dispatcher and under-use it; a named tool per op keeps every capability on
> view (a standing reminder) and its **typed per-op `inputSchema`** surfaces the arg shape up
> front — a wrong/missing key or wrong type is caught at the boundary. The cross-field `one-of`
> constraints JSON Schema can't express (a symbol-addressed op's `{symbolId | name | file+line+col}`)
> stay enforced by the canonical zod gate (`.refine`), which rejects them with a pointed error.
> The N-schema cost IS the feature (visibility + type-safety), not a price to dodge. So the
> surface is: one tool per op, plus `status` and `batch`.

- **`<op>({ ...args, ...flags })`** — one tool per op (`find_usages`, `rename_symbol`, …),
  tool-name = op-name. Args and flags are **flat** (no `name`/`args` envelope): the op's own
  args, plus the output-shape flags as top-level params — `apply` / `summaryOnly` (mutating
  ops), `verbosity`, `format`, `debug`, `root`, and `sql` / `return` (table-bearing ops);
  column projection is `sql`, not a `fields` flag. The `inputSchema` is **generated** from
  the op's canonical zod `argsSchema` (single source of truth = the dispatch gate, so the
  advertised schema can't drift from what validates) and enriched with those flags; the
  description carries the op summary + the compact `argsHint`. The flat call is routed
  through the unchanged dispatch path: the facade extracts the reserved flag/route keys and
  hands the remainder to the op's own argsSchema — the **sole** validator (§7).
- **`status({ brief?, op? })`** — the first-contact manifest. Lists active plugins (with
  their versions/freshness fingerprints), the op catalogue for _this_ repo (op names +
  one-line what-it-does + args schema + per-op notes + the shared concepts), and available
  debug namespaces (§13). The per-op tools advertise each op's schema standingly; `status`
  is the per-repo **deep dive** (per-op notes + shared concepts + freshness) and the place
  to discover which ops the active plugins enable. The codemaster-vs-grep steer is **not**
  re-emitted here — it ships once per session in the MCP `initialize` response
  (`SERVER_INSTRUCTIONS`), so repeating it every `status` would be a pure token tax.
  Two opt-in token-saver renders sit on top of the FULL default: **`brief: true`** drops
  the arg schemas / per-op notes / concepts and prints just names + summaries; **`op:
"<name>"`** renders one op's full detail on demand (cheaper than re-emitting the whole
  catalogue to re-read one op). It also carries the **self-staleness** line
  (§3.6 applied to the tool itself): when the daemon's own `src/**` changed since spawn it
  is serving pre-edit behavior, so `status` and the per-op/`batch` responses prepend — on
  EVERY stale response, not just the first — a one-line "run `codemaster daemon restart`"
  banner (a multi-edit session must be warned on every answer it acts on). It is a PREFIX so the
  render cap (which trims the tail) can never lose it and it never lands inside a batch's
  per-section JSON; suppressed in `format:'json'` (a prefix would corrupt the single bare-JSON
  payload — json consumers read the structured `sourceStale` from `status`) and silent where the
  source can't be located (global/`npx` — §19). The
  remedy is **restart**, not a bridge reconnect: a reconnect re-attaches to the same stale-code
  daemon on the same socket (§2 singleton), so the daemon itself must be restarted (`codemaster
  daemon restart` — the management verbs, §2).
- **`batch(requests)`** — one tool carrying a list of op invocations (each `{name, args, …}`);
  results come back
  in order. Reads run against per-plugin freshness checked once at batch entry, so all
  ops in the batch see a consistent view per plugin (each plugin pins its state at
  batch entry; there is no single global version across all plugins). A batch (or a single
  per-op tool call) may carry **`sql`**: each request is aliased (`as`), its tabular projection
  (`OpDefinition.table`) is loaded into an **ephemeral in-memory SQLite database that
  lives only for that call**, and one read-only `SELECT` runs across the aliased tables —
  relational algebra (anti-joins, negations, aggregates) over op outputs without the agent
  hand-merging. Producers run **uncapped** in sql-mode (a capped table feeding `NOT IN`
  would lie); a per-table hard bound marks the result `partial` with the table named. A
  producer that errors / returns `ok:false` fails the **SELECT**, not the whole call — a
  join over its missing table would lie, so the SELECT is skipped and the `sql` record is an
  honest failure naming the failed producer; every independent, successful producer still
  returns under `return:'all'` (never a silent drop, §3.4). The
  LS stays the only oracle — SQLite is a stateless evaluator over one call's freshly
  produced rows, never a cache or a second index (`support/sql/`, lazy `better-sqlite3`).

Every op IS a first-class MCP tool (`find_usages`, `rename_symbol`, … exposed to the agent
by name). The tool-list is the static union of the op catalogue, generated from each op's
`OpDefinition`; `status` adds the per-repo deep dive (notes, concepts, freshness).

Usage guidance ships in the MCP `initialize` response — **not** an instructions file
bolted into `CLAUDE.md`/`AGENTS.md` — and it steers the agent to **query codemaster
directly rather than delegate to file-reading sub-agents** (the plugins already did that
work; a sub-agent grep/read loop just repeats it). `status` does **not** re-emit that steer
(it would be a per-call duplicate of the once-per-session `initialize` instructions); it
carries the per-repo op catalogue.

---

## 12. Output format

Ultra-dense, coded, agent-first (the `front-renamer` house style: short codes +
one-line legend + sectioned summary). Rules:

- Always emit clickable `file:line`.
- Default cap with explicit `… N more (filter: …)` — never silent.
- **Verdict-before-bulk ordering (a stated contract, not an accident).** The dense renderer emits
  object keys in **insertion order** and the hard char-cap truncates the **tail**, so a result
  must place its small, load-bearing verdict FIRST and any bulky/re-fetchable payload LAST. The
  mutating ops rely on this — they put `typecheck`/`touched` before a `diff` that can be tens of KB,
  so the cap can only ever truncate the (re-fetchable) diff, never the safety verdict (§3a /
  spec-stresstest). A renderer change that reorders keys (e.g. sorting them) would silently re-bury
  the verdict — keep insertion-order rendering, or move this guarantee behind an explicit field
  ordering. **The verdict-first contract orders keys WITHIN `data`; the envelope-seam cap is a
  separate guarantee** — the renderer caps only the `data` region and reserves the envelope's
  honesty channels (truncation / handle-rebind / freshness) against the budget so they ALWAYS
  survive the cut, never trimmed off the tail (dropping a `freshness: UNVERIFIED` or a partial
  handle rebind is the silent-stale / §6-misidentification lie). Debug (a dev trace, not an
  honesty channel) is the only segment the cap may drop.
- `verbosity = terse | normal | full` lets the agent dial token cost; column
  projection is done with `sql` (SELECT over the op table), not a `fields` flag.
- `format=json` for machine composition (agent feeding one call into another).
- The default text mode carries the proof spans compactly; `terse` may elide span
  text and keep only `file:line` (the agent can re-fetch via `expand_type` or
  `find_definition` for the full span).
- **Size to the answer, not the file count:** when several results are interchangeable
  (near-duplicate implementations), show one in full and collapse the rest to signatures.

**Shape-tagged dispatch (the `~shape` protocol).** Every renderable ROW the dense text mode
collapses to one coded line carries a stable shape TAG — a reserved `~shape` key (the same
`~`-is-meta idiom the SymbolId uses for `~rootTag`). The renderer dispatches tag → per-shape
function; it does NOT guess the shape from the row's key-set (that silently leaked a new/changed
shape into the multi-line `key=value` exploder). An unknown tag fails LOUD (a visible `~shape=`
marker), never a silent fall-through.

- **The tag is META, stripped from json/sql.** It must be a real ENUMERABLE field so it survives
  the IPC/NDJSON hop to the renderer (`process` mode), so `format:'json'` strips every `~`-key from
  a data COPY before serializing (the live data keeps its tags for the text path / sql projector —
  §19 tear-free; non-meta key order is preserved, so json is byte-identical to the untagged shape),
  and the sql projector — explicit columns — never reaches it. Text mode is the only consumer.
- **The vocabulary + tag/strip helpers live in [`common/shape-tag`](src/common/shape-tag)**
  (`ShapeTag`, `SHAPE_KEY`, `tag()`, `stripShapeTags()`); the renderers live in
  [`format/render/shapes`](src/format/render/shapes), one file per domain, assembled into a
  `Record<ShapeTag, renderer>` registry — so a NEW tag with no renderer is a COMPILE error
  (the first half of the coverage guard; the runtime guard catches a forgotten `tag()` call).
- **Ops own the tag.** Composing the answer, an op stamps `tag(<shape>, row)` on every renderable
  row it emits (the shape is the op's contract; the renderer is the format layer's). A row reused
  across ops (a `GroupRow` in `find_usages` and `impact`) is tagged at each op's assembly. A
  DOMAIN-NEUTRAL row reused across a whole op FAMILY shares ONE tag — every `trace_*` op emits the
  single `trace-hop` tag (its `relation`/`kind` are open data, dispatched by the one tag, never a
  per-trace tag), so the trace family adds capability without growing the tag registry.
- **`full` is per-tag, and COLLAPSE is the default.** `FULL_DISPOSITION`
  ([`format/render/shapes`](src/format/render/shapes)) is an EXHAUSTIVE `Record<ShapeTag,
'collapse' | 'verbatim'>` — so a new tag with no entry is a COMPILE error (the second half of the
  coverage guard, mirroring `SHAPE_RENDERERS`), and the disposition it must then declare defaults to
  `collapse`. `collapse` means the tag renders as its dense one-liner even at `full` (a list/verdict
  row carries no verbatim body — a name-token span is a location, a member is `name: type`, a verdict
  is a value). `verbatim` is the small opt-OUT for a proof-BEARING form whose full value IS meaningful
  source text — the renderer is SKIPPED and the raw object passes to render-dense (so it explodes
  unless an upstream interception reshapes it first). **No tag currently elects `verbatim`:** the
  "show me the code" decl-BODY payload is delivered by the `renderSource` COMPACT-BODY interception in
  [`render-result.ts`](src/format/render/render-result.ts) (find_definition / source), which fires
  BEFORE `condense`. Most symbol-tagged rows reaching this disposition (find_usages' `definition`,
  `mergedDeclarations`) are name-token-only REFS with no body, which `verbatim` only ever exploded;
  `search_symbol`'s `matches` at `verbosity:'full'` DO carry a `decl` — but a HEADER-only preview span
  (t-517121), which the `collapse` renderer reads via the object-safe `spanTextOf` (its first line),
  never the full body. So `symbol` is
  `collapse` like every other tag; a renderer that reaches a span must use the object-safe `spanLoc` /
  `spanTextOf` helpers (a collapse row meets a verbatim span OBJECT at full, never `[object Object]`).
  The `verbatim` branch in `condense` is retained as infrastructure for a future proof-bearing form
  whose body is NOT routed through a renderSource-style interception. This default-collapse inversion
  is what stops the density regression recurring: a new row shape cannot silently fall into the
  exploder — it must be classified, and collapse is what it inherits. (Raw top-level spans — not
  tagged rows — still pass verbatim at full per `condense`, which is the point of `full` for a
  single-symbol lookup; an op whose top-level span is a name-token LOCATION, not a body, projects it
  to a clickable `at` loc instead — see `expand_type`.)

---

## 13. Debug & observability (for the agents building this tool)

Codemaster will mostly be _built and maintained by agents_. They need to see inside it —
richly, but compactly (debug output spends tokens too).

- **Namespaced traces, `debug`-library style.** Each subsystem logs under a namespace:
  `ipc`, `daemon`, `repo`, `watcher`, `plugin:<id>` (e.g. `plugin:ts`, `plugin:scss`,
  `plugin:i18n`, `plugin:schema`, `plugin:react-query`, …), `plugin:ts:ls` (LS
  lifecycle), `plugin:ts:resolve`, `plugin:ts:refs`, `op:<name>` (e.g. `op:find_usages`,
  `op:rename_symbol`), `edit:plan`, `edit:apply`, `resync`, `eviction`, `format`, `mcp`.
  Enabled by `CODEMASTER_DEBUG=plugin:ts:*,watcher,-eviction` (wildcards, `-` excludes),
  a config `debug` field, or **hot-toggled at runtime** over CLI/IPC
  (`codemaster debug plugin:ts:* on`) — the daemon lives, so you flip tracing on,
  reproduce, grep, flip off, no restart.

- **Correlation id via `AsyncLocalStorage`.** Every line is auto-tagged with the
  request's `req#N`, threaded through async hops by ALS — _not_ passed through every
  signature (concurrent calls would smear it). So `grep 'req#42' debug.log` yields the
  complete trace of one call. The single most useful debugging affordance.

- **One compact, greppable line per event:**

  ```
  12:00:01.234 req#42 op:search_symbol q=Button hits=1 3ms
  12:00:01.235 req#42 plugin:ts:resolve Button@src/Button.tsx:1 cache=miss 12ms
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

**Usage telemetry (distinct from debug traces).** The MCP serve path records every
agent call — request args + the rendered response — as one JSON line, routed by
success/fail to `~/.codemaster/usage/{success,fail}.jsonl` (`support/usage-log/`,
rotating + size-capped like the debug sink). It is for **later analysis of how the tool
is actually used**, not for live debugging. Classification is from the **structured**
result, never `isError`: a `Result` with `ok:false` (a `ToolFailure`) renders through a
plain text response with no `isError`, so an isError-only check would mis-file it as
success; a batch is a success only when every constituent op succeeded. The write is a
single point around the dispatch, wrapped so a disk/serialize error never touches the
request path. On by default on the `mcp` path (the composition root injects the logger;
`serveMcp`'s library default is a no-op — no side effects in tests); opt out with
`CODEMASTER_USAGE_LOG=0`, relocate with `CODEMASTER_USAGE_DIR`.

See [`src/core/debug.ts`](src/core/debug.ts).

---

## 14. Dependencies

- **`typescript`** — resolved from the target project (bundled fallback). Used by the
  `ts` plugin for AST + LS.
- **`@ast-grep/napi`** — syntactic structural match/rewrite for the `codemod` op.
- **`postcss` + `postcss-scss`** — used by the `scss` plugin.
- **`diff`** — unified diffs for mutating-op previews.
- **`yaml`** — parse `pnpm-workspace.yaml` to honor its negative (`!`) workspace-glob exclusions
  during package discovery (§5-L2): a package.json-anchored dir the manifest explicitly excludes
  stays unindexed. Hand-rolling YAML would be a subtly-wrong second oracle; read best-effort (a
  malformed manifest yields no globs, never a throw).
- **`prettier`** — resolved from the target project **only** (NO bundled fallback);
  post-edit formatting for mutating ops. A repo that ships no prettier — or no prettier
  config — is written unformatted rather than restyled against its intent (§5-L1).
- **`better-sqlite3`** — the ephemeral in-memory SQL evaluator behind `batch + sql`
  (§11). Loaded **lazily** on the first sql-carrying call (cold start never pays for the
  native module) and hidden behind the `support/sql/` seam so a DuckDB impl can drop in.
- **`chokidar`** — debounced file watching (behind an injectable seam for tests).
- **`@modelcontextprotocol/sdk`** — the MCP facade.
- **`zod`** — runtime validation at the boundaries where serialized/external data enters:
  config load, MCP tool args (per-op + status + batch), IPC messages. Internal typed data is
  trusted — only the edges are guarded.
- **`@cevek/typescript-extract-refactor-fix`** — a patched TypeScript fork, loaded **lazily**
  (via `createRequire`, gated to the project's TS major) **only** as the LS-relocation rescue
  (§4) for `extract_symbol` / `move_symbol`: it produces "Move to file" (both drive the same LS
  action) edits for shapes the stock LS asserts on (the `Expected symbol to be a module` and `Changes
overlap` assertions — e.g. a moved block using a css-module member, which co-extract —
  spec-css-coextract — needs, or mutually-recursive symbols whose edits overlap).
  It is an **edit producer, not a fact oracle** — every rescued edit is verified by the
  project's own LS typecheck (the §2.8 gate), so it never originates a reported fact, and an
  unavailable/incompatible fork degrades to an honest `ts-ls` failure. The bounded exception to
  "one parser per domain" is recorded in §4.
- **(ported) `front-renamer`** — symbol-anchored refactor engine (the project's prior art
  for safe edits over a VFS-backed LS). The relevant code is **vendored** inside
  `plugins/ts/refactor/`; codemaster does **not** depend on the `front-renamer` npm
  package at runtime.

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
    index.ts                 # public re-export barrel (programmatic API, defineConfig)
    core/                    # L0 — leaf, types only
      brands.ts              # branded primitives: RepoRelPath, Glob, RepoId, FileVersion
      json.ts                # JsonValue — closed shape, never `unknown`
      span.ts                # Loc, Span, Confidence, Provenance — proof primitives
      result.ts              # proof-carrying envelope (Fact, FreshnessNote, ToolFailure)
      ids.ts                 # SymbolId (plugin-routed) + proof-carrying rebind
      op-example.ts          # canonical op example shape (status anti-drift)
      plugin.ts              # Plugin interface + PluginRegistry (the DAG manifest)
      debug.ts               # tracing contract (§13) — impl lives in support/debug/
    config/
      config.ts              # CodemasterConfig + defineConfig
    common/                  # L0.5 — pure logic over core types, no I/O; topical subfolders
      result/                # ok/fail/partial constructors; isOk/isFailure; freshness merge
      ids/                   # SymbolId codec (encode/decode plugin-prefix-routed format)
      span/                  # contains/intersects/equals; text-at-span + Loc↔offset bridge
      confidence/            # worstOf and per-hop reducers
      trace/                 # domain-neutral trace-hop contract: TraceNode/TraceHop + makeNode/makeHop/dedupHops (§17 Phase 6)
      fingerprint/           # FileFingerprint shape + comparators (mtime-tie hash, §19)
      hash/                  # FNV-1a — rollups + short stable keys (never security)
      glob/                  # glob matching over RepoRelPath
      json/                  # JsonValue zod schema (boundary validation)
      plugin-registry/       # topological sort + cycle detection for the Plugin DAG
      async/                 # Clock seam; debounce / deferred / withTimeout over Clock
      debug-spec/            # parse 'plugin:ts:*,watcher,-eviction' into a matcher
      lru/                   # generic LRU map (memory governor §9)
      shape-tag/             # ~shape render-dispatch vocabulary: ShapeTag, SHAPE_KEY, tag(), stripShapeTags (§12)
      truncate/              # §3.4 truncation chokepoint: elideString / elideType + CapId registry / capList / nameWithMore
    support/                 # L1 — external-tool wrappers; per-tool subfolders
      git/                   # rev-parse HEAD, porcelain, diff --name-only, ls-files (+ --ignored sync; + ls-source-files.ts: ls-files --recurse-submodules ∪ --others --exclude-standard for the no-program syntactic scan), blame, log
      fs/                    # walking (non-git fallback); realpath canonicalization; stat
      debug/                 # DebugSystem impl: ALS req#N, rotating per-repo log, stderr
      config-load/           # find + transpile + sandbox-eval codemaster.config.*; zod
      watch/                 # watcher seam (tests inject a fake) + chokidar adapter
      sql/                   # SqlRunner seam + lazy better-sqlite3 impl (read-only sandbox)
      text-search/           # TextScanner seam + pure-JS scanner (find_usages text:true)
      usage-log/             # jsonl usage telemetry: success.jsonl / fail.jsonl (§13)
      prettier/              # invoke project's own prettier
      text-edits/            # span-based edits, atomic apply, conflict detection
    plugins/                 # L2 — the only domain layer
      ts/                    # TypeScript plugin: VFS, LS, module-resolve, all TS facts (+ syntactic-{surface,nodes,search,catalogue,matcher,cache}.ts: the no-program OOM-survival search_symbol + symbols_overview scans, matcher = the shared navto createPatternMatcher; program/config-membership.ts: symbols_overview per-tsconfig grouping)
      scss/                  # SCSS classes & usages (postcss-scss CST)
      i18n/                  # locale-JSON keys + t('…') usages
      schema/                # openapi-typescript openapi.d.ts → endpoint cards
      react/                 # framework plugin (deps: ts) — components/hooks/conventions
      react-query/           # framework plugin (deps: ts) — mutations/queries/invalidates
      tanstack-router/       # framework plugin (deps: ts) — routes
      zustand/               # framework plugin (deps: ts) — stores
    ops/                     # L3 — public, named, parameterized ops (compose plugins)
      contracts.ts           # OpRequest, OpResult, DispatchError, OpFlags, Batch
      intake/                # liberal arg-intake (§7 Postel): aliases, coercions, flag-lift — invisible normalizer before the canonical zod gate
      find-definition.ts  find-usages.ts  expand-type.ts  construction-sites.ts
      search-symbol.ts  source.ts  list.ts  symbols-overview.ts  symbols-overview-facets.ts  trace-invalidation.ts  trace-prop-through-tree.ts
      rename-symbol.ts  move-file.ts  move-symbol.ts  extract-symbol.ts  change-signature.ts  codemod.ts  transaction.ts
      find-unused-scss-classes.ts  find-unused-i18n-keys.ts
      impact.ts  impact-type-error.ts  affected.ts  …
    daemon/                  # L4 — orchestrator: front door, routing, lifecycle, governor + host.ts
    mcp/                     # L5 — MCP facade: per-op tools (op-tools.ts) + status + batch
    format/                  # dense formatter, codes, json mode
      render/                # condenseSpans (thin ~shape dispatcher), render-result/-dense/-source
        shapes/              # per-domain ~shape renderers + Record<ShapeTag> registry (§12)
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
  tasks/                     # the backlog — one .md per task (task-manager: MCP + `tm` CLI)
    config.yml               # task schema — fields mirror the old type·imp·cx tags + area
  docs/
    backlog.md               # pointer stub → the task-manager backlog (content migrated to tasks/)
    about-ru.md              # long-form human guide (RU) — the "why" + big picture
    wishlist.md              # parked ideas, not yet scoped
```

---

## 16. Testing & honesty harness

Because "never lie" is the product, **every test needs an independent oracle** —
fixtures are only inputs; the comparison to ground truth is the test.

**Oracles.** `expand_type` / `construction_sites` → a fresh-from-cold `ts.Program`.
`find_usages` → the LS itself, compared **cold-rebuild vs warm-daemon** (validating
`find_usages` against `findReferences` when `find_usages` _is_ `findReferences` is
circular — see the invariants below). Mutating ops → `git` (byte-exact rollback) +
`tsc --noEmit` on the result. Non-TS plugins (`scss`/`i18n`/`schema`) → cold reparse of
the relevant files. Format → golden snapshots. Generic text search is **not** a codemaster
op — agents call ripgrep directly. The one textual surface, `find_usages text:true`, is a
**semantic ∪ textual join**: the symbol's name is scanned word-boundary across tracked
files and a hit overlapping any semantic ref is deduped away; the remainder returns in a
separate `text-only` section flagged `unresolved` (same text, identity not proven). The
oracle is an independent naive scanner plus a ripgrep cross-check — never grep parity,
since the two sets differ by design. The cross-check honest-skips when `rg` is absent
locally, but under `CODEMASTER_REQUIRE_RG` (set by CI) a missing `rg` fails loud instead of
skipping, so the distinctness half can never silently no-op to green in the gate.

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
// find_usages must include the aliased <B/> usage — grep would miss it:
const r = await p.op('find_usages', { target: 'ts:Button@src/Button.tsx:v1' });
assertFiles(r, ['src/Button.tsx', 'src/App.tsx']);
```

Committed **repo folders** (`test/fixtures/repos/`) are reserved for realistic cases —
monorepo, large projects, MCP end-to-end — and deliberately cover the traps the tool
must not lie about: aliased imports / re-exports / barrels, type-only imports, JSX with
literal/spread/computed props, **same-named symbols in different scopes**, dynamic
dispatch (must flag `dynamic`/`partial`), cross-package usages, compound/nested/orphan
SCSS classes, template-literal i18n keys.

**`find_usages ⊇ grep` does not hold** — semantic refs and textual matches are different
sets, neither a superset (grep hits comments, strings, `obj.Foo` on an unrelated type,
`FooBar` without a word boundary; the LS catches `import {Foo as F}` … `<F/>` that grep
misses). The harness rests on invariants that do:

1. **Proof-span validity** — every emitted `Span.text` equals the live source at its
   range (the 1-based `Loc` ↔ 0-based TS-offset boundary is the usual culprit). A drifted
   span is a lie; asserted on every fixture query of every plugin.
2. **Per-plugin freshness honesty** _(guards the §3.5 / §8 read-time backstop)_ —
   with the watcher silenced: mutate a file; **add** a file a find-all answer should
   include (e.g. a new `<Button/>` user); and `git checkout` another branch. After each,
   query: the answer must be reindexed-correct or carry a `FreshnessNote`, **never**
   silent-stale — including the _omitted-file_ case (a result missing an entry it should
   have had), which an answer-scoped check would miss. Tested per plugin.
3. **Per-plugin `cold == warm`** — for any state reached by a sequence of edits, an op
   asked against the warm daemon's plugin returns the same result as the same op asked
   against a cold-booted daemon's same plugin. This invariant guards per-plugin
   incremental-update drift (each plugin maintains its own state independently).
4. **Edit safety** — dry-run leaves `git status` clean; `diff(dry-run) == diff(apply)`;
   post-apply the edit introduces **no new** `tsc` errors vs the pre-edit baseline (a repo's
   pre-existing errors are reported as a `preExisting` count, never gated on — so an edit applies
   on a repo that doesn't already compile); rollback restores byte-exact prior state.
5. **Op golden against oracle** — `find_usages` pinned against cold LS on fixtures;
   `find_unused_scss_classes` pinned against cold reparse; etc. (regression net, not a
   correctness proof — paired with the oracle).
6. **Format golden** — dense-output stability. **Never the only assertion** for a
   correctness claim; always paired with an oracle.
7. **Plugin DAG honesty** — the `PluginRegistry` refuses cyclic deps at init; tested by
   feeding it a small cyclic DAG and asserting the failure shape (an op-time crash would
   be lying about plugin capability).

**Determinism (an architecture requirement).** Scenario tests must not `sleep`. The
daemon takes injectable seams: a `clock` (no `Date.now`), a `watcher` interface (tests
call `fileChanged(path)` / `flushWatcher()` directly instead of awaiting real chokidar
events), and a `forceEvict` hook for the LS LRU. Real chokidar gets one separate smoke
test.

**Tooling:** `node:test` + `node:assert`, no heavy framework — matching the project's
lean-deps stance. **Pyramid:** unit (inline-VFS) · differential (oracle-backed, the
invariants above) · integration scenarios (`*.scenario.ts`) · edit-safety (git-backed) ·
golden · MCP end-to-end. CI gates hardest on invariants 1–5 (proof-span validity,
per-plugin freshness, cold == warm, edit safety, op-vs-oracle); format and DAG honesty
are infrastructure guards, not correctness ones.

---

## 17. MVP roadmap

The build is **plugin-incremental**: each phase adds one plugin (with its ops) and the
project gets useful capability immediately. There is no upfront "build the graph first"
phase — there is no graph.

- **Phase 0 — Foundation.** Daemon + IPC + MCP facade (per-op tools + `status` + `batch`);
  repo resolution; orchestrator with engine lifecycle (lazy spin-up, idle
  TTL, path-existence sweeper §9); `core/plugin.ts` `Plugin` interface + `PluginRegistry`
  with DAG validation; `support/` (git/prettier/text-edits/fs); read-time freshness
  backstop (§3.5/§8); injectable watcher seam; output formatter (§12); debug subsystem
  (§13); honesty harness skeleton (§16). **No plugin yet** — Phase 0 exit is "daemon
  responds to `status` round-trips through MCP".
- **Phase 1 — `ts` plugin (the heavy one).** VFS, long-lived LS (lazy warm),
  module-resolve. Ops: `find_definition`, `find_usages`, `expand_type`, `construction_sites`,
  `search_symbol`. Per-plugin freshness (file fingerprints); per-plugin invariants
  (§16): `find_usages` vs cold LS, proof-span validity. The plugin-DAG bottom is in.
- **Phase 2 — mutating ops on `ts` plugin.** `rename_symbol`, `move_file`,
  `extract_symbol`, `move_symbol` (into an existing file, via the LS "Move to file"),
  `change_signature` (symbol-anchored via LS); `codemod` (shape-based
  via ast-grep). Dry-run by default, explicit `apply` flag (§7); git-aware (dirty gate,
  rollback); resync (§7) — the next op's read-time freshness check picks up our own
  writes, no special coupling.
- **Phase 3 — `scss` + `i18n` + `schema` plugins** (independent of each other, all
  depend on `ts` only for cross-tier usage discovery). Ops:
  `find_unused_scss_classes`, `find_unused_i18n_keys`, `list_endpoints`, `i18n_lookup`,
  `scss_class_diff` (latter `partial` for `@use` — §19).
- **Phase 4 — framework plugins** (`react-query`, `tanstack-router`, `zustand`,
  autodetected + config-gated). Each ships `list` ops for its registry and the cross-tier
  ops it owns (e.g. `react-query.invalidations_for(mutation)`). Plugin DAG enforcement
  proves itself at this scale.
- **Phase 5 — compound ops (token-saver composites).** `component_card`, `feature_map`,
  `mount_path`, `why_this_line`, `recent_changes`, `changed_since_branch`,
  `impact` (type-aware blast radius), `affected` (changed files → tests via import
  graph). Pure compositions of plugins; no new plugin capability.
- **Phase 6 — `trace` ops.** Control- and data-flow as a recipe over plugins:
  `trace_invalidation` (mutation → invalidates → consumers), `trace_prop_through_tree`,
  `trace_field_to_render`. Heavily proof-carrying, per-hop `confidence`/`provenance`;
  dynamic hops flagged, never silently bridged.

**Done definition per phase** — `npm run fix-and-check` green · oracle-backed tests
(§16) · docs at present state · no upward import · no file > 300 lines · no blocking the
orchestrator.

---

## 18. Formats & open questions

Wire formats are plain, readable JSON: seeing exactly what crosses a channel is worth
more than saved bytes here. Compact framing is an option to reach for later, not a goal.

- **IPC** — newline-delimited JSON.
- **No disk snapshots.** Plugin state is in-memory only; cold start on every engine
  spawn. See §17 and `docs/wishlist.md` for the rationale and deferred opt-in disk
  persistence considerations.
- **i18n template-literal keys** — flagged `dynamic`, never guessed.

Open questions (no answer committed):

- **Windows IPC** — unix socket today; named-pipe parity if it's wanted.
- **Cross-engine plugin state share** — not supported; each engine runs a fresh set of
  plugins from cold. Plugin internals are opaque (each plugin picks its own storage), so
  there is no universal serialize/deserialize hook to ride on. See `docs/wishlist.md` for
  the conditions under which this could change.

---

## 19. Platform & runtime — decisions for Phase 0

Where the design meets the OS and Node it must be explicit, because Phase 0 ships the
daemon, IPC, repo resolution, the plugin registry + DAG enforcement, and the freshness
backstop — the exact surfaces these live on. (Surfaced by a runtime-soundness review.)

- **Path canonicalization (`RepoRelPath`)** — one minting chokepoint normalizes: forward
  slashes always; case-fold on case-insensitive volumes (APFS/NTFS — detected, not assumed),
  preserve case on case-sensitive ones; a fixed `realpath` symlink policy (pnpm / workspace
  symlinks). Every plugin keys its data by `RepoRelPath` and it is part of `SymbolId`, so
  two spellings of one file must brand to one value, or freshness and `find_usages`/rebind
  silently misfire (§3.5, §6).
- **Non-git freshness is best-effort; git is the strong guarantee.** `git status --porcelain`
  is content-INSENSITIVE for an already-dirty tracked file (` M path` both before and after a
  second edit), so the (HEAD, porcelain) fingerprint alone would serve a stale program for a
  re-modified dirty file in a warm watcher-OFF daemon. The git check therefore also re-stats
  each dirty path and re-hashes on an mtime tie — bounded by the dirty set, content read only on
  a tie. The non-git mtime fallback copies the same racy-clean rule across the whole tree — size
  - mtime, treating a file within the FS mtime-resolution window of the recorded stamp as
    dirty (hash-on-tie) — else a same-tick edit is silently missed on coarse FS (HFS+, FAT,
    some network mounts). That whole-tree walk is **bounded and burst-coalesced** so it can neither
    hang nor scale per-op (§1): `walkFiles` uses `lstat` and **never follows a symlink** (a dir with
    ≥2 ancestor symlinks otherwise explodes into ~K^32 virtual paths — an eternal 100% CPU sync spin
    that kills the event loop; skipped symlinks are counted + disclosed as `partial`, never silently
    dropped — §3.4), is depth- and entry-capped, and is stopped by a wall-clock deadline →
    `partial{tool:'timeout'}` on overrun; the per-op freshness re-walk is debounced (a ~1s window
    reuses the prior fingerprint, the baseline's failure riding along so a timed-out/partial walk is
    never laundered into a clean answer). (§3.5, §8)
- **Monorepo LS = project references, not a flat Program.** One engine/process, but the
  `ts` plugin runs one `Program` per package `tsconfig`, each keeping its own
  `compilerOptions` (never a flat single-options Program). Built today: the repo's tsconfigs
  (root + sibling `tsconfig.*.json` + `references` + every `package.json`-anchored package —
  workspaces-glob member or isolated nested package, t-865312) load as **independent** programs that
  usages / dead-code **and the mutating ops** (rename / change_signature / move / extract +
  the §2.8 typecheck gate) fan out across (§5-L2 / Task G). Roadmap: wiring them with
  project-reference redirects (what `tsserver` does) so cross-package references resolve
  in-memory as one graph. (§9)
- **Watcher is best-effort and must degrade, not crash.** chokidar 4 uses per-directory
  `fs.watch` on Linux → `ENOSPC` past `fs.inotify.max_user_watches` on large trees. Catch the
  watcher `error`, fall back to read-time-only freshness (still correct, §3.5), surface it in
  `status`, cap with polling on huge trees.
- **SCSS analysis is syntactic** (`postcss-scss` — a CST, not a resolved module graph or
  computed values): cross-`@use`/`@forward` orphan checks are `partial`; computed-property
  work needs real `sass`/dart-sass. (§5-L2, wishlist)
- **Daemon singleton** (spec-daemon-singleton). Two concurrent launches converge on one daemon:
  a bridge tries to `connect`; on `ENOENT`/`ECONNREFUSED` it unlinks a stale socket and spawns a
  detached daemon, then bounded-poll-connects; a launch race resolves at the daemon's bind
  (`EADDRINUSE` → the loser daemon exits, both bridges connect to the winner). The daemon
  idle-self-exits at zero open bridges and unlinks its socket; a stale socket from a SIGKILLed
  daemon is recovered by the next bridge (unlink + rebind), never a hang. If the daemon can't be
  reached within the budget the bridge falls back to in-process serving (worst case: Stage-1
  behavior). (§2)
- **IPC endpoint portability.** Socket at a short, hashed path under an **env-independent** base
  dir (`os.userInfo().homedir/.codemaster/run` — the passwd home, never `$HOME`/`XDG_RUNTIME_DIR`/
  `$TMPDIR`, so the stripped-env bridge and a normal-shell management verb compute the SAME path and
  the singleton can't split), with a length assertion at bind (a very long home can still blow
  `sun_path`'s ~104/108-byte limit → honest throw) and created user-only (0600). A `Transport` seam
  (mirroring `ProjectHost`, built in `support/transport/`) carries the unix-socket impl now; a
  Windows named-pipe impl drops in behind it later. (§2, §18)
- **`process`-mode child bootstrap.** Specify the child entry script and how it loads the
  engine when codemaster is global / `npx` (its `__dirname` is not in the project); how
  the `ts` plugin resolves the **project's own TS** (resolve-from-project-root, passed as
  an arg — §5-L2);
  `--max-old-space-size` set at spawn from the governor budget; orphan-child reaping if the
  orchestrator is `SIGKILL`ed. (§2, §9)
- **Eviction is graceful.** Idle-TTL, path-existence sweeper, and the memory governor
  evict with `SIGTERM` → drain → `SIGKILL` on timeout; hard-kill is the OOM emergency
  only. (§9)
- **Cancellation is partial — and "never hang" (§1) is non-negotiable.** A deadline-based
  `HostCancellationToken` (host `getCancellationToken`, `isCancellationRequested()` polled by TS)
  DOES cancel TS _checker/search_ ops — `find_usages`, navto, `getSemanticDiagnostics`, completions
  poll it throughout; wire it so they are deadline-bounded → `ToolFailure{tool:'timeout', partial}`
  on overrun. It does NOT cancel TS _program build_ (`getProgram` runs to completion, empirically)
  nor codemaster's _own_ synchronous code (host callbacks, plugin loops); those must be bounded by
  DESIGN — cache/scope inputs, never a per-call tree scan (the `ls-host` config-reparse hang) — and,
  for the hard guarantee on truly-uncancellable sync, by engine isolation + kill-on-deadline (the
  orchestrator stays responsive in `process` mode and reaps an overrun child). An op never spins
  unbounded; an abandoned query is otherwise dropped only _between_ serialized requests. (§1, §2, §8)
- **Per-plugin tear-free reads.** Plugins choose their internal storage, but the contract
  is the same: a reader pins the plugin's current state reference at request entry and
  never re-reads it across an `await`; a writer (reindex, mutating op) does a synchronous
  build-and-swap of the single `current` pointer (atomic in one-threaded Node), so writes
  never interleave; old states GC when their last reader finishes. `readonly` is
  compile-time only — the runtime guarantee is build-new-never-mutate-old; **no
  `Object.freeze`**. The copy-on-write-per-file-shard pattern remains useful **inside** a
  plugin (it is the simplest way for the `ts` plugin to keep commits O(changed) in heap),
  but it is the plugin's choice, not an enforced architecture. (§8)
- **Editor temp churn.** Atomic-save renames and swap/backup files (`.swp`, `~`, `.tmp`) are
  debounced, rename-over is treated as modify, and editor temp patterns join the default
  ignore set. (§10)

**Forward risk (state now; does not bite TS 6.x).** The `ts` plugin assumes the project's
own `typescript` exposes an **in-process, synchronous JS `LanguageService`** (§3.1, §5-L2).
The native (Go) TypeScript port may not — a project on it would break "drive the project's
own TS over our VFS host," needing that TS's own server protocol instead.
