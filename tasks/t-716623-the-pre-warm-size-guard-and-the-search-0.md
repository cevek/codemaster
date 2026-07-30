---
id: t-716623
title: The pre-warm size guard and the search 0-match file hint go blind on a non-git root — both still read git-only listings
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: S
area: platform
relates:
  - t-408918
surface:
  - plugins/ts
audience: external
evidence: repro
created: '2026-07-30T15:46:24.385Z'
---
Extends **t-408918** (same class, third and fourth mechanism) — read that first: it names the
correlated fall-through in `daemon/escalate.ts` (no escalation on an unmeasurable size) and
`ops/guard/semantic-fanout-guard.ts` (no refusal), decides the direction (escalate on unknown), and
already proposes the `walkFiles` bounded count as the second measurement source. None of that is
re-argued here.

**What is new: two more sites read the same git-only listing, and one of them is a guard t-408918
does not cover at all.**

- `plugins/ts/surface-size.ts` — the `search_symbol` pre-warm PEAK guard (§9,
  `ts.searchWarmPeakMaxFiles`). This is a THIRD guard, distinct from the two in t-408918: it gates
  a `search_symbol` warm on the post-pruning peak, and it is isolation-BLIND by design (it fires
  inside an escalated child too). Its estimate is `gitSourceFilesSync`, which fails outright on a
  non-git root, and a failed estimate deliberately falls through to warming rather than over-refuse.
  So a non-git monorepo has NO pre-warm guard, independently of whatever t-408918 decides about
  escalation — closing t-408918 alone leaves this open.
- `plugins/ts/discovery-prune.ts` — the `willPrune` predicate reads the same listing. Without it the
  peak estimate loses its pruning-awareness even where the estimate itself survives, so a fix that
  only restores the COUNT still gets the peak wrong on a loose-root monorepo.

Third site, lower stakes, no OOM exposure — filed here so it is not lost:

- `plugins/ts/files-named.ts` (`filesNamedLike`) — the `search_symbol` 0-match "a FILE by that name
  exists" hint, best-effort by design (`isOk` fails → `{files: [], total: 0}`). On a non-git root the
  hint is simply never offered. Not a lie; it is the one place an agent gets a next step out of an
  empty answer, missing exactly where orientation is hardest.
  REPRO: `search_symbol {query:'zzzNoSuch', syntactic:true}` in a non-git dir holding `zzzNoSuch.ts`
  returns the 0-match note with no file hint; the same tree under `git init` offers it.

The no-program syntactic surface already degrades this way (t-810757, `plugins/ts/syntactic-cache.ts`
`walkSurfaceKey`), so the fix SHAPE exists in-tree. The size estimate needs care the surface did not:
it must stay a bounded file COUNT (never per-file sizing — that is the O(surface) hang class §19
forbids), and a walk that hit a BOUND must not read as a small repo, which would un-refuse a warm
that should have been refused. An under-count here fails toward the OOM.

Naming debt, same area: `brandGitPath` (`support/fs/canonicalize.ts`) is now the branding chokepoint
for walk-listed paths too. The behaviour is right — both listings hand out repo-relative POSIX paths
— but the name says git.
