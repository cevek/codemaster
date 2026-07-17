---
id: t-882645
title: Bound codemod's ast-grep match phase by the op deadline (§1 never-hang)
status: backlog
priority: low
parent: t-031282
tags:
  - codemod
  - deadline
  - platform
type: feat
complexity: S
area: platform
created: '2026-07-17T10:29:30.264Z'
---
Split from t-072590. That task wired `ctx.deadline` into the LS-driven mutating ops (rename/move/extract/change_signature/transaction) and into the shared `applyMutation`/`applyRefactorPlan` gate + pre-write guard. Because `codemod` routes through `applyMutation`, its §2.8 typecheck gate AND its pre-write guard are ALREADY deadline-bounded for free (no codemod.ts change was needed).

## The residual gap
`codemod`'s OWN compute phase — the ast-grep structural MATCH over the file set (`@ast-grep/napi`, plus `detectCodemodCaptures`) — runs BEFORE `applyMutation` and is NOT bounded by the deadline. On a giant repo this is O(files) native work; different mechanism from the LS cancellation token (ast-grep does not poll the TS `HostCancellationToken`), so it needs its own analysis:
- A loop-boundary `deadline.expired()` check around the per-file ast-grep match/scan loop (if the match is driven file-by-file in codemaster's code), and/or
- bound the ast-grep invocation itself (it may be a single native call with no cooperative cancellation — then the honest fix is a pre-count size guard or leaning on process-mode kill-on-deadline).

## Done means
codemod's match phase degrades to `ToolFailure{tool:'timeout'}` before the write on an exhausted budget; deterministic test (injected Clock, tiny budget → timeout, git tree clean); the existing free gate/guard coverage untouched.
