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
- [x] **`plugins/react-query`** (`deps:['ts']`) — mutations, queries, queryKeys, `invalidates`
      relations via the `ts.callArgShapes` seam; `invalidations_for` op + `list` registries.
      Residuals (out of v1 scope):
  - [ ] **react-query v4 positional hook signatures** — `useQuery(key, fn)` / `useMutation(fn, opts)`
        positional forms are NOT detected (v5 object-form only); positional `invalidateQueries(['a'])`
        IS handled via the generic arg-shape. `feat`·`low`·`cx:S`
  - [ ] **`new QueryClient()` receiver** — the invalidate-family methods match a `useQueryClient()`
        binding only; a `const qc = new QueryClient()` receiver is not matched (deferred to W5-a). `feat`·`low`·`cx:S`
  - [ ] **`queryKeys` registry = query keys only** — lists each query's key (one entry per query site,
        no dedup; invalidation-only keys are not included). `feat`·`low`·`cx:S`
  - [ ] **`dynamicKeyedQueries` note wording** — for a BROAD edge (`invalidateQueries()` with no key)
        the opaque-keyed queries DO appear in `affects` as `dynamic` (matchKey's opaque-check follows
        the broad-check), so the op note "not listed under affects" is imprecise. Cosmetic — no false
        `certain`; tighten to "not listed under a CONCRETE invalidation's affects". `bug`·`low`·`cx:S`
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

- [ ] **`knip --fix-type` comma form silently no-ops (knip@6.15).** `fix-and-check` strips dead
      exports with **two repeated** flags (`--fix-type exports --fix-type types`) **on purpose** —
      the documented comma form (`--fix-type exports,types`, or `=exports,types`) parses but fixes
      nothing in knip 6.15.0 (the gate still reports the dead export, autofix never fires). Don't
      "simplify" the script back to the comma form. Re-check on a knip bump; collapse to the comma
      form (or upstream a fix) once it actually applies. `dx`·`low`·`cx:S`

- [ ] **Wedged-daemon recovery** — the singleton (spec-daemon-singleton, shipped) reaps orphans via
      the daemon's idle-exit + the bridge's per-request reply deadline, but a **permanently wedged
      daemon** (accepts connections but never replies — a wedged synchronous loop holding the socket)
      is not reaped: its own idle loop is wedged too. Bridges fail honestly (reply-deadline →
      `ToolFailure`) and the agent falls back, but the daemon process lingers until killed. Needs
      process-mode engine isolation + kill-on-deadline (below) — the supervising process kills a child
      that overran. Optional cheaper interim: after N consecutive bridge reply-timeouts, trigger a
      daemon liveness re-probe / SIGTERM. `bug`·`med`·`cx:L`
- [ ] **`process`-mode engine isolation** — one child process per workspace (§2/§9): own heap +
      `--max-old-space-size`, OS-reclaim-on-kill, real cross-workspace parallelism, and the
      kill-on-deadline backstop that reaps a wedged engine/daemon (above). The daemon would own the
      child engines. `feat`·`med`·`cx:L`
- [ ] **convergence hardening — liveness-probe-before-unlink / bind-first** (`connect-or-spawn.ts`).
      The bridge re-probes before unlinking a socket (§19), so it only clears a stale file — but a
      narrow residual race remains: a daemon another bridge binds in the microsecond after the
      re-probe could be unlinked → a transient split-brain (two daemons). It self-heals (the orphan
      idle-exits by TTL). A bind-first scheme (the spawned daemon owns the unlink+bind atomically, the
      bridge never unlinks) would close it fully. `bug`·`low`·`cx:S`
- [ ] **`StatusView.isolation` репортит engine-host-mode, бессмысленный на degraded remote-пути** — поле = режим транспорта движка (`config.daemon.isolation`), форвардится от daemon; healthy-путь хардкодит `'in-process'` (orchestrator.ts:187), `'process'` не реализован (отклоняется на спавне, orchestrator.ts:254-260). На недостижимом daemon (`degradedStatus`) спросить некого, любой конкретный тег произволен: `'process'` — over-claim несуществующего режима + флип от достижимости; `'in-process'` просто совпадает с единственным реализованным режимом и healthy-путём (выбран). Честный "unknown" потребовал бы редефайна поля сквозь healthy-path + докстринг + render — кросс-каттинг, вне скоупа. Косметика; `engines:0` + `workspaceError` уже несут факт сбоя. `infra`·`low`·`cx:M`
- [ ] **daemon bind sets `process.umask(0o177)` process-globally** for the bind window
      (`support/transport/unix-socket.ts`) — safe today (no other startup I/O; plugins are lazy), but
      a future concurrent startup file-write would inherit 0600. Prefer a per-socket mode at create if
      a portable API appears. `bug`·`low`·`cx:S`
- [ ] **bridge spawn-wait budget is 5s** (`connect-or-spawn.ts`) — a cold daemon start slower than 5s
      makes the bridge fall back to in-process (safe + self-correcting on the next launch, but loses
      amortization for that session). Revisit if cold starts approach it. `perf`·`low`·`cx:S`
- [ ] **`transport.connect()` has no explicit timeout** (`support/transport/unix-socket.ts` /
      `connect-or-spawn.ts`) — it relies on a fast kernel resolve of a unix socket (a connect to a
      live or absent socket settles immediately; carried from the daemon-singleton {2a+2b} review).
      The management verbs and the bridge bound their REPLY/spawn-wait, not the connect itself, so a
      pathological connect that neither resolves nor rejects would sit unbounded. Add a bounded
      connect (deadline → reject) if it ever hangs in the field. `perf`·`low`·`cx:S`
- [ ] **`daemon/manage.ts` is ~284 lines — near the 300 line-cap** (like `imports.ts`). No issue today,
      but the next verb / wording change is the split signal: factor the wire helpers (`awaitReply` /
      `awaitClose` / envelope builders / `fmtUptime`) into a sibling file. `dx`·`low`·`cx:S`
- [ ] **No wall-time bound on synchronous TS ops** — `find_unused_exports` (`cap×O(import-graph)`)
      and a 10k-importer `find_usages` are bounded by DESIGN but don't degrade to honest
      `ToolFailure{timeout}` on a pathological whole-repo call. The hard guarantee is §19 engine
      isolation + kill-on-deadline (process mode — above). Meanwhile: scope with pathInclude.
      `perf`·`med`·`cx:L`
- [ ] **`module-resolve`: bundler-only aliases + a dedicated module** — relative AND tsconfig-`paths`
      aliased `.scss` importers now resolve (via the shared `alias-paths.ts`, Task J), but a
      bundler-only alias absent from tsconfig `paths` stays invisible (the same resolution boundary
      codemaster applies repo-wide), and there's still no dedicated `module-resolve` module. `feat`·`low`·`cx:M`
- [ ] **freshness `statDirty` stats the FULL dirty set incl. `--untracked-files=all`** — the
      re-dirty content check (`src/daemon/freshness.ts`) re-stats every porcelain-dirty path on
      every op-entry check; `dirtyPaths` includes untracked files, so a repo with a large
      un-gitignored untracked tree pays per-op stat work that scales with it (not a hang — stat is
      cheap, untracked files keep old mtimes → no hash escalation). Scope `statDirty` to
      tracked-modified paths (untracked can't be the porcelain-insensitive re-dirty case). `perf`·`low`·`cx:S`
- [ ] **`ts` public API gaps** — `assignability`, `imports(file)`, deep `expandType`. `feat`·`low`·`cx:M`
- [ ] **re-export `callArgShapes` result types on the `ts` public surface** (feedback) — `plugins/ts/plugin.ts`
      re-exports `CallMatchSpec` but not the result types (`ValueShape` / `ValueProp` / `ShapedCall` /
      `CallArgShapesResult`, in `call-scan-shared.ts`). A framework-plugin consumer derives them via
      `ReturnType<TsPluginApi['callArgShapes']>` + indexed-access (works, keeps the public-method contract —
      the idiom i18n uses for `literalCalls`). A one-line `export type { … } from './call-scan-shared.ts'`
      lets authors name the discriminated union directly. Hit building `react-query`; future framework
      plugins (zustand / tanstack-router) hit the same. `dx`·`low`·`cx:S`
- [ ] **`ops/scss-class-diff.ts`** — the remaining Phase-3 op. `feat`·`low`·`cx:S`
- [ ] **watcher-bridge as its own seam consumer** — today the engine fans watcher batches into
      every plugin's `reindex` (same effect); revisit when plugins multiply. `dx`·`low`·`cx:S`
- [ ] **MCP op hot-reload / dev-CLI** — a freshly-registered builtin op isn't dispatchable until the
      MCP session reconnects (catalogue loaded at spawn), so new-op validation falls back to the e2e
      harness. Read ops already hot-reload via the read-time freshness backstop. Relates to
      daemon-singleton. `dx`·`med`·`cx:M`
- [ ] **idle-exit brackets only `CallTool`, not `ListTools`** — the Stage-1 idle deadline
      (`src/mcp/idle-exit.ts`) is reset by `op`/`status`/`batch` calls but NOT by `tools/list`.
      Harmless and arguably correct (listTools is instant; an orphan that only ever lists tools
      should still reap, and a tool-active client resets the deadline on its next real call), but
      formally one request type sits outside the enter()/leave() bracketing. Note for when the
      Stage-2 daemon owns the lifetime. `dx`·`low`·`cx:S`

---

## Known gaps & residuals (parked — honest, never silent)

### multi-program (Task G residuals)

- [ ] **Cross-program capture detection is PRIMARY-only (all symbol-anchored ops)** — capture
      detection (rename's `detectRenameCapture`; move/extract/move_symbol's import re-resolution) runs
      over the PRIMARY program only, so a type-compatible silent re-bind the edit would cause in a
      SIBLING program (a `test/**` site whose `newName` shadows an in-scope binding there, or a
      rewritten import that lands on a different same-named sibling export) is NOT flagged. The
      cross-program §2.8 gate still catches a resulting DANGLE/type error, but is blind to a same-typed
      re-bind (the exact class the capture guard exists for — the same residual the codemod/transaction
      capture gaps carry). Surfaced in every such op's notes ("cross-program LIMITS"). Fix: fan capture
      detection across programs too. `bug`·`low`·`cx:M`
- [ ] **Cross-program WRITE sites stay PRIMARY-only inside a `transaction`** — the rename /
      change_signature site fan-out is gated OFF when a step runs under a `PlanningOverlay` (a
      sibling reading stale disk would be unsound, ls-host TRAP), so a transaction step that
      renames/change-sigs a symbol a `test/**` sibling references rewrites only the primary sites.
      The fanned §2.8 gate then REFUSES the whole transaction on the resulting dangle (honest, never
      a silent partial), but the step can't yet COMPLETE cross-program. Fix: make the planning
      overlay sibling-aware (seed each sibling's overlay from the cumulative tree). `bug`·`low`·`cx:M`
- [ ] **Write-gate check scope misses a gitignored-but-sibling-compiled file** — the §2.8 fan-out
      gate's `check` scope is the git tree ∪ the PRIMARY program's `fileNames()`. A file that is
      gitignored (absent from the tree listing) AND compiled only by a SIBLING tsconfig (absent from
      primary `fileNames`) is in no program's check scope, so if it imports a moved/extracted module
      its post-edit dangle reads clean (a §2.8 completeness gap in the unsafe direction). Rare
      (gitignored + sibling-only + importer). Fix: union every built program's `fileNames()` into
      the gate's check scope. `bug`·`low`·`cx:S`
- [ ] **`mayContain` glob-ownership is a normalized approximation** — the write gate decides which
      program owns a not-yet-created move/extract DEST via `buildMembership` (picomatch over the
      tsconfig include/exclude, with tsconfig's bare-dir → `dir/**/*` shorthand re-expanded by hand).
      Matching itself defers to picomatch (faithful for `*`/`?`/`**`/literal-file globs), but tsconfig's
      IMPLICIT excludes (node_modules / outDir / declarationDir) are not modelled — so a dest under,
      e.g., a config's `outDir` could be deemed owned → a false REFUSAL (the SAFE direction for a write
      gate; never a false success / missed dangle). Fix if it bites: model the implicit excludes, or
      drive membership off TS's own matcher rather than re-normalizing. `bug`·`low`·`cx:M`
- [ ] **Write-gate `introduced` list can double-count under OVERLAPPING globs** — a genuinely-new
      move/extract DEST owned by TWO overlapping programs, carrying an error, is diagnosed once per
      program in the overlay while the baseline has zero → the same `file:line:message` appears twice
      in `introduced` (`introducedDiagnostics` multiset-diffs but does not dedup the `after` set). The
      verdict (`clean:false`) and refusal are CORRECT; only the displayed count is inflated. Bites only
      overlapping-glob + erroring new dest. Fix: dedup-on-display. `bug`·`low`·`cx:S`
- [ ] **`absOf` is `path.join` (OS-sep), not posix — Windows-latent path-form skew in the gate** —
      `owns`/`affected`/`entriesFor` compare `ctx.absOf(rel)` against `containsFile`/`mayContain`.
      `mayContain` re-runs `toPosix` defensively, but `containsFile` passes the path straight to
      `getSourceFile`. On darwin/linux `path.join` keeps `/` so they agree; on Windows the `\` spelling
      could make the two ownership predicates disagree → under-include (a missed dangle). Pre-existing
      (`absOf` predates this work); not a bug on the current platform. Fix: route `absOf` through
      `toPosix`. `bug`·`low`·`cx:S`
- [ ] **Sibling-tsconfig discovery is adjacent-dir + `references` only — real nested discovery (the
      STRETCH on the shipped floor)** — discovery loads the primary + adjacent `tsconfig*.json` +
      transitive `references`; a nested-package `tsconfig.json` neither beside the primary nor
      `references`d isn't loaded as a program. `find_unused_exports` NOW has its honest floor: when any
      such undiscovered config exists (`host.undiscoveredProgramLabels()`, a one-time cached repo walk
      over `walkFiles`' ignore set), every otherwise-`certain` claim is demoted to `partial` and the
      config is NAMED (`demote()` in `unused-exports-classify.ts`) — never a silent false-`certain`-dead
      (§3.4). The floor is BLUNT (any undiscovered config demotes ALL otherwise-certain claims; e.g. on
      codemaster itself `test/fixtures/repos/kitchensink/tsconfig.json` demotes every dead `src` export
      to partial — honest, but coarse). The stretch: load nested configs as real sibling programs (or an
      import-graph proxy) so usages are SEEN and only genuinely-undiscovered-reachable exports demote —
      precise, not blunt. Risk: slurping hermetic fixture/sub-project configs as siblings (cost + the
      reason discovery is conservative today); needs a "shares the import graph" test the cheap blunt
      floor avoids. NOT the full monorepo project-reference redirect graph (still scoped OUT). `imp`·`med`·`cx:L` - **Sub-note (post-warm invalidation under-reach, `bug`·`low`).** `ls-host` reindex now invalidates
      the discovered/undiscovered memos when a `tsconfig*.json` appears in the changed set, BUT a
      `references:[{path:"./base.json"}]` chain through a NON-`tsconfig*.json`-named config is missed:
      an edit to `base.json`'s own `references` has basename `base.json`, so `isTsconfigChange` (a
      basename match) doesn't fire and a newly-chained config isn't picked up until reconnect. This is
      CONSISTENT with — not worse than — the pre-existing discovery blind zone: `findRepoTsconfigs`
      (the undiscovered floor) and source-1 sibling discovery already only see `tsconfig*.json` names,
      so an arbitrarily-named referenced config was never discovered either. Closed wholesale by the
      real-nested-discovery stretch above (which would key invalidation off the resolved config graph,
      not basenames). Orthogonally, the trigger OVER-invalidates on any tsconfig EDIT (not just
      add/remove) — the safe direction (a redundant lazy recompute, never a stale read), not a bug.
- [ ] **The `ls-host` reindex sibling-dispose branch is uncovered by tests** — `reindex`'s tsconfig-change
      path disposes + drops ALREADY-BUILT sibling programs (`if (siblings !== undefined)`) so they
      re-warm from the current tree on the next cross-program read. Correct by design (§8 tear-free: a
      reindex is between serialized requests), but the existing invalidation test never builds siblings
      before the tsconfig change ((b) is host-level + sibling-free; (a) asserts the undiscovered memo,
      not a sibling re-warm), so the dispose branch runs only in production. Add a scenario that forces a
      cross-program build (a cross-program `find_usages`/dead-code read), THEN a post-warm tsconfig change,
      and asserts the rebuilt sibling reflects the new tree. `dx`·`low`·`cx:S`
- [ ] **`find_usages` / `importers_of` under-report a usage living only in an UNDISCOVERED program** —
      the parallel gap to the `find_unused_exports` floor above: a `src` symbol referenced ONLY from a
      nested-package program codemaster doesn't load reads as having that usage MISSING (a completeness
      under-report, the safe direction — never a false dead, but an incomplete usage set). Unlike
      dead-code, a usage list has no per-row "confidence" to demote, so the honest fix is a `partial` +
      a note naming the undiscovered config(s) (reuse `host.undiscoveredProgramLabels()`) when any
      exists. Same root cause as the discovery gap; fixed wholesale by the real-nested-discovery stretch.
      `bug`·`med`·`cx:M`
- [ ] **Sibling-program robustness on the READ path — a malformed sibling tsconfig sinks the op** —
      the per-program READ fan-outs (`getNavigateToItems`/`resolveModuleArg`/`findReferences`) aren't
      individually guarded, so a throwing sibling bubbles to the op-level catch and takes the PRIMARY
      answer with it. Degrade per-sibling (skip + surface the bad program), as the §2.8 WRITE gate
      now does (`gateAcross`/`diagnosticsAcross` degrade a throwing SIBLING to a note, never the
      primary). Not a false-report; low frequency. `bug`·`low`·`cx:S`
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

- [ ] **`capture/imports.ts` at the 300-line cap** (297 after the E-g overlay-aware resolver) — the
      next addition trips the cap → split-signal. Lift `postMoveResolutionHost` (the
      `ModuleResolutionHost` builder + `emptiedByMove` walk, ~80 lines) into a sibling module; the
      forward/reverse detectors + `mergedFileSet` stay. `dx`·`low`·`cx:S`

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

### transaction (Task E follow-ups)

- [ ] **E-g residual — in-transaction REVERSE import-capture is not overlay-aware** — the FORWARD
      pass now seeds its resolver from the cumulative prior-step overlay (`PriorStepState` via
      `mergedFileSet`), closing the headline trust-gap. The REVERSE pass (`detectReverseImportCaptures`)
      stays symmetric on this-step content + pre-transaction disk (both its POST and PRE resolutions),
      so a reverse shadow that only manifests through a PRIOR step's move is under-detected. Left
      deliberately: E-g is forward-only, an overlay-aware reverse has no red→green yet, and the §7-safe
      direction is a missed rare same-typed shadow over a fabricated refusal (§1; §2.8 backstops a
      resulting dangle). Close with a positive reverse-shadow-via-prior-step repro, then make the
      reverse POST overlay-aware (and decide PRE: prior-only host vs pre-tx disk) under that test.
      `bug`·`low`·`cx:M`
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

- [ ] **indented `.sass` → parse failure (half-support)** — the index gate accepts `.sass` (to match
      the css-module usage scanner's `/\.(scss|sass|css)$/`), but postcss-scss parses brace SCSS, not
      indented Sass — so an indented `.sass` sheet surfaces an honest `parseFailure` (no classes
      extracted), never a silent skip. Its `s.foo` usages are still seen by the ts tier, so its
      classes are invisible to `scss_classes`/`find_unused` while usages are counted — an honest
      half-support. Full indented-sass support needs a real indented-sass parser (dart-sass /
      `sass`). `bug`·`low`·`cx:M`
- [ ] **co-extract path-scrub is untested** — the `classifyForExtract`/`extractRules` catch blocks
      now `scrubRoot` their thrown message (defensive: keeps "scrub on every failure exit" true by
      construction), but there is no test repro of a co-extract throw that EMBEDS a path (the
      taxonomy walk / CST clone don't surface `input.file` today). Add a scrub assertion when a
      pathological throwing-with-path co-extract case surfaces. `bug`·`low`·`cx:S`
- [ ] **stylesheet-extension matching is case-sensitive** — `isStylesheetFile`/`isCssModuleFile`
      (scss plugin) and the TS `cssModuleUsages` scanner (`css-modules.ts` `/\.(scss|sass|css)$/`)
      are all case-sensitive, so `foo.MODULE.css` over-demotes to `partial` (treated global) and
      `x.module.CSS` isn't indexed at all. CONSISTENT between gate and scanner (conservative — a
      `partial` is never a false `certain`), so not a lie; fix only if an uppercase-extension repo is
      in scope. `bug`·`low`
- [ ] **`scss/plugin.ts` near the 300-line cap** — ~290 real lines after the index/demotion/scrub
      work; the next scss change should split it by responsibility (e.g. lift `unusedClasses`/`demote`
      into their own module) rather than grow it. `dx`·`low`
- [ ] **`:local` bare-prefix / block forms not module-owned** — the paren subject form `:local(.foo){}`
      is now unwrapped to behave exactly like `.foo{}` (`selector-scope.ts`), but the bare-prefix
      `:local .foo {}` and block `:local { .foo {} }` forms are still treated as entangled (descendant /
      nested) → demoted to `partial` for `find_unused`, and the cascade reads `:local .foo` as a
      descendant. Conservative-honest (never a false `certain`), but `.foo` there is module-local too.
      Fix: extend the unwrap to the prefix/block forms (precise per-compound scoping). `bug`·`low`·`cx:M`
- [ ] **`:local(.a, .b)` paren-comma list under-reports in cascade** — a multi-subject `:local(...)`
      unwraps to `.a, .b`, but `analyzeBranch` reads only the LAST compound's subject (`b`), so a
      `css_cascade` query for target `a` emits no contribution from that rule → a wrong `certain`
      winner for `.a` is possible ONLY if another same-specificity rule also targets `.a`. NOT a
      regression (the multi-subject form was invisible before the `:local` fix too); the find_unused
      side stays honest (`:local(.a, .b)` is not-owned → `partial`). Fix: split the unwrapped
      `:local(...)` selector list into per-branch subjects. `bug`·`low`·`cx:M`
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

- [ ] **I-b — within-file `const`/`let`/`var` REBIND of a bound name fabricates a missing row** —
      param + catch-var shadowing is CLOSED (the by-identity scan gates the match through
      `scope-shadow.ts` `extendShadow`). What remains: a `const`/`let`/`var` rebind of `t`
      (`const t = (k) => k; t('absent.key')`) is NOT gated — `extendShadow` only introduces shadows
      for params/catch vars, since a sound rebind skip needs block-POSITION-aware shadowing. The two
      directions differ: `find_unused` UNDER-reports (counts the rebound call → false "used", safe),
      but `find_missing` FABRICATES — a certain missing row with a proof-span on the local closure
      for a key that is not an i18n usage. The same hole exists in the BY-NAME scan
      (`scanByName`, `src/plugins/ts/literal-calls.ts`), which matches any same-named `t` with no
      scope check at all (no binding pool to anchor `extendShadow` against). Rare.
      `bug`·`fabrication`·`low`·`cx:M`
- [ ] **I-c — a `tsconfig` `paths`/`baseUrl` edit leaves the identity scan on STALE compiler options**
      until a structural reindex re-globs (`ls-host` caches `parsed.options`; an in-place edit bumps
      `projectVersion` but resolves against the old `@/*` mapping). Niche. `bug`·`low`·`cx:M`
- [ ] **I-d — `splitNames` silently no-ops a malformed name** — a leading-dot `.t` or multi-segment
      `a.b.c` never matches. Under-reports silently (never lies). Reject at the config schema with a
      pointed message. `dx`·`low`·`cx:S`
- [ ] **I-e — dynamic-prefix re-derives template parsing from raw source (§4 boundary)** —
      `staticDynamicPrefix` (`src/plugins/i18n/dynamic-prefix.ts`) extracts a dynamic `t(\`a.b.${x}\`)`
      static head by backtick-counting + `indexOf('${')`over`span.text`— a second, text-based slice
of TS template parsing living outside`plugins/ts`(the §4 "one parser per domain" line). It errs
SAFE (an unfaithful head — escapes, inner backtick, raw CR/LF — bails to global demote, never a
false`certain`), but must conservatively drop legit prefixes the cooked value would keep. Proper
fix: have `plugins/ts` `literalArgFields`emit`staticPrefix`from`arg0.head.text`(the cooked
value) when`ts.isTemplateExpression(arg0)`; i18n consumes that proof-carrying field. `dx`·`med`·`cx:M`
- [ ] **I-f — a no-substitution template `t(\`a.b\`)` is treated as dynamic** — a
      `ts.isNoSubstitutionTemplateLiteral` arg is classified `dynamic:true`, so a statically-
      determinate backtick key is NOT counted as a use (may read unused) AND demotes the whole `a.b*`
      namespace to `partial`. Not a lie (stays `partial`), but in a backtick-habitual repo it collapses
      the actionable dead tail. Fix: treat a no-substitution template as a static literal (read `.text`
      as the key). `bug`·`med`·`cx:M`

### impact / usages

- [ ] **K-b — a naked type-parameter target is labelled `value`** — `construction_sites` at a bare
      type parameter `T` falls through `targetKind` to `value`. Still scanned + correctly `partial`
      via `isGenericTarget`, so no honesty issue — cosmetic mislabel on a degenerate input.
      `bug`·`low`·`cx:S`

### framework seams (`callArgShapes` / `functionDeclarations`, wave 5)

- [ ] **W5-a — `new QueryClient()` receiver not bound** — `callArgShapes` matches a member call
      (`qc.invalidateQueries()`) only when the receiver came from the configured `hook`
      (`const qc = useQueryClient()`), via the existing `collectHookBindings` machinery. A
      `const qc = new QueryClient()` receiver (setup/test code, rare in app code) is NOT bound → the
      member call under-reports. Generic fix: an optional `CallMatchSpec.constructors?: string[]`
      (module-anchored class names whose `new C()` result is a member base, like `hook`). Deferred —
      react-query covers it with a method-name `partial` fallback in its own policy. `feat`·`low`·`cx:M`
- [ ] **W5-b — anonymous default-export component not reported** — `functionDeclarations` reports only
      NAMED declarations; `export default () => <x/>` / `export default function () {}` has no name
      token (the chainable anchor), so it is omitted (under-reports, never fabricates). A consumer that
      wants it needs a synthetic name (e.g. the module basename) — react policy, not a ts-language fact.
      `bug`·`low`·`cx:M`
- [ ] **W5-c — class components out of v1** — `functionDeclarations` covers function-like forms only;
      a `class X extends Component { render() {…} }` is not surfaced as a component (its `render`
      method IS reported as a `method` with `returnsJsx`, but the class itself is not). The react plugin
      detects class components separately when needed. `feat`·`low`·`cx:M`
- [ ] **W5-d — `isExported` misses a separate `export { X }` / `export default X` statement** —
      `functionDeclarations.isExported` reads the `export` modifier on the declaration or its owning
      `VariableStatement`; a declaration exported by a later `export { X }` / `export default X`
      statement reads `isExported:false` (under-reports). Fix: fold the file's export-specifier set into
      the scan. `bug`·`low`·`cx:M`
- [ ] **W5-e — unary-plus / bigint number literals classify as `other`** — `value-shape` reads
      `NumericLiteral` and a negative `-1` as `number`/`certain`, but a unary-plus `+1` and a bigint
      `1n` (`BigIntLiteral`) fall through to `other`/`dynamic`. Honest under-report (never a
      false-`certain`), rare in keys. Fix: extend the numeric branch to `+`-prefixed numerics and
      `BigIntLiteral`. `bug`·`low`·`cx:S`
- [ ] **`list` has no `limit` / `pathInclude` / pagination** — `list {registry}` returns the WHOLE
      registry (e.g. `components` = 652 entries on amiro). Each entry now condenses to one clickable
      line (`condense.ts` ListEntry branch), but 652 lines still bust the 20KB `RENDER_CHAR_CAP` →
      honest `!! OUTPUT CAPPED`, and the only way to narrow is `sql` (the op exposes a table). Other
      list-shaped ops (`find_usages`, `find_unused_exports`) take `limit` + `pathInclude`/`pathExclude`;
      `list` takes neither, so an agent can't scope by dir or page through. Fix: add `limit` +
      `pathInclude`/`pathExclude` (globs over the entry's decl file) to `list`'s args, mirroring
      find_usages' filter, and report the cap as truncation. `feat`·`low`·`cx:S`

---

## Output-density audit (amiro dogfood) — residuals

> Per-op output review against `/Users/cody/Dev/amiro`. The systemic root cause — row shapes that
> fell through `format/render/condense.ts` `collapseKnownShape()` into `render-dense.ts`'s multi-line
> `key=value` exploder — is closed: the four block-exploders (`construction_sites`,
> `find_unused_exports`, `invalidations_for` leaves, mutating-op `captures`) now have collapse cases,
> and `test/differential/output-density.test.ts` is the **render-contract guard** — it runs the
> at-risk ops on a fixture and fails CI if any result row renders as a bulleted/deeper `key=value`
> block, so a future op that lacks a case is caught before it ships. `expand_type` (the type is no
> longer printed twice), `importers_of` (now `limit`-capped + truncation), and `find_usages` (a
> `listable` field ties the raw `total` to the listed/`shown` counts) are also fixed. Open residuals:

- [ ] **`~<rootTag>` printed on every SymbolId** — the workspace tag (`~d19d0f20`) is identical on
      every id of a single-root answer (it exists only to refuse a cross-root rebind, §6), so it is
      pure repeated noise within an answer — ~10ch × every id-bearing row (×200 in a busy
      `find_usages`). NOT a simple strip: a tag-stripped id pasted into a different-root request can
      mis-rebind to a same-named symbol there (the §6 cross-root lie the tag prevents) — making it
      safe needs a resolution-semantics change (untagged ⇒ current-root-only) first, OR stating the
      tag once in a header and rendering ids tag-less only in text. Affects every id-bearing op.
      `dx`·`med`·`cx:M`
- [ ] **`list` repeats constant columns per row** — every entry carries `· <kind>` (= the registry,
      constant) and `· heuristic:<plugin>` (constant provenance); on amiro `components` that is 652
      identical decorations. Hoist the constant kind/provenance to the header and print per-row only
      the exceptions (`partial`/`dynamic`/`wrapped`). Coordinated change: the op must detect
      answer-level uniformity and strip the constant fields into a header (a stripped row is a new
      key-set → needs its own `collapseKnownShape` case). Complements the `list`-limit item above.
      `dx`·`low`·`cx:M`
- [ ] **`css_cascade` repeats the same boilerplate note per property and per loser** — the ~20-word
      "cross-module — CSS-module classes are per-file scoped; cannot prove it cascades…" sentence is
      re-emitted on every property line and every `loses:`/`ambiguous-with:` entry. Dedupe to a single
      footnote keyed by a short code (`xmod`, `state`, `tie`) and tag each row with the code.
      `dx`·`low`·`cx:M`
- [ ] **`expand_type verbosity:full` bloats the span block** — `full` renders the one-line span as a
      multi-line `file=/line=/col=/endLine=/endCol=/text=` block (the condense span-collapse is
      skipped at `full`). Minor; collapse the span even at `full` for a single-symbol answer.
      `dx`·`low`·`cx:S`

- [ ] **`construction_sites` floods on all-optional target types** — `ButtonProps` (a big
      intersection of `ButtonHTMLAttributes & ClassAttributes & VariantProps & {asChild?}`, every
      field optional) matched 5739 candidate literals across unrelated `scripts/openapi-codegen/**`
      and even `en.json`, all `confidence=certain` (an `{}`-ish literal IS assignable to an
      all-optional type, so it is not strictly a lie — but it is noise). Consider a low-signal guard:
      when the target type has zero required fields, demote to `partial` with a "target is all-optional
      — matches are weak" note, or rank by field-overlap. `bug`·`low`·`cx:M`

---

## Wishes (new capabilities — no task yet)

- [ ] **Outward-call / `depends_on` view** — the dual of `find_usages`/`impact`: "what does this
      function/file CALL or import outward", bounded + proof-carrying + depth-capped. Candidate fat
      task `spec-calls-op`. `feat`·`med`·`cx:L`
- [ ] **Member-level `find_usages`** — trace readers of a specific object-type FIELD (e.g.
      `GroupRow.site`); today `find_usages` on a type finds the TYPE, not a named `.field` member
      (role:read/write is syntactic). Checker-backed. `feat`·`med`·`cx:L`
