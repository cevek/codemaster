---
id: t-000074
title: The `ls-host` reindex sibling-dispose branch is uncovered by tests
status: backlog
priority: low
type: dx
complexity: S
area: multi-program
created: '2026-07-08T00:01:13.000Z'
---
**The `ls-host` reindex sibling-dispose branch is uncovered by tests** — `reindex`'s tsconfig-change
path disposes + drops ALREADY-BUILT sibling programs (`if (siblings !== undefined)`) so they
re-warm from the current tree on the next cross-program read. Correct by design (§8 tear-free: a
reindex is between serialized requests), but the existing invalidation test never builds siblings
before the tsconfig change ((b) is host-level + sibling-free; (a) asserts the undiscovered memo,
not a sibling re-warm), so the dispose branch runs only in production. Add a scenario that forces a
cross-program build (a cross-program `find_usages`/dead-code read), THEN a post-warm tsconfig change,
and asserts the rebuilt sibling reflects the new tree. `dx`·`low`·`cx:S`
