---
id: t-034354
title: '"This symbol is used here and here" is TRUE and read as the wrong fact when nothing executes the file: whether code runs at all lives in build/test config, outside the perimeter, and no op says so'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - honesty
type: feat
complexity: M
area: correctness
source: dogfood-inbox-aug
relates:
  - t-089408
  - t-891340
surface:
  - docs
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:00:45.188Z'
---
A file's membership in a RUN — which test command executes it, which glob selects it — is a property of
`vite.config.ts` / `package.json`, not of the reference graph. codemaster indexes the graph, so for such a
file it answers "the symbol exists, exported, referenced at A and B". That answer is technically correct and
is READ as a different fact: that the code is live. This is the honesty family "a true answer reads as the
wrong fact", not an exotic request to understand vite.

The asymmetry is the argument: `find_unused_exports` catches a dead EXPORT, and the class "looks like a
guard, guards nothing" is the same class — a suite no command runs is dead in exactly the way a dead export
is, and only one of the two is visible.

Three defects of one class from a single track, none reachable from any op:

1. Seventeen vitest suites that `fix-and-check` never invoked. Present in the graph, compiling, exporting,
   executed by nothing. Every symbol query reports them alive.
2. The test glob selected nested git worktrees of other branches (`.claude/worktrees/*/tests/**`): the gate
   ran 69 files instead of 33 — it executed another branch's code and counted it as its own. The boundary
   "which files enter the run" is one line of config. (Cross-check: codemaster's own §10 program file-set
   already excludes `.claude` by directory-name for the mirror-image reason — a nested worktree checkout
   phantom-doubling declarations. Same hazard, opposite side of the tool.)
3. A repo plugin's `handleHotUpdate` handled `change` but not `add`/`unlink`, so invalidation worked on an
   edit and stayed silent on a new file.

Asked-for shape (the reporter explicitly does NOT ask us to model bundlers): a narrow "does this file fall
under any executable run / which test files does the current configuration actually execute", or — as the
floor — an honest statement that the perimeter does not cover configuration, so the symbol answer is not
evidence of liveness. Today the floor is missing too: nothing in the answer marks the boundary.

## Свидетельство (field report)

2026-08-03, repo amiro-frontend, external agent, one track: «всё трое живёт в vite.config.ts / package.json —
вне графа символов»; wanted «хотя бы честный FAIL "периметр не покрывает конфиги" вместо верного-но-вводящего-
в-заблуждение "символ используется"». Framed by the reporter as distinct from the "the question was not about
symbols" frictions: here the question WAS about this repo's code, and the answer lives in config.
