---
id: t-072590
title: Wire the cooperative wall-clock deadline into the mutating ops (rename/move/extract/change_signature/transaction) — a huge refactoring should degrade to an honest ToolFailure{timeout} before the atomic write, not hang until the watchdog
status: backlog
priority: medium
parent: t-031282
tags:
  - deadline
  - platform
  - ts-refactor
type: feat
complexity: M
area: platform
created: '2026-07-17T02:25:33.270Z'
---
Found while explaining the deadline coverage. Verified via codemaster: `OpContext.deadline` (registry.ts:55) is READ by exactly 4 READ ops — find-usages, search-symbol, find-unused-exports, impact. The MUTATING ops (rename_symbol / move_file / extract_symbol / change_signature / transaction / codemod) do NOT consume the deadline.

## The gap
A refactoring's expensive phase is the COMPUTE (find every reference across the graph + typecheck every affected program) — all BEFORE any file is written (§7: compute-in-memory → typecheck gate → atomic write last). So a genuinely-huge refactoring under the DEFAULT `in-process` isolation has:
- NO cooperative deadline (unlike reads) — the compute isn't bounded by the 120s budget.
- NO process hard-kill (that only exists in `isolation:'process'`).
- Only the 5-minute worker-thread watchdog (t-095661) as last resort → a 5-minute hang in the shared process before it's reaped.

The never-CORRUPT guarantee holds regardless (writes are atomic + last, so a timeout/kill during compute touches no files). This is purely the never-HANG gap: reads degrade to an honest `ToolFailure{timeout}` in 120s; a huge refactoring hangs up to 5 min under the default.

## Fix
Thread `ctx.deadline` into the mutating ops' compute phase (the reference-search + typecheck-gate), so they degrade to an honest `ToolFailure{tool:'timeout'}` BEFORE the write, same as the read ops. The reference-search inside them is already partially cancellable via the HostCancellationToken (t-000059) — this is wiring the op-level budget + honest-refusal on top, and confirming the abort lands before the atomic write (no partial edit). Deterministic test via injected Clock (tiny budget → refactoring returns ToolFailure{timeout}, git tree clean, no files written).
