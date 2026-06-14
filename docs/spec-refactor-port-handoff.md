# Phase 2 refactor port — implementation handoff (for the spec author's final review)

> A decision-log + deviation map for [`spec-refactor-port.md`](spec-refactor-port.md), written
> for whoever wrote that spec. NOT a present-state doc (it narrates the _path_); it exists to be
> read once at final review and then can be archived. Present state lives in ARCHITECTURE.md /
> src/README.md / plan.md / the `status` op. Branch: `renamer`. Base: `c5721e3`.

## 0. TL;DR

All 8 stages (A–H) shipped: `rename_symbol`, `move_file`, `extract_symbol`, `change_signature`,
`codemod`, on the tree + overlay + dry-run/apply/typecheck/rollback core. **149 tests,
`fix-and-check` green.** Reviewed in **9 passes** (4 per-stage code reviews, a 6-reviewer
whole-PR sweep, 1 external review) — every real finding fixed with a regression test, including
**2 data-loss bugs** and **~10 gate-blind** (type-checker-invisible) correctness bugs.

The spec was followed in **structure and contract**; the deviations are all either (a) the spec's
own open decisions resolved conservatively, or (b) scope narrowed _honestly_ (named "deferred"
everywhere), or (c) reuse pushed _further_ than the spec asked. No silent scope drift.

The single thing to internalize: **the §2.8 cold-tsc typecheck gate is type-blind** — it cannot
catch a same-typed mis-bind (reordered args of the same type, a renamed shorthand key, a wrong
alias that still resolves). Most of the review effort went into the cases the gate misses; the
defense for those is _conservative refusal_ (refuse rather than risk a silent wrong edit), not the
gate. Confirm you're comfortable with where we drew the refuse/allow line (§5 below).

---

## 1. Did it follow the spec? Stage-by-stage

| Spec stage                    | Built                                                                                 | Matches spec?                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A `support/text-edits/`       | apply · conflict · quote · write                                                      | Yes. `conflict` is split out of front-renamer's inline overlap check; `write` (atomic temp+rename) is net-new (no FR equivalent). The spec said "overlapping/**adjacent** → error"; we allow adjacency + coincident zero-length insert/delete pairs (the LS shape) and reject only true overlap — pinned by oracle, not the literal spec wording. |
| B `support/prettier/`         | resolve · format                                                                      | Yes. Honest skip / broken-config→ToolFailure as specced.                                                                                                                                                                                                                                                                                          |
| C `plugins/ts/refactor/tree/` | node · tree · build · commit-plan                                                     | Yes, near-verbatim port. Keyed on `RepoRelPath` (§2.5), seeded from `git ls-files` (§2.6). The 7 §2.3 invariants ported with their killed-bug guards intact.                                                                                                                                                                                      |
| D `rename_symbol` + core      | overlay (`vfs/`), `renameSites`/`typecheckOverlay`/`diagnostics`, `refactor-apply.ts` | Yes. The §2.10 envelope, §2.8 gate, §2.7 overlay.                                                                                                                                                                                                                                                                                                 |
| E `change_signature`          | remove/reorder params                                                                 | **Narrowed** — see §3.4.                                                                                                                                                                                                                                                                                                                          |
| F `move_file`                 | tree + import rewrite + git mv                                                        | Yes, the prize. Reuses `ts.resolveModuleName` per §2.2 (no second resolver).                                                                                                                                                                                                                                                                      |
| G `extract_symbol`            | LS "Move to a new file" + re-target                                                   | **TS-only** — CSS co-extract + §4 deferred. See §3.2/3.3.                                                                                                                                                                                                                                                                                         |
| H `codemod`                   | ast-grep shape-based                                                                  | Yes. Independent, lands after A as specced.                                                                                                                                                                                                                                                                                                       |

`plan.md` Phase 2 is the present-state tracker; the spec now carries an "Implementation status"
note marking the deferrals.

---

## 2. The big structural win the spec under-specified (worth your attention)

Spec §6 listed `ops/refactor-apply.ts (shared)`. We discovered extract's output is **the same
plan shape as move** (a `RefactorPlan` with `moves: []`), so:

- **`plugins/ts/refactor/plan.ts`** — the shared `RefactorPlan` (plain serializable data: moves,
  newFiles, contentWrites, removed, overlayFiles, checkPaths, diff, rebind). Tree/`FsNode` handles
  never cross to the op layer.
- **`imports/assemble.ts`** (plugin side) — `assemblePlan(host, tree, options)`: import rewrite +
  read the tree → a `RefactorPlan`. Used by **both** `planMove` and `planExtract` (and trivially by
  change_sig, which only sets content overrides).
- **`ops/refactor-plan-apply.ts`** (ops side) — `applyRefactorPlan`: the §2.10 dry-run/apply/
  typecheck/rollback driver. Used by **move + extract + change_sig**.

So there are **two orchestrators**: `applyMutation` (content-only; rename + codemod) and
`applyRefactorPlan` (plan-based; the other three). The external reviewer flagged this duplication
(their B1) and is right that it's a consolidation target — but the _semantic_ divergence that
mattered (rollback-to-HEAD vs rollback-to-pre-op) is **fixed** (§5, A-data-loss), so it's now a
code-quality follow-up, not a correctness risk.

---

## 3. On-the-fly decisions & deviations (the part you care about)

### 3.1 Stage order: A B C D **F** G H **E** (E last, not 5th)

Used the spec's own §5 note ("E … if uncertainty is high, ship after F"). E (change_signature) is
the only **net-new-on-the-LS** op (no front-renamer prior art) → highest uncertainty → shipped last.
F/G are direct ports. H is independent. No contract impact.

### 3.2 §4 patched-LS rescue — DEFERRED (this was the spec's explicit open decision, "resolve at Stage G")

**Decision: do NOT wire `@cevek/typescript-extract-refactor-fix` in v1.** On the
`Expected symbol to be a module` assertion, extract fails honestly with the `ts-ls-internal`
category + workaround note (the `ts-ls-failures` taxonomy). Rationale: the version-coupling risk
the spec itself flags (the fork tracks specific TS majors; codemaster resolves the project's TS of
_any_ version) outweighs a best-effort rescue. The honest-failure path is the safe baseline; the
fork can drop in later behind the same taxonomy. **The assertion is THROWN by the LS** — wrapped so
it surfaces as an honest result, never a crash (this is the load-bearing safety property here;
unit-pinned via `isExtractAssertion`, but note the actual assertion isn't reproducible in the
pinned TS version, so the _recognizer_ + _wrapping_ are tested, not a live throw).

### 3.3 CSS co-extract — DEFERRED

`css-coextract/` (the safe-move half) is not built; extract is TS-only. The _analysis_ the spec
relies on (`ts.cssModuleUsages` + the scss plugin) already exists, so the deferred part is purely
the rule-moving + per-class report-code logic (front-renamer `extract-css.ts`, 707 lines). Marked
pending in plan.md and in the op's `status` notes.

### 3.4 `change_signature` — narrowed to remove/reorder, plus a refusal layer

Spec Stage E said "add/remove/reorder/rename param." Built **remove + reorder (positional only)**.

- _rename-param_ → that's `rename_symbol`, not this (told to the agent in the op notes).
- _add-param_ → deferred (the call-site value to insert is ambiguous).
- **Added beyond spec — a CONSERVATIVE pre-check that refuses the whole op** when it can't faithfully
  rewrite a reference: a non-call value-use (`const g = greet; g(...)`), a spread arg, a reorder over a
  call that under- or over-supplies args (omitted optionals / rest param). This exists because the
  §2.8 gate is type-blind to a same-typed mis-bind. "truth > speed" — refuse rather than corrupt.
  **Please sanity-check this refuse/allow boundary** — it's the one place I added policy the spec
  didn't dictate.

### 3.5 Overlay gained a TOMBSTONE + `directoryExists` (beyond the Stage D add-only design)

Stage D's overlay (`vfs/overlay.ts`) is add-only in the spec. Move needs more: the moved file's OLD
path must **drop out of the LS** so an un-rewritten importer dangles and the dry-run typecheck
catches it (§2.7 "a moved file drops out"). So the overlay has a `removed` set threaded through
`fileExists`/`readFile`/`getScriptSnapshot`/`getScriptFileNames`, plus `directoryExists`/`hasDirectory`
so module resolution into a **not-yet-on-disk** move-target dir succeeds during dry-run. Inert when
empty (Stage D read ops unaffected — verified).

### 3.6 §2.8 gate scope widened to the whole program

The dry-run/post-apply typecheck scope (`checkPaths`) is **every TS file in the LS program**, not
just the touched/rewritten set. Reason (found in review): an importer we failed to rewrite — or a
**gitignored** importer that's in the tsconfig program but not the git tree — would otherwise never
be typechecked, and its dangling import after a move would read as clean (a completeness lie).
`collectDiagnostics` skips paths not in the program (a moved-away old path) so it never throws.

### 3.7 §2.9 rollback = pre-op bytes, atomic-edits-first (no `git reset --hard`)

Implemented per §2.9's "atomic-edits-first" intent: rename/codemod revert via
`writeFileAtomic(before)`; move/extract/change_sig revert via `revertMove` which writes the **pre-op**
content back (from `plan.diff[].before` — the on-disk bytes when the op started, **dirty edits
included**), unstages the `git mv` (`git reset HEAD --`), and removes created paths. **NOT
`git checkout HEAD`** — that was the first implementation and it was a data-loss bug (see §5).
`git reset --hard` is used nowhere.

### 3.8 Dirty-gate scoped to TOUCHED files (+ `dirtyOk`), not the whole tree

Spec §7/§2.9 said "refuse a dirty tree." Narrowed to _touched files_ dirty, because an always-on
daemon serves a usually-dirty worktree and whole-tree refusal makes the ops unusable — and §2.9
itself says whole-tree git handling is "destructive in an always-on daemon." `dirtyOk` overrides.
(With the §3.7 pre-op rollback, `dirtyOk` is now safe — it was NOT before the fix.)

### 3.9 `plan/levels.ts` (the multi-op DAG) — NOT built

Spec §6 listed `plan/levels.ts` (front-renamer's inter-op dependency DAG). A single `move_file`/
`extract_symbol` op stages ONE relocation, ordered fine by `commit-plan`'s `explainedBy`/
`actualOnDiskPath`. The multi-op DAG is only needed for a _batch_ of moves sharing one tree, which
isn't wired (§3.10). Deferred.

### 3.10 §2.4 "move #2 sees move #1's layout in a batch" — NOT realized

Each op call **rebuilds the tree from `git ls-files`**, so within an MCP `batch` move #2 sees move
#1's _committed_ result (if #1 applied), not an in-memory shared tree. This contradicts the spec's
§2.4 wording ("a batch of them, so move #2 sees move #1's layout"). Low impact — single ops are
correct; a shared transient tree per batch is a future option. Flagging because it's a stated spec
decision we didn't implement.

### 3.11 Files added beyond §6's module layout

`plugins/ts/refactor/plan.ts` (shared type, §2), `imports/{rewrite,assemble}.ts` (split from the
spec's `imports/{resolve,emit}`), `change-signature/plan.ts`, `plugins/ts/resolve-target.ts`
(extracted `resolveSymbolId`/`dedupeByDefinition` out of `plugin.ts` to hold the 300-line cap),
`plugins/ts/diagnostics.ts`, `ops/{refactor-plan-apply,refactor-commit,mutation-support}.ts`,
`support/git/mutate.ts`, `support/fs/read-file.ts`. Not built: `extract/{postprocess,rescue}.ts`
(post-process not needed — raw LS output compiles clean; rescue = §4), `css-coextract/`.

---

## 4. Reuse-vs-port ledger (did we avoid the copy-paste traps?)

- **Forward module resolution** → `ts.resolveModuleName` (the project's own resolver, same as
  `importers.ts`). The spec's main copy-paste fear (a second resolver) did **not** materialize.
- **Alias EMIT** (the inverse, which TS can't do) → derived from tsconfig `paths`/`baseUrl` in
  `emit.ts`. This is emit-only, not a forward resolver.
- **Edit splicing** → all transforms feed Stage A's `applyEdits` (rename, extract LS edits,
  change_sig, import rewrite). No hand-rolled splice survived.
- **Tree** → C is the single VFSTree; move/extract/change_sig all drive it; no second model.
- **`messageOfThrown`/`failFromThrown`, `toPosix`, `writeFileAtomic`** → reused, not re-inlined
  (copy-paste reviewer enforced this twice).

---

## 5. What review found & fixed (read this — it's where the bugs were)

9 review passes. Real findings, all fixed + regression-tested. Grouped by class:

**Data loss (2, both fixed):**

- **Rollback restored to HEAD, not pre-op** (external A1, BLOCKER): with `dirtyOk:true`, a touched
  file's uncommitted edits were overwritten to HEAD on rollback while the envelope reported a clean
  revert (§3 lie). Fixed → pre-op restore (§3.7). Regression: commit C0 → edit C1 (uncommitted) →
  op writes C2 → rollback asserts **C1** restored.
- **Gitignored file at a move/extract `dest` clobbered** (sweep): the tree (from `ls-files`) can't
  see it. Fixed with an `existsSync` backstop that refuses regardless of `dirtyOk`.

**Gate-blind correctness (the typecheck can't catch these — highest value):**

- **Shorthand-property rename corrupted the KEY** (`{ foo }`→`{ bar }` instead of `{ foo: bar }`):
  `findRenameLocations` had prefix/suffix text disabled → fixed (`providePrefixAndSuffixTextForRename:
true`).
- **Stale SymbolId prefix-match** (`foobar` at `foo`'s offset passed `startsWith`) → bound to the
  wrong symbol silently → added a word-boundary check.
- **extract/change_sig dropped the proof-carrying rebind** → a stale SymbolId could rebind to a
  re-located (possibly mis-identified) symbol with NO `Result.handle` warning. Threaded the rebind
  through `RefactorPlan` onto the envelope.
- **change_sig reorder** silently scrambled bindings on under/over-supplied calls (same-typed args)
  → conservative refusal (§3.4).
- **codemod `$` vs `$$$` sigil mismatch** emitted a literal `$X` → rejected up front.
- **tree `iterChildren`** iterated the incomplete initial-name index (could drop a node when two
  siblings share an initial name) → iterate the complete current-name index. (Reachable only via a
  multi-move-in-one-tree, i.e. §3.10, so latent today — fixed anyway.)

**Honesty / §3.6 (no crash, no false report):**

- `carrySiblings` threw past the op boundary on a `.scss`-sibling collision → caught.
- post-write `ts.reindex` (reads disk, can throw) wasn't wrapped → wrapped, incl. the rollback path.
- un-editable rename sites are surfaced as PARTIAL (not silently dropped).

**Quality:** most-specific alias wins; prettier `.default` unwrap; dangling `(§2.8)`/`(§4)` removed
from agent-facing `status` notes.

---

## 5a. Post-handoff review round (spec author) — fixed in-branch

A second adversarial sweep (three bug-reviewers, by slice) after the handoff. Each finding fixed +
regression-tested, or — for guards on paths unreachable by construction — commented with the
no-test rationale. Branch green at 161 tests. By commit:

- **codemod typechecks the WHOLE program; rename stays narrow** (BLOCKER): `applyMutation`
  (rename/codemod) checked only changed files, so a shape-based codemod renaming an exported
  decl shipped a broken importer under `clean:true`. codemod now widens to `ts.programTsFiles()`
  (the §2.8 `check` scope); rename keeps the narrow gate — its `findRenameLocations` changeset
  is complete, so widening it only regressed the hot path (refusing on unrelated pre-existing
  errors, whole-program typecheck per apply). (`0d626d1` + split `9f7495c`)
- **Aliased `.scss` rewrite — done right** (supersedes the reverted first attempt): wildcard-aware alias
  matching on resolve+emit (exact match for non-`*` keys) — fixes both the original dangle and
  the over-match the first attempt introduced. (`7b48e55`, after revert `685f54f`)
- **`.js`/`.jsx`/`.mjs`/`.cjs` importers rewritten on move** (allowJs projects). (`7524c3c`)
- **`change_signature` `this`/rest + overload refusals**: `removeParam` skipped the arg-shape
  guards (a `this`/rest param → same-typed mis-bind); an overloaded fn → TS2554. Both refuse now.
  (`286db45`, `22b3fe3`)
- **`move_file` dest-collision guard**: a gitignored / empty-dir dest is refused before commit,
  so rollback never `rmSync`-deletes a pre-existing file the op didn't create. (`c10ca25`)
- **codemod `$$X` + repo-escaping-path rejection.** (`ef19b66`)
- **`revertMove` honesty**: surfaces a git-index-reset failure instead of overclaiming a clean
  revert. (`be823ea`)
- **Plan-assembly honest-fail**: no silent `''` / empty-splice on unresolvable content. (`42e2078`)
- **emit `.d.ts`/`.mts` specifier nits + commit-plan swap-cycle guard.** (`b94a3df`)

---

## 6. Known limitations / open items for you to decide (the ones still open after §5a)

1. **§2.5 case-fold for op-arg paths**: tree keys are canonical `RepoRelPath` (from git), but the op
   args `source`/`dest` are cast without re-minting through the §19 chokepoint, so on APFS/NTFS a
   user passing `src/Foo` vs git's `src/foo` misses the lookup. Fix needs disk access at the op
   boundary. **Deferred.**
2. **alias-emit when `baseUrl` resolves to repo root** regresses `@/x` to a relative specifier (diff
   noise, never wrong).
3. **change_sig drops inter-parameter comments** (`getText().join(', ')`); prettier reformats, types
   hold. Cosmetic.
4. **B1 — consolidate the two orchestrators** (`applyMutation` / `applyRefactorPlan`): code-quality;
   semantic divergence already closed.
5. **Deferred features** (your call on follow-ups): CSS co-extract, patched-LS §4, change_sig
   add/rename-param, `plan/levels.ts` multi-op DAG, §2.4 shared-batch tree (its swap-cycle clobber
   is now guarded — `b94a3df` — so landing the batch tree itself is the only open part).

---

## 7. Test / oracle posture (how to trust this)

Every op has an **independent oracle**, never golden-only (§16):

- **cold `ts.createProgram`** over the on-disk result is the semantic oracle for every mutating op
  (a missed/wrong import rewrite or arg mis-bind surfaces as "cannot find module" / a type error).
- **edit-safety**: dry-run leaves `git status` clean (zero-write), `diff(dry)==diff(apply)`,
  post-apply cold-tsc clean.
- **discriminating fixtures** built deliberately: rename's §2.8 negative gate (colliding rename
  refused, files byte-identical); move's one-file-imported-via-alias-AND-relative-with-its-own-import;
  C's git-replay (moved dir + renamed carried child + synthetic + edited); the pre-op-not-HEAD
  rollback unit; codemod's shape-not-symbol.
- **honest-failure** pinned per op (extract taxonomy, change_sig refusals, codemod sigil).

149 tests. Determinism honored (no `sleep`; `project()` drives the real pipeline with the watcher
silenced so the read-time freshness backstop is exercised).

---

## 8. Where to look (review map)

```
plugins/ts/refactor/
  tree/{node,tree,build,commit-plan}.ts   C — the VFSTree (§2.3–2.6)
  plan.ts                                 shared RefactorPlan (§2)
  imports/{resolve,emit,rewrite,assemble,plan-move}.ts   F — resolve/rewrite/assemble
  rename/rename-sites.ts                  D
  extract/{move-to-file,taxonomy}.ts      G (postprocess/rescue NOT built)
  change-signature/plan.ts                E
plugins/ts/vfs/overlay.ts + ls-host.ts    the §2.7 overlay + tombstone wiring
plugins/ts/{diagnostics,resolve-target}.ts
ops/
  refactor-apply.ts                       applyMutation (rename/codemod, content-only)
  refactor-plan-apply.ts                  applyRefactorPlan (move/extract/change_sig)
  refactor-commit.ts                      commitMove / revertMove (pre-op rollback)
  mutation-support.ts                     shared helpers
  {rename-symbol,move-file,extract-symbol,change-signature,codemod}.ts
support/{text-edits,prettier,git/mutate,fs/read-file}.ts   A/B + git mv/unstage
```

Commits are one-per-stage + one-per-review-pass (`git log --oneline c5721e3..HEAD`), so each review
fix is isolated and reviewable on its own.
