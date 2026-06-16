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

## Task C — `move_symbol` (move one symbol into an EXISTING file)

> Spec: [docs/spec-move-symbol.md](spec-move-symbol.md). Relocate a top-level symbol from its
> file into an EXISTING `dest`, merging its imports into dest's and rewriting every importer.

- [x] **`ops/move-symbol.ts`** — new mutating op `move_symbol { symbol?|name?|file+line+col,
dest (existing file), dirtyOk? }`. Reuses `applyRefactorPlan` (the same §2.8 dry-run/apply/
      typecheck/rollback + dirty-gate + capture machinery as move/extract); registered in
      `ops/builtins.ts`; self-describes in `status` (golden updated, 17 ops).
- [x] **Planner via the native LS "Move to file" refactor** (`refactor.move.file` +
      `interactiveRefactorArguments.targetFile`) — `plugins/ts/refactor/extract/move-to-existing.ts`.
      **Deliberate deviation** from the spec's "reuse extract planning + hand-append" sketch: the LS
      itself owns the hard part (merge the moved symbol's imports into dest's existing imports,
      existing-locals, rewrite every importer incl. aliased/re-export, add the source back-import).
      A hand-rolled merge over `rewriteImports`/`computeCommitPlan` would be a large, bug-prone
      mutation of shared move/extract code; the project's own §2.8 post-typecheck gate + byte-exact
      rollback make leaning on the LS equivalently safe (a bad edit is refused, never shipped). The
      LS is an **edit producer, not a fact oracle** (ARCHITECTURE §4) — its edits are gated by the
      project's own LS, gated to the project TS major via the same §4 rescue path on assertion.
- [x] **Shared statement helpers** (`extract/statements.ts`) — range + nested-target guard +
      `applyTsChanges` extracted from `move-to-file.ts` so extract and move_symbol can never drift on
      "what is the symbol the agent pointed at" (no copy-paste; both call `targetsNestedDeclaration`).
- [x] **Honest refusals** — dest not in project (→ use `extract_symbol`), `source===dest`, nested
      target (§4a), dest top-level name-collision (pre-check + §2.8 backstop), JSX body into a `.ts`
      dest. None half-write (refused before/at the gate).
- [x] **Capture-safety** (`capture/move-symbol.ts`) — the importer rewrites are LS-driven (not
      `rewriteImports`), so capture metadata is RECONSTRUCTED: each before→after-NEW importer
      specifier bringing in the moved name is re-resolved over the post-edit tree through the shared
      `detectImportCaptures`; a same-named, type-compatible export at a different path is flagged and
      apply refused. Conservative — only move-INTRODUCED specifiers are policed (a pre-existing
      same-name import is left alone), so no over-refusal.
- [x] **Oracle edit-safety tests** (`test/e2e/move-symbol.test.ts`) — A→existing B with an ALIASED
      importer repointed, cold `ts.Program` clean, `diff(dry)==diff(apply)`; §2.8 gate refuses an
      introduced error byte-identical; name-collision / nested / dest-not-in-project / same-file /
      `.js`-dest / re-export-barrel all REFUSED with nothing written; source-no-longer-uses (no
      back-import), type-alias + type-only importer. Plus a synthetic capture unit test
      (`test/unit/move-symbol-captures.test.ts`): a divergent specifier is flagged, a clean move
      flags nothing (no over-refusal), pre-existing same-named imports are left alone.

### Residual gaps (honest — follow-ups, NOT silent)

- [ ] **specifier style is LS-chosen, not alias-preserving.** Unlike `extract_symbol` (whose final
      consumer specifier is codemaster-emitted via `emitSpecifier`, alias-aware), `move_symbol`'s
      importer specifiers are emitted by the LS, which prefers a relative form (`@/source` →
      `./dest`) over re-forming the project's path alias. Functionally correct (cold compile proves
      resolution) — purely a cosmetic/diff-noise difference. Closing it means post-processing the
      LS's emitted specifiers through `emitSpecifier`, or a follow-up that teaches the LS preferences.
- [ ] **capture reconstruction is name-anchored.** A move with an unnamed / multi-binding top-level
      statement yields no single moved name, so the name-anchored capture reconstruction is skipped
      (the §2.8 typecheck remains the backstop). Today's op moves one named top-level symbol, so this
      is not reachable via the current target resolver, but noted for when multi-binding moves land.
- [ ] **no positive capture fixture yet.** The reconstruction + over-refusal guard are exercised by
      the happy path (captures empty → applies). A POSITIVE capture repro (the LS emits a specifier
      that resolves to a different same-named export) is hard to construct deterministically with the
      LS's correct resolver; add one if a real-world case surfaces. The forward-only / empty-dir
      limitations of `detectImportCaptures` (shared with move/extract) apply here too.
- [ ] **capture `line:col` is computed over UNFORMATTED LS output, not the prettier-formatted diff**
      (shared with move/extract's `capture/imports.ts`, acute for move_symbol's freshly-synthesized
      dest import-merge). `capture/move-symbol.ts` reads the specifier position from `d.after` (raw
      LS edit), but the diff the agent sees is prettier-formatted in the op layer — so on a real
      capture whose import sits where prettier reflows, the proof `file:line:col` can point at a line
      the formatted diff doesn't have. The detail string still names the specifier; only the
      coordinate drifts. Apply is refused either way (correct verdict). Clean fix: locate the
      specifier in the FORMATTED content (needs the format pass visible to capture detection — a
      cross-cutting refactor of where formatting sits vs the plugin-layer planner).
- [ ] **renamed default-import under-detection** (capture). A locally-renamed default import of a
      moved `export default` is not reconstructed (matches on local name ≠ moved name). Currently
      UNREACHABLE — the LS doesn't rewrite default-export importers, so the gate refuses the dangling
      move first. Documented in `capture/move-symbol.ts`'s `declImportsName` header.
- [ ] **CROSS-CUTTING (pre-existing, NOT move_symbol-specific) — stale `before` on a RE-DIRTIED
      tracked file in non-watcher mode.** Surfaced by a move_symbol bug-review but it affects EVERY
      refactor op through `assemblePlan` + `applyRefactorPlan` (move_file / extract_symbol /
      move_symbol). `assemble.ts`'s `diskText` reads the plan's `before` (the dry-run diff base AND
      the rollback-restore content) from the warm program text, not a fresh disk read. The read-time
      freshness guard only reindexes on a CHANGED git fingerprint (`HEAD` + `git status --porcelain`),
      and porcelain is content-insensitive for an already-dirty tracked file: a file edited twice
      with no commit between shows ` M path` BOTH times (identical fingerprint → no reindex). So if
      the daemon is warm, the watcher is OFF/degraded (the design says the read-time guard alone must
      hold — `freshness.ts:1`), and a tracked file is edited a SECOND time on disk, the warm program
      still holds the first-edit text → a dry-run `diff` whose `before` lies (§2/§3), and under
      `apply + dirtyOk` the second edit is silently lost (commit splices onto stale base; rollback
      restores stale bytes). Masked in the common case by the chokidar `reindexAll`. Narrow fix: read
      `before` from a fresh disk read for any path in the porcelain dirty set (or hash dirty-path
      contents into the git-mode fingerprint, as walk-mode already does). Out of THIS task's scope
      (touches shared freshness/assemble code) — filed here so it is not lost.
- [ ] **re-export barrels are not repointed (honest refusal, not silent).** The LS "Move to file"
      rewrites DIRECT importers but leaves `export { X } from './source'` re-export barrels untouched
      — so a barrel naming the moved symbol dangles and the §2.8 gate REFUSES the whole move (verified
      in `test/e2e/move-symbol.test.ts`; disclosed in the op notes). Closing it means supplementing
      the LS edits with codemaster's own barrel-specifier rewrite (the same kind of import-rewrite
      `rewriteImports` does for move/extract) — a follow-up; the current behavior is safe (never a
      half-move), just less capable than direct-import repointing. Also: the default export's
      importer (`import x from './source'`) is likewise not repointed by the LS → same honest refusal.

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
  - [x] **precise escape-site span** — DONE (spec-usage-role-rollup-fidelity, Task H). The
        rollup now records a representative reference SITE span per encloser (`GroupRow.site`,
        captured where ref+encloser are paired — no extra LS call, never a guessed heuristic);
        a `dynamic` boundary points at the exact value-read TOKEN instead of the encloser name.
        Stripped from agent-facing `find_usages`/`impact` listings (`group-row.ts`) — internal
        plumbing, dense output preserved.
  - [x] **module-rollup leaves** — DONE (spec-usage-role-rollup-fidelity, Task H). Both
        `find_usages`/`classifyRole` ROOT causes fixed: (a) a ref inside a top-level non-function
        value binding (`export const b = a()` / `const cfg = { f: dep }`) now rolls up to the
        binding `b`/`cfg` (kind `const`/`variable`, re-resolvable `name@file:line:col`), not the
        module node — so impact follows the chain through `b` to its own dependents instead of
        dead-ending. `findEncloser` treats any TOP-LEVEL named `VariableDeclaration` as an
        encloser (function-valued ones stay `function`; nested locals still roll to their
        enclosing function). (b) an interface/type-literal method-/property-SIGNATURE occurrence
        is now role `type` (was `read`), killing the spurious value-flow `dynamic` boundary on
        ordinary symbols that structurally match an interface member.
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
      (§5) · non-determinism (§1c, resolved via P0) · `css_cascade` now SHIPPED (see the
      "Task L — `css_cascade`" section below); `construction_sites` still parked (§7, out of scope)

## Task L — `css_cascade` op (resolved cascade / specificity for a CSS-module class)

> Spec: [docs/spec-css-cascade-op.md](spec-css-cascade-op.md). A net-new read op extending the
> scss plugin with a resolved-cascade/specificity VIEW over the postcss CST. Honest `partial`
> first-class for the syntactic model's limits (§19); proof-carrying; bounded; wrapped.

- [x] `plugins/scss/cascade/specificity.ts` — W3C (a,b,c) specificity over a resolved complex
      selector (`:is`/`:not`/`:has` max-of-args, `:where` 0) + subject (rightmost-compound)
      class extraction + condition traits (descendant/state/attribute/negation/pseudo-element/
      interpolation). Oracle: canonical W3C examples (`test/unit/scss-cascade-specificity.test.ts`).
- [x] `plugins/scss/cascade/rules.ts` — extract per-target CONTRIBUTIONS from a sheet's CST with
      cascade's OWN inclusion policy (NOT parse.ts's class-decl machinery, which drops the
      descendant/`:global`/compound selectors a cross-module override hides in): nesting/`&`
      resolution, `:global` paren/bare forms, `@media`/`@supports` context, proof spans over the
      selector-as-written + each `prop:value`, computed-value (`$var`/`#{}`) flag.
- [x] `plugins/scss/cascade/resolve.ts` — order contributors by specificity; per-property winner
      (`!important` > specificity > later source-order WITHIN a file) + losers. Confidence
      `certain` ONLY for a same-module, unconditional, context-free, statically-valued, untied
      winner; cross-module / state / attribute / `@media` / interpolated / computed / cross-file
      tie → `partial` with the reason. A partial winner is still a NAMED winner.
- [x] `plugins/scss/cascade/query.ts` — on-demand orchestration: re-parse the in-scope sheets
      FRESH (bounded, scopeable by pathInclude — never extends the plugin's hot `warm`/`reindex`
      path), resolve target (class, or a selector's subject), resolve cascade.
- [x] `ops/css-cascade.ts` (registered in `builtins.ts`) + `condense.ts` dense collapse +
      `status` golden. Tests: `test/differential/css-cascade.test.ts` (DoD multi-sheet: local vs
      higher-specificity cross-module descendant/attribute → both reported, ordered, cross-module
      winner NAMED & partial; state → partial; ancestor-context class excluded; !important wins;
      pathInclude scoping; proof-span validity). css_cascade added to the span-validity sweep.

### Out-of-scope findings — surfaced building Task L, parked (do not lose)

- [ ] **scss plugin indexes `.scss` only** (`warm()`/`reindex` gate on `.endsWith('.scss')`), so
      `css_cascade`'s cross-sheet search misses `.module.css` / `.sass` sheets unless one is named
      directly as `{file}` (then it's read+parsed on demand). `cssModuleUsages` already accepts
      `.css`/`.sass` imports, so the index and the usage scanner disagree on the sheet set. Real
      close: index `.css`/`.sass` in the scss plugin (one walk-filter change + parser pick, which
      `parseStylesheetRoot` already does). Stated in the op notes; low frequency.
- [ ] **scss parse-failure messages leak an ABSOLUTE path** (filed to codemaster feedback inbox,
      `friction`). `scss_classes` / `find_unused_scss_classes` / `css_cascade` all report
      `{file:<repo-rel>, message:<postcss CssSyntaxError>}` where the message embeds the machine
      path (postcss resolves `from` to absolute for `Input.file`). Pre-existing, shared across the
      scss parse path; breaks path-scrub/golden stability across machines. Fix = strip the leading
      `${root}/` (or substitute the rel) when recording the failure message.
- [ ] **`:global` / bare-`:global` cross-module handling is best-effort syntactic.** `:global(.x)`
      paren classes and bare `:global .x` / `:global { … }` blocks are surfaced as `global:true`
      (→ always `partial`), but the per-compound boundary of a bare `:global` prefix isn't tracked
      precisely (the whole branch's subject classes are treated global). Conservative-honest (never
      a false `certain`); tighten if a real repo shows it mis-attributing.
- [ ] **explicit `:local(.foo)` subject form is not matched as a module class** (rare false-NEGATIVE,
      found in final bug review). `:global(.x)` paren classes are extracted (via `globalParenClasses`),
      but `:local(.x)` — the explicit form of the css-modules DEFAULT — has its class buried in the
      pseudo arg and is neither read as a module subject class nor as a global one, so a rule written
      `:local(.foo) { … }` is missed entirely for target `foo`. Low frequency (people write `.foo`, not
      `:local(.foo)`), and a missing-rule is far less severe than the false-`certain` it can't cause.
      Fix = pull `:local(...)` arg classes into the MODULE subject set (mirror of globalParenClasses).
- [ ] **cross-file source order is unknown** (we don't model `@use`/`@forward`/import order), so a
      cross-module specificity+importance tie is reported as `ambiguousWith` co-winners at `partial`
      — by design (§19). A real dart-sass evaluation would resolve it; deferred (lean-deps §14).

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

> **F-a / F-b / F-c CLOSED** by [spec-i18n-symbol-identity.md](spec-i18n-symbol-identity.md)
> (Task I). Memo lives in `plugins/ts/plugin.ts` (keyed `projectVersion()` + spec); the
> by-identity scan in `plugins/ts/i18n-identity-scan.ts` (config `i18n.module`/`hook`,
> tsconfig-paths-aware, checker-FREE — see the F-b note for why); provenance on every
> `LiteralCall` + the `i18n_lookup` usage rows. Tests:
> `test/differential/i18n-symbol-identity.test.ts`. The by-name model stays the default
> (no `module` → no regression). Residual honest edges (under-report only, never fabricate):
> element access `i18n['t']`, `t` passed as a value, a non-destructured hook return
> (`const o = useTranslation(); o.t()`), multi-hop re-export chains, within-file shadowing.

- [x] **F-a (perf) — `scanLiteralCalls` runs uncached + now does per-call checker work.**
      Each of `i18n_lookup` / `find_unused_i18n_keys` / `find_missing_i18n_keys` calls
      `ts.literalCalls(functions)` fresh, and the import-resolution adds `getSymbolAtLocation`
      per candidate callee — an O(#calls) checker sweep re-run per op. Bounded (linear, no loop),
      so honesty holds, but a memo keyed on `ts.freshness()` + `fnNames` (invalidated on reindex)
      would cut repeated work, especially for a `batch` that runs several i18n ops together.
      DONE: single-slot memo in `createTsPlugin` keyed on `projectVersion()` + serialized spec.
- [x] **F-b (capability) — matching is by NAME (module-blind), not by symbol identity.**
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
      DONE (Task I): config `i18n.module` resolves the module once (tsconfig-paths aware), and a
      `t('…')` counts iff its callee binding resolves to a function FROM that module (import /
      alias / namespace / `useTranslation()` destructure incl. renamed `{ t: x }`). FP closed
      (telemetry `t` no longer matches); FN closed (renamed destructure + renamed namespace now
      match). Kept bounded/checker-free per §19 (advisor flagged the per-call-checker design).
- [x] **F-c (DX) — no per-usage resolution provenance.** `i18n_lookup` usages carry only a span,
      so a user can't see which were written-name vs import-resolved (alias/destructure/namespace).
      Filed to the codemaster feedback inbox as a wish during dogfooding; a `provenance` column
      would make the new resolution self-auditable.
      DONE: every `LiteralCall` + `i18n_lookup` usage row carries `provenance`
      (`written | alias | destructure | namespace`); the op surfaces a per-provenance breakdown note.

## Out-of-scope findings — surfaced during Task I (i18n symbol-identity) dogfooding, parked

Found running the i18n ops on amiro (real repo); outside this task's scope, captured so they
don't evaporate (also filed to the codemaster feedback inbox).

- [ ] **I-a (UX/honesty) — a single dynamic `t(`…`)` buries `find_unused_i18n_keys` in 1000+
      all-`partial` rows (output then caps).** On amiro the op returned 1025 keys, every one
      `partial`, because one `t(`errors.codes.${code}`)` demotes the WHOLE scan; the dense output
      capped at ~86 KB so the genuinely-dead tail is invisible. The §3 honesty is right (dynamic →
      partial, never guessed) but the answer is unactionable. Candidate closes: (1) when degraded,
      default to a SUMMARY (count + `degradedReason` + "narrow with prefix/pathExclude") instead of
      dumping every partial row; (2) a flag to show only `certain`-dead; (3) **prefix-scoped dynamic
      demotion** — a dynamic `t(`errors.codes.${x}`)` only makes the `errors.codes.*` PREFIX
      unprovable; demote that prefix to `partial` and leave unrelated namespaces `certain`. (3) is
      the real fix and would shrink the false-partial set dramatically; it needs the literal scan to
      surface the static PREFIX of a dynamic template key (currently a dynamic call carries no arg).
- [ ] **I-b (honesty residual) — within-file shadowing of a bound name can FABRICATE.** The
      identity scan is syntactic-by-local-name with no scope resolution, so a local that shadows a
      bound name (a parameter `t` in a file that also imports the configured `t`) is matched →
      `find_missing` can emit a fabricated row, `find_unused` can mis-mark. Same class as the prior
      by-name model (reviewer-rated LOW), documented in `call-identity-scan.ts` header + op notes.
      The cheap closer is `plugins/ts/scope-shadow.ts` (already used by the refactor capture-safety):
      gate a match on "the call site's nearest binding of this name IS the import/destructure", not
      just the name. Out of §19's checker-free budget for this task.
- [ ] **I-c (pre-existing, host) — a `tsconfig.json` `paths`/`baseUrl` edit leaves the identity
      scan resolving against STALE compiler options** until a STRUCTURAL reindex re-globs. `ls-host`
      caches `parsed.options` and only re-parses on a new/removed ts file (`ls-host.ts` `loadFileList`);
      an in-place tsconfig edit bumps `projectVersion` (so the memo + scan re-run) but against the old
      `@/*` mapping, so `resolveModuleArg` can resolve the i18n module to the old target. The F-a memo
      is correct; the staleness is the host's config cache. Niche; flagged by a reviewer.
- [ ] **I-d (minor) — `splitNames` silently no-ops a malformed name.** A leading-dot (`.t`) lands in
      `simpleLeaves` (never matches an identifier); a multi-segment `a.b.c` yields base `a.b` which
      the single-identifier base matcher never matches. Both under-report silently (never lie).
      Could reject at the config schema with a pointed message. Documented in `call-scan-shared.ts`.

## Out-of-scope findings — surfaced during Task H (usage-role-rollup-fidelity), parked

Discovered while fixing `classifyRole` / `findEncloser` / `impact`; real but outside Task H's
scope. Captured so they don't evaporate.

- [ ] **Expose the representative reference SITE in grouped `find_usages` output.** The rollup
      already records `GroupRow.site` (the span of the first reference inside each encloser) to
      power impact's precise value-flow boundary, but it is stripped before the agent sees it
      (`group-row.ts`). Surfacing it would make grouped `find_usages` proof-carrying at the
      reference level — today a group points at the encloser's NAME token (e.g. "Widget uses X
      ×3"), not at where X is actually referenced. Deferred because it widens the public
      `find_usages`/SQL surface (new column, golden churn) beyond Task H; add behind a flag or as
      a deliberate output-shape change with its own goldens.
- [ ] **A factory/HOC-wrapped top-level component is labelled `kind:'const'`, not `function`.**
      `const Foo = memo(() => …)`, `forwardRef(…)`, or a tagged-template (`styled.div`) have a
      call/tagged-template initializer, so `findEncloser`'s `isFn` is false and a ref inside the
      callback rolls up to `Foo` with kind `const`. Strictly BETTER than before (it previously
      dead-ended at the module node) and harmless to `impact`'s value-flow detection (which keys
      off the seed's `callable`, not the encloser kind). But a `find_usages`/`impact`
      `kind:'function'` VIEW filter will skip these renderable bindings. A precise fix would peek
      through known HOC wrappers (or any call/tagged-template whose callback is an arrow/fn-expr)
      to label them `function`. Low priority — label imperfection, never a reachability or escape
      lie.
- [ ] **`findEncloser` does not treat a `namespace`/`module`-nested top-level binding as an
      encloser.** `topLevelVariableStatement` requires the `VariableStatement`'s parent to be the
      `SourceFile`, so a `const` declared inside `namespace N { … }` rolls up to the module node
      (its refs dead-end in impact just like the pre-fix top-level case). Rare in modern ESM TS;
      the position-addressed SymbolId would still re-resolve, so the fix is to walk to the nearest
      `SourceFile`/`ModuleBlock` boundary. Low priority — surfaces only on namespace-heavy repos.

## Task E — Transactional multi-mutation (chain of edits, one gate, all-or-nothing)

> Spec: [docs/spec-transactional-mutation.md](spec-transactional-mutation.md). A new `op`
> `transaction { steps: [{name,args}, …] }` (NOT a 4th MCP tool — §11) applies an ordered chain
> of mutating ops atomically: step i+1 plans against step i's post-edit overlay, ONE §2.8 gate
> over the cumulative result, and byte-exact rollback of the WHOLE sequence on any failure.

- [x] **plan-against-overlay seam** — `PlanningOverlay` (plan.ts) threaded through the overlay-
      aware plugin plan methods (`renameSites`/`planMove`/`planExtract`/`planChangeSignature`):
      the move-tree is seeded from the overlay listing (prior moves/new files baked in) and the
      LS is shadowed with prior-step content + tombstones for the synchronous plan, ALWAYS cleared
      (never leaks into the final disk-baseline gate). `targetOf` (ts-target) is the single shared
      target mapping — the op and the step planner never drift.
- [x] **compose + gate-once** — `transaction-compose.ts` folds per-step `RefactorPlan`s into ONE
      cumulative plan (identity keyed on origin path; `diff[].before` is always the original disk
      bytes — the rollback baseline), fed to the SAME `applyRefactorPlan` backbone → `diff(dry) ==
diff(apply)` is structural and a single-step transaction == the direct op. `refactor-steps.ts`
      is the per-kind step registry (reuses each op's own zod schema).
- [x] oracle-backed edit-safety tests (`test/e2e/transaction.test.ts`): 3-step rename→move→
      change_sig applies with ONE clean gate + cold `ts.Program` compiles; a last step that errors
      rolls back the WHOLE sequence byte-exact (`git status` empty); a middle step that can't plan
      refuses with the step index, writes nothing; a chain that would CAPTURE refuses; single-step
      == direct op. Self-described in `status`; dogfooded live through the MCP.

### Task E follow-ups (out of scope, parked — do not lose)

- [ ] **E-a — `codemod` is not a transaction step.** It reads disk directly (`readTextFile`) and
      detects captures against the disk-LS, so threading the overlay through it is the most invasive
      kind; the DoD chain doesn't need it. The transaction refuses a `codemod` step honestly. Close
      by giving codemod an overlay-aware content source + an overlay-aware `detectCodemodCaptures`.
- [ ] **E-b — CSS co-extract is not supported inside a transaction `extract_symbol` step.** The
      scss join lives in the op (`extract-css-coextract.ts`), not the plan seam; a transaction
      extract is TS-only and refuses `css`. Close by lifting the join into the step planner.
- [ ] **E-c — a transaction containing an extract shares the §1b extract-baseline gap** (path+line
      shift defeats the path-only baseline remap, so a pre-existing error relocated INTO an extracted
      block can read as `introduced`). The op discloses this with a hedge note rather than asserting
      it; the real fix is the span-aware baseline remap already tracked under "Stress-test findings".
- [ ] **E-d — dir moves inside a transaction commit file-by-file** (per-file `git mv`, not one
      dir move), so an emptied source directory may linger (git ignores empty dirs). A single
      `move_file` of a folder is unaffected; only a folder move _inside a chain_ takes this path.
- [ ] **E-e — a path swap/cycle within a composed transaction** (`a→b` while `c→a`) hits
      `computeCommitPlan`'s clobber guard → an honest refusal (never corruption), but a legitimate
      swap isn't supported (needs temp-file ordering). Same backstop as the single-op case.
- [ ] **E-f — `move_symbol` (spec scope-IN list) does not exist as an op** — the spec's step list
      was aspirational; the four real symbol/path refactors are wired. Revisit if `move_symbol` lands.
- [ ] **E-g — import-capture detection for a move/extract step ≥2 is not overlay-aware.**
      `capture/imports.ts` builds its OWN `ts.ModuleResolutionHost` (afterContent = this step's
      `overlayFiles`, else `ts.sys` = pre-transaction disk), so a rewritten specifier that must
      resolve through a PRIOR step's move is checked against the stale disk layout. The final
      whole-program `typecheckOverlay` backstops a DANGLE, but a same-named type-compatible export
      reachable only via the prior-move layout could slip the import-capture gate (a narrow
      false-negative). Fix: seed that resolver from the cumulative overlay/listing the step planned
      against (the rename-capture path is already nest-safe via `withMergedOverlay`).
- [ ] **E-h — dry-run does not preview the capture/collision/dirty REFUSAL verdict.** The shared
      `applyRefactorPlan` dry-run branch emits the `captures` rows but not `applied:false`+`reason`
      (those gates are apply-only) — so `diff(dry)==diff(apply)` holds but an agent reading only
      `typecheck.clean` (a separate signal from captures) wouldn't see the would-refuse. Pre-existing
      across all mutating ops; a predictive `wouldApply:false`+reason on dry-run would close it
      uniformly (touches the shared backbone + goldens, hence parked, not slipped into Task E).

## Cross-cutting (gates every box, not a phase)

- [ ] `fix-and-check` green · oracle-backed test · no file > 300 lines · no upward
      import · no cyclic plugin deps
- [ ] new boundary → zod-validated · new external-tool call → wrapped → `ToolFailure`
- [ ] docs at present state · remove each newly-wired dep from `knip.jsonc`
      `ignoreDependencies`
- [ ] every plugin reports honest freshness; every op aggregates freshness from the
      plugins it touched

## Findings parked during Task K (`construction_sites`) — out of this spec's scope

- [ ] **K-a (bug) — `find_usages groupBy:'enclosing'` mints a non-chainable SymbolId for a
      CLASS-MEMBER encloser.** `usages.ts:300` mints `mintSymbolId(enc.name, …)` where
      `enc.name` is the QUALIFIED display string `Class.method` (`usage-roles.ts:85`,
      `${clsName}${up.name.text}`), but the line:col point at the BARE `method` token. So the §6
      same-symbol check `text.startsWith('Class.method', offset)` fails, the rebind filter
      `searchSymbols(...).filter(c => c.name === 'Class.method')` is empty (navto reports the bare
      member name), and the encloser id resolves `gone` — a dead handle for every class-member
      rollup. It is an honest `gone` (not a silent wrong-bind), but breaks chaining. Fix mirrors
      Task K's `construction-encloser.ts`: mint the id on the BARE member token, keep the dotted
      string as a display/`container` field only. (`construction_sites` already does this; the two
      mint sites could share one helper.) Found by the bug-reviewer; filed to the codemaster
      feedback inbox during dogfooding.
- [ ] **K-b (polish) — a naked type-parameter target is labelled `value`.** `construction_sites`
      pointed (via file:line:col) at a bare type parameter `T` inside a generic falls through
      `targetKind` to `'value'`. Still scanned and correctly demoted to `partial` via
      `isGenericTarget`, so no honesty issue — just a cosmetic mislabel on a degenerate input.
      Low priority.
