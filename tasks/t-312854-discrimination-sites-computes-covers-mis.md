---
id: t-312854
title: discrimination_sites computes covers/missing against the TYPE AUTHORITY's discriminant domain while judging identity with each program's own T — a sibling whose T has a constituent the authority lacks under-reports the exhaustiveness gap
status: backlog
priority: medium
tags:
  - dogfood
  - multi-program
type: bug
complexity: S
area: multi-program
source: dogfood-jul
relates:
  - t-162650
surface:
  - plugins/ts
audience: both
evidence: unverified
created: '2026-07-30T13:03:34.835Z'
---
UNVERIFIED (reasoned from the code, no hermetic repro yet — the trigger needs two configs that
disagree about T's constituents). The t-162650 cross-program fan re-resolves T in each program
(assignability / union identity are invalid across checkers) — but `discrimination_sites` applies that
invariant only HALF way.

`plugins/ts/discrimination-sites.ts`: `discByName` is built ONCE, from the type authority's checker
(`fan[0]`'s `discriminants`), and passed into `gate` for every fanned program. `LitVal` is
checker-independent, so there is no cross-checker type comparison and no crash — the defect is in the
DOMAIN the gate diffs against:

- if a sibling program's T has a constituent the authority's T does not (the two configs' `paths`
  resolve T's module differently, or a conditional `.d.ts` adds an arm), `missing` — the op's headline
  exhaustiveness field, "what you must handle when widening T" — is computed against a FOREIGN domain
  and under-reports the gap;
- a discriminant NAME present only in the sibling's T is absent from `discByName`, so `resolveDomain`
  (`discrimination-gate.ts`) drops that site silently — a real discriminating switch reported absent.

The identity gate itself is sound (it uses each program's own `type`). This is the one place the
"re-resolve T per program" invariant reaches the identity check but not the domain derived from it, so
it is the residual of that fix rather than a separate design question.

Fix: move `discriminantsOf` / `bareLiteralDomain` into the per-program `resolve` callback (both are
already pure over a checker + type), so each program's sites are diffed against its own T's domain.
The authority's domain stays the one reported in the `target` header — that is the target-level view
and must not become program-dependent — so the honest shape is per-program domains for the diff plus a
disclosure when they DIVERGE, which is itself a real fact about the repo worth surfacing.

Oracle: a fixture whose two configs resolve T to different constituent sets (a `paths` redirect), with
a discriminating switch in the sibling's own files; assert `missing` matches that program's domain and
that a sibling-only discriminant name does not silently drop the site.
