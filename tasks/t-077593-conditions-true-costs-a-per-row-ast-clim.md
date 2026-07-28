---
id: t-077593
title: conditions:true costs a per-row AST climb with no deadline poll — sql-mode can run it 100k times inside one synchronous map
status: backlog
priority: low
tags:
  - never-hang
type: perf
complexity: S
area: impact-usages
created: '2026-07-28T07:24:37.744Z'
---
`assembleView` (`src/plugins/ts/usages.ts`) calls `conditionChainAt` once per displayed usage, and in
sql-mode the cap is `tableRowBound` = `DEFAULT_MAX_TABLE_ROWS` (100_000). Measured ~7.7 µs/call on a
10 KB file (the climb is O(depth), but `nodeAt` re-descends from the SourceFile each time), so ~0.8 s
at 100k rows on a small file and single-digit seconds on large ones.

Bounded and opt-in, so it is not a hang — but the map has NO `deadline.expired()` poll, so in
`in-process` mode it is a synchronous block on the shared loop for that whole stretch (§1/§19: heavy
loops poll at their boundary). Two cheap options: thread the op's `Deadline` into `assembleView` and
poll every N rows (degrade to `partial`), or memoize `nodeAt` per (file, offset) across the batch.

Also related (§12 density): the measured-empty chain renders `⟨no branch⟩` on every row — ~13 chars ×
row, so a 2000-row answer spends ~26 KB against the 60 KB MCP seam cap. The explicit token is
deliberate (it must never be confusable with "not annotated"), but a §12 hoist
(`allCondition=no branch`, the way `role`/`allProgram` hoist a constant column) would keep the
measurement at a fraction of the cost.
