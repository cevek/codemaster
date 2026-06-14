# Spec: porting the symbol-anchored refactor engine into `plugins/ts/refactor/`

Status: **implemented, with named deferrals** (Phase 2). Owner: the implementing agent.
Read ARCHITECTURE.md §1 (north star), §3 (trust contract), §5-L2/L3, §7 (edit model),
§8 (lifecycle/freshness), §9 (memory), §16 (honesty harness), §19 (platform) and
CONTRIBUTING.md before starting. This spec is the contract; where it is silent, those
documents rule. It refines [plan.md](plan.md) Phase 2.

> **Implementation status (present state).** Built: the tree (Stage C), `rename_symbol` (D),
> `change_signature` (E, **remove/reorder only** — add/rename-param not built), `move_file`
> (F), `extract_symbol` (G, **TS-only**), `codemod` (H). **Deferred / not yet built** (this
> spec describes them as the full design; the merge shipped a narrower, honest subset): the
> extract **CSS co-extract** (`css-coextract/` §6) and the **patched-LS rescue** (§4,
> `extract/rescue.ts`); `extract/postprocess.ts` (the raw LS output compiles clean today, so
> no post-process was needed — re-add when a fixture demands it).

Prior art: `front-renamer` (at `../front-renamer` during the port) — a standalone CLI that
moves files/folders, rewrites imports (aliased + relative), renames identifiers via the
LS, extracts symbols via the LS "Move to a new file" refactor, and co-extracts sibling
CSS. codemaster keeps the **transform logic** and discards the standalone
**infrastructure** it duplicates. File:line references below point into front-renamer's
`src/`.

## 1. Problem & idea

Phase 2 adds symbol-anchored mutating ops — `rename_symbol`, `move_file`,
`extract_symbol`, `change_signature` (§7). The hard, battle-tested logic exists in
`front-renamer`. The win is to **vendor the brains and reuse codemaster's plumbing**, not
to re-derive the brains or pull the plumbing in twice.

## 2. Fixed decisions

### 2.1 Port (vendor), never depend

front-renamer's `RenameEngine`/`ExtractEngine` **construct their own `ts.LanguageService`
internally** (`rename.ts:21-24`, `extract.ts:113-121`) from a config bundle (`ProjectInfo`)

- their own disk-built `VFSTree`; there is no seam to inject codemaster's warm LS.
  Consuming them as a library therefore means a **second LS** over the same files — doubling
  the §9 memory (the dominant operational risk) and producing edits that are not the
  freshness-checked oracle of §3.1, so they cannot be proof-carried (§3.2). The
  npm-dependency path is closed for the parts that matter. The relevant code is **vendored**
  inside `plugins/ts/refactor/`; codemaster does not depend on the `front-renamer` package at
  runtime (§14).

### 2.2 Brains vs plumbing — what is ported and what is reused

**Ported** (transform brains → `plugins/ts/refactor/`): specifier rewriting on move
(aliased `@/…` + relative, with resolve-as-written / emit-as-current dual addressing); the
dependency-ordered move plan; identifier rename via the LS; the extract refactor + its
failure taxonomy (`../front-renamer/docs/ts-ls-failures.md`) + the patched-LS rescue (§4);
the **safe-move** half of CSS co-extraction.

**Reused** (codemaster already owns these — do not port front-renamer's copies):

| front-renamer                                                             | codemaster                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| own VFS + LS-host / project loader (`vfs.ts`, `ts-loader.ts`)             | `plugins/ts/ls-host.ts` (warm, versioned, lazy)   |
| `git mv` / dirty gate / snapshot / rollback (`engine.ts`, `preflight.ts`) | `support/git/`                                    |
| prettier loader (`prettier-loader.ts`)                                    | `support/prettier/` (fill the stub — Stage B)     |
| span edits, atomic apply (`text-edits.ts`)                                | `support/text-edits/` (fill the stub — Stage A)   |
| dense report (`report.ts`)                                                | `format/` (§12 already credits this house style)  |
| ops.json schema (`schema.ts`)                                             | per-op zod arg schemas + the `op` dispatcher      |
| pre/post typecheck (`typecheck.ts`, `preflight.ts`)                       | the `ts` plugin's LS diagnostics over the overlay |
| CLI (`bin.ts`), path templating (`template.ts`)                           | the three MCP tools + explicit op args            |

### 2.3 The mutation model is a TREE, not a flat path-map — load-bearing

A moving-file-set must hold three invariants **simultaneously**: (a) stable identity across
a location change, (b) two coordinate systems live at once — where a file _was_ (to resolve
specifiers as written) and where it _is_ (to emit new ones), and (c) hierarchical cascades.
A tree of file nodes is the natural home: the **node is the identity**, `currentPath()` is
_computed_ by walking parent links, `initialPath()` is a _frozen_ snapshot, content is keyed
by **node identity, not path**. A flat path-keyed map keys identity on the mutable location,
so every move forces bidirectional-map resync and defects cluster at the sync seams. The
tree forecloses these classes structurally — port the algorithm near-verbatim, these guards
are killed bugs made structural:

1. **Cascading ancestor moves** — re-parent one node; descendants' `currentPath()` follows
   for free (`vfs.ts:107-127`). Commit ordering: `engine.ts:393-433` (`explainedBy` /
   `actualOnDiskPath`).
2. **Resolve-old / emit-new** — `findByInitialPath(written) → node`, then
   `node.currentPath()`; relative specifiers resolve against the importer's _initial_ dir,
   emit against _current_ (`imports.ts:40-53`).
3. **Content survives moves** — edits live on the node (`vfs.ts:45,182-194`).
4. **New file vs moved file** — synthetic node has `initialPath()` == current path, no disk
   presence → commit writes fresh, not `git mv` (`vfs.ts:262-304`, `engine.ts:380-386`);
   the byInitialPath-collision surfacing (`vfs.ts:268-303`) prevents importers resolving to
   a wrong target.
5. **Sibling neighbourhood** — `.module.scss` carry is a structural neighbour lookup
   (`engine.ts:291-293`).
6. **Collision-check-first** — never mutate on a failure path (`vfs.ts:67-72,139-148,169-175`).
7. **Dual child indices** (initial + current name); removal only evicts entries that point
   at the node (`vfs.ts:83-93`).

### 2.4 The tree is transient per mutating invocation

Scratch space for one mutating op (or one `batch` of them, so move #2 sees move #1's
layout). **Not** warm plugin state: holds no parsed TS, never served as a fact, discarded
after dry-run/apply. The §8/§19 build-new-never-mutate-old rule governs _warm shared_
state; the tree is single-invocation, serialized (§8), never read concurrently — so in-place
`moveTo`/`rename`/`setContent` is correct (state this in a code comment so
architecture-reviewer doesn't flag it). No new lifecycle: dry-run discards the tree + clears
the overlay; apply writes through `support/text-edits` + `support/git`, and the next op's
read-time freshness check (§7 resync) reconciles.

### 2.5 Key the tree on `RepoRelPath` — a robustness upgrade

front-renamer compares raw path strings case-sensitively (`vfs.ts:241-254`) — a latent miss
on APFS/NTFS where `src/Foo` and `src/foo` are one file. Route every tree lookup through the
`RepoRelPath` canonicalization chokepoint (§19). The port lands _more_ robust than the
original.

### 2.6 Build the tree from the tracked listing, not `readdir`

Seed from `support/git` ls-files (the gitignore-aware listing; LS file set / walker
fallback), not `fs.readdirSync` (`vfs.ts:221-231`). ls-files returns files only →
**synthesize the directory chain** by splitting paths. Empty dirs never appear; they matter
only to commit-time pruning, which runs on the real tree at apply.

### 2.7 The tree feeds the LS overlay (the dry-run engine)

The `ts` plugin's in-memory overlay (`plugins/ts/vfs`, Stage D) is a thin adapter over the
tree, not a second model: `getScriptFileNames()` enumerates the tree's current files,
`getScriptSnapshot(path)` returns the node's content override (or disk), `getScriptVersion`
bumps on change; a moved file drops out so stale-import diagnostics fire. **Order:**
apply-to-tree → rewrite-imports (populate content overrides) → typecheck-overlay. The
overlay is **inert when empty** — reads resolve exactly as today (guards current tests).

### 2.8 Cornerstone safety invariant

No `apply` without a clean post-typecheck from the **project's own TS** over the overlay
(§16.4). Any mis-port — a missed import rewrite, a wrong extract — surfaces as a typecheck
failure, not silent corruption. codemaster keeps front-renamer's dry-run overlay typecheck
and adds proof-spans, replacing its "diff and visual-test before merging" hedge.

### 2.9 Rollback is atomic-edits-first, not `git reset --hard`

front-renamer's `git reset --hard && git clean -fd` is fine for a one-shot CLI, destructive
in an always-on daemon. Prefer `support/text-edits` atomic apply + targeted revert; keep
`git reset --hard` only as an armed-when-clean last resort (§7/§8).

### 2.10 Shared mutating-op result shape

Every mutating op returns one envelope (`Result<T>`, `core/result.ts`), `data`:

```ts
{ mode: 'dry-run' | 'applied',
  diff: string,                    // unified diff (the `diff` dep), the proof of the edit
  touched: RepoRelPath[],          // files written / to be written
  typecheck: { clean: boolean, diagnostics?: {file,line,message}[] },  // §2.8, project TS
  rollback?: { performed: boolean, reason?: string } }                 // apply path only
```

Dry-run (`apply:false`, default) writes nothing (§16.4); apply runs dirty-gate → write
(text-edits) → prettier → post-apply typecheck → rollback-on-failure. A failed internal
tool → `ToolFailure` (`§3.6`), never a throw across the boundary.

## 3. Rejected alternatives

- **`front-renamer` as an npm dependency** — no LS-injection seam → second LS → double §9
  memory + un-proof-carryable edits (§2.1); whole-batch CLI granularity vs per-op dry-run.
- **Wholesale file copy** — re-imports the duplicated plumbing and 300–1143-line files that
  violate the ≤300-line / one-op-per-file hygiene on day one.
- **Dry-run in a git worktree** — different root → cold LS per dry-run (the per-call cost the
  daemon exists to amortise, §2/§9) or a second LS; a fresh worktree has no `node_modules`
  so it cannot typecheck without a symlink hack or `npm install` per run; and it does not
  simplify the transforms (same edit-set regardless of substrate). The in-memory overlay is
  the LS's native substrate.

## 4. Open decision — patched-TS for extract (resolve at Stage G)

`@cevek/typescript-extract-refactor-fix` is reconcilable with §5-L2 ("run the project's own
TS"): the fork is an **edit producer, not a fact oracle** — it computes candidate
"Move to a new file" edits, which the project's own TS then verifies via post-typecheck
(§2.8). Plan: try the project TS first → patched only on the `Expected symbol to be a module`
assertion → if the fork can't load or mismatches the project's TS major, fail honestly with
the `ts-ls-failures` category. Best-effort rescue, surfaced as provenance (§3.3/§3.6),
gating only `extract_symbol`. The cost to weigh is **version coupling** (the fork tracks
specific TS majors; codemaster resolves the project's TS of any version).

Secondary: porting front-renamer's project-own-TS loader (`ts-loader.ts`) advances §19
(the `ts` plugin is on `bundled-ts` today). Optional within this spec; do it when Stage F/G
makes the divergence bite.

## 5. Implementation stages

Each stage is one PR-sized box. **Definition of done per box** (§17 + CONTRIBUTING):
`npm run fix-and-check` green (eslint → prettier → tsc → knip) · an **oracle-backed** test
(a fixture is only input — §16) · ≤300 lines real code per file · no upward import · new
boundary zod-validated · every external-tool call wrapped → `ToolFailure` (no throw across
the boundary) · docs at present state · the wired dep removed from `knip.jsonc`
`ignoreDependencies`. knip's `entry` is `test/**/*.test.ts`, so a leaf module is "used" once
a test imports it — Stages A–C may land standalone, each with its own test.

Order is **easiest → highest blast radius**; each step adds exactly one new hard thing on a
proven base. A–C are independently-testable leaves (the "core"); D establishes the shared
mutating-op contract via the thinnest op; E/F/G build on it; H is an orthogonal family.

---

### Stage A — `support/text-edits/`

- **Goal.** Span-based edits, atomic application, conflict detection — the substrate every
  mutating op writes through.
- **Build.** `apply.ts` (merge a set of `{start,end,text}` edits into a string — sort
  descending, reject overlaps); `conflict.ts` (overlapping/adjacent edits → explicit error,
  never silent clobber); `quote.ts` (emit a quoted specifier preserving the source quote
  style); `write.ts` (atomic disk write for the apply path — temp + rename, wrapped).
- **Port from.** `text-edits.ts` (83 — `applyEdits`, `emitQuoted`).
- **Reuse.** `core/span.ts`; `common/span/` (Loc↔offset bridge); `support/fs`.
- **Oracle.** Known edit-set → expected output (hand-computed); overlapping edits → throws;
  quote-style preserved both styles; atomic write leaves no partial file on simulated
  failure. `test/unit/`.
- **Exit.** Pure merge + conflict path + atomic write tested; green.

### Stage B — `support/prettier/`

- **Goal.** Format a file with the project's **own** prettier; honest skip when
  unavailable / unsupported extension; never kill a batch on one bad config.
- **Build.** `resolve.ts` (resolve prettier + config from the project root, bundled
  fallback, report which is active — §5-L1); `format.ts` (`format(absPath, content) →
string | null`; `null` = skipped). Per-file try/catch (the `engine.ts:199-229` pattern).
- **Port from.** `prettier-loader.ts` (80) + `formatTouchedFiles` (`engine.ts:199-229`).
- **Reuse.** `support/config-load` resolution patterns; §3.6 wrap.
- **Oracle.** Unformatted snippet + fixture `.prettierrc` → expected; no prettier → `null` +
  reported; broken config → recorded failure, not throw. `test/unit/`.
- **Exit.** Format / skip / failure-isolation paths tested; green.

### Stage C — `plugins/ts/refactor/tree/` (the VFSTree port)

- **Goal.** The transient move/layout/content model — the load-bearing tree (§2.3–2.6).
- **Build (split for ≤300).** `node.ts` (FsNode: identity, initial/current name,
  parent/initialParent, `rename`/`moveTo` with collision-first + cycle guards, content,
  `currentPath`/`initialPath`, dual child indices); `tree.ts` (VFSTree: byInitialPath index,
  `findByInitialPath`/`findByCurrentPath`, `addFileAtCurrent` + collision surfacing,
  `ensureDirAtCurrent`, iterators); `build.ts` (seed from ls-files — synthesize the dir
  chain); `commit-plan.ts` (the `explainedBy`/`actualOnDiskPath` ancestor computation →
  ordered move list; pure — the actual `git mv` lives in the op via `support/git`).
- **Port from.** `vfs.ts` (364 — near-verbatim) + commit ordering `engine.ts:354-493`
  (the _computation_, not its `execFileSync`/`fs` calls).
- **Adapt.** Keys on `RepoRelPath` via the §19 chokepoint (§2.5); build from ls-files
  (§2.6); reads through `support/fs` (wrapped), not `fs.readFileSync`.
- **Reuse.** `core/brands`, `support/git` (ls-files), `support/fs`.
- **Oracle.** The 7 §2.3 invariants as direct unit assertions; **plus a replay oracle** —
  apply a move/rename sequence to a real temp git repo, run `commit-plan`'s `git mv` list,
  assert the on-disk layout == the tree's `currentPath()` claims. `test/unit/` + one
  git-backed case.
- **Exit.** 7 invariants + replay oracle green; the §2.4 transient-mutation comment present;
  no upward import (tree imports only core/common/support).

### Stage D — `rename_symbol` (establishes the shared mutating-op core + overlay)

- **Goal.** The thinnest real mutating op; it builds the apply/dry-run/typecheck/rollback
  contract + the LS overlay that E/F/G reuse. **No tree needed.**
- **Build.**
  - `plugins/ts/vfs` — in-memory overlay on `ls-host`: set/clear content+version per path;
    `getScriptSnapshot`/`getScriptFileNames` consult overlay-then-disk; **inert when empty**
    (§2.7).
  - `ts` plugin API: `renameSites(target, newName)` (LS `findRenameLocations` → spans+text,
    conflicts surfaced); `diagnostics(overlayPaths)` (LS `getSemanticDiagnostics` for the
    §2.8 typecheck). Both wrapped → `ToolFailure`.
  - Mutating-op contract: extend `OpContext` to expose `apply: boolean` + reach to
    `support/git` / `support/text-edits` / `support/prettier`; a shared
    `ops/refactor-apply.ts` helper turning an edit-set into the §2.10 envelope (dry-run
    preview / apply with dirty-gate → write → prettier → post-typecheck → rollback).
  - `ops/rename-symbol.ts` — `defineOp({ name:'rename_symbol', mutating:true,
requires:['ts'], argsSchema, run })`; register in `builtins.ts`.
- **Port from.** `rename.ts` (194 — `RenameEngine.rename`), `ts-decl.ts` (55 —
  `findTopLevelDeclaration`). Reframe tree-node-content writes → overlay + text-edits.
- **Reuse.** `ls-host`; `support/git` (dirty gate, snapshot, rollback); Stages A, B;
  `format/`; the `diff` dep (remove from knip ignore here).
- **Oracle (§16.4 edit-safety, git-backed).** Dry-run leaves `git status` clean;
  `diff(dry) == diff(apply)`; post-apply `tsc --noEmit` clean; rollback byte-exact. **Plus
  semantic:** after apply, a cold-LS `findReferences` on the new name resolves the same set
  the old name did. **Plus:** existing read-op tests stay green (overlay inert).
- **Exit.** Edit-safety + semantic + overlay-inert proven; op in `status`; green.

### Stage E — `change_signature`

- **Goal.** Same core as D, harder transform (call-site argument rewriting). Independent of
  move/extract — schedule flexibly; if uncertainty is high, ship after F.
- **Build.** `ts` plugin `changeSignature` (resolve symbol → call sites → transform
  add/remove/reorder/rename param at the declaration **and** every call site);
  `ops/change-signature.ts` (mutating, reuses D's apply helper).
- **Port from.** No direct front-renamer prior art (its rename is the closest pattern) —
  the one op that is mostly net-new on the LS. Flag higher-uncertainty.
- **Oracle.** Edit-safety; post-apply `tsc` clean is the strong gate (a wrong arg rewrite
  fails to compile); golden on the call-site transforms paired with the oracle.
- **Exit.** Edit-safety + tsc-clean oracle; green.

### Stage F — `move_file` (wires the tree + import rewrite — the prize)

- **Goal.** Move files/folders + rewrite every importer; highest blast radius.
- **Build.**
  - `plugins/ts/refactor/imports/` — resolve a specifier (relative/alias) to a tree node;
    emit the new specifier from importer-current-dir to target-current-path, preserving
    alias-vs-relative + the extension policy. **Reconcile with `plugins/ts/importers.ts` —
    reuse its tsconfig-paths resolution, do NOT stand up a second resolver** (copy-paste
    risk; front-renamer's `module-resolve.ts:1-9` carries the scar of three divergent ones).
  - `plugins/ts/refactor/plan/` — `buildPlan`: dependency levels (folder-before-file) +
    sibling-carry (`.module.scss`/`.css`).
  - `ops/move-file.ts` — mutating. Dry-run: build tree (C) → apply moves → rewrite imports
    across importers (overlay content overrides) → typecheck (§2.7 order). Apply: commit-plan
    → `support/git` `git mv` (history) + text-edits writes + new-file writes → prettier →
    post-apply tsc → rollback.
- **Port from.** `imports.ts` (159), `module-resolve.ts` (77), `plan.ts` (202); engine
  orchestration `engine.ts:276-339` (move + `rewriteAllImports`).
- **Reuse.** Tree (C); `importers.ts` resolver; overlay; `support/git`/text-edits/prettier;
  `format/`; `diff`.
- **Oracle (git-backed).** Edit-safety; **semantic** — after move+apply, cold-LS find-usages
  of a symbol in the moved file resolves the same set (imports correctly rewritten, nothing
  dangling); `tsc --noEmit` clean; **history** — `git log --follow` finds the pre-move
  history. Fixtures: aliased + relative + folder-move + sibling-scss, each.
- **Exit.** Edit-safety + semantic + history oracles; single resolver (copy-paste-reviewer
  clean); green.

### Stage G — `extract_symbol` (+ CSS co-extract) — the meat, last

- **Goal.** Extract a top-level symbol to a new file via the LS refactor, with honest
  failure + safe CSS co-move. Resolve §4 here.
- **Build.**
  - `plugins/ts/refactor/extract/` — drive the LS "Move to a new file" / "Move to file"
    (`getEditsForRefactor`); place output at the target (tree new-file node);
    post-process; rewrite consumer imports the LS couldn't reach. **Patched-LS rescue (§4):**
    project TS first → on the assertion, retry via `@cevek/...` as an isolated edit-producer
    LS → `rescued: true` provenance; on failure, `partial`/`ToolFailure` with the
    `ts-ls-failures` category. Auto-coerce `.ts`→`.tsx` when the body has JSX.
  - `plugins/ts/refactor/css-coextract/` — the **safe-move** half: given the analysis (which
    classes the block uses — from the `scss` plugin + `ts.cssModuleUsages`), move
    provably-safe rules to a new sibling stylesheet; leave ambiguous ones
    (compound/`@include`/`@extend`/interpolation) behind with rewritten refs; per-class
    report codes (USED/NO-RULE/COMPOUND/NESTED/AT-RULE/SASS-VAR/EXTEND/…).
  - `ops/extract-symbol.ts` — mutating; reuses D's apply helper + F's consumer-import rewrite.
- **Port from.** `extract.ts` (875), `extract-postprocess.ts` (302), `extract-css.ts` (707 —
  safe-move half only; analysis already lives in codemaster). Taxonomy:
  `../front-renamer/docs/ts-ls-failures.md`.
- **Reuse.** Tree (C); imports (F); `scss` plugin + `ts.cssModuleUsages` (analysis);
  overlay; `support/*`; `format/`.
- **Oracle (git-backed).** Edit-safety; **semantic** — post-apply `tsc` clean; the extracted
  symbol's references all resolve (cold-LS); **each `ts-ls-failures` category reproduced in a
  fixture and asserted to FAIL HONESTLY** (partial + category — never crash or half-write);
  CSS — moved classes provably safe, ambiguous ones stay + refs rewritten, report codes
  correct vs an independent class-usage scan.
- **Exit.** All four oracle families green; §4 decision recorded in this spec; `@cevek/...`
  wired & removed from knip ignore; green.

### Stage H (orthogonal) — `codemod` (ast-grep, shape-based)

- **Goal.** Shape-based transform; explicitly **not** symbol-anchored (§7) — never claims to
  target a symbol, so it can't rewrite a same-named unrelated binding.
- **Build.** `ops/codemod.ts` — `@ast-grep/napi` matcher (declarative pattern + rewrite)
  over `support/text-edits`; dry-run/apply via D's contract.
- **Port from.** None (front-renamer deliberately omits codemods). Net-new.
- **Oracle.** Edit-safety; golden on a known pattern+rewrite paired with an oracle; an
  explicit "matches shape, not symbol" test (a same-named binding NOT matching the shape is
  left untouched).
- **Exit.** `@ast-grep/napi` wired & removed from knip ignore; green. Independent of
  tree/LS-refactor — may land any time after A.

## 6. Module layout

```
plugins/ts/refactor/
  tree/        node.ts · tree.ts · build.ts · commit-plan.ts        (Stage C)
  imports/     resolve.ts · emit.ts                                  (Stage F)
  plan/        levels.ts                                             (Stage F)
  rename/      rename-sites.ts                                       (Stage D)
  extract/     move-to-file.ts · postprocess.ts · rescue.ts · taxonomy.ts  (Stage G)
  css-coextract/ safe-move.ts · report.ts                            (Stage G)
plugins/ts/vfs/          overlay on ls-host                          (Stage D)
support/text-edits/      apply.ts · conflict.ts · quote.ts · write.ts (Stage A)
support/prettier/        resolve.ts · format.ts                       (Stage B)
ops/                     rename-symbol.ts · change-signature.ts · move-file.ts
                         · extract-symbol.ts · codemod.ts · refactor-apply.ts (shared)
```

## 7. Review protocol & per-stage acceptance

Each stage's **Exit** criteria are the review checklist — review against this spec, not
vibes. Gate stage N+1 on stage N's review being clean (the next stage builds on it). The
oracle tests are the objective correctness gate (§16: the harness _is_ the review for
correctness — golden-only is never sufficient for a correctness claim).

Per-stage, run the shipped reviewer subagents (`.claude/agents/`):

- **architecture-reviewer** — layering (refactor/ imports only core/common/support + the
  `ts` plugin's own API; ops compose, never reach into plugin internals), the §2.4
  transient-tree exemption, no upward import, ≤300 lines.
- **bug-reviewer** — the correctness-critical paths: the §2.10 dry-run/apply/rollback
  contract (a destructive rollback bug is the worst case), the §2.3 tree invariants, the
  overlay inert-when-empty guarantee, proof-span validity, honest failure (never a guessed
  result for a failed tool).
- **copy-paste-reviewer** — Stage F especially: the move resolver must reuse `importers.ts`,
  not duplicate it; no re-implementation of `ls-host`, `support/git`, or `format/`.
- **doc-sync-reviewer** — after each stage, ARCHITECTURE.md / src/README / plan.md / this
  spec / `status` output stay in sync; tick the matching plan.md Phase 2 box.

For the high-blast-radius stages (**F move**, **G extract**) escalate to a heavier pass
(`/code-review` at high effort, or a review workflow) — these touch every importer / write
new files and the failure modes are subtle. Mutating ops get extra scrutiny on the
dirty-gate + rollback path before merge.
