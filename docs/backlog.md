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

## Bug sweep 2026-06-21 (non-low) — adversarial multi-agent hunt

Five domain-scoped bug-reviewers swept the tree for the cardinal sins (lie / crash / hang,
§1/§3). HIGH items verified by code-trace and (where noted) reproduced. Parked here so they
don't vanish.

### HIGH

- [ ] **`CODEMASTER_SOCK_DIR` is read unconditionally in prod (`bin.ts:141/165/195`)** — if a user
      exports it in a normal shell, a management verb honours it but the stripped-env bridge does
      NOT → re-opens the exact split the fix closed. Severity low (needs a user to set an internal
      test-seam var, undocumented for users). Fix idea: bridge ignores it, or warn on set; at
      minimum document it as test-only. `bug`·`low`·`cx:S`
- [ ] **`socket-path.ts` is git-classified BINARY** (numstat `- -`, `Bin` in diff) despite 0 NUL /
      valid UTF-8 — the fix's core shows as "Binary files differ" in plain `git diff`, hiding it
      from review (needs `git diff -a`). Since file creation (bc3003b). Fix: `.gitattributes`
      `*.ts text`, or find the trigger byte. No runtime impact. `infra`·`low`·`cx:S`
- [ ] **key-template separator is a space (`username version`)** — admits a theoretical
      username/version collision (`"a b"+"c"` vs `"a"+"b c"`); pre-existing (main was identical),
      practically impossible (POSIX usernames + semver carry no spaces). Use an unambiguous
      delimiter if ever touched. `bug`·`low`·`cx:S`
- [ ] **long/network home → `assertSocketPathLength` throw lands in discarded daemon stderr** on
      the bridge/spawn path — the user sees only a silent in-process fallback, no message.
      Pre-existing. Surface the actionable "home too long" error to the client. `bug`·`low`·`cx:S`
- [ ] **broken-tsconfig edit silently falls back to default options + glob-everything** —
      `single.ts` `parseConfig`/`loadFileList` discard `parseJsonConfigFileContent` errors (and a
      malformed-JSON edit yields `config ?? {}`), so an edit that breaks the tsconfig silently
      re-globs under DEFAULT options instead of failing/noting. The result set changes with no
      `FreshnessNote` — a silent behaviour swap (mild §3.5/§3.6 honesty gap). Surface a note (or
      keep the prior parse) when the re-parse has `errors`. `bug`·`low`·`cx:S`
- [ ] **`parseConfig`/`loadFileList` not wrapped in try/catch (`single.ts` `reindex`)** — a throw
      from `ts.parseJsonConfigFileContent` / `readConfigFile` would escape `reindex` to the agent,
      against CONTRIBUTING "every external-tool call wrapped". Pre-existing, but now REACHABLE on a
      tsconfig edit (the new structural trigger). Wrap → keep prior parse + honest note on failure.
      `bug`·`low`·`cx:S`
- [ ] **a non-`tsconfig*.json`-named `extends` target is not detected** — the structural trigger
      keys on `isTsconfigBasename`, so an `extends: "./base.json"` / `"configs/strict.json"` parent
      edit does NOT re-glob the child → stale options until an unrelated source add/remove. Fix idea:
      on warm, resolve+track each program's `extends` chain and trigger on any member's change (still
      §19-bounded — resolved once per program, not per call). `bug`·`low`·`cx:S`
- [ ] **`SPAN_TEXT_CEILING == RENDER_CHAR_CAP` (20_000) — one large span can fill the whole render
      budget** — `src/plugins/ts/spans.ts`. A single proof span allowed up to the same 20K as the
      whole-output cap means one big declaration body consumes the entire `bulk` region; the
      envelope-seam fix keeps the honesty channels alive, but the data itself is reduced to one
      truncated span. Lower the per-span ceiling well under the output cap (leave room for ≥a few
      spans + the honesty tail), or budget spans against the remaining output room. `bug`·`med`·`cx:S`
      (plugins/ts boundary — not in the envelope-seam scope.)
- [ ] **the envelope `head` segment is no longer capped — a pathological `failure.message` escapes
      the 95KB-dump guard** — `src/format/render/render-result.ts` (the head-path of `renderResult`
      / `assembleEnvelope`). The envelope-seam fix reserves `head` (FAIL verdict + message) and
      `tail` (honesty channels) against the budget so they always survive; only `bulk` is trimmed.
      That is correct for the honesty channels, but it means a pathologically large `failure.message`
      now renders unbounded — weakening the "never a 95KB dump" guarantee on the FAIL path. The
      message is our OWN text (a `ToolFailure.message`, normally a short tool error), so this is a
      latent edge, not a live leak. Fix: cap the FAIL message itself at the source, or give `head` a
      generous own sub-budget before reserving it. `bug`·`low`·`cx:S`

### MED

- [ ] **chokidar feeds absolute OS paths into the reindex pipeline** —
      `src/support/watch/chokidar.ts:48-51` (`pending.add(path)` collects chokidar's absolute path
      → `onChanged(batch)`). Plugins key by `RepoRelPath` (forward-slash, root-relative, case-folded,
      §19). If the downstream reindex doesn't re-mint these through the canonicalization chokepoint,
      a watcher-driven invalidation can miss its target on case-insensitive volumes / Windows
      separators (freshness then rides the slower read-time backstop). Confirm the re-mint happens in
      engine/plugin reindex. `bug`·`med`·`cx:S`
- [ ] **`detectReverseImportCaptures` adds an O(repo) AST walk to every `move_file`/`extract_symbol`**
      — `src/plugins/ts/refactor/capture/imports.ts:160-210`, reached unconditionally via
      `assemblePlan` from `planMove` + `planExtractTo`. It `forEachChild`-traverses EVERY source file
      in the program on every dry-run and apply; the touted memo bounds only `resolveModuleName`
      calls, not the walk. CONTRIBUTING bans per-call work scaling with repo size; tiny-fixture tests
      can't catch it. MED not HIGH because `rewriteImports` already imposes one O(repo) pass, so this
      ~doubles an already-O(repo) op rather than introducing the first. Confirm with a timed
      `move_file` dry-run on a multi-thousand-file repo. `perf`·`med`·`cx:M`
- [ ] **schema endpoint card reads `certain` while its body/response type is unresolvable** —
      `src/plugins/schema/parse.ts:141-160,221`. `buildCard` derives card `confidence` from `notes`,
      but `notes` is populated only for `query`/`response` enumeration failure; a `requestBody`/
      response content that falls to `contentRef`'s `partial` catch-all (`:221`) never demotes the
      card. In `list_endpoints` sql/table mode (`list-endpoints.ts:31-40`) the slot's own `partial`
      is dropped, so the row reads a clean `certain` (§3.4 completeness lie). Trigger needs
      non-standard generator output (union / bare-alias content). Fix: demote the card to `partial`
      when `body`/`resp` came back `partial`. `bug`·`med`·`cx:S`
- [ ] **sql text-table renderer lacks the `~`-meta-key strip the generic/json paths have** —
      `src/format/render/render-table.ts:37-51`. `renderSqlTable` prints `data.columns` as the header
      and every cell raw, with no `~`-key guard (unlike `condenseSpans`/`stripShapeTags` on the
      generic path and `stripShapeTags` on json). REAL mechanism, THEORETICAL trigger (needs a
      producer emitting a `~`-prefixed column — none proven today). Defensive: add a `~`-strip to
      match the generic-path guarantee. `bug`·`med`·`cx:S`
- [ ] **json op/batch consumers never see daemon self-staleness** — the always-on staleness banner
      (`src/mcp/server.ts`) is a TEXT-mode prefix, suppressed in `format:'json'` (a prefix would
      corrupt the single bare-JSON payload — §12). So an agent composing in json learns of daemon
      source-drift only via `status` (`sourceStale: boolean`), never from the op/batch response it
      acts on. Pre-existing; the honest json fix is a STRUCTURAL field on the envelope (e.g.
      `ResultCommon.sourceStale?: true`, surfaced as a real key json keeps and text renders in the
      tail) injected at the facade — deferred because it tugs a daemon-level fact into the L0
      `core/result.ts` op-envelope and renders N× in a batch unless scoped to one result. `imp`·`cx:M`
- [ ] **facade-level rejects (pre-dispatch) stay banner-free on a stale daemon** — two per-op paths
      reject BEFORE the orchestrator round-trip, so they carry no self-staleness marker even when the
      daemon is source-stale: `badArgsOp` (`src/mcp/server.ts` `runOpTool`, the `!built.ok` branch) and
      the `unknown tool` guard (the `opNames.has` miss). On a stale daemon with an old arg-schema/op
      catalogue these could themselves be staleness artifacts, so the restart remedy doesn't reach
      them. Narrow + low-value (the format is unparsed in the bad-args case, so json-suppression is
      ambiguous; the `unknown tool` guard fires off the BRIDGE's own catalogue, not the daemon's, so it
      isn't really a daemon-staleness signal). `bug`·`low`·`cx:S`
- [ ] **two non-op error paths carry no staleness banner** — `runOpTool`'s `result === undefined` ("no
      result (codemaster bug)") sentinel and the `handleCall` top-level `catch` (internal-error) return
      bare error text with no banner (`src/mcp/server.ts`). Both are exception/edge paths (an empty
      results array from a non-failing outcome; an escaped throw), negligible in practice — flagged for
      completeness so the banner-coverage isn't mistaken as total. `bug`·`low`·`cx:S`

## Roadmap — unbuilt phases

### Phase 4 — framework plugins + `list` ops

> With adapters configured, `list` ops return adapter-contributed registries.

- [ ] **`plugins/react`** (`deps:['ts']`) — component detection, hook identification, dialog/sheet
      conventions. `feat`·`med`·`cx:L`
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
      `why-this-line`, `recent-changes`, `changed-since-branch`,
      `refactor-extract-container`. `feat`·`med`·`cx:L`
- [ ] **impact: `batch+sql` table** — needs a "bounded-by-design, always-partial" table contract
      (a capped table feeding `NOT IN` would lie, §2.3). `feat`·`low`·`cx:M`
- [ ] **impact: wall-clock deadline** — node-cap guarantees termination but there's no cumulative
      wall-clock budget → slow-but-finite on a huge repo. Needs a live `Clock` in `OpContext`
      (engine-level). `perf`·`med`·`cx:M`
- [ ] **affected/impact super-seed: reverse-import map** — the `affected` super-seed fans `importersOf`
      (un-memoized O(files) scan) per changed file; in sparse mode (import-leaf changes) the node-budget
      break never fires → O(traced×files), slow-but-terminating (the op note states this honestly).
      Build a reverse-import map once (one O(F) scan) + memoize `importersOf`. Same class as **impact:
      wall-clock deadline**. `perf`·`med`·`cx:M`
- [ ] **affected: dynamic-import tracing** — `importersOf` follows only static import/export; a test that
      lazily `import('./x')`/`require()`s a changed module is silently skipped (the op honestly scopes
      `complete` to the static trace, but the test is still missed). Tool-wide, inherited from
      `importersOf`. `feat`·`low`·`cx:L`
- [ ] **impact_type_error: clean-scope caveat note** — `clean:true` means "no introduced error WITHIN the
      reference-closure scope"; a purely-structural breaker that never references the symbol by name (outside
      the find_usages closure) is missed. Matches impact's reference-closure contract, but a standing
      one-line scope-note on the clean verdict would stop `clean` being read wider than it is. `bug`·`low`·`cx:S`
- [ ] **impact_type_error: editSiteDirty false-`!!` on line-shift** — if the edited declFile has a
      pre-existing error AND the splice changes line count, the shifted old error resurfaces as
      "introduced" in declFile → the editSiteDirty `!!` "parse cascade" note fires on a correct `replace`
      with a real downstream list. Over-warning (conservative, not a lie); per-file diff can't tell a new
      syntax error from a line-shifted old one. `bug`·`low`·`cx:M`
- [ ] **impact_type_error: overlay-baseline doc wording** — the overlay-check doc (`ts/api.ts`) says "disk
      baseline" but `collectFromService` reads the CURRENT program state (=VFS), not disk. Cosmetic doc
      accuracy. `dx`·`low`·`cx:S`
- [ ] **jsxCallSites: member-expression tagName `<C.Sub/>`** — a ref to `C` inside a member-expr tagName
      (`<C.Sub foo/>`) is classified `jsx` and Sub's attributes read as passed to `C` → `find_unused_props`
      may mask a dead prop on `C` (false-negative) or falsely mark it used. Rare (compound components).
      `bug`·`low`·`cx:S`
- [ ] **react read-model: `FunctionDecl` internal-reach** — `react/unused-props.ts` + `react/detect.ts`
      import `FunctionDecl` from the ts plugin's internal `function-declarations.ts` rather than the public
      `ts/plugin.ts` barrel (which re-exports `JsxCallSitesView`/`ParamTypeMembersView` but not
      `FunctionDecl`). Re-export it for §5-L3 consistency. `imp`·`low`·`cx:S`

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
- [ ] **idle-exit brackets only `CallTool`, not `ListTools`** — the Stage-1 idle deadline
      (`src/mcp/idle-exit.ts`) is reset by any `CallTool` (per-op / `status` / `batch`) but NOT by `tools/list`.
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
- [ ] **stale "Move to a new file" docs/test comments after the extract action-switch** — the
      action-switch (extract now drives "Move to file", not "Move to a new file") left present-state
      drift: `docs/spec-extract-completion.md` (Status: proposed) still describes the RETIRED mechanism
      ("drives Move to a new file, post-processes specifiers") — retire or rewrite it, and re-verify its
      KS-2 / KS-3 quarantine claims under "Move to file". Plus stale test comments naming the dead
      action: `extract-symbol.test.ts`, `kitchensink-extract.test.ts`, `refactor-doc-adjacency.test.ts`,
      `refactor-import-fold.test.ts`. `dx`·`low`·`cx:S`
- [ ] **ambient-rebase neither-resolve residual** — `imports/rebase-ambient.ts` rebases a new-file
      ambient import (`*.module.scss`) only when it resolves from SOURCE but not from DEST. A
      PATH-RELATIVE ambient import whose sheet lives in an UNTRACKED source file resolves from neither,
      so it is not rebased and stays broken from `dest` — and the ambient `declare module '*'` keeps the
      §2.8 typecheck clean, so no error surfaces. Narrow (needs a relative ambient import of an untracked
      sheet); close by also probing the source dir for an on-disk (untracked) sheet. `bug`·`low`·`cx:S`
- [ ] **extract JSX-dest coercion misses `.mts`/`.cts`** — `move-to-file.ts` coerces a JSX body's dest
      `.ts`→`.tsx` only when it ends `.ts` (not `.mts`/`.cts`), and unlike `move_symbol` does not refuse
      a non-`.tsx` JSX dest — a JSX body extracted to a `.mts`/`.cts` dest is created as-is and caught
      only by the §2.8 typecheck (a less pointed message). Parity-nit with `move_symbol`'s upfront JSX
      refusal. `dx`·`low`·`cx:S`
- [ ] **move_symbol leaves a namespace+named same-module pair as two statements** — when dest has
      `import * as M from 'm'` and the move brings a named `{ x }` from `m` (or vice-versa), the result
      is two statements from `m`. This is NOT foldable — `import { x }, * as M from 'm'` is illegal
      syntax, so two statements are mandatory (the import-fold's `hasNamespace` guard skips it). The only
      consolidation possible would be rewriting the moved `{ x }` reference to `M.x` (use the existing
      namespace binding) — a semantic rewrite of the moved body, well past the import-fold scope. Distinct
      from the foldable default+named bare-specifier dup the fold handles; low-value. `bug`·`low`·`cx:M`
- [ ] **`name+line` WITHOUT `file` silently ignores `line` → workspace-wide `resolveByName`** —
      `resolve-target.ts`. The col-less `file+line` and `name+file` branches both require `file`; a
      target carrying `name+line` but no `file` matches neither, falls through to `resolveByName(name)`,
      and the `line` is dropped (the resolution is workspace-wide, not line-scoped). Pre-existing (the
      col-less work didn't introduce it — `name` always short-circuited the gate), low impact (an
      unusual address: a name with a line but no file), but a silent input-drop (§3). Fix: a `name+line`
      with no file is underspecified — fail with a pointed "pass `file` too (or drop `line`)".
      `bug`·`low`·`cx:S`
- [ ] **move_symbol capability gap — an edit targeting a gitignored-but-COMPILED file is refused, not
      relocated** — the move-tree is git's listing (`ls-files`: tracked + untracked-not-ignored), but the
      TS program ALSO compiles GITIGNORED files (a `generated/` tree, an out dir). When the LS "Move to
      file" repoints such an importer, the edit targets a file the plan/rollback machinery has no node
      for → `move-symbol-importer-untracked` HONEST refusal (now NAMES the file + says git-track-or-move-
      manually; nothing written — verified in `test/e2e/move-symbol.test.ts`). This is the safe floor;
      the CAPABILITY fix (seed a tree node from the program text, rewrite the gitignored importer too) is
      deferred — it pulls untracked/ignored files into the edit set, which the dirty-gate and git-backed
      rollback don't currently cover, so it needs its own dirty/rollback story. `feat`·`low`·`cx:M`
- [ ] **the precise move_symbol fail[10] (amiro `getInitials`→`src/lib/utils.ts`, "edits target an unknown
      file …/PersonAvatar.tsx") has no captured repro** — the observed desync was on the SOURCE-side
      `PersonAvatar.tsx` (not a gitignored importer like the floor repro above), pointing at a different
      trigger: a realpath↔git path-form skew, a nested-path mismatch, or a DUPLICATE `getInitials`
      (cf. fail[9]) resolving the symbol into the wrong file. The amiro snapshot is destroyed, so a
      faithful repro needs real amiro inputs; the honest refusal + zero-write floor holds regardless.
      Reproduce against a path-form / duplicate-symbol fixture, then close the matching desync.
      (2026-06-23: 4 hermetic sandbox repros on current main — duplicate-symbol, alias-vs-relative
      importer, APFS case-variant import, nested-dir + re-export barrel — all NO-REPRO; apply succeeded,
      the floor held. Likely already fixed; reopen only with captured amiro inputs.) `bug`·`med`·`cx:M`
- [ ] **move_symbol could optionally consolidate PRE-EXISTING dest duplicate imports** — deferred. The
      guarded fold in `move-to-existing.ts` collapses only the duplication the move ITSELF created (its
      `skipModules` set excludes modules dest already had ≥2 statements for), so a same-module split that
      ALREADY existed in the dest is left untouched — consolidating it is an unrequested refactor that
      expands the diff beyond the moved symbol + its imports, exceeding the op's scoped-edit contract. A
      future opt-in "tidy dest imports" could drop the skip-set and fold the whole dest. `feat`·`low`·`cx:S`
- [ ] **extract import-fold misses different-specifier-same-after-rewrite** —
      `foldSameModuleImports` runs BEFORE `assemblePlan`'s `rewriteImports`, so two imports that become
      same-module only AFTER a specifier rewrite (e.g. `'./a'` and `'@/a'` resolving to one moved file)
      are not folded. Rare; acceptable today. `bug`·`low`·`cx:M`
- [ ] **reattach-doc gap rebuild is LF-only** — `reattachLeadingDoc` rebuilds the comment→decl gap with
      `'\n'.repeat(...)`, so in a CRLF file the normalized gap is LF (mixed line endings). The project's
      own prettier normalizes on apply; only bites a no-prettier repo on Windows. `dx`·`low`·`cx:S`
- [ ] **`fold-imports.ts` git-classified as BINARY** (same as `socket-path.ts`) — `git grep` without
      `-a` misses it. A repo-wide `.gitattributes` `*.ts text` would fix both this and the socket-path
      B2 residual in one stroke; do them together. `infra`·`low`·`cx:S`
- [ ] **fold-imports leaves an own-line leading comment of a deleted duplicate import hanging** —
      `deleteLine` removes the import line from its `import` token, not from a comment above it, so a
      `// note` on its own line above a folded-away duplicate is orphaned. Rare (a comment on a duplicate
      import); §2.8 doesn't care (comment). `dx`·`low`·`cx:S`
- [ ] **extract/move_symbol: cosmetic double blank line after the import block (no-doc case)** — the LS
      can emit `import …\n\n\nexport const X` (two blank lines) in the extracted/moved block when the
      symbol has no leading doc. LS-emitted, not detached by our fix; the project's own prettier collapses
      it to one blank line on apply (mutating ops format), so it is invisible in real repos and only shows
      in fixtures without a project prettier. Known-cosmetic, prettier-handled. `dx`·`low`·`cx:S`
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
- [ ] **`move_symbols({names:[],dest})` bulk-move sugar (optional)** — dogfood ask: splitting a large
      file means moving N top-level symbols into one dest. The underlying need (one §2.8 gate, atomic,
      importers repointed once) is now MET by a `transaction` whose steps are N `move_symbol`s. A
      dedicated bulk op would only save the agent from authoring the steps array — pure ergonomics, not
      a capability gap. Defer unless the transaction form proves too verbose in practice. `feat`·`low`·`cx:M`
- [ ] **move_symbol note(b) wording — "fan-out is OFF" reads as a disable-able mechanism** — the
      transaction cross-program note says the write-site fan-out is OFF inside a transaction, but
      move_symbol is primary-only **by construction** (no `rewriteImports` branch — the LS drives the
      repoint on the primary service), so there is nothing to switch off. The limitation-direction is
      honest, but the phrasing implies a move_symbol-specific sibling-write path that gets gated.
      Optionally reword to "primary-only by construction" for parity-accuracy. `dx`·`low`·`cx:S`
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
      `mergedFileSet`), closing the headline trust-gap — for `extract_symbol`/`move_file`
      (`assemblePlan`) AND `move_symbol` (its LS-driven `detectMoveSymbolCaptures` forward path,
      seeded with the same `PriorStepState`). The REVERSE pass (`detectReverseImportCaptures`)
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
- [ ] **`list` combineTruncation defensive branch desyncs with the path filter** — in `list.ts`
      `combineTruncation`, the `!opCapped` branch passes a plugin-reported `view.truncation`
      (`{shown,total}`) through VERBATIM. Those counts are PRE-path-filter (the plugin counts before the
      op drops entries by `excludedByFilter`), so a plugin that sets `view.truncation` would report a
      `shown`/`total` out of sync with the post-filter `entries`. No shipping plugin sets
      `view.truncation` today (dead branch), so it never fires — but if one does, the count lies. Fix:
      recompute the combined `total` against the post-filter matched set, or document that plugins must
      report post-filter counts. `bug`·`low`·`cx:S`

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
> `listable` field ties the raw `total` to the listed/`shown` counts) are fixed; `list` hoists a
> constant kind/provenance column to a header (`allKind`/`allProvenance`); and `css_cascade` states
> the cross-module explanation once in the header instead of per row. Open residuals:

- [ ] **`~<rootTag>` printed on every SymbolId — two-halves task (resolver-semantics THEN render-strip,
      land together or not at all)** — the workspace tag (`~d19d0f20`) is identical on every id of a
      single-root answer (it exists ONLY to refuse a cross-root rebind, §6), so it's ~10ch of pure
      repeat × every id-bearing row (×200 in a busy `find_usages`) — the single biggest aggregate
      constant in the tool. **Empirically confirmed (the blocker, tested mint-in-A/resolve-against-B):**
      a tag-LESS id resolved against a DIFFERENT root that holds a same-named symbol at identical
      relpath+name+pos returns a **`certain`** positional bind to the wrong symbol (resolve-target.ts:167-178)
      — the exact silent §6 cross-root lie; the TAGGED id correctly returns `gone` (cross-repo.test.ts:207).
      So a text-side strip ALONE re-opens that hole on the default (text) output path, and a header
      caveat does NOT fix it (the caveat sits in answer 1; the lie is the `certain` resolve in a
      _later_ call, where there is no flag — honest disclosure must sit AT the resolve, not remote).
      **Unblock = TWO halves that MUST land in one change:** (1) resolver-semantics — a tag-less id
      resolves _current-root-only_ (any cross-root ⇒ `gone`), so the resolve ITSELF becomes honest (a
      real §6 task with its own cross-root surface); THEN (2) the render-strip — already designed
      (`format/render/strip-root-tag.ts`: derive the single distinct `~<8hex>` over id-shaped leaves,
      strip `:\d+~<tag>$`, 0/multi-tag honest fallback; JSON keeps the FULL tagged id; state the root
      once in the header). DANGER: today the tag-less mis-resolve is LATENT (nothing strips); shipping
      half (2) without half (1) ACTIVATES it. The token win is also concentrated where it's least
      needed (json — the programmatic chaining path — already keeps the full id). `dx`·`med`·`cx:L`
- [ ] **`construction_sites` floods on all-optional target types** — `ButtonProps` (a big
      intersection of `ButtonHTMLAttributes & ClassAttributes & VariantProps & {asChild?}`, every
      field optional) matched 5739 candidate literals across unrelated `scripts/openapi-codegen/**`
      and even `en.json`, all `confidence=certain` (an `{}`-ish literal IS assignable to an
      all-optional type, so it is not strictly a lie — but it is noise). Consider a low-signal guard:
      when the target type has zero required fields, demote to `partial` with a "target is all-optional
      — matches are weak" note, or rank by field-overlap. `bug`·`low`·`cx:M`

---

## Tagged-dispatch render contract — residuals (post-foundation, from review)

> The central render seam (`~shape` tag-in-data → `format/render/shapes/` registry; `condense` = thin
> dispatcher) landed. Compile-time `Record<ShapeTag, renderer>` makes "forget a renderer" impossible.
> These are the review-surfaced follow-ups, none a current lie.

- [ ] **shape renderers are not wrapped in try/catch** — `condense`'s tag-dispatch calls the renderer
      directly; a throwing renderer would escape to the agent (the "never crash" §3.6 contract formally
      relies on renderers being throw-free by construction — they are today: only `String()`/asArray
      guards). Wrap the dispatch so a throwing renderer yields a loud `!! renderer error ~shape=X`
      marker (mirroring the unknown-tag marker), never a stack trace. `dx`·`low`·`cx:S`
- [ ] **`looksLikeSpan` short-circuits before tag-dispatch** — `condenseSpans` renders a top-level
      span-shaped object (`file`+`line`+`col`+`endLine`+`text`) as a loc string BEFORE checking
      `~shape`; so if a future op tagged a raw span-shaped row, its `~shape` would leak into the output
      at `full`. No op does this today (usage/group-row/list-entry carry no top-level `endLine`+`text`).
      Latent footgun: check `~shape` before `looksLikeSpan`. `bug`·`low`·`cx:S`
- [ ] **no-op `codemod` bypasses the dirty-tree gate** — a pattern that matches nothing reports a
      compact zero-change verdict (`changed:0`, `typecheck:{clean:true}` without running tsc — honest,
      the edit introduced nothing) but no longer hits the dirty-tree refusal a non-empty codemod would.
      Harmless (writes nothing), but a behavior change vs main — confirm intended. `dx`·`low`·`cx:S`
- [ ] **unit byte-identity assertions use `assert.match` (contains), not exact** — the hermetic
      render-compact suite pins outputs with `match`/`doesNotMatch` (pre-existing style), so a trailing
      append would slip a strict byte check; the renderer ports were verified by reading. New multi-line
      forms (`name-survives`/`target-ref`/`css-coextract`) are pinned only structurally (they were
      explosions — no prior bytes). Tighten to exact-string where it matters. `dx`·`low`·`cx:S`

---

## Full-verbosity density — review residuals (post-merge 2026-06-23, none a current lie)

> The full-verbosity density pass landed (`expand_type` name-token span → `at`-loc; `FULL_DISPOSITION.symbol`
> flipped verbatim→collapse, fixing `find_usages.definition` / `search_symbol.matches` / `mergedDeclarations`;
> `css_cascade` rules selector dedup; i18n evidence — dynamic `t()` template + dotted key — preserved at full;
> `output-density.test.ts` now sweeps every op incl. config-gated at terse/normal/**full**, closing the
> ts+scss-only forgot-to-`tag()` guard). 4 reviewers PASS (2 bug + trust + doc-sync); discrimination
> independently confirmed (revert→RED per fix-group). Residuals below.

- [ ] **`find_definition` full fallback can collapse a body-bearing sibling post-FLIP** — at full,
      `render-result.ts:65-71` routes to `renderSource` only when `usable` (every definition has a non-empty
      `decl` body); if ANY site lacks a `decl` object, the WHOLE result falls to `renderDense(condenseSpans)`,
      where post-FLIP a body-bearing sibling's `decl` now collapses to `loc · firstline` instead of the full
      body — violating `find_definition`'s own "full = whole body" note. Effectively DEAD today: both bug
      reviewers could not make `declarationNodeOf` (`plugins/ts/declaration.ts`) return undefined for a real
      definition site (overloads/merges/default-exports/re-export chains/lib types all resolve a decl). Guard:
      a discriminating test (a find_definition with ≥2 sites, ≥1 no-decl + ≥1 body, at full) so a future
      `declarationNodeOf` change or a new no-decl definition kind can't silently reintroduce the body-drop.
      `bug`·`low`·`cx:S`
- [ ] **`spanTextOf` first-line-only — "never a silently-dropped body" comment overstated** — the `symbol`
      renderer's full-mode guardrail (`shapes/ts.ts` `declHeader` → `shapes/span-text.ts` `spanTextOf`) keeps
      only `text.split('\n')[0]`, so a hypothetical body-bearing `symbol`-tagged row reaching `condense` at
      full would lose lines 2..N (same first-line caveat for a multi-line dynamic template in `bareSpan`).
      No present consumer triggers it (reaching symbol rows are decl-less; body-bearing forms are
      renderSource-intercepted / `verbatim`-disposition). Correct the comment, or route such a future form
      through `verbatim`. `dx`·`low`·`cx:S`
- [ ] **`expand_type` `at`-loc correctness validated by neither suite** — `span-validity.test.ts` correctly
      dropped `expand_type` from the proof-span sweep (it no longer emits a Span, only the `at` string), but
      `expand-type.test.ts` oracle-checks members/signatures/type, NOT the location. The `at` derives from the
      same `info.textSpan`/`spanFromRange` as the old validated span (drift unlikely), but the net is thinner.
      Add a loc-correctness assert in `expand-type.test.ts`. `dx`·`low`·`cx:S`
- [ ] **`expand_type` span→`at` agent-facing rename under-documented** — the data-shape changed
      `span:{object}` → `at:"file:line:col"` (string); documented in the `span-validity` EXCLUSIONS comment but
      not in the op's `notes`. Not a lie; add a 1-line op-note for the agent-facing rename. `doc`·`low`·`cx:S`

> The 3 density tracks (mutating/ts-read/analyzers) landed. These are the review-surfaced follow-ups.

- [ ] **no dedicated sql-mode test for `list` `allConfidence` backfill** — `listTable.rows` fills
      `confidence` from `allConfidence` when hoisted (verified by reading); mirrors `allKind`/
      `allProvenance` which also lack a dedicated sql test. Add one. `dx`·`low`·`cx:S`
- [ ] **mutating envelope: `DiffstatEntry` type name + "for the diffstat" comment are stale** — the
      field is now `touched` (merged per-file counts), but an internal type name/comment still says
      diffstat (mutation-support.ts:158-159). Not user-facing; rename for clarity. `dx`·`low`·`cx:S`
- [ ] **mutating `touched` key is overloaded** — `string[]` in full mode, structured
      `{path,added,removed}[]` in summaryOnly. Documented + typed, but an agent must branch on `mode`.
      Design wart; consider distinct keys (`touched` vs `touchedStat`). `dx`·`low`·`cx:M`
- [ ] **`find-usages.ts` is at exactly 300 real lines (the cap, no headroom)** — passes eslint
      `max-lines`, but any further edit busts it. Pre-emptive extraction (e.g. the hoist helpers to a
      sibling) before the next change. `dx`·`low`·`cx:S`
- [ ] **misc density test-coverage gaps** — `dominant=sibling` prog-hoist case (symbol mostly in
      `test/**`) has no dedicated test (only primary-dominant fixture); `find_usages text:true` 0-hit
      note + truncated-text `… N more` hint untested; `expand_type` `constituents` `covered()`
      substring-match has a theoretical false-positive (arm a substring of arm AB, head drops standalone
      a without `...`) needing a TS-format bug to trigger. `dx`·`low`·`cx:S`
- [ ] **self-staleness banner missed after `daemon restart`** — ROOT CAUSE NOW KNOWN (see the
      2026-06-21 bug-sweep HIGH items above): the "no daemon running" + stale-serving combo is the
      **socket-path env-divergence** (bridge in `/tmp`, restart in `$TMPDIR` → different sockets) PLUS
      the **one-shot staleness banner** (op/batch re-warns only once). The banner half is FIXED
      (always-on prefix — see the FIXED HIGH item above); the socket half is being fixed on branch
      `socket-path-fix`. `bug`·`med`·`cx:M`
- [ ] **intake flag-precedence: a lifted-from-args flag overrides an explicit top-level flag** — when a
      call passes the SAME OpFlag both inside `args` AND at top level (e.g. `{apply:false, args:{apply:true}}`),
      the intake flag-lift (`engine.ts` `extractFlags({ ...req, ...resolved.flags })`) lets the args-placed
      value win. Harmless today (no agent double-specifies) and arguably the right call (the args-placed one
      is the more explicit intent), but undocumented; pick a precedence and state it. `dx`·`low`·`cx:S`
- [ ] **intake: `find_usages` scalar `symbols:"Foo"` not coerced to array** — the bare-name multi-target
      field `symbols` is not in any op's `arrayFields`, so `symbols:"Foo"` (string) still rejects; the
      single-name path is `symbol`→`name` (or `name` directly), not `symbols`. Minor DX — add `symbols` to
      find_usages `arrayFields` if the scalar form shows up again in the fail log. `dx`·`low`·`cx:S`

---

## Correctness bugs surfaced by the density audit (not density — parked here so they don't vanish)

- [ ] **expand_type / find_unused_exports small render+resolve bugs (dogfood 2026-06-20, kitchensink)**
      — (a) FIXED + (b) FIXED + (c) test-landed/fix-in-addressing-track; (d)/(e) OPEN. (a) `expand_type`
      on a fn/namespace merge truncated the return type after the colon — now the callable headline is
      cut at the first `(` and the full call shape lives in `signatures` (NoTruncation), so nothing is
      lost. (b) overload signatures were dropped everywhere — `expand_type` now lists EVERY call
      signature via `getSignaturesOfType(…, Call)` in `signatures[]`. (c) `expand_type` by `name`+`file`
      fails to resolve a type alias that `file`+`line`+`col` resolves (the `name`+`file` resolver path
      silently ignores `file` and falls into workspace-wide fuzzy navto, where case-insensitive `span`
      matches bury the exact `Span` past the cap) — FIXED by the addressing track's `name`+`file` →
      `resolveNameInFile` branch in the shared `plugins/ts/resolve-target.ts`; oracle test
      `test/differential/expand-type.test.ts` "Bug C". (d) `find_unused_exports` `undiscoveredPrograms`
      lists ABSOLUTE paths while every other path is repo-relative; (e) namespace-merge members flagged
      `inherited=true` (per the different-decl-node rule, misleading for a fn/namespace merge). (d)/(e)
      are honesty/clarity. `bug`·`med`·`cx:M`
- [ ] **A refused-on-`apply` mutating op reports `mode=dry-run`** — `move_symbol … apply:true` that the
      typecheck gate refuses still renders `mode=dry-run` (+ `applied=false` + the reason). `mode` is
      conflating "was apply requested" with "did anything get written"; a refused apply is neither a
      dry-run nor an applied edit. Report `mode=refused` (or `requested=apply applied=false`) so the
      agent isn't told it ran a dry-run it didn't ask for. `bug`·`low`·`cx:S`
- [ ] **`typecheck.preExisting` count is non-deterministic across identical runs** — two back-to-back
      identical `codemod` dry-runs reported `preExisting=3` then `preExisting=2`. A flapping baseline
      error count means the gate's "introduced vs pre-existing" split can misclassify on the boundary
      (a real introduced error could be absorbed as pre-existing, or vice versa) — a correctness risk,
      not cosmetic. Investigate the baseline typecheck determinism (program reuse / diagnostic order).
      `bug`·`med`·`cx:M`
- [ ] **FAIL envelopes repeat the `file it: feedback({kind:'bug'…})` footer** — every `FAIL tool=…`
      response appends the same feedback-CTA footer; in an agent loop hitting repeated FAILs it is
      per-call noise. Consider emitting it once per session, or only on an internal-error FAIL (not a
      conservative-refusal FAIL the agent expects). `dx`·`low`·`cx:S`
- [ ] **per-op tool accepts `sql` on a non-table op** — `opToolSchema` accepts `sql` for any op, but
      the per-op `inputSchema` advertises it only on table-bearing ops; a `sql` on a tableless op
      still reaches dispatch and degrades honestly ("op has no table"). Optionally reject at the
      facade before dispatch for a sharper error. `dx`·`low`·`cx:S`
- [ ] **no test for the per-op `needs:<plugin>` description tag** — `buildOpToolDescriptor` adds a
      `[needs: i18n]`-style tag from `op.requires`, but no test asserts it appears (the e2e covers
      the call-time `unavailable`, not the advertised tag). `dx`·`low`·`cx:S`
- [ ] **`src/mcp/server.ts` is ~299 real lines (300 cap) — one line of headroom** — the exit-seam track
      pushed it to the cap; the next edit forces a split. The natural seam is extracting the per-op
      `runOpTool` + the render helpers (`renderResults`/`renderBatch`) into a sibling `render-call.ts`.
      `dx`·`low`·`cx:S`
- [ ] **exit-seam masking test: orphaned `.gen.ts` child swept only on the NEXT run** — `exit-seam-
masking.test.ts` generates a pid-unique `exit-seam-child.<pid>.gen.ts` under `test/e2e/`, cleaned in
      `finally` + a defensive sweep at the START of the next run. A hard-kill (SIGKILL) between generation
      and cleanup leaves a stray `.gen.ts` that an independent `npm run check` (tsc -p tsconfig.test.json /
      eslint `test/**/*.ts`) would glob before the next test run sweeps it. Narrow window, abs-path import
      stays valid, low risk. Consider generating under `os.tmpdir()` instead, or a sweep in the check
      script. `dx`·`low`·`cx:S`
- [ ] **`source` shows only the impl signature for an overloaded function** — `source` on an
      overloaded `function coerce(...)` returns only the implementation declaration's span/body, never
      the overload signature decls that precede it (verified: only the impl line is rendered). The
      decl-span machinery (`plugins/ts/definitions.ts` / `source` op) anchors one declaration; for an
      overload set it should surface all signature decls. Split out of the `expand_type` overload fix
      (that fix covered `expand_type` only; `source` is `src/ops/source.ts`, a different surface).
      `feat`·`low`·`cx:M`
- [ ] **`expand_type` enum members echo the member name and omit the value** — enum/const-enum members
      render `Low: Severity.Low` (a name echo) while the actual value (`Low=0`, `High='high'`) is not
      shown; the column should carry the value, not re-echo the name. `bug`·`low`·`cx:S`
- [ ] **`find_unused_exports.undiscoveredPrograms` lists ABSOLUTE paths** — `/Users/…/tsconfig.json`
      while every other path in every op is repo-relative — inconsistent, and leaks the absolute FS
      layout. Make it repo-relative. `bug`·`low`·`cx:S`
- [ ] **namespace/function-merge members flagged `inherited=true`** — `isInherited` (type-expand.ts:155)
      = "decl in a different node", which is technically true for a fn+namespace merge but reads as
      misleading. Verify the label is wanted for merges before acting. `bug`·`low`·`cx:S`
- [ ] **`importers_of` doesn't hoist a dominant imported name** — each row trails `· <imports>`, which
      for a SINGLE-export module is a constant (= the main export) repeated on every importer. A
      `hoistUniform`-style lift would densify it. NOT done: dogfood shows `imports` is a VARYING set
      per file for multi-export/barrel modules (`partial,ok` / `ok` / `fail,messageOfThrown,ok` …), so
      no dominant constant exists there — a hoist is fragile and rarely applies. Revisit only with a
      "single dominant covers ≥X% of rows" guard. `dx`·`low`·`cx:S`
- [ ] **runtime result-note §N citations** — the status-notes density pass (concepts hoist + § strip)
      scoped itself to `status`-rendered text (op `notes:`/`summary` + `concepts.ts`). MANY agent-facing
      RUNTIME result-note strings still carry opaque ARCHITECTURE `§` refs the agent can't resolve —
      this is NOT an exhaustive list (a closed list here would itself leak by §3.4): seen across
      `src/ops/*` (e.g. codemod / mutation-support / transaction / refactor-apply / refactor-plan-apply)
      and `src/plugins/scss/*` (e.g. cascade/resolve). FIND THEM ALL, don't enumerate: `grep -rn "§" src/`
      then keep only the hits INSIDE an agent-facing string literal (skip code comments / doc refs). Strip
      the `§` (keep the substance) for the same wrong-pocket reason. Left out of the density pass to avoid
      touching logic-adjacent strings. (The leaks are PRE-EXISTING, not introduced by the density pass.)
      `dx`·`low`·`cx:S`

---

## Wishes (new capabilities — no task yet)

- [ ] **Outward-call / `depends_on` view** — the dual of `find_usages`/`impact`: "what does this
      function/file CALL or import outward", bounded + proof-carrying + depth-capped. Candidate fat
      task `spec-calls-op`. `feat`·`med`·`cx:L`
- [ ] **Member-level `find_usages`** — trace readers of a specific object-type FIELD (e.g.
      `GroupRow.site`); today `find_usages` on a type finds the TYPE, not a named `.field` member
      (role:read/write is syntactic). Checker-backed. `feat`·`med`·`cx:L`
