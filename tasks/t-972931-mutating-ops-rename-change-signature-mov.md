---
id: t-972931
title: Mutating ops (rename/change_signature/move/extract) are not size-gated — they warm and fan the same way on a pinned in-process oversized repo
status: backlog
priority: high
tags:
  - platform
type: bug
complexity: M
area: platform
created: '2026-07-27T23:12:10.539Z'
---
`semanticFanoutRefusal` covers the READ fan-out ops. The MUTATING ops — `rename_symbol`, `change_signature`, `move_symbol`, `extract_symbol` — warm the LS and fan their edit sites across every containing program (ARCHITECTURE §5-L2 "writes fan out too"), plus the §2.8 typecheck gate over every affected program. Same memory profile, no guard.

Since t-754922 an oversized repo normally lives in a killable child, so the exposure is narrowed to a PINNED in-process workspace (`daemon.autoEscalate: false`, an explicit `isolation: 'in-process'`, a failed fork, or a size estimate that could not be taken) — there a mutating op can still OOM the singleton daemon uncatchably.

Fix direction: run the same pre-warm refusal at the top of the mutating ops. Their refusal wording differs — a mutation has no cheap substitute, so the remedy is the isolation change, not a lighter op.

## The refusal a `transaction` step would emit names the wrong op

`OpContext.opName` is stamped once per dispatched op (`daemon/engine.ts` `runOne`, the tree's only
`op.run` call site). A `transaction` sub-step does not go through it — steps run through plugin plan
methods under the TRANSACTION's context (`ops/refactor-steps.ts` takes and forwards `ctx: OpContext`).

So the moment a guard is added here, a refusal fired inside a step reads `ctx.opName === 'transaction'`:
the head says "transaction declines…", and `BY_OP.get('transaction')` misses, degrading the redirect to
the subject-less orientation arm. The message would name a call the caller never made and drop the one
it did.

Whichever way it is resolved — re-stamp `opName` per step, or have the step-level refusal address the
step's own op — decide it as part of adding the guard, not after: the wrong-name refusal is silent
(it compiles, it renders, it is merely about the wrong call).
