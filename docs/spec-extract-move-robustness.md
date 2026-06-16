# Task J — extract/move robustness: rescue the LS asserts, resolve aliased css, complete import-capture

> Self-contained, FAT task. Build on `main`. First: read `CLAUDE.md`, `ARCHITECTURE.md` §4 (the §4
> patched-LS rescue) + §7, call `status`, READ `src/plugins/ts/refactor/extract/move-to-file.ts` +
> `taxonomy.ts` (the rescue/assertion recognizers), `src/plugins/ts/refactor/extract/css-usage.ts`
>
> - `src/ops/extract-css-coextract.ts`, and `src/plugins/ts/refactor/capture/imports.ts`.

## Why

Three honesty/robustness holes in `extract_symbol`/`move_file`, all surfaced live:

1. **Mutually-recursive symbols leak a raw LS assertion** (feedback bug 10:12). `extract_symbol`
   on two mutually-recursive top-level functions FAILs with the raw stock-LS internal string
   `Debug Failure. False expression: Changes overlap … {"pos":0,"end":244} …`. Two problems: (a) the
   §4 rescue doesn't cover this "Changes overlap" assertion shape (it leaked straight through, no
   rescue note); (b) the raw internal debug string is shown to the agent — should be a clean
   `cannot extract: edits overlap (mutual recursion) — extract manually`. (No half-write — good.)
2. **css `copy-safe` doesn't resolve `@/` aliased sheet importers** (feedback wish 10:00). Extracting
   a component co-moves a shared sheet's classes, emptying the old sheet — but a SIBLING file
   importing that sheet via `@/…` still reads from the now-empty sheet → a silent runtime style
   break (scss is type-blind, typecheck clean). `importers_of` ALREADY resolves `@/` via tsconfig
   paths; wire the same resolution into co-extract safety so an aliased importer either blocks the
   move or is rewritten — not just warned about.
3. **import-capture completeness** (plan.md capture residuals): the move/extract import-capture check
   is forward-only (a pre-existing non-rewritten import the move now SHADOWS isn't checked), and
   `postMoveResolutionHost` tombstones moved-away FILES but not now-EMPTY dirs (a stale relative
   resolution can land and mask a capture). Close both — reverse import-capture + emptied-dir
   tombstoning — so the capture guarantee (Task A) is complete for moves.

## Scope — IN

1. Extend `taxonomy.ts` to recognize the `Changes overlap` assertion → route through the §4 rescue;
   if the rescue also can't, FAIL with a SANITIZED message (no raw `Debug Failure`/`pos/end` string)
   - the honest "extract manually" guidance. Never a half-write (preserve).
2. Resolve `@/`-aliased (tsconfig-paths) importers of a co-extracted sheet in `extract-css-coextract`
   — reuse the `importers_of` resolution. An aliased importer of a class being moved → either keep
   the class (don't move what an aliased file still uses) or rewrite that importer; report it under
   `cssCoExtract` like the relative case. Drop the "aliased not resolved" warning once handled.
3. Reverse import-capture + emptied-dir tombstoning in `capture/imports.ts`.
4. **Rider (trivial, do it here):** CLI `op` should forward `--apply` / `--summaryOnly` flags
   (feedback friction 11:35 — `bin.ts op` only forwards `{name,args}`, so mutating ops can't be
   dogfooded via CLI). A few lines in `src/bin.ts`.

## Scope — OUT

- New extract capabilities beyond robustness. · codemod capture residuals (introduced-identifier /
  out-of-span — documented won't-fix/minor).

## Definition of done

- `fix-and-check` green; full suite 0 fail. Oracle-backed (the extract/co-extract e2e suites are the
  template): mutual-recursion extract → clean sanitized FAIL (no raw debug string), nothing written;
  co-extract with an `@/`-aliased importer → no silent style break (the aliased use is handled +
  reported), cold compile + a class-reachability check confirm; reverse import-capture repro
  REFUSES; emptied-dir case no longer masks a capture; CLI `--apply`/`--summaryOnly` reach the op.
- Honesty: sanitized failures (never a raw LS internal string), wrapped, no half-write. Layering;
  files ≤300. Dogfood live.

## Files (likely)

`src/plugins/ts/refactor/extract/{move-to-file,taxonomy,css-usage}.ts` · `src/ops/extract-css-coextract.ts`
· `src/plugins/ts/refactor/capture/imports.ts` · `src/bin.ts` (CLI flags) · tests.

## Parallel-run note

Touches the refactor/extract + capture/imports area — overlaps Wave-2 Task C (`move_symbol`) and the
capture core. Sequence after C, or expect a refactor/ merge. Own worktree off `main`. Covers:
feedback bugs 10:12 + wish 10:00 + friction 11:35; plan.md import-capture residuals.
