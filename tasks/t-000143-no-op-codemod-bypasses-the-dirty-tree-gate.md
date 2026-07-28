---
id: t-000143
title: no-op `codemod` bypasses the dirty-tree gate
status: backlog
priority: low
type: dx
complexity: S
area: render
relates:
  - t-011315
surface:
  - ops
audience: both
evidence: repro
created: '2026-07-08T00:02:22.000Z'
---
**no-op `codemod` bypasses the dirty-tree gate** — a pattern that matches nothing reports a
compact zero-change verdict (`changed:0`, `typecheck:{clean:true}` without running tsc — honest,
the edit introduced nothing) but no longer hits the dirty-tree refusal a non-empty codemod would.
Harmless (writes nothing), but a behavior change vs main — confirm intended. `dx`·`low`·`cx:S`

**Related:** t-011315 rests on the same fact from the opposite direction — a `codemod` that changes nothing is not a mutation. There it argues the dry-run IS a read op; here the no-op path skips the mutation-side dirty-tree gate. One answer about `codemod`'s identity settles both.
