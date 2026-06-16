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
      Prettier, knip, lint-staged + husky, `fix-and-check`, `check` (non-mutating CI twin),
      GitHub Actions gate (`.github/workflows/ci.yml`) + optional pre-push
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
      — deferred: today each MCP/CLI process hosts its own in-process orchestrator, so every
      MCP connection/worktree spawns its own warm LS (no §2 amortization) and orphaned stdio
      servers pile up (observed: 26). Spec:
      [docs/spec-daemon-singleton.md](spec-daemon-singleton.md) (proposed; Stage 1 orphan-reaping
      → Stage 2 socket singleton + thin stdio bridge)
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
- [x] oracle runners (ripgrep, cold `Program`) + scenario runner — cold `Program`
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
- [x] tests — proof-span validity swept over **every** span-bearing read op
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
- [x] cross-sheet `composes: x from './other'` linkage — `find_unused` resolves the relative
      `from` (via the shared `support/fs/resolve-relative.ts`) and marks the provider class
      reachable; an unresolvable OR resolved-but-unindexed specifier demotes the composed name
      everywhere (conservative — never a false `certain` dead)
- [ ] follow-up (deferred — SAFE direction, low-frequency): `scanCssModuleUsages` shadow-skip
      (`plugins/ts/scope-shadow.ts`) only treats function params + catch vars as shadows of a
      css-import name; a `const`/`let`/`var` rebind (`import s from './x.scss'; { const s = …;
s.notCss }`) is NOT skipped, so that access is mis-counted as a class use (a false "used"
      that can mask a genuinely-dead class). It is the SAFE direction (never a false
      `certain`-unused) and rare. A correct fix needs **block-POSITION-aware** shadowing (a
      `const s` shadows only from its declaration onward in its block — a naive subtree-wide skip
      would over-skip a real `s.x` EARLIER in the same block, a worse false-"unused" lie), so it
      is tracked-not-patched (documented in `scope-shadow.ts`). Do it **when this pattern is
      observed biting in a real repo**, with the position-aware analysis + before/after-decl tests.

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

- [x] vendor `front-renamer` engine inside `plugins/ts/refactor/` (symbol-anchored): tree
      (C) + rename (D) + change_signature (E, remove/reorder params) + move/import-rewrite (F)
  - extract (G): TS move + **patched-LS rescue (spec §4)** + **CSS co-extract**
    (`css: 'copy-safe'`, spec-css-coextract) all landed
- [x] `support/text-edits` — span-based edits (`apply`/`conflict`/`quote`/`write`); atomic
      temp-then-rename apply; overlap detection (non-empty same-start pairs conflict)
- [x] `support/prettier` — `resolve` (project copy ONLY, no bundled fallback — absent
      project prettier → `available:false`, file written unformatted) + `format` (honest
      `ok(null)` skip for no-parser AND no-config; broken config → `ToolFailure`, never throws)
- [x] `ops/rename-symbol.ts` (D) · `ops/move-file.ts` (F) · `ops/extract-symbol.ts` (G,
      TS-domain core — LS "Move to a new file", re-targeted + import-rewritten; honest ts-ls taxonomy)
      · `ops/change-signature.ts` (E, remove/reorder positional params at decl + call sites) —
      dry-run preview → explicit `apply`; git-aware (dirty gate, rollback to HEAD). Extract's
      patched-LS rescue (§4) + CSS co-extract (`ops/extract-css-coextract.ts`) landed
- [x] `ops/codemod.ts` — ast-grep matcher; declarative pattern + rewrite; **never claims
      to target a symbol** (§7), gated by the spec §2.8 post-edit typecheck
- [ ] codemod enhancement — accept a full ast-grep **rule** object (relational constraints:
      `inside`/`has`/`follows`/`not`/…) alongside the string `pattern`; the engine already
      supports it, only the narrow string slice is wrapped today. Additive, back-compatible;
      the metavar guard must walk the whole rule tree. Spec:
      [docs/spec-codemod-ast-grep-rule.md](spec-codemod-ast-grep-rule.md) (proposed)
- [x] resync — mutating ops write through `support/text-edits` + `support/git`; the next op's
      read-time freshness check (the engine reindexes touched plugins) self-corrects (§7)
- [x] tests (git-backed) — dry-run zero-write · `diff(dry)==diff(apply)` · post-apply
      `tsc` clean (cold Program) · rollback byte-exact (rename overlay-gate + move revert unit)
- [ ] follow-up (deferred — DRY-only, not a correctness gap): the two mutating-op envelope
      builders (`ops/refactor-apply.ts` flat-edit path + `ops/refactor-plan-apply.ts` move/extract
      path) encode the same §2.10 dry-run/apply/rollback contract with near-verbatim gate /
      envelope / post-typecheck blocks. Both are verified correct and the edit-safety suite
      already covers both paths — a pure DRY consolidation with no behavior change to buy, so
      defer. Extract a shared scaffold (commit + rollback injected; the move-specific collision-check / `removed` tombstones / `git mv` stay
      in the plan path) **when the next change to the §2.10 contract forces editing both.**

## kitchensink integration — the port's first realistic workout

> Spec: [docs/spec-kitchensink-integration.md](spec-kitchensink-integration.md). Drive the
> Phase 2 symbol-anchored ops over the dense `test/fixtures/repos/kitchensink/` trap-zoo
> (spec-synthetic-fixture). Test-writing only (no production code); expected to SURFACE port
> bugs — handled per the failure discipline (§2), audited in
> [docs/findings-kitchensink.md](findings-kitchensink.md).
> **Exit**: each stage's tests green-or-honestly-quarantined; oracles independent (cold-LS /
> `tsc` / git byte-exact / independent css scan).

- [x] oracle: `test/helpers/cold-ls.ts` → `coldFindReferences` (cold LS over the post-op tree)
- [x] Stage 1 — `rename_symbol` over the substrate (`test/e2e/kitchensink-rename.test.ts`):
      high-fan-in `formatLabel` (M4 dual-path) + `Registry` (T3) + const-enum member `Code.Ok`
      (T13, inlined refs); cold-LS refs + cold `tsc` + git byte-exact. Surfaced **KS-1** (rename
      preserves the old name through a re-export chain — RESOLVED: completeness signal added, an
      `oldNameSurvives` note on the rename envelope, `docs/spec-rename-completeness-signal.md`).
- [x] Stage 2 — `move_file` over the substrate (`test/e2e/kitchensink-move.test.ts`):
      M11 dual-spelling (both spellings rewritten, ext-style preserved) · M12 `import().Type` (3
      embedded paths + ES type import) · M9 dynamic specifier · folder move + sibling scss/bare-scss
      carry + history. All green — no port bugs surfaced.
- [x] Stage 3 — `extract_symbol` (+ CSS co-extract) (`test/e2e/kitchensink-extract.test.ts`):
      closure-capture from the T12 monolith (KS-2 — scope analysis works, extract refused under
      verbatimModuleSyntax: type-only captures imported as values; tsc-clean MUST quarantined,
      bug filed) · Widget co-extract (KS-3 — CSS report correct: safe title/badge moved,
      card NESTED / block\_\_el NO-RULE; TS extract refused as sole-export importers dangle, bug filed)
- [x] Stage 4 — oracle hardening (extend `kitchensink-traps.test.ts` + fixture): S12 isolable
      `composes` target (KS-4 — CLOSED by spec-scss-css-honesty Stage 1: find_unused now consults
      `composes:` linkage → `composeBase` is `partial`, never plainly certain-unused) · S5
      dynamic-module demotion (`.active` → partial, works) · M9
      honest-limitation (move rewrites the dynamic specifier; rename reaches the dynamic-import
      member + leaves the path string to move_file)

## Phase 3 — non-TS plugins (`scss` · `i18n` · `schema`)

> **Exit**: cross-tier ops work — agent can `find_unused_scss_classes`,
> `find_unused_i18n_keys`, `list_endpoints`.

- [x] `plugins/scss` — done, pulled forward (see the §"Phase 3 (pulled forward)" section)
- [x] `plugins/i18n` — done (see the §"Field feedback, round 2" i18n plugin entry)
- [x] `plugins/schema` — openapi-typescript `openapi.d.ts` reader → endpoint cards (method ·
      path · params · query · body · response), proof-carrying; own parser
      (`ts.createSourceFile`, AST only — no `deps: ['ts']`); config-gated; freshness/reindex
      per entrypoint ([spec-schema-plugin.md](spec-schema-plugin.md)). _Deferred: orval/custom
      runtime-client shape (`generator: 'custom'`) — stated follow-up, not a silent partial
      (spec §2); the `schema:` SymbolId/rebind — no op chains an endpoint handle yet (knip)._
- [x] config sections wired + zod-validated (`scss`, `i18n`, `schema`) — `schema` gated in
      `bin.ts`/`project.ts` `pluginsFor`
- [x] `ops/list-endpoints.ts` (cards + `pathInclude`/`method` filters + SQL table); response/
      body/query are proof-carrying type REFERENCES that chain into `expand_type` at the span.
      _Still todo: `ops/scss-class-diff.ts` (the remaining Phase-3 op)._
- [x] tests — `schema` per-plugin oracle (hand-enumerated cards, cold reparse, span validity,
      `expand_type` chain end-to-end, freshness honesty, cold==warm, op gating —
      `test/differential/schema.test.ts`); `list_endpoints` in the universal span sweep

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
- [x] `ops/impact.ts` — type-aware blast radius: the bounded transitive set of DEPENDENTS,
      a depth/node-capped BFS over `find_usages` (encloser rollup). Proof-carrying, cycle-safe
      (visited-set), honest truncation + value-flow `dynamic` boundaries (spec-impact-op.md).
      Deferred follow-ups (out of this task's scope — parked, not lost):
  - [ ] **type-error blast radius** — beyond reference edges, simulate the change and report
        the real `tsc` errors it would introduce at each dependent (needs a trial edit +
        `typecheckOverlay`; the spec scoped impact to the reference closure only).
  - [ ] **`batch + sql` table** — impact omits `TableSpec` because its hard never-hang cap
        conflicts with sql-mode's "producers run uncapped" rule (a capped table feeding
        `NOT IN` lies, §2.3). The `summary.byDepth` counts cover the common aggregate; a
        sound sql face would need a "bounded-by-design, always-partial" table contract.
  - [ ] **precise escape-site span** — a `dynamic` boundary is flagged at the _encloser's_
        `file:line:col` (grouped `find_usages` gives no per-ref span); the exact value-read
        token would be a tighter proof (an ungrouped re-query of flagged parents).
  - [ ] **module-rollup leaves** — a `(top-level file.ts)` dependent can't be re-expanded by
        SymbolId (no symbol at 1:1), so it's a closure leaf; impact flags it un-expandable +
        `complete:false`. Two `find_usages`/`classifyRole` ROOT causes (filed to the feedback
        inbox, would deepen impact's reach if fixed): (a) a ref inside a top-level value
        binding (`export const b = a()`) rolls up to the module node, not `b` — so the chain
        through `b` dead-ends; fix = `findEncloser` treats any top-level named
        `VariableDeclaration` as an encloser. (b) an interface/type method-SIGNATURE
        occurrence is classified role `read`, producing a spurious value-flow `dynamic`
        boundary (safe over-warn, but noisy); fix = `classifyRole` returns `decl`/`type` for
        type-member signatures.
  - [ ] **wall-clock deadline** — termination is guaranteed by the node cap (≤ `nodes`
        find_usages calls, each LS call itself deadline-bounded §19), but there is no
        cumulative wall-clock budget → on a huge repo the op can be slow-but-finite. A
        per-op deadline → `ToolFailure{timeout}` needs a live `Clock` in `OpContext` (only a
        captured `nowMs` is exposed today) — an engine-level addition, not impact-local.
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

## Stress-test findings — mutation-gate / codemod / output hardening

> Spec: [docs/spec-stresstest-findings.md](spec-stresstest-findings.md) (proposed). Consolidated
> backlog from a 90-point adversarial MCP stress test (read/sql layer passed clean; all findings
> are in mutating ops + codemod + output/honesty edges). Priority-ordered:

- [x] **P0** — `ts` LS host canonicalizes symlinks (`realpath`, like `tsc`/`createProgram`) — the
      tsconfig WAS loaded correctly (root cause was NOT config); on pnpm repos the missing `realpath`
      loaded a package under two paths (symlink + realpath) → duplicate type identity → the ~600
      phantom errors (vs project tsc=0) that poison every mutation gate (§1a; ARCHITECTURE §5/§19)
- [x] **P1** — move/extract baseline-diff re-keys a moved file's own pre-existing errors as
      `introduced` (§1b, shipped bug) · codemod `$$$` malformed output + `paths` glob silent-0 (§2)
      · extract of a nested symbol silently retargets to the enclosing top-level (§4a)
- [x] **P2** — mutation summary before the diff (cap hides verdict, §3a) · dropped the uninvokable
      `fields` dial, point to `sql` projection (§3b) · cross-root SymbolId → gone/re-search not
      name-rebind, via a `~rootTag` origin stamp (§4b) · validate a root is a TS project (§4c) ·
      one-shot staleness banner (§6)
- [x] **P3** — softened the fuzzy/Cmd+T claim · ambiguous-decl column added · role read/write doc
      (§5) · non-determinism (§1c, resolved via P0) · deferred new ops `construction_sites` /
      `css_cascade` still parked (§7, out of scope)

## Capture-safety — generalize the post-edit re-resolve (+ summaryOnly)

> Spec: [docs/spec-refactor-capture-safety.md](spec-refactor-capture-safety.md). Turned the
> rename-only silent-capture fix (commit `530cb0b`) into a general guarantee across every mutating
> op, surfaced as `captures: [...]` on the envelope (refuses apply, shown on dry-run). Shared helper
> in `src/plugins/ts/refactor/capture/` (types · overlay-resolve · rename · imports · codemod).

- [x] shared `capture/` helper; rename refactored to use it (returns `captures` on the outcome,
      no longer fails the whole op — the agent still sees the diff)
- [x] move/extract: each rewritten import re-resolved over the post-move tree (path-capture)
- [x] codemod: re-resolution of metavar-PRESERVED identifiers inside the rewritten span
- [x] `captures` on every mutating envelope (verdict-first, before the diff); apply refused when
      non-empty, naming the sites + the corrective action
- [x] `summaryOnly` mutation flag → verdict + per-file `+added/-removed` diffstat, omits the diff
- [x] oracle-backed corpus (`test/e2e/capture-safety.test.ts`): rename/move/extract/codemod capture
      repros that REFUSE (cold-checker confirms the genuine re-bind) + over-refusal guards that APPLY

### Residual gaps (honest — follow-ups, NOT silent)

- [ ] **codemod, introduced-identifier capture.** Only metavar-PRESERVED references are checked. A
      rewrite that INTRODUCES an identifier (literal template text) which binds a same-named local is
      NOT flagged — flagging it would over-refuse legitimate codemods (the §1 risk). The
      whole-program §2.8 typecheck is its only guard (catches a type mismatch, not a same-typed
      shadow). Documented in the op notes + `capture/codemod.ts` header.
- [ ] **codemod, out-of-span re-resolution.** A rewrite that changes scope by deleting/adding a
      declaration can re-resolve a reference OUTSIDE the rewritten span; only in-span references are
      checked (the spec's stated minimum). §2.8 catches a resulting dangle/type-mismatch, NOT a
      type-compatible re-bind (the typecheck is blind to a same-typed shadow — the whole reason this
      capture gate exists).
- [x] **codemod region offsets byte↔UTF-16 (FIXED, post-review).** ast-grep reports UTF-8 byte
      indices; the capture check enumerates identifiers at TS UTF-16 char offsets. The mismatch on
      non-ASCII source could MISS a capture OR FABRICATE one (over-refuse a clean codemod — the §1
      risk). `byteToUtf16` now converts every edit boundary up front so regions are built entirely in
      char space (`codemod.ts`).
- [ ] **import-capture is forward-only.** Verifies each rewritten import still lands on its intended
      target; does not check a pre-existing non-rewritten import that the move now shadows (rarer,
      and a fresh-ground collision is already refused). Reverse import-capture is a follow-up.
- [ ] **import-capture `directoryExists` tombstones files, not now-empty dirs** (under-refusal, LOW;
      from bug-review). `postMoveResolutionHost` (`capture/imports.ts`) tombstones moved-away FILES
      in `removedAbs`, but a directory left empty by the move still `directoryExists` on disk during
      dry-run, so a stale relative resolution could land and MASK a capture. Within the conservative
      "only a positive divergence is a capture" contract (the §2.8 typecheck still gates a true
      dangle), so accepted — closing it means tombstoning emptied dirs too.

## Task B — Agent-surface ergonomics: `status` brief/op + `find_unused_exports`

> Spec: [docs/spec-agent-surface-ergonomics.md](spec-agent-surface-ergonomics.md).

- [x] **`status {brief}` / `status {op:"<name>"}`** — brief = header + warm roots + plugins + per-op name+summary + freshness only; single-op = one op's full schema/notes/example
      on demand. Default `status` stays FULL (back-compat + golden).
- [x] **Drop the duplicated GUIDANCE tail** — the 4 `>` lines in `status` duplicated
      `SERVER_INSTRUCTIONS` (shipped once per session at MCP `initialize`); removed the
      `guidance` field + render.
- [x] **`find_unused_exports`** — TS exports with no importer/usage anywhere (semantic, via
      the LS). Barrel/`export *`/dynamic-`import()`-reached → `partial` ("could not prove
      dead"), never "definitely unused". pathInclude/pathExclude scope + bounded candidate
      scan (caps fast). Mirrors `find_unused_scss_classes`/`find_unused_i18n_keys` honesty.

### Out-of-scope findings (do not lose — surfaced while building Task B)

> Backlog discovered during Task B; NOT in its scope. File-and-park so they survive the session.

- [ ] **`find_usages` / dead-code ops are blind to a separate test program (`tsconfig.test.json`).**
      The warm LS runs the MAIN `tsconfig`; a symbol used only by `test/**` (compiled under
      `tsconfig.test.json`) reads as having no usage — e.g. `nullWatcher` shows `total=1 (decl)`
      though `test/helpers/project.ts` imports it. So `find_unused_exports` can mark such a symbol
      `certain` unused. Disclosed in the op's notes for now (matches `find_usages`), but the real
      fix is indexing sibling tsconfigs (project-references / a test-program overlay) or a caveat
      when a symbol's file participates in an unloaded `*.test.json`. Filed to codemaster feedback
      (friction). Inherent to any single-program "is X used" op.
- [ ] **No wall-time bound on synchronous TS ops until the §19 kill-on-deadline backstop lands.**
      `find_unused_exports` is `cap × O(import-graph)` (cap=200 reference searches); `find_usages`
      is 1× but on a 10k-importer symbol is itself O(repo). Both are bounded by DESIGN (scoped/
      capped inputs, §19) but neither degrades to an honest `ToolFailure{timeout}` on a pathological
      whole-repo call — a default `find_unused_exports {}` on a 50k-file repo could put widely-
      imported modules among the first 200 candidates and exceed the latency budget. The hard
      guarantee is the §19 engine isolation + kill-on-deadline (process mode), still roadmap. A
      genuinely-O(repo) single-pass `find_unused_exports` (walk refs once, resolve via the checker,
      diff against the export set) is the future optimization IF profiling shows the cap limits real
      use — but it re-opens the false-certain risks the current LS-delegating design closes, so park
      it behind that evidence. Meanwhile: scope with pathInclude.

## Out-of-scope findings — surfaced during Task F (i18n alias-aware), parked

Discovered while implementing [spec-i18n-alias-aware.md](spec-i18n-alias-aware.md); each is
real but outside that task's scope (isolated to the i18n plugin + its ops). Captured so they
don't evaporate.

- [ ] **F-a (perf) — `scanLiteralCalls` runs uncached + now does per-call checker work.**
      Each of `i18n_lookup` / `find_unused_i18n_keys` / `find_missing_i18n_keys` calls
      `ts.literalCalls(functions)` fresh, and the import-resolution adds `getSymbolAtLocation`
      per candidate callee — an O(#calls) checker sweep re-run per op. Bounded (linear, no loop),
      so honesty holds, but a memo keyed on `ts.freshness()` + `fnNames` (invalidated on reindex)
      would cut repeated work, especially for a `batch` that runs several i18n ops together.
- [ ] **F-b (capability) — matching is by NAME (module-blind), not by symbol identity.**
      Resolution is confined to user-named bindings (written name, named-import alias, configured
      dotted base) because config names only the FUNCTION, never its module — so the code cannot
      prove a `t`/`i18n.t` call targets THE i18n module vs a same-named function elsewhere. We
      pick the honest-safe side: only assert a match where the user explicitly named the binding
      (a bare `t` never matches `<import>.t()`; a destructure rename of a non-i18n value is not
      resolved). Two residuals remain, accepted and documented (op notes + literal-calls.ts):
      (1) FALSE POSITIVE — a `t` from a non-i18n module still matches by resolved name, both the
      pre-existing `import { t } from './telemetry'; t('k')` AND, new in Task F, its aliased form
      `import { t as tr } from './telemetry'; tr('k')` (one hop further, rarer; a call carrying no
      i18n signal at the site → a fabricated find_missing row / usage). (2) FALSE NEGATIVE — a key
      reached ONLY through a binding we don't follow (a renamed destructure of the real hook
      `const { t: x } = useTranslation()`, element access `i18n['t']`, `t` passed as a value) is
      missed → find_unused may report a live key as `certain` unused. Both are the by-name model's
      limit, not coding bugs. A namespace/default import renamed at the import site
      (`import * as foo from '@/i18n'; foo.t()`, config `i18n.t`) is also NOT resolved — a
      namespace import has no export name to de-alias. The real close: add config to
      NAME the i18n module/hook, resolve the configured function to ONE declaration, then match
      call sites by symbol identity (like `find_usages`). That closes both the false-positive
      residual AND the namespace-alias gap. Out of this spec's scope.
- [ ] **F-c (DX) — no per-usage resolution provenance.** `i18n_lookup` usages carry only a span,
      so a user can't see which were written-name vs import-resolved (alias/destructure/namespace).
      Filed to the codemaster feedback inbox as a wish during dogfooding; a `provenance` column
      would make the new resolution self-auditable.

## Cross-cutting (gates every box, not a phase)

- [ ] `fix-and-check` green · oracle-backed test · no file > 300 lines · no upward
      import · no cyclic plugin deps
- [ ] new boundary → zod-validated · new external-tool call → wrapped → `ToolFailure`
- [ ] docs at present state · remove each newly-wired dep from `knip.jsonc`
      `ignoreDependencies`
- [ ] every plugin reports honest freshness; every op aggregates freshness from the
      plugins it touched
