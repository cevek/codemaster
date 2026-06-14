# Spec: post-port core consolidation — make the read-core provably non-lying

Status: **done** — all six stages landed (see `docs/plan.md` for the per-box state and the
test files). The **first chunk after the Phase 2
refactor port merges** ([spec-refactor-port.md](spec-refactor-port.md) lands all of A–H).
Read ARCHITECTURE.md §1 (north star), §3 (trust contract), §16 (honesty harness), §8
(freshness), §6 (rebind), §19 (platform) and CONTRIBUTING.md before starting. This spec is the
contract; where it is silent, those documents rule.

Goal stated by the owner: **make the core as hard and solid as possible.** So this is not a
two-test patch — it is a gap-driven program that closes the honesty-harness holes for the
_read-core_ (the `ts` read-path, `scss`/`i18n`, freshness/overlay, the proof-carrying envelope,
the dispatch/resilience seam). It adds **no new agent-facing capability**; it makes the
capability we already shipped _provably_ honest.

## 1. Why now, and what is in scope

Phase 2 stacks a VFS overlay + mutating ops onto the `ts` read-core. Before growing surface
(Phase 3 `schema` / Phase 4 framework / Phase 5 composites), the invariants that guard that core
must actually gate CI. A coverage audit of the suite (§16 inv. 1–7, §3 clauses) found the core
honest where present but **incompletely gated**. The gaps below are the scope.

**Boundary with the port (do not double-own).** The Phase 2 port (`spec-refactor-port.md`) owns:
§16 inv. 4 **edit-safety** for `rename_symbol`/`move_file`/`extract_symbol`/`change_signature`/
`codemod`; `prettier` + `text-edits` `ToolFailure` (its Stages A/B); **cross-file** move/extract
rebind; the tree invariants. This spec owns the **read-core** only and must not re-test those.

### Coverage map — read-core (audit result)

| §    | Invariant / clause                                              | State                                                                                                                                                                                                                                | Gap this spec closes                                                                  | Sev      |
| ---- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------- |
| 3.6  | Resilience: external-tool failure → `ToolFailure`, daemon lives | THIN — `fs`/`sql`/`text-search` covered (`feedback-op.test.ts:74`, `sql-sandbox.test.ts:92`, `text-overlay.test.ts:144`)                                                                                                             | **git + TS-LS** failure injection on read ops                                         | **HIGH** |
| 16.5 | `find_usages` vs an independent cold-LS oracle                  | THIN — `ops.test.ts:12` proves _catches alias_, not _parity vs cold LS_                                                                                                                                                              | semantic-ref set == cold-LS `findReferences` on the traps                             | MED      |
| 16.2 | Per-plugin freshness honesty (watcher silenced)                 | THIN — `ts` only tests `add` (`freshness.test.ts:96`); scss/i18n better                                                                                                                                                              | `ts` **in-place mutation**; rebase/stash bulk; racy-clean end-to-end; i18n `checkout` | MED      |
| 16.3 | `cold == warm` after edits                                      | THIN — i18n done (`i18n.test.ts:287`); ts static-only; scss absent                                                                                                                                                                   | `ts` + `scss` **post-edit** warm == cold-boot                                         | MED      |
| 16.1 | Proof-span validity on every emitted span                       | THIN — opt-in; covered on `find_usages`/`find_definition`/`i18n_lookup`/`source`, missing on `expand_type`/`search_symbol`/`importers_of`/`scss_classes`/`find_unused_scss_classes`/`find_unused_i18n_keys`/`find_missing_i18n_keys` | a **sweep** asserting spans on every op output                                        | MED      |
| 3.3  | Confidence + provenance honesty                                 | THIN — `dynamic`/`unresolved` ok (`i18n.test.ts:93`); provenance _selected_ not _asserted_ (`text-overlay.test.ts:162`)                                                                                                              | assert `provenance` values (`syntactic` vs `type`); computed-scss-access confidence   | MED      |
| 6    | Stale-handle rebind                                             | THIN — `rebound`+proof ok (`ops.test.ts:68`); no `gone`                                                                                                                                                                              | read-side **`gone`** (decl deleted → not a false rebind)                              | MED      |
| 19   | `RepoRelPath` canonicalization                                  | THIN — minting/escape ok (`support.test.ts:51`)                                                                                                                                                                                      | case-fold collision + symlink/realpath policy (deterministic, not FS-dependent)       | LOW      |
| 16.7 | Plugin-DAG honesty                                              | OK (unit, 2-node — `common.test.ts:141`)                                                                                                                                                                                             | a realistic 3+ node cycle                                                             | LOW      |

What is already solid and **not** re-done: truncation `{shown,total,hint}` (§3.4 —
`ops.test.ts:44`, `expand-type.test.ts:179`, `sql-over-ops.test.ts:113`); i18n cold==warm; the
`rebound` path with proof; `fs`/`sql`/`text-search` `ToolFailure`.

### Fixtures — no real project needed

Every gap below is closed with **inline `project({...})` fixtures** (one trap each, hermetic,
no `npm install`) plus **failure injection through the existing `project()` seams** (the
`createSqlRunner`/`createTextScanner` pattern, extended to git + LS). No committed repo folder,
no NDA project, no synthetic `refactor-app` — those belong to the _port's_ high-blast-radius
move/extract integration tests, not here.

## 2. Fixed decisions

- **Inline-VFS only**, oracle-backed. A fixture is input; the oracle is independent (cold LS,
  cold-boot daemon, independent scanner, byte-range source read) — §16.
- **Failure injection via seams, never by breaking the host.** Add git/LS injectable seams to
  `project()` mirroring `createSqlRunner`/`createTextScanner`, so a forced failure is
  deterministic and the daemon's liveness is asserted _after_ (next op still answers).
- **Determinism (no `sleep`, no FS-dependence).** Freshness/cold==warm drive the injected clock
  and the scenario runner; §19 case-fold is tested against the canonicalization _function_ with
  an injected volume-casing verdict, not by hoping the CI volume is case-insensitive.
- **No architecture change, no new capability.** Each stage ticks an existing plan.md box or
  hardens an existing path.
- Two small DX riders ship at the end (own surface, no plugin): the daemon **self-staleness
  signal** (plan.md "Self-hosting DX", gated "after round 2" — now unblocked) and the **root-
  placement concepts fix** (inbox `[friction]`).

## 3. Stages (PR-sized; foundation → HIGH severity → MED → LOW → DX riders)

**Definition of done per stage** (§17 + CONTRIBUTING): `fix-and-check` green · an
**oracle-backed** test · ≤300 lines real code/file · no upward import · new boundary
zod-validated · every external-tool call wrapped → `ToolFailure` · docs at present state · tick
the matching plan.md box.

### Stage 1 — oracle runners + universal span sweep (foundation, inv. 1 + 5 infra)

- **Goal.** One reusable home for the independent oracles, and make proof-span validity
  _universal_ instead of opt-in.
- **Build.**
  - `test/helpers/cold-ls.ts` — `coldProgram(root)` + `coldFindReferences(root, target)`
    returning `find_usages`' `{file,line,col}` projection (set-comparable). Lift from
    `expand-type.test.ts:37-72` and re-point that test at the helper (proves behavior-preserving).
  - `test/helpers/ripgrep.ts` — `rg(root, word)` word-boundary scan, honest-skip when absent
    (the _distinctness_ cross-check, never a parity oracle — §16).
  - `test/helpers/scenario.ts` — `scenario(steps)` over `project()`: `{edit|add|remove|checkout|op}`
    driving the injected clock (no `sleep`). Reused by Stages 3–4.
  - **Span sweep:** a `test/differential/span-validity.test.ts` that runs a representative call of
    **every registered op** (`ops/builtins.ts` — the 12 shipping ops; currently span-unchecked:
    `expand_type`/`search_symbol`/`importers_of`/`scss_classes`/`find_unused_scss_classes`/
    `find_unused_i18n_keys`/`find_missing_i18n_keys`) through `assertSpansValid`. Drive it off the
    `op-examples.test.ts` example set (which already imports `builtinOps()`), so the sweep tracks
    the real catalogue and auto-covers any op added later — never a hand-maintained phantom list.
- **Oracle.** Re-pointed `expand-type` test green; the sweep flags a deliberately-drifted span.
- **Exit.** Runners factored; sweep covers every op; plan.md Phase 0 "oracle runners + scenario
  runner" ticked.

### Stage 2 — resilience: git + TS-LS `ToolFailure` injection (§3.6, **HIGH**)

- **Goal.** A failing git or a throwing LS yields an honest `ToolFailure` with empty `data` and a
  **live daemon**, never a crash or a guessed result ("never crash" — CONTRIBUTING).
- **Build.**
  - Add `createGit?` / LS-fault seams to `project()` (mirror `createSqlRunner`). A forced fault
    is injected for one op; the test asserts the result is `ToolFailure` (named tool, empty data)
    **and** that a subsequent normal op on the same engine succeeds (liveness).
  - Cover: git `rev-parse`/`status`/`diff` failure on the freshness path; LS throw during
    `find_usages` and `expand_type` (the semantic ops). Assert no exception escapes the boundary
    (`DispatchError.op_threw` must not appear for a _wrapped_ failure — it must be a `ToolFailure`).
- **Oracle.** Structured `ToolFailure` shape (`core/result.ts`) + post-fault liveness probe.
- **Exit.** git + LS read-op faults proven honest; daemon stays up; plan.md resilience note added.

### Stage 3 — `find_usages` vs cold-LS (inv. 5) + provenance/confidence values (inv. 6 / §3.3)

- **Goal.** Prove the semantic half of `find_usages` equals an independent cold-LS oracle on the
  exact traps the tool beats grep on; assert provenance/confidence _values_, not just presence.
- **Build.** `test/differential/find-usages.test.ts`: for each trap, warm semantic-ref set ==
  `coldFindReferences` (Stage 1): aliased import (`import {Foo as F}`…`<F/>`), barrel re-export,
  type-only import, JSX literal/spread/computed props, **same-named symbols in different scopes**,
  cross-file. Cross-check `rg` only for _distinctness_ (neither subset nor superset — the §16
  "`⊇ grep` does not hold" claim, made concrete). Provenance: assert a syntactic hit carries
  `provenance:'syntactic'` and a type-resolved hop `'type'`; computed scss access
  (`s[expr]`) carries `confidence:'dynamic'` (independent class-usage scan as oracle).
- **Oracle.** Cold `ts` LS `findReferences`; independent scss class-usage scan; `rg` for distinctness.
- **Exit.** All traps equal the cold oracle; provenance/confidence values asserted; plan.md Phase 1
  "`find_usages` vs cold-LS differential" ticked.

### Stage 4 — freshness hardening (inv. 2) + `cold == warm` for ts & scss (inv. 3)

- **Goal.** No incremental-update drift and no silent-stale on the patterns the watcher misses.
- **Build (over the Stage 1 scenario runner).**
  - **inv. 2:** `ts` **in-place mutation** (currently only `add` is tested), a **bulk** change
    (`git checkout` of a branch touching many files; a `rebase`/`stash`-shaped multi-file swap),
    and the **racy-clean mtime-tie** exercised _end-to-end_ through the pipeline (it is unit-only
    today — `common.test.ts:66`). i18n `checkout`. Each: answer is reindexed-correct or carries a
    `FreshnessNote`, **never** silent-stale — including the **omitted-file** case (§16 inv. 2).
  - **inv. 3:** `cold-equals-warm.test.ts` — for `ts` and `scss`, run a scenario then assert the
    warm op result == a cold-boot `project()` over the identical post-edit tree, comparing the
    dense `Result` data **including proof spans** (a drifted span is a lie — inv. 1).
- **Oracle.** Cold-boot daemon over the identical tree (definitional); reindex-on-read correctness.
- **Exit.** ts mutation + bulk + racy-clean-e2e freshness green; `cold==warm` green for ts+scss;
  plan.md Phase 1 "`cold == warm`" + freshness boxes ticked.

### Stage 5 — read-side `gone` rebind (§6) + §19 canon edges + DAG realistic cycle (inv. 7)

- **Goal.** Close the remaining LOW/MED edges that silently misfire when wrong.
- **Build.**
  - **§6 `gone`:** delete a symbol's declaration (scenario `remove`/`edit`), query the stale
    handle → `{status:'gone'}` with empty data, **never a false `rebound`** to a same-named
    unrelated symbol. (Cross-file move rebind is the port's, not here.)
  - **§19:** test the canonicalization _function_ with an injected case-insensitive volume verdict
    — two spellings (`src/Foo.tsx`, `src/foo.tsx`) brand to one `RepoRelPath`; a symlinked path
    `realpath`s to its target per the fixed policy. Deterministic, not FS-dependent.
  - **inv. 7:** feed `createPluginRegistry` a realistic 3-node cycle (a→b→c→a) and assert the
    init-time failure shape names the cycle (an op-time crash would lie about capability).
- **Oracle.** `gone` vs a cold-LS confirm the symbol is absent; independent path-equality for
  canon; registry error shape for the cycle.
- **Exit.** `gone`, canon edges, 3-node cycle green; plan.md/ARCHITECTURE notes accurate.

### Stage 6 — DX riders: daemon self-staleness signal + root-placement fix

- **Goal.** The daemon never silently serves behavior older than its own source; the `root`
  stumble the inbox logged is removed.
- **Build.**
  - **Self-staleness:** record codemaster's **own** source fingerprint at spawn (FNV rollup over
    `src/**` via `support/fs` — reuse `common/hash/fnv` + the §3.5 rollup, no second
    fingerprinter). On `status` and as a one-line op-result note, when live ≠ recorded:
    `daemon code behind source — reconnect MCP`. Off the hot path; honest/non-fatal (§3.6).
    Document the `node src/bin.ts op …` self-dev loop in CONTRIBUTING. Hot-reload stays on wishlist.
  - **Root fix:** edit the `status` concepts line (`mcp/schema.ts:165` area) to say `root` sits
    **top-level (beside `name`/`args`, not inside `args`)**; the batch request-item schema already
    carries `root` (`mcp/schema.ts:121`). Anti-drift unit test + concepts golden update; a positive
    test that `root`-in-`args` still fails with the self-correcting `bad_args` error (docs improve,
    validation unchanged).
- **Oracle.** Staleness line present-when-stale / **absent-when-fresh** (no false positive);
  concepts golden + anti-drift assertion.
- **Exit.** Signal + self-dev loop documented; concepts clarified, guard green; plan.md
  "Self-hosting DX" ticked; inbox `[friction]` resolved.

## 4. Module layout

```
test/helpers/    cold-ls.ts · ripgrep.ts · scenario.ts                 (Stage 1)
test/differential/
  span-validity.test.ts        every op's spans valid                  (Stage 1)
  find-usages.test.ts          semantic == cold LS; provenance/conf     (Stage 3)
  cold-equals-warm.test.ts     warm == cold-boot (ts, scss)             (Stage 4)
  freshness.test.ts (extend)   ts mutation · bulk · racy-clean e2e      (Stage 4)
  resilience.test.ts           git + LS fault → ToolFailure, daemon up  (Stage 2)
  rebind-gone.test.ts          decl deleted → gone, no false rebind     (Stage 5)
test/helpers/project.ts (extend) createGit / LS-fault seams             (Stage 2)
daemon/          self-source fingerprint at spawn + status/op note      (Stage 6)
mcp/schema.ts    concepts: root is top-level                            (Stage 6)
CONTRIBUTING.md  self-dev `node src/bin.ts op …` loop                    (Stage 6)
```

Stages 1–5 are test-only except the `project()` seam additions (Stage 2); Stage 6 touches
`daemon/` + the `mcp` render + prose.

## 5. Review protocol

Per stage, run the shipped reviewer subagents (`.claude/agents/`):

- **bug-reviewer** — oracles must be genuinely _independent_ (cold LS vs warm LS = independent;
  warm op vs itself = circular — §16). The staleness signal must not false-positive on an
  unchanged tree; a forced fault must surface as `ToolFailure`, not `op_threw`.
- **copy-paste-reviewer** — Stage 1 exists _because_ the cold-LS oracle was about to be
  copy-pasted; confirm `expand-type.test.ts` reuses the helper and the self-fingerprint reuses
  `common/hash/fnv` + the §3.5 rollup, not a second impl.
- **doc-sync-reviewer** — plan.md boxes ticked, ARCHITECTURE §16 still accurate, CONTRIBUTING
  self-dev loop matches reality, this spec's status flipped to done.

## 6. What comes after — feature-direction fork (next decision)

This chunk is feature-neutral. After it, the surface-growth options (all merge-safe — separate
directories; pick by _strategy_):

- **`schema` plugin (finish Phase 3).** `schema.d.ts` → endpoint cards + `ops/list-endpoints`.
  Smallest, self-contained, completes the non-TS trio (scss ✓ · i18n ✓ · schema ✗).
- **`react` plugin (open Phase 4).** Base of the framework-plugin DAG; unlocks `component_card`;
  first real exercise of runtime DAG enforcement at scale. Higher value, higher cost.
- **Phase 5 compound ops** (`component_card`/`feature_map`/`affected`/`impact`) — composites over
  shipped plugins; the component-shaped ones want `react` first.
- **Phase 1 read-op leftovers** (`assignability`, `imports(file)`, aliased-scss `module-resolve`)
  — small capability fills, now unblocked once the port frees `plugins/ts/`.

Recommended once consolidation lands: `schema` (cheap Phase 3 close) → `react` (opens the
high-value Phase 4/5 surface). The owner picks; this spec does not.
