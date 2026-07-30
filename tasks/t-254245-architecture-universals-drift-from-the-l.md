---
id: t-254245
title: ARCHITECTURE § universals drift from the live values inside one section — three independent instances in one wave, all caught by a reader rather than a gate
status: backlog
priority: medium
parent: t-532530
type: infra
complexity: M
area: docs
source: dogfood-jul
relates:
  - t-259465
  - t-815425
audience: internal
evidence: measured
created: '2026-07-30T13:11:44.639Z'
---
## Three instances, one wave, three different sections

1. **§9 claimed the pre-warm peak guard is in-process-only** while the same track's measurement proved it
   isolation-BLIND (it fires inside an escalated child too). The doc and the new task contradicted each other
   on landing.
2. **§9's "Two triggers, two escape sets" paragraph claimed a `file` re-pin provably escapes the fan-out
   guard** — false for `construction_sites` / `discrimination_sites`, whose fan follows the DECLARATION, so a
   file-pinned call fans identically.
3. **§5-L2 claimed collapse-by-definition already displaces the alias pointing at a declaration** while the
   field showed 19 "declaration sites" for one declaration on a barrel-heavy monorepo.

All three were caught by doc-sync review — a reader comparing both sides. None would have failed a gate.

## Why prose is the wrong place for these particular claims

Each is a UNIVERSAL over a set whose members carry the real property in code: which ops call the guard, which
addressing forms fan, which programs a resolve admits. ARCHITECTURE.md is exactly the shape t-815425
describes — §-sections asserting universals over ops/plugins whose properties live in `OpDefinition`s, plugin
manifests and guard call sites.

## The mechanism to bind them

Where a § asserts a universal over ops, derive it or check it:

- "these N ops call the fan-out guard" — enumerable from the guard's own call sites (the absence-audit
  anti-join codemaster already documents as a concept: family from the factory every member calls, F from
  its own call sites, `NOT IN` on file).
- "a file-pinned call never fans" — a property of each op's fan predicate, readable per op, so the § should
  cite the predicate rather than restate its conclusion.
- Threshold / default numbers quoted in prose (`searchWarmMaxFiles`, the peak threshold, the child ceiling)
  should be single-sourced from the constant, or asserted equal to it by a test.

A red test on drift, not a careful reviewer. Start with the smallest version that pays: an agreement test
over the numbers and the op-set universals a § already names — the two shapes that drifted three times here.
