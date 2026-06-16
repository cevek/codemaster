# Task A — Refactor capture-safety (generalize the post-edit re-resolve) + summaryOnly

> Self-contained implementation task. Build on `main`. **First:** read `CLAUDE.md`,
> `ARCHITECTURE.md` §1 (never lie/hang/crash) + §3 (trust contract) + §2.8 (mutation gate),
> call codemaster `status` (dogfood it for all structural/semantic navigation — don't grep),
> and READ the reference implementation this task generalizes:
> `src/plugins/ts/refactor/rename/rename-sites.ts` → `detectRenameCapture`.

## Why

`rename_symbol` had a silent-capture bug (now fixed on `main`, commit `530cb0b`): renaming to a
name that shadows / is shadowed by an in-scope binding makes a rewritten reference bind to a
DIFFERENT symbol — type-compatible, so the §2.8 typecheck can't see it; not a redeclaration, so the
LS doesn't flag it. A stress-test review established this is a **class, not a rename-only bug**: the
same hazard exists wherever a mutation rewrites references/imports. Turn the per-op fix into a
**general guarantee**.

The invariant: _after the edit, every reference/import the mutation rewrote must still resolve to the
SAME symbol it did before — and no pre-existing token now silently binds to the mutated symbol._

## Scope — IN

1. **Lift the capture check into a shared helper** (e.g. `src/plugins/ts/refactor/capture.ts`) reused
   by rename (refactor `rename-sites.ts` to call it), move, and extract. Keep the proven approach:
   resolve references over the POST-EDIT overlay via the LS (it handles aliases/overloads/shorthand),
   compare to the exact rewritten sites, BOTH directions. Anchor on the symbol's declaration.
2. **`move_file` + `extract_symbol`:** their rewrites are IMPORT specifiers/paths. Verify each
   rewritten import still resolves to the SAME target symbol/module post-edit. The capture flavor
   here is path-resolution: a moved/relinked import landing on a DIFFERENT same-named, type-compatible
   export the typecheck won't catch. (extract also has the §1b carve-out already documented — don't
   regress it.)
3. **`codemod`** (the hard one — shape-based, NO symbol anchor): snapshot the resolved symbol of each
   identifier in the rewritten span BEFORE the edit; after, verify none silently re-resolved to a
   different symbol. If a fully-general impl proves infeasible in budget, AT MINIMUM detect
   re-resolution of identifiers inside the rewritten nodes and document the residual gap honestly.
4. **Surface `captures: [...]` on the mutation envelope** for every mutating op — structured
   `{ file:line:col, kind: 'forward'|'reverse', detail }`. Refuse `apply` when non-empty (like the
   §2.8 gate); show it on dry-run too. This is the review's "guarantee as a feature".
5. **`summaryOnly` mutation mode** (spec-stresstest §3a asked for it; grouped here because it edits
   the same envelope builders — keeps this task collision-free with Task B). A mutation flag that
   omits the unified `diff` and returns only `mode`/`applied`/`typecheck`/`touched`/`captures` + a
   **diffstat** (per file: +added/-removed line counts). Wire: `OpFlags` (`ops/contracts.ts`), the
   MCP flag (`mcp/schema.ts` — see overlap note), the envelope builders (`refactor-apply.ts` +
   `refactor-plan-apply.ts`), and the renderer (`format/`).

## Scope — OUT (do not touch — they belong to other tasks)

- `status` output / brief mode / GUIDANCE; `find_unused_exports` (Task B).
- scale / `process`-mode (spec-daemon-singleton); `move_symbol`, transactional multi-mutation (wishlist).

## THE #1 RISK — over-refusal (read this twice)

A capture detector that fires on a LEGITIMATE refactor is a daily-use regression **worse** than the
rare silent bug. The reference fix already hit this trap (aliased `import {x as sg}` … `sg()` usages
are references to the renamed symbol but are NOT rewritten — they must NOT read as captures; reverse
candidates must be literally spelled `newName`). Your tests MUST assert that legit mutations still
succeed: a fresh name; a name confined to an unrelated non-overlapping scope; an aliased multi-file
rename; a move whose imports still resolve to the same targets; a clean codemod. If any of those
refuse, that's a failure, not a pass.

## Definition of done

- `npm run fix-and-check` GREEN (eslint→prettier→tsc→knip) and `node --test "test/**/*.test.ts"` 0 fail.
- **Oracle-backed tests** (§16 — never golden-only for a correctness claim): for each of rename
  (keep), move, extract, codemod — a capture repro that REFUSES, plus the over-refusal guards above
  that still PASS. Bake these as the durable regression corpus.
- Ethos: every external call wrapped → `ToolFailure`, nothing throws to the agent; bounded (no
  unbounded scan — the re-resolve is over the rewritten sites, not the whole repo); honest refusal
  message naming the captured site(s) and the action ("pick a different name / the move lands on a
  different export").
- Layering respected (ops→plugins, no upward); no file >300 lines (extract helpers); `captures:[]`
  and `summaryOnly` documented where the op self-describes (status notes).
- Validate at least the rename + one new case **live through the MCP** against a real repo
  (`node src/bin.ts mcp` driven over stdio, or the CLI `op`) — dogfood, don't just unit-test.

## Files you'll likely touch

`src/plugins/ts/refactor/capture.ts` (new, shared) · `rename/rename-sites.ts` (use shared) ·
`refactor/extract/move-to-file.ts` + the move planning under `refactor/imports/` · `src/ops/codemod.ts` ·
`src/ops/refactor-apply.ts` + `src/ops/refactor-plan-apply.ts` (captures + summaryOnly) ·
`src/ops/contracts.ts` (summaryOnly flag) · `src/mcp/schema.ts` (summaryOnly flag — **OVERLAP**) ·
`src/format/render-result.ts` · tests under `test/e2e/` + `test/differential/`.

## Parallel-run note

Runs in parallel with **Task B** (read-surface). The ONLY shared file is `src/mcp/schema.ts`: you add
a `summaryOnly` flag to `opRequestSchema`; Task B adds `brief`/`op` to `statusToolSchema` — different
schemas, adjacent lines, trivial merge. Keep your edit localized to `opRequestSchema`. Work on your
own branch/worktree off `main`.
