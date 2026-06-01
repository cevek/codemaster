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
- [x] Toolchain — strict TS, ESLint (300-line · no-any · no-console · exhaustive switch),
      Prettier, knip, lint-staged + husky, `fix-and-check`
- [x] Docs — CLAUDE.md, CONTRIBUTING.md, test/README.md
- [x] Reviewer agents — architecture / bug / copy-paste / doc-sync (`.claude/agents/`)

## Phase 0 — Foundation (daemon · plugin registry · MCP surface · honesty harness skeleton)

> **Phase 0 exit**: `status` round-trips agent → MCP → daemon → dense reply. The daemon
> is alive, has zero plugins yet (Phase 1 ships the first one), and reports that
> truthfully. Honesty harness skeleton green on the things it can check (no plugins, no
> facts).

- [ ] **Settle the §19 platform decisions first** — `RepoRelPath` canonicalization, non-git
      mtime racy-clean, monorepo project-references, watcher degrade-not-crash, daemon
      singleton, socket path + `Transport` seam, child bootstrap. They gate everything below.

**Plugin infrastructure (no plugins yet):**

- [ ] `core/plugin.ts` — `Plugin` interface + `PluginRegistry`; runtime DAG validation
      (refuses cycles); composition-root self-registration
- [ ] `daemon/` — per-engine registry, IPC server (newline-delimited JSON), injectable clock
- [ ] **lifecycle** — lazy engine spin-up; idle-TTL eviction; **path-existence sweeper**
      (`stat()` `repoRoot`/`.git`; dispose disappeared engines without waiting for TTL)
- [ ] orchestrator memory governor (cross-engine RSS tracking; LRU evict; meaningful in
      `process` mode)

**Support utilities (used by Phase 1+ plugins and ops):**

- [ ] `support/git` — repo root, dirty gate, `HEAD` + `--porcelain` fingerprint, basic
      blame/log
- [ ] `support/fs` — `.gitignore`-aware file walker
- [ ] `support/prettier`, `support/text-edits` — stubs; populated by Phase 2

**Read-time freshness backstop (no plugins to ask yet; the backstop is in place for
Phase 1 to consume):**

- [ ] read-time fingerprint check infrastructure (`git HEAD` + porcelain, mtime fallback)
- [ ] `FreshnessNote` plumbing into `Result<T>`
- [ ] never-silent-stale invariant tested with a stub plugin that records freshness

**Surface:**

- [ ] MCP facade — three tools: `op({name, args, ...flags})`, `status()`,
      `batch(requests)`. Op enum is empty in Phase 0 (no ops); `status` reports honestly.
- [ ] `format/` — dense coded output, `file:line`, truncation, verbosity (§12)
- [ ] `core/debug.ts` impl — namespaced tracing + `AsyncLocalStorage` `req#N` + rotating
      capped log at `~/.codemaster/<repoId>/debug.log` (§13)
- [ ] zod boundary validation — config load, IPC, MCP `op` args (§10/§11)
- [ ] honesty harness skeleton — `project()` VFS mount (for Phase 1+ plugins), oracle
      runners (ripgrep, cold `Program`), scenario runner (§16)

## Phase 1 — `ts` plugin

> **Exit**: agent can `op({name: 'find_definition'|'find_usages'|'expand_type'|
'assignability'|'search_symbol'})` and get oracle-equal answers. Per-plugin invariants
> 1–3, 5 (§16) green for `ts`.

- [ ] `plugins/ts/vfs` — in-memory overlay (powers both reads and dry-run edits)
- [ ] `plugins/ts/ls-host` — long-lived `LanguageService` over the VFS host; lazy warm
      (warms on first semantic op); resolves the project's own `typescript`/`tsconfig`
      (`paths`/`baseUrl`), bundled TS as fallback
- [ ] `plugins/ts/module-resolve` — import/path resolution incl. tsconfig aliases
- [ ] `plugins/ts/watcher-bridge` — subscribes to the engine's watcher seam, marks
      touched files dirty for the LS
- [ ] `plugins/ts/freshness` — per-file fingerprints (size+mtime+hash-on-tie)
- [ ] `plugins/ts/handles` — `SymbolId` mint + decode for `ts:` prefix; proof-carrying
      rebind (§6) when a handle's file moved/changed
- [ ] **public API**: `findDefinition`, `findUsages`, `expandType`, `assignability`,
      `searchSymbol`, `imports(file)`, `symbolAccesses(file, base)` (the cross-tier
      helper for other plugins), `freshness()`
- [ ] `ops/find-definition.ts`, `ops/find-usages.ts`, `ops/expand-type.ts`,
      `ops/assignability.ts`, `ops/search-symbol.ts` — passthrough wrappers
- [ ] tests — per-fixture: proof-span validity, `find_usages` vs cold LS, freshness
      honesty (mutate · **add** · `git checkout`), `cold == warm` for the `ts` plugin

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
