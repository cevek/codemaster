# Implementation backlog

Present-state backlog of what's **not yet built** — expanded from [ARCHITECTURE.md §17](../ARCHITECTURE.md).
Shipped work is not narrated here (git holds history); this file lists only open items.

> This is the single backlog. The old per-phase `plan.md` checklist has been retired (its open
> items + the residuals the wave-3 tasks appended are folded in below).

**Tags** (every item): `type` · `importance` · `complexity`

- **type** — `bug` (can lie / crash / lose data / wrong proof) · `feat` (new capability) ·
  `perf` · `dx` (ergonomics / output-shape / dev-loop / test-debt / DRY)
- **imp** — `high` (lies, data-loss, or blocks a common workflow) · `med` · `low` (rare / cosmetic)
- **cx** — `S` (hours) · `M` (a PR) · `L` (a fat task / design needed)

**Definition of done (per item):** `npm run fix-and-check` green · oracle-backed test (§16) ·
no file > 300 real lines · no upward import · no cyclic plugin deps · new boundary zod-validated ·
new external-tool call wrapped → `ToolFailure` · docs at present state · dep removed from
`knip.jsonc` `ignoreDependencies` · honest freshness aggregated from every plugin touched.

---

## Roadmap — unbuilt phases

### Phase 4 — framework plugins + `list` ops

> With adapters configured, `list` ops return adapter-contributed registries.

- [ ] **`plugins/react`** (`deps:['ts']`) — component detection, hook identification, dialog/sheet
      conventions. `feat`·`med`·`cx:L`
- [ ] **`plugins/react-query`** (`deps:['ts']`) — mutations, queries, queryKeys, `invalidates`
      relations. `feat`·`med`·`cx:L`
- [ ] **`plugins/tanstack-router`** (`deps:['ts']`) — route declarations. `feat`·`low`·`cx:M`
- [ ] **`plugins/zustand`** (`deps:['ts']`) — stores. `feat`·`low`·`cx:S`
- [ ] **autodetection** — presence of dep in `package.json` + config gate. `feat`·`low`·`cx:S`
- [ ] **`ops/list.ts`** — dispatches to the plugin owning the requested registry; DAG enforcement +
      per-plugin oracles. `feat`·`med`·`cx:M`

### Phase 5 — compound ops (token-saver composites)

> "One call = full answer"; size-to-the-answer output (§12). Each op = pure plugin composition +
> golden + oracle.

- [ ] **component/feature composites** — `ops/component-card`, `feature-map`, `mount-path`,
      `find-unused-props`, `why-this-line`, `recent-changes`, `changed-since-branch`,
      `refactor-extract-container`. `feat`·`med`·`cx:L`
- [ ] **`ops/affected.ts`** — changed files → impacted tests, via the `ts` import graph.
      `feat`·`med`·`cx:M`
- [ ] **impact: type-error blast radius** — beyond reference edges, simulate the change and report
      the real `tsc` errors at each dependent (trial edit + `typecheckOverlay`). `feat`·`med`·`cx:L`
- [ ] **impact: `batch+sql` table** — needs a "bounded-by-design, always-partial" table contract
      (a capped table feeding `NOT IN` would lie, §2.3). `feat`·`low`·`cx:M`
- [ ] **impact: wall-clock deadline** — node-cap guarantees termination but there's no cumulative
      wall-clock budget → slow-but-finite on a huge repo. Needs a live `Clock` in `OpContext`
      (engine-level). `perf`·`med`·`cx:M`

### Phase 6 — `trace` ops (data + control flow)

> Walk plugin-to-plugin with per-hop `confidence`/`provenance`; dynamic hops flagged, never
> silently bridged. Heaviest layer; depends on Phases 1/3/4 solid.

- [ ] **`ops/trace-invalidation.ts`** — mutation → invalidates → useQuery sites → component mount
      points. `feat`·`med`·`cx:L`
- [ ] **other traces** — `trace-prop-through-tree`, `trace-field-to-render`,
      `trace-cache-key-to-http`, `trace-type-widening`. `feat`·`low`·`cx:L`

---

## Platform / infra

- [ ] **Daemon singleton + IPC server** — [spec-daemon-singleton.md](spec-daemon-singleton.md).
      Today every MCP/CLI process hosts its own in-process orchestrator → each connection/worktree
      spawns its own warm LS (no §2 amortization) and orphaned stdio servers pile up (observed: 26).
      Stage 1 orphan-reaping → Stage 2 socket singleton + thin stdio bridge. Unblocks `process`-mode + the §19 kill-on-deadline backstop. `feat`·`high`·`cx:L`
- [ ] **No wall-time bound on synchronous TS ops** — `find_unused_exports` (`cap×O(import-graph)`)
      and a 10k-importer `find_usages` are bounded by DESIGN but don't degrade to honest
      `ToolFailure{timeout}` on a pathological whole-repo call. The hard guarantee is §19 engine
      isolation + kill-on-deadline (process mode — above). Meanwhile: scope with pathInclude.
      `perf`·`med`·`cx:L`
- [ ] **`module-resolve`: bundler-only aliases + a dedicated module** — relative AND tsconfig-`paths`
      aliased `.scss` importers now resolve (via the shared `alias-paths.ts`, Task J), but a
      bundler-only alias absent from tsconfig `paths` stays invisible (the same resolution boundary
      codemaster applies repo-wide), and there's still no dedicated `module-resolve` module. `feat`·`low`·`cx:M`
- [ ] **`ts` public API gaps** — `assignability`, `imports(file)`, deep `expandType`. `feat`·`low`·`cx:M`
- [ ] **`ops/scss-class-diff.ts`** — the remaining Phase-3 op. `feat`·`low`·`cx:S`
- [ ] **watcher-bridge as its own seam consumer** — today the engine fans watcher batches into
      every plugin's `reindex` (same effect); revisit when plugins multiply. `dx`·`low`·`cx:S`
- [ ] **MCP op hot-reload / dev-CLI** — a freshly-registered builtin op isn't dispatchable until the
      MCP session reconnects (catalogue loaded at spawn), so new-op validation falls back to the e2e
      harness. Read ops already hot-reload via the read-time freshness backstop. Relates to
      daemon-singleton. `dx`·`med`·`cx:M`

---

## Known gaps & residuals (parked — honest, never silent)

### multi-program (Task G residuals)

- [ ] **Mutating ops are still SINGLE-program — a cross-program rename/move/change-sig is a silent
      partial edit.** `computeRename` (`findRenameLocations`), `change_signature`, and the
      move/extract import rewrites resolve sites via the PRIMARY LS only, and the §2.8 typecheck gate
      runs on the primary only. So renaming a `src/` symbol a `test/**` file (under
      `tsconfig.test.json`) references rewrites the src sites but NOT the test reference → the test
      program dangles and the primary-only gate doesn't catch it. Same class as the usages blindness
      Task G fixed, but for WRITES. Fix: fan out site computation across programs (dedup) and gate
      over every affected program. `bug`·`high`·`cx:L`
- [ ] **Sibling-tsconfig discovery is adjacent-dir + `references` only** — a nested package
      `tsconfig.json` neither beside the primary nor reachable via `references` isn't loaded, so a
      cross-package-used export could still read `certain`-dead (the full monorepo project-reference
      redirect graph the spec scoped OUT). `demote()` has no "used in an undiscovered program" net.
      `bug`·`med`·`cx:M`
- [ ] **Sibling-program robustness — a malformed sibling tsconfig sinks the whole op** — the
      per-program `getNavigateToItems`/`resolveModuleArg`/`findReferences` aren't individually
      guarded, so a throwing sibling bubbles to the op-level catch and takes the PRIMARY answer with
      it. Degrade per-sibling (skip + surface the bad program). Not a false-report; low frequency.
      `bug`·`low`·`cx:S`
- [ ] **`importers_of` residuals (safe direction)** — (a) a bare relative module arg
      (`importers_of {module:'./x'}`) has no canonical anchor → falls back to raw-string match,
      over-matching every `./x` (false-LIVE, never false-dead); (b) the target resolves once under
      PRIMARY options, so a target named via a SIBLING-only alias drops real sibling importers
      (under-report). Both honest-incomplete. Fix: anchor relative args / per-program target.
      `bug`·`low`·`cx:M`
- [ ] **`find_usages` cross-program merge has no PER-OFFSET oracle** — the differential test pins the
      file SET against a cold `tsconfig.test.json` program, but not within-file ref counts/offsets or
      overload/merged-symbol dedup. Add a per-offset cross-program assertion + an overloaded-symbol
      dedup fixture. `dx`·`low`·`cx:M`

### ts / refactor

- [ ] **`construction-sites.ts` exceeds the 300-line cap** (347 → 353 after the encloser-id
      unification) — pre-existing debt, nudged by the shared-helper import + wrapped call. Split the
      scan loop / target-description / encloser-view helpers into a sibling module (sibling to the
      already-extracted `construction-encloser.ts` / `construction-confidence.ts`). `dx`·`low`·`cx:S`

- [ ] **Stale `before` on a RE-DIRTIED tracked file in non-watcher mode** (cross-cutting; every
      refactor op via `assemble.ts`/`applyRefactorPlan`). `diskText` reads `before` from the warm
      program, not fresh disk; `git status --porcelain` is content-insensitive for an already-dirty
      file (` M path` both times → no reindex). Warm daemon + watcher OFF + a tracked file edited a
      SECOND time → a dry-run `diff` whose `before` lies, and under `apply+dirtyOk` the second edit
      is silently lost. Masked in the common case by chokidar `reindexAll`. Fix: read `before` fresh
      for any porcelain-dirty path (or hash dirty contents into the git-mode fingerprint).
      `bug`·`high`·`cx:M`
- [ ] **codemod: full ast-grep RULE object** — [spec-codemod-ast-grep-rule.md](spec-codemod-ast-grep-rule.md).
      Accept relational constraints (`inside`/`has`/`follows`/`not`) alongside the string `pattern`;
      engine already supports it. Additive; the metavar guard must walk the whole rule tree.
      `feat`·`med`·`cx:M`
- [ ] **codemod: introduced-identifier capture** — only metavar-PRESERVED refs are checked; a rewrite
      that INTRODUCES an identifier binding a same-named local isn't flagged (flagging would
      over-refuse, §1). §2.8 typecheck is the only guard (misses a same-typed shadow). `bug`·`low`·`cx:M`
- [ ] **codemod: out-of-span re-resolution** — a rewrite that adds/deletes a decl can re-resolve a
      reference OUTSIDE the rewritten span; only in-span refs are checked. §2.8 catches a dangle, not
      a type-compatible re-bind. `bug`·`low`·`cx:M`
- [ ] **extract baseline: span-aware remap** — a pre-existing error relocated INTO an extracted block
      can read as `introduced` (path+line shift defeats the path-only baseline remap, §1b). Disclosed
      via a hedge note today; real fix is a span-aware baseline remap. `bug`·`med`·`cx:L`
- [ ] **`extract_symbol`: complete the import/export edits the LS leaves (KS-2/KS-3)** —
      [spec-extract-completion.md](spec-extract-completion.md). Extracting a closure that captures a
      type-only binding under `verbatimModuleSyntax` (the LS imports it as a value → §2.8 gate refuses)
      and the sole-export-`Widget` case currently honestly REFUSE — pinned/quarantined in
      `test/e2e/kitchensink-extract.test.ts`. Complete the edits so the extract succeeds cleanly.
      `feat`·`med`·`cx:L`
- [ ] **move_symbol: re-export barrels not repointed** — the LS "Move to file" rewrites DIRECT
      importers but leaves `export { X } from './source'` barrels (and default-export importers)
      dangling → the §2.8 gate honestly REFUSES the whole move. Close by supplementing the LS edits
      with codemaster's own barrel-specifier rewrite. `feat`·`med`·`cx:M`
- [ ] **move_symbol: specifier style is LS-chosen, not alias-preserving** — importer specifiers come
      out relative (`@/source` → `./dest`) instead of re-forming the path alias. Cold compile proves
      correctness; purely diff-noise. Close by post-processing through `emitSpecifier`. `dx`·`low`·`cx:M`
- [ ] **move/extract/move_symbol: capture `line:col` over UNFORMATTED LS output** — the proof
      coordinate is computed on raw LS edits, but the agent sees the prettier-formatted diff → on a
      real capture the `file:line:col` can point at a reflowed line. Detail string still names the
      specifier; apply is refused either way (correct verdict). Needs the format pass visible to
      capture detection. `bug`·`low`·`cx:L`
- [ ] **move_symbol: capture reconstruction is name-anchored** — an unnamed/multi-binding move yields
      no single moved name → name-anchored reconstruction is skipped (§2.8 backstops). Unreachable via
      today's single-named-symbol target resolver; noted for multi-binding moves. `bug`·`low`·`cx:M`
- [ ] **move_symbol: renamed default-import under-detection** — a locally-renamed default import of a
      moved `export default` isn't reconstructed. Unreachable today (the LS doesn't rewrite
      default-export importers → the gate refuses the dangle first). `bug`·`low`·`cx:M`
- [ ] **move_symbol: no positive capture fixture** — the reconstruction/over-refusal guard is only
      exercised by the happy path (captures empty). A deterministic positive repro is hard with the
      LS's correct resolver; add if a real case surfaces. `dx`·`low`·`cx:M`
- [ ] **DRY: consolidate the two mutating-op envelope builders** — `refactor-apply.ts` (flat-edit) and
      `refactor-plan-apply.ts` (move/extract) encode the same §2.10 gate/envelope/post-typecheck
      near-verbatim. Both verified correct + covered; extract a shared scaffold when the next §2.10
      change forces editing both. `dx`·`low`·`cx:M`
- [ ] **`Changes overlap` rescue has no live e2e repro** — the assertion routing/sanitization
      (Task J) is covered by a deterministic unit test, but with the bundled TS + the extract-fork the
      mutual-recursion shapes tried no longer throw `Changes overlap`, so there's no end-to-end throw
      pinning it. Add an e2e repro if a shape that still asserts surfaces. `dx`·`low`·`cx:S`
- [ ] **Reverse import-capture does a full-AST walk over the program** — O(nodes), bounded (module
      resolution memoized per (dir, spec), second pre-move resolution gated to specifiers landing on a
      new arrival), same cost class as the §2.8 typecheck; but no per-op wall-clock deadline (shared
      §19 gap). Optional bound: pre-filter files with no module specifier before the child-walk.
      `perf`·`low`·`cx:M`
- [ ] **`find_usages` arg is `symbol`, not the natural `target`** (feedback) — a SymbolId-taking read
      op rejects `{target:'ts:…'}` with a (self-correcting) `bad_args`; other surfaces speak of the
      `target` symbol. Accept `target` as an alias for `symbol` on the SymbolId-taking read ops. The
      error already teaches the right shape, so low. `dx`·`low`·`cx:S`

### transaction (Task E follow-ups)

- [ ] **E-g — import-capture for a step ≥2 is not overlay-aware** — `capture/imports.ts` resolves a
      rewritten specifier against pre-transaction disk, not prior steps' edits, so a same-named
      type-compatible export reachable only via a prior step's move could slip the capture gate (the
      whole-program typecheck backstops a dangle, but is BLIND to a type-compatible re-bind). Fix:
      seed the resolver from the cumulative overlay/listing. The headline transaction trust-gap.
      `bug`·`med`·`cx:M`
- [ ] **E-h — dry-run doesn't preview the capture/collision/dirty REFUSAL verdict** — the shared
      dry-run branch emits `captures` rows but not `applied:false`+`reason` (apply-only). Pre-existing
      across all mutating ops; a predictive `wouldApply:false`+reason would close it uniformly.
      `dx`·`med`·`cx:M`
- [ ] **E-a — `codemod` is not a transaction step** — it reads disk directly + detects captures
      against the disk-LS. Refused honestly today. Close with an overlay-aware content source +
      `detectCodemodCaptures`. `feat`·`low`·`cx:L`
- [ ] **E-b — CSS co-extract not supported inside a transaction `extract_symbol` step** — the scss
      join lives in the op, not the plan seam; refused honestly. Close by lifting the join into the
      step planner. `feat`·`low`·`cx:M`
- [ ] **E-d — dir moves inside a transaction commit file-by-file** (per-file `git mv`) so an emptied
      source dir may linger. A single `move_file` of a folder is unaffected. `bug`·`low`·`cx:M`
- [ ] **E-e — a path swap/cycle within a composed transaction** (`a→b` while `c→a`) hits the clobber
      guard → honest refusal (never corruption); a legitimate swap needs temp-file ordering.
      `feat`·`low`·`cx:M`

### scss

- [ ] **scss plugin indexes `.scss` only** — `warm`/`reindex` gate on `.endsWith('.scss')`, so the
      cross-sheet search misses `.module.css`/`.sass` unless named directly. `cssModuleUsages` already
      accepts them → index and usage scanner disagree. Fix: index `.css`/`.sass` (one walk-filter +
      parser pick). `bug`·`med`·`cx:S`
- [ ] **scss `parseFailures` leaks an ABSOLUTE path** — every scss parse-failure path reports a
      message embedding the machine path (postcss resolves `from` to absolute `Input.file`). Leaks
      the path into agent output + breaks path-scrub/golden stability across machines. Fix: strip the
      leading `${root}/` when recording the failure. `bug`·`med`·`cx:S`
- [ ] **`:local(.foo)` subject form not matched as a module class** — `:global(.x)` paren classes are
      extracted but `:local(.x)` (the explicit form of the default) is missed → a rule written
      `:local(.foo){…}` is invisible for target `foo`. Rare false-NEGATIVE. Fix: pull `:local(...)`
      arg classes into the module subject set. `bug`·`low`·`cx:S`
- [ ] **`:global` bare-prefix handling is best-effort syntactic** — `:global(.x)` and bare
      `:global .x`/`:global{…}` are surfaced as `global:true` (→ always `partial`), but the
      per-compound boundary of a bare prefix isn't tracked precisely. Conservative-honest (never a
      false `certain`); tighten if a real repo mis-attributes. `bug`·`low`·`cx:M`
- [ ] **cross-file source order is unknown** — we don't model `@use`/`@forward`/import order, so a
      cross-module specificity+importance tie is reported as `ambiguousWith` co-winners at `partial`
      (by design, §19). A real dart-sass eval would resolve it. `feat`·`low`·`cx:L`
- [ ] **scss css-module shadow-skip is decl-only** — `scanCssModuleUsages` shadow-skip treats only
      function params + catch vars as shadows of a css-import name; a `const`/`let`/`var` rebind isn't
      skipped → that access is mis-counted as a class use (SAFE direction, never a false `certain`-
      unused; rare). A correct fix needs block-POSITION-aware shadowing. Do it when observed biting.
      `bug`·`low`·`cx:M`

### i18n

- [ ] **I-a — one dynamic template key buries `find_unused_i18n_keys` in 1000+ all-`partial` rows**
      (then output caps). On amiro: 1025 keys, all partial, genuinely-dead tail invisible — a single
      dynamic `t(...)` with a template literal demotes the WHOLE scan. Honesty is right (dynamic →
      partial) but unactionable. Fixes: (1) on degrade default to a SUMMARY (count + `degradedReason` + "narrow with prefix"); (2) a flag to show only `certain`-dead; (3) **prefix-scoped dynamic
      demotion** — a dynamic key with static prefix `errors.codes.` demotes only the `errors.codes.*`
      namespace, leaving unrelated namespaces `certain`. (3) is the win (needs the literal scan to
      surface a dynamic template's static prefix). `dx`·`high`·`cx:M`
- [ ] **I-b — within-file shadowing of a bound name can FABRICATE** — the identity scan is syntactic-
      by-local-name with no scope resolution, so a local shadowing a bound `t` (e.g. a param `t`) is
      matched → `find_missing` can emit a fabricated row, `find_unused` can mis-mark. Cheap closer:
      gate a match on `scope-shadow.ts` (nearest binding IS the import/destructure). `bug`·`med`·`cx:M`
- [ ] **I-c — a `tsconfig` `paths`/`baseUrl` edit leaves the identity scan on STALE compiler options**
      until a structural reindex re-globs (`ls-host` caches `parsed.options`; an in-place edit bumps
      `projectVersion` but resolves against the old `@/*` mapping). Niche. `bug`·`low`·`cx:M`
- [ ] **I-d — `splitNames` silently no-ops a malformed name** — a leading-dot `.t` or multi-segment
      `a.b.c` never matches. Under-reports silently (never lies). Reject at the config schema with a
      pointed message. `dx`·`low`·`cx:S`

### impact / usages

- [ ] **K-b — a naked type-parameter target is labelled `value`** — `construction_sites` at a bare
      type parameter `T` falls through `targetKind` to `value`. Still scanned + correctly `partial`
      via `isGenericTarget`, so no honesty issue — cosmetic mislabel on a degenerate input.
      `bug`·`low`·`cx:S`

---

## Wishes (new capabilities — no task yet)

- [ ] **Outward-call / `depends_on` view** — the dual of `find_usages`/`impact`: "what does this
      function/file CALL or import outward", bounded + proof-carrying + depth-capped. Candidate fat
      task `spec-calls-op`. `feat`·`med`·`cx:L`
- [ ] **Member-level `find_usages`** — trace readers of a specific object-type FIELD (e.g.
      `GroupRow.site`); today `find_usages` on a type finds the TYPE, not a named `.field` member
      (role:read/write is syntactic). Checker-backed. `feat`·`med`·`cx:L`
