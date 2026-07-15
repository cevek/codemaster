---
id: t-610634
title: transaction move_symbol/extract chain is silently order-sensitive (requires leaf-first) AND mislabels plain acyclic step-order overlap as "edits overlap (e.g. mutual recursion)"
status: done
priority: high
tags:
  - dogfood
type: bug
complexity: M
area: transaction
source: dogfood-jul
created: '2026-07-15T11:30:47.690Z'
---
**Repro (current main, hermetic).** `src/chain.ts` has an ACYCLIC chain: `c()` (leaf), `b(){c()}`, `a(){b()}`. A `transaction` moving them dependent-first — `[move a, move b, move c]` into `src/dest.ts` — FAILs at step 1: `move_symbol could not be planned: cannot move: edits overlap (e.g. mutual recursion) — move manually. Nothing written.` Reordering leaf-first (`c, b, a`) succeeds.

Two defects:
1. **Silent order-sensitivity.** A transaction of moves into one dest must not depend on the caller hand-sorting steps leaf-first. Either topologically sort the steps internally before planning, or refuse with an actionable "reorder: move X before Y (dependency)".
2. **Misleading error.** The failure is pure step-order (no cycle here — `a→b→c` is acyclic), yet the message blames "mutual recursion". It should name the real cause (an earlier step's edit overlaps a later target region) and the fix (reorder / co-move), not misattribute to recursion.

Note: genuinely mutually-recursive FUNCTIONS in one source file co-move CLEANLY via one transaction today (verified) — so the "mutual recursion is a hard wall" framing in the inbox does NOT reproduce for functions; the reproducible defect is the order-sensitivity + the wrong error label.

Inbox source: 2026-07-10 (line 154 pt 2). Related: t-000118 (path swap/cycle in transaction).
