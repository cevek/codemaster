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
- [x] `support/prettier/`, `support/text-edits/` — populated by Phase 2 (Stages A/B)

**Read-time freshness backstop:**

- [x] repo-global fingerprint check at batch entry (`git HEAD` + porcelain; stat-walk
      fallback with racy-clean hash-on-tie); drift → changed set → every plugin's
      `reindex`
- [x] `FreshnessNote` plumbing into `Result<T>` (batch-entry capture, worst-of merge)
- [x] never-silent-stale invariant tested against real plugins with the watcher silenced
      (mutate · **add** · `git checkout` — test/differential/freshness.test.ts)
- [x] **resilience (§3.6)** — git + TS-LS fault injection via `project()` seams
      (`gitRunner` / `faultTsMethod`; test/differential/resilience.test.ts): a throwing LS
      read op → honest `ToolFailure(ts-ls)`, never `op_threw`, daemon stays live; a git
      fingerprint failure degrades to the mtime walk; a drift `git diff` failure surfaces
      `FreshnessNote.unverified` and suppresses a false `indexedAtCommit` (the clean-checkout
      silent-stale lie — fixed in `buildFreshnessNote`; the drift baseline is not advanced
      past an un-diffed change so `unverified` stays sticky until a diff succeeds, and
      `mergeFreshness` carries it worst-of across cross-root joins). A git⇄mtime-walk **mode
      transition** (git availability flips between ops) forces a full reindex — the two
      baselines are incomparable, so reporting `changed:[]` would serve the other mode's
      possibly-stale state dressed as fresh; tested both directions.

**Surface:**

- [x] MCP facade — exactly three tools: `op`, `status`, `batch`; usage guidance in the
      initialize response; per-repo op catalogue via `status`
- [x] `format/` — dense output, `file:line`, explicit truncation, verbosity (§12)
- [x] debug subsystem (§13) — namespaced tracing, hot `configure()`, `CODEMASTER_DEBUG`
- [x] zod boundary validation — config load, MCP tool args, op args (per-op schemas)
- [x] honesty harness skeleton — `project()` temp-git mount driving the real pipeline;
      proof-span oracle (`assertSpansValid`); manual clock (no sleeps)
- [~] oracle runners (ripgrep, cold `Program`) + scenario runner — cold `Program`
  home (`test/helpers/cold-ls.ts`: `coldMembers`/`coldDiagnostics`) and the ripgrep
  distinctness oracle (`test/helpers/ripgrep.ts`: `rgSites`, honest-skip when absent;
  `text-overlay.test.ts` re-pointed onto it) both landed; the scenario runner resolved to
  not-needed — the freshness tests interleave assertions between steps, so inline
  `write`/`git`/`op` over `project()` reads cleaner than a step-list wrapper (knip-clean,
  no one-use abstraction)

## Phase 1 — `ts` plugin

> **Exit**: agent can `op({name: 'find_definition'|'find_usages'|'expand_type'|
'assignability'|'search_symbol'})` and get oracle-equal answers. Per-plugin invariants
> 1–3, 5 (§16) green for `ts`.

- [x] `plugins/ts/ls-host` — long-lived `LanguageService`, lazy warm, versioned
      disk-backed host; `reindex` bumps script versions, structural changes rescan the
      file list. _Simplifications, stated in code + status: bundled TS (project-own TS
      resolution pending), root tsconfig only (per-package Programs pending §9)._
- [x] `plugins/ts/vfs` in-memory overlay on `ls-host` (dry-run typecheck engine, spec §2.7;
      inert when empty; `typecheckOverlay` self-contained set→diagnose→clear)
- [ ] `plugins/ts/module-resolve` — aliased (`paths`/`baseUrl`) scss-import resolution
      and friends; today only relative scss specifiers resolve in `css-modules.ts`
- [ ] watcher-bridge as its own seam consumer (today the engine fans watcher batches
      into every plugin's `reindex` — same effect, revisit when plugins multiply)
- [x] `plugins/ts/`: target resolution (SymbolId / file:line:col / unambiguous name) +
      proof-carrying rebind (§6) — `rebound`/`gone`, location-not-identity confidence. The
      SymbolId-taking read ops surface the structured `{status:'gone'}` uniformly through a
      shared `missOf` chokepoint: `find_usages`/`find_definition`/`expand_type` on the failed
      result's `handle`, `source` per target in `unresolved`; `referenceSpans` (internal, no
      agent handle chain) and the mutating ops still flatten a gone handle to an honest message
- [x] **public API**: `searchSymbol`, `findDefinition`, `findUsages`, `expandType`
      (quick-info depth), `cssModuleUsages()` (the cross-tier helper);
      `freshness()`/`pending()`/`reindex()`
- [ ] `assignability`, `imports(file)`, deep `expandType`
- [x] `ops/search-symbol.ts`, `ops/find-definition.ts`, `ops/find-usages.ts`,
      `ops/expand-type.ts` — passthrough wrappers, zod-validated, explicit truncation
- [~] tests — proof-span validity swept over **every** span-bearing read op
  (`test/differential/span-validity.test.ts`: coverage-gated against `builtinOps()`,
  non-vacuous ≥1-span guard, drift negative-control); freshness honesty
  (mutate · add · checkout); aliased-JSX find*usages; stale-handle rebind;
  `find_usages` trap distinctness vs grep (`test/differential/find-usages.test.ts`:
  alias/barrel/type-only/cross-file ⊋ grep, same-name-scope ⊊ grep, hand-curated oracle +
  rg cross-check — NOT cold-`findReferences`, which §16 flags as circular); confidence
  honesty (`scss-confidence.test.ts`: computed `s[expr]` demotes unused-claims to partial,
  never falsely dead). \_Deviation: the spec's "provenance syntactic/type" is unproduced by
  shipped ops (core `Provenance.kind` lands with trace/adapter ops); the find_usages
  semantic/text provenance axis is already asserted in `text-overlay.test.ts`.* Freshness
  honesty extended (`freshness.test.ts`): ts in-place mutation, bulk multi-file checkout,
  i18n checkout, and the §19 racy-clean mtime-tie resolved by content **end-to-end**. `cold == warm` for ts + scss (`cold-equals-warm.test.ts`: warm-after-edits
  fact arrays incl. proof spans == a cold boot over the identical tree). Read-side `gone`
  rebind (`ops.test.ts`: deleted decl with no sibling → structured `{status:'gone'}` +
  empty data, never a false rebind; a same-named sibling → `rebound` at `partial`
  confidence with the "identity not proven" note — the honest non-silent retarget). §19
  canonicalization (`support.test.ts`: injected-realpath seam — case-fold collapses two
  spellings to one `RepoRelPath`, symlink resolves to target, escape refused — deterministic,
  not FS-dependent). Plugin-DAG honesty (`common.test.ts`: a realistic 3-node a→b→c→a cycle
  refused at registry init, naming every node).

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
- [x] Stage 2 — `find_usages`: `reexport` role split from `import` · conditional
      import collapse (default on, never in sql tables, counters unchanged) · role
      breakdown on filtered-empty results
- [x] Stage 3 — declaration spans (`find_definition` returns signature/body, not an
      echo) · new multi-target `source` op · deep `expand_type` (members /
      constituents, depth + memberLimit, cold-Program oracle)
- [x] `feedback` op — in-band bug/wish/friction channel → global
      `~/.codemaster/feedback/inbox.md`, FAIL-render nudge
      ([spec-feedback-channel.md](spec-feedback-channel.md))
- [x] `status` as the documentation — per-op `notes` + concepts block + golden;
      the parallel usage guide retired with a no-living-references guard test
      ([spec-status-as-the-doc.md](spec-status-as-the-doc.md))

## Self-hosting DX (inbox triage)

- [x] daemon self-staleness signal: the orchestrator records its OWN `src/**` fingerprint
      at spawn (`daemon/source-fingerprint.ts`, reusing `common/fingerprint/rollup` +
      `support/fs` walk) and `sourceStale()` compares on demand; `status` prints a
      first-line `!! daemon code behind source — reconnect MCP` and the MCP `op`/`batch`
      responses prepend the same one-line banner (`mcp/server.ts` `staleBanner`). §3.6
      applied to ourselves: the freshness contract covers the inspected repo's data, this
      covers the tool's own running code. Degrades silently to off where `src/` isn't
      locatable (global/`npx` — §19), never a false positive (tested both directions). The
      `node src/bin.ts op …` self-dev loop is documented in CONTRIBUTING; hot-reload stays
      out (wishlist) — the MCP client owns the process lifetime.
- [x] root-placement clarification (inbox `[friction]`): the `status` concepts line states
      `root` is a TOP-LEVEL field beside `name`/`args` (not inside `args`); validation is
      unchanged, so `root` smuggled into `args` still fails with a self-correcting `bad_args`
      (asserted in `self-staleness.test.ts`); concepts golden updated.

## Field feedback, round 2 — sequential, one PR each, in this order

- [x] cross-repo: per-request `root` in batch · cross-root sql at the orchestrator ·
      discoverability (concepts/guidance/engines list)
      ([spec-cross-repo-root.md](spec-cross-repo-root.md))
- [x] `find_usages text:true` — textual-occurrence overlay, deduped against semantic
      refs, `unresolved` half stated; `support/text-search/` seam; ARCHITECTURE §16
      present-state rewrite ([spec-text-overlay.md](spec-text-overlay.md))
- [x] `i18n` plugin — `ts.parseJsonText` keys with proof spans, `ts.literalCalls`
      cross-tier usages, `i18n_lookup` / `find_unused_i18n_keys` /
      `find_missing_i18n_keys`; ARCHITECTURE §4 parser-cell update
      ([spec-i18n-plugin.md](spec-i18n-plugin.md)). _Deferred: the `i18n:` SymbolId +
      rebind (spec §2) — no op consumes a key handle in this slice, so shipping it would
      be dead exports (knip); add with the first op that chains an `i18n` handle._

## Phase 2 — mutating ops on `ts` plugin

> Spec: [docs/spec-refactor-port.md](spec-refactor-port.md) (approved). The front-renamer
> transform brains vendored into `plugins/ts/refactor/`, reusing codemaster's plumbing.
> **Exit**: edit-safety invariant green; symbol-anchored refactors + shape-based codemods
> work dry-run-first with explicit `apply: true`.

- [~] vendor `front-renamer` engine inside `plugins/ts/refactor/` (symbol-anchored): tree
  (C) + rename (D) + change_signature (E, remove/reorder params) + move/import-rewrite (F)
  - extract TS-only (G) landed; pending: extract's **CSS co-extract** + **patched-LS (spec §4)**
- [x] `support/text-edits` — span-based edits (`apply`/`conflict`/`quote`/`write`); atomic
      temp-then-rename apply; overlap detection (non-empty same-start pairs conflict)
- [x] `support/prettier` — `resolve` (project copy → bundled fallback, reports which) +
      `format` (honest `ok(null)` skip; broken config → `ToolFailure`, never throws)
- [x] `ops/rename-symbol.ts` (D) · `ops/move-file.ts` (F) · `ops/extract-symbol.ts` (G,
      TS-only — LS "Move to a new file", re-targeted + import-rewritten; honest ts-ls taxonomy)
      · `ops/change-signature.ts` (E, remove/reorder positional params at decl + call sites) —
      dry-run preview → explicit `apply`; git-aware (dirty gate, rollback to HEAD). Extract's
      CSS co-extract + patched-LS (spec §4) still pending
- [x] `ops/codemod.ts` — ast-grep matcher; declarative pattern + rewrite; **never claims
      to target a symbol** (§7), gated by the spec §2.8 post-edit typecheck
- [x] resync — mutating ops write through `support/text-edits` + `support/git`; the next op's
      read-time freshness check (the engine reindexes touched plugins) self-corrects (§7)
- [x] tests (git-backed) — dry-run zero-write · `diff(dry)==diff(apply)` · post-apply
      `tsc` clean (cold Program) · rollback byte-exact (rename overlay-gate + move revert unit)

## Phase 3 — non-TS plugins (`scss` · `i18n` · `schema`)

> **Exit**: cross-tier ops work — agent can `find_unused_scss_classes`,
> `find_unused_i18n_keys`, `list_endpoints`.

- [x] `plugins/scss` — done, pulled forward (see the §"Phase 3 (pulled forward)" section)
- [x] `plugins/i18n` — done (see the §"Field feedback, round 2" i18n plugin entry)
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
