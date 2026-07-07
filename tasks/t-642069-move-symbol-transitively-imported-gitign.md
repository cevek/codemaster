---
id: t-642069
title: 'move_symbol: transitively-imported gitignored file (git-tree ↔ program desync) refusal path is now untested'
status: backlog
priority: low
depends_on:
  - t-019044
tags:
  - dogfood-jul
type: bug
complexity: S
area: ts-refactor
created: '2026-07-07T22:24:34.717Z'
---
Residual from t-019044. The wave-2 file-set fix aligned the TS program with git's listing (tracked + untracked-not-ignored), which eliminated the git-tree↔program desync for a ROOT-globbed gitignored importer (that case now cleanly succeeds — the old e2e test was rewritten to assert the new correct behavior). BUT a gitignored file pulled into the program TRANSITIVELY (imported by a tracked file) can STILL desync move_symbol's git-tree vs program — the refusal/actionable-error machinery still applies to that case but is now UNTESTED (the old test only covered the root-globbed case).

Add a regression test: a tracked file imports a gitignored file that imports the moved symbol → move_symbol must still refuse honestly (name the file), not half-move. fix-locus: test/e2e/move-symbol.test.ts + the move_symbol desync-refusal path.
