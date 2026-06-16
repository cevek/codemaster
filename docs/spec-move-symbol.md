# Task C — `move_symbol`: move one symbol to an EXISTING file

> Self-contained task. Build on `main`. First: read `CLAUDE.md`, `ARCHITECTURE.md` §7 (edit model)
>
> - §2.8 (gate), call `status`, and READ `extract_symbol` (`src/ops/extract-symbol.ts` +
>   `src/plugins/ts/refactor/extract/move-to-file.ts`) and `move_file` — this op reuses their machinery.

## Why

`extract_symbol` moves a top-level symbol only to a NEW file. "Move this symbol into an EXISTING
file B and rewrite importers" is a common refactor with no op today.

## Scope — IN

- New mutating op **`move_symbol { symbol?|name?|file+line+col, dest: RepoRelPath (an existing file),
dirtyOk? }`**: relocate one top-level symbol from its current file into the existing `dest`,
  rewrite every importer (and the source's own back-reference), dry-run→apply under the standard
  §2.8 contract (pre/post typecheck diffed vs baseline, byte-exact rollback, dirty-gate, git-aware).
- Reuse the extract/move planning + import-rewrite; the delta vs extract is "append into an existing
  file" instead of "create a new file" (handle the dest's existing imports/exports, name collisions
  in dest → refuse with a duplicate-identifier diagnostic, never clobber).
- Honest refusals with the `ts-ls` category (nested target → refuse, like extract §4a; dest not in
  project → fail). Never a half-written file.

## Scope — OUT

- New-file extraction (that's `extract_symbol`). · capture-safety internals (Task A — but DO consume
  the shared capture check if it has landed; otherwise note the dependency). · css co-extract.

## Definition of done

- `fix-and-check` GREEN; full suite 0 fail.
- Oracle-backed edit-safety tests (§16.4, like `extract-symbol.test.ts`): move a symbol A→existing B,
  cold `ts.Program` compiles clean, importers rewritten, `diff(dry)==diff(apply)`, byte-exact rollback
  on an introduced error, dest name-collision REFUSED (nothing written), nested target REFUSED.
- Ethos: wrapped/bounded/honest; layering (ops→plugins); files ≤300 (extract helpers). Self-describe
  in `status`. Dogfood: validate live through the MCP against a real repo.

## Files

`src/ops/move-symbol.ts` (new) · `src/plugins/ts/refactor/...` (extend the extract/move planning —
**OVERLAP** with Task A's capture work in `refactor/`) · `src/ops/builtins.ts` (register — OVERLAP) ·
status catalogue · tests.

## Parallel / dependency note

Smoothest AFTER Task A lands (both touch `refactor/` planning, and you should consume A's capture
check). If run in parallel with A, expect a merge in `refactor/imports`/`extract`. Shares
`builtins.ts` + status golden with B/D/F (mechanical). Own branch/worktree.
