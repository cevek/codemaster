# Implementation plan

A checkbox tree of the build, expanded from [ARCHITECTURE.md §17](../ARCHITECTURE.md).
Each `[ ]` is roughly a PR-sized unit. **Definition of done per box:** `npm run
fix-and-check` green · an oracle-backed test (§16) · docs at present state
(CONTRIBUTING). Tick a box when it merges; keep this file present-state — mark what's
done, don't narrate history.

Legend: `[x]` done · `[~]` in progress · `[ ]` todo.

## Phase −1 — Scaffold `[x]`

- [x] Architecture & decisions — ARCHITECTURE.md §1–§19
- [x] Module map + import/dependency contract — src/README.md
- [x] Typed contracts — `core/{span,brands,json,ids,result,plugin,debug}`,
      `ops/contracts`, `daemon/host`, `config/config`
- [x] Layered scaffold — `common/` (result/ids/span/confidence/fingerprint/plugin-registry/
      async/debug-spec/lru) and `support/` (git/prettier/text-edits/fs) topical subfolders
- [x] Toolchain — strict TS, ESLint (300-line · no-any · no-console · exhaustive switch),
      Prettier, knip, lint-staged + husky, `fix-and-check`
- [x] Docs — CLAUDE.md, CONTRIBUTING.md, test/README.md
- [x] Reviewer agents — architecture / bug / copy-paste / doc-sync (`.claude/agents/`)

## Phase 0 — Foundation (daemon · plugin registry · MCP surface · honesty harness skeleton)

> **Phase 0 exit**: `status` round-trips agent → MCP → daemon → dense reply, reporting
> active plugins and the per-repo op catalogue truthfully.

- [~] **Settle the §19 platform decisions first** — settled: `RepoRelPath` canonicalization
  (`realpathSync.native` true-casing at one minting chokepoint), non-git mtime
  racy-clean (record-time-aware tie → hash), watcher degrade-not-crash (seam +
  `onDegraded` → status). Deferred with the IPC transport: daemon singleton,
  socket path, `process`-mode child bootstrap (monorepo project-references land with
  the per-package Programs work).

**Plugin infrastructure:**

- [x] `core/plugin.ts` — `Plugin` interface + `PluginRegistry`; runtime DAG validation
      (refuses cycles at init — tested); dep-scoped registries enforce declared `deps`
      at runtime; composition root is `bin.ts` (`pluginsFor`/`opsFor` injection)
- [ ] `daemon/` IPC server (newline-delimited JSON) + daemon singleton (bind-or-connect)
      — deferred: today each MCP/CLI process hosts its own in-process orchestrator
- [x] **lifecycle** — lazy engine spin-up; idle-TTL eviction; **path-existence sweeper**
      (pre-flight + periodic `existsSync` of `repoRoot`); injectable clock throughout
- [x] orchestrator governor — engine-count LRU budget (in-process shadow of the §9 RSS
      governor; RSS tracking becomes meaningful with `process` mode)

**Common (pure logic, no I/O):**

- [x] `common/result/` — `ok()`/`fail()`/`partial()` constructors; `isOk()`/`isFailure()`
      narrowers; `mergeFreshness()` + `combineFailures()` aggregators
- [x] `common/ids/codec.ts` — `SymbolId` encode/decode (plugin-prefix-routed format)
- [x] `common/span/` — `contains`/`intersects`/`equals`; `extractText` + Loc↔offset bridge
- [x] `common/fingerprint/` — `FileFingerprint` + racy-clean comparator (§19) + rollup
- [x] `common/plugin-registry/` — toposort + cycle detection; registry construct + scope
- [x] `common/async/` — `Clock` seam; `debounce` / `deferred` / `withTimeout` on top
- [x] `common/debug-spec/` — parse `'plugin:ts:*,watcher,-eviction'` into a matcher
- [x] `common/lru/map.ts` — generic LRU map
- [x] `common/hash/fnv.ts` — FNV-1a (fingerprint rollups, repo-key naming)

**Support utilities:**

- [x] `support/git/` — repo root, `HEAD` + `--porcelain` fingerprint, `diff --name-only`,
      ls-files (the exact gitignore-aware listing), basic blame/log
- [x] `support/fs/` — default-ignore walker (non-git fallback; git ls-files is the exact
      listing); `realpath` canonicalization chokepoint; `stat` → `FileFingerprint` +
      hash-on-tie
- [x] `support/debug/` — `DebugSystem` impl: ALS `req#N`, rotating capped per-repo log at
      `~/.codemaster/<repoKey>/debug.log`, stderr sink, per-call capture (contract stays
      types-only in `core/debug.ts`; I/O lives here per the §5 bright-line)
- [x] `support/config-load/` — find/transpile/sandbox-eval `codemaster.config.*`, zod
      schema with compile-time drift guard against `config/config.ts`
- [x] `support/watch/` — watcher seam (`nullWatcher` for tests) + chokidar adapter
      (debounced, degrade-not-crash §19)
- [ ] `support/prettier/`, `support/text-edits/` — stubs; populated by Phase 2

**Read-time freshness backstop:**

- [x] repo-global fingerprint check at batch entry (`git HEAD` + porcelain; stat-walk
      fallback with racy-clean hash-on-tie); drift → changed set → every plugin's
      `reindex`
- [x] `FreshnessNote` plumbing into `Result<T>` (batch-entry capture, worst-of merge)
- [x] never-silent-stale invariant tested against real plugins with the watcher silenced
      (mutate · **add** · `git checkout` — test/differential/freshness.test.ts)

**Surface:**

- [x] MCP facade — exactly three tools: `op`, `status`, `batch`; usage guidance in the
      initialize response; per-repo op catalogue via `status`
- [x] `format/` — dense output, `file:line`, explicit truncation, verbosity (§12)
- [x] debug subsystem (§13) — namespaced tracing, hot `configure()`, `CODEMASTER_DEBUG`
- [x] zod boundary validation — config load, MCP tool args, op args (per-op schemas)
- [x] honesty harness skeleton — `project()` temp-git mount driving the real pipeline;
      proof-span oracle (`assertSpansValid`); manual clock (no sleeps)
- [ ] oracle runners (ripgrep, cold `Program`) + scenario runner — with Phase 1
      completion

## Phase 1 — `ts` plugin

> **Exit**: agent can `op({name: 'find_definition'|'find_usages'|'expand_type'|
'assignability'|'search_symbol'})` and get oracle-equal answers. Per-plugin invariants
> 1–3, 5 (§16) green for `ts`.

- [x] `plugins/ts/ls-host` — long-lived `LanguageService`, lazy warm, versioned
      disk-backed host; `reindex` bumps script versions, structural changes rescan the
      file list. _Simplifications, stated in code + status: bundled TS (project-own TS
      resolution pending), root tsconfig only (per-package Programs pending §9)._
- [ ] `plugins/ts/vfs` in-memory overlay (needed for Phase 2 dry-run edits)
- [ ] `plugins/ts/module-resolve` — aliased (`paths`/`baseUrl`) scss-import resolution
      and friends; today only relative scss specifiers resolve in `css-modules.ts`
- [ ] watcher-bridge as its own seam consumer (today the engine fans watcher batches
      into every plugin's `reindex` — same effect, revisit when plugins multiply)
- [x] `plugins/ts/`: target resolution (SymbolId / file:line:col / unambiguous name) +
      proof-carrying rebind (§6) — `rebound`/`gone`, location-not-identity confidence
- [x] **public API**: `searchSymbol`, `findDefinition`, `findUsages`, `expandType`
      (quick-info depth), `cssModuleUsages()` (the cross-tier helper);
      `freshness()`/`pending()`/`reindex()`
- [ ] `assignability`, `imports(file)`, deep `expandType`
- [x] `ops/search-symbol.ts`, `ops/find-definition.ts`, `ops/find-usages.ts`,
      `ops/expand-type.ts` — passthrough wrappers, zod-validated, explicit truncation
- [~] tests — proof-span validity oracle on every e2e answer; freshness honesty
  (mutate · add · checkout); aliased-JSX find_usages; stale-handle rebind; missing:
  `find_usages` vs cold-LS differential, `cold == warm`

## Phase 3 (pulled forward) — `scss` plugin + cross-tier ops

- [x] `plugins/scss` — postcss-scss CST parse (classes + spans; interpolated selectors
      flagged `partial` §19); per-file reindex; parse failures surfaced in op results
- [x] cross-tier join: `ts.cssModuleUsages()` observes `import s from '*.scss'` +
      `s.x`/`s['x']`/`s[expr]` (computed → `dynamic`, never guessed)
- [x] `ops/scss-classes.ts`, `ops/find-unused-scss-classes.ts` — dynamic access demotes
      a module's unused-claims to `partial` with a note

## Relational post-filter — SQL over op outputs

> Spec: [docs/spec-sql-over-ops.md](spec-sql-over-ops.md) (approved). Ephemeral
> in-memory SQLite per call; `batch + as + sql`; producers uncapped in sql-mode;
> read-only sandbox; table schemas declared per op and surfaced via `status`.

- [x] `OpDefinition.table` (schema + pure row projection) for the five list-shaped ops
      (`find_usages` `GroupRow` enriched with name/file/line/col/confidence so the
      projection never decodes the opaque SymbolId payload)
- [x] `support/sql/` — seam + better-sqlite3 impl (lazy load, three-layer read-only sandbox)
- [x] engine sql-mode batch (uncapped producers via `OpContext.unbounded`, hard row bound,
      honesty envelope; driver in `daemon/sql-batch.ts`)
- [x] MCP surface: `as`/`sql`/`return` on batch, `sql` sugar on op; status columns line
- [x] tests per spec §7 (anti-join oracle, sandbox, truncation/partial honesty)

## Read-side polish — agent field feedback, round 1

> Spec: [docs/spec-feedback-polish.md](spec-feedback-polish.md) (approved). Six fixes
> in three PR-stages; no architecture changes. Out of scope there (separate specs):
> cross-repo per-request `root`, textual overlay on `find_usages`, `i18n` plugin.

- [x] Stage 1 — call-shape ergonomics (structured examples + anti-drift test, errors
      carry a valid example, fix `batch([...])` guidance) · freshness `reindexed`
      marker (envelope + render, visible in terse)
- [ ] Stage 2 — `find_usages`: `reexport` role split from `import` · conditional
      import collapse (default on, never in sql tables, counters unchanged) · role
      breakdown on filtered-empty results
- [ ] Stage 3 — declaration spans (`find_definition` returns signature/body, not an
      echo) · new multi-target `source` op · deep `expand_type` (members /
      constituents, depth + memberLimit, cold-Program oracle)

## Phase 2 — mutating ops on `ts` plugin

> **Exit**: edit-safety invariant green; symbol-anchored refactors + shape-based codemods
> work dry-run-first with explicit `apply: true`.

- [ ] vendor `front-renamer` engine inside `plugins/ts/refactor/` (symbol-anchored:
      rename/move/extract/changeSignature; resolves through the LS)
- [ ] `support/text-edits` — span-based edits, atomic apply, conflict detection
- [ ] `support/prettier` — wrap project prettier for post-edit format
- [ ] `ops/rename-symbol.ts`, `ops/move-file.ts`, `ops/extract-symbol.ts`,
      `ops/change-signature.ts` — dry-run preview (diff + touched + typecheck) → explicit
      `apply`; git-aware (dirty gate, rollback)
- [ ] `ops/codemod.ts` — ast-grep matcher; declarative pattern + rewrite; **never claims
      to target a symbol** (§7)
- [ ] resync — mutating ops mark plugin state dirty via VFS; the next op self-corrects
      on read (§7)
- [ ] tests (git-backed) — dry-run zero-write · `diff(dry)==diff(apply)` · post-apply
      `tsc` clean · rollback byte-exact

## Phase 3 — non-TS plugins (`scss` · `i18n` · `schema`)

> **Exit**: cross-tier ops work — agent can `find_unused_scss_classes`,
> `find_unused_i18n_keys`, `list_endpoints`.

- [ ] `plugins/scss` — postcss-scss CST; classes + literal usages observed in TS files
      (via the `ts` plugin's `imports`/`symbolAccesses` cross-tier API). Cross-`@use`
      orphan check `partial` (§19).
- [ ] `plugins/i18n` — locale-JSON keys (defs) + `t('…')` usages (via `ts` plugin);
      template literals `dynamic`; missing/orphan checks
- [ ] `plugins/schema` — `schema.d.ts` reader → endpoint cards
- [ ] config sections wired + zod-validated (`scss`, `i18n`, `schema`)
- [ ] `ops/find-unused-scss-classes.ts`, `ops/find-unused-i18n-keys.ts`,
      `ops/list-endpoints.ts`, `ops/i18n-lookup.ts`, `ops/scss-class-diff.ts`
- [ ] tests — per-plugin oracles (cold reparse); cross-plugin op correctness against the
      same fixtures

## Phase 4 — framework plugins + `list` ops

> **Exit**: with adapters configured, `list` ops return adapter-contributed registries
> (components, routes, mutations, queries, stores).

- [ ] `plugins/react` (`deps: ['ts']`) — component detection, hook identification,
      dialog/sheet conventions
- [ ] `plugins/tanstack-router` (`deps: ['ts']`) — route declarations
- [ ] `plugins/react-query` (`deps: ['ts']`) — mutations, queries, queryKeys,
      `invalidates` relations
- [ ] `plugins/zustand` (`deps: ['ts']`) — stores
- [ ] autodetection (presence of dep in `package.json`) + config gate
- [ ] `ops/list.ts` — dispatches to the plugin owning the requested registry
- [ ] tests — DAG enforcement (cyclic deps refused at registry init), per-plugin oracles

## Phase 5 — compound ops (token-saver composites)

> **Exit**: "one call = full answer" ops; size-to-the-answer output (§12).

- [ ] `ops/component-card.ts`, `ops/feature-map.ts`, `ops/mount-path.ts`,
      `ops/find-unused-props.ts`, `ops/why-this-line.ts`, `ops/recent-changes.ts`,
      `ops/changed-since-branch.ts`, `ops/refactor-extract-container.ts`
- [ ] `ops/impact.ts` — type-aware blast radius (the real type errors a change would
      cause, not just call edges)
- [ ] `ops/affected.ts` — changed files → tests, via the `ts` plugin's import graph
- [ ] each op is pure composition of plugins; output golden + an oracle

## Phase 6 — `trace` ops (data + control flow)

> **Exit**: trace ops walk plugin-to-plugin with per-hop `confidence`/`provenance`;
> dynamic hops flagged, never silently bridged.

- [ ] `ops/trace-invalidation.ts` — mutation → invalidates → useQuery sites → component
      mount points
- [ ] `ops/trace-prop-through-tree.ts`, `ops/trace-field-to-render.ts`,
      `ops/trace-cache-key-to-http.ts`, `ops/trace-type-widening.ts`
- [ ] heaviest layer; depends on Phases 1, 3, 4 being solid

## Cross-cutting (gates every box, not a phase)

- [ ] `fix-and-check` green · oracle-backed test · no file > 300 lines · no upward
      import · no cyclic plugin deps
- [ ] new boundary → zod-validated · new external-tool call → wrapped → `ToolFailure`
- [ ] docs at present state · remove each newly-wired dep from `knip.jsonc`
      `ignoreDependencies`
- [ ] every plugin reports honest freshness; every op aggregates freshness from the
      plugins it touched
