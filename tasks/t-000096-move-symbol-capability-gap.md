---
id: t-000096
title: '**move_symbol capability gap'
status: backlog
priority: low
type: feat
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:35.000Z'
---
**move_symbol capability gap — an edit targeting a gitignored-but-COMPILED file is refused, not
relocated** — the move-tree is git's listing (`ls-files`: tracked + untracked-not-ignored), but the
TS program ALSO compiles GITIGNORED files (a `generated/` tree, an out dir). When the LS "Move to
file" repoints such an importer, the edit targets a file the plan/rollback machinery has no node
for → `move-symbol-importer-untracked` HONEST refusal (now NAMES the file + says git-track-or-move-
manually; nothing written — verified in `test/e2e/move-symbol.test.ts`). This is the safe floor;
the CAPABILITY fix (seed a tree node from the program text, rewrite the gitignored importer too) is
deferred — it pulls untracked/ignored files into the edit set, which the dirty-gate and git-backed
rollback don't currently cover, so it needs its own dirty/rollback story. `feat`·`low`·`cx:M`
