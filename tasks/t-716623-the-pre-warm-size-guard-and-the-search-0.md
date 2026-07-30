---
id: t-716623
title: The pre-warm size guard and the search 0-match file hint go blind on a non-git root — both still read git-only listings
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: bug
complexity: S
area: platform
surface:
  - plugins/ts
audience: external
evidence: repro
created: '2026-07-30T15:46:24.385Z'
---
The no-program syntactic surface now degrades to the bounded filesystem walk on a non-git root
(t-810757), but three of its git-listing siblings do not, so the same workspace gets a working
browse beside silently-degraded neighbours:

- `plugins/ts/files-named.ts` (`filesNamedLike`) — the `search_symbol` 0-match "a FILE by that
  name exists" hint. Best-effort by design (`isOk` fails → `{files: [], total: 0}`), so on a
  non-git root the hint is simply never offered. Not a lie, but the one place an agent gets a
  next step from an empty answer is missing exactly where orientation is hardest.
- `plugins/ts/surface-size.ts` — the `search_symbol` pre-warm PEAK estimate (§9). A failed
  estimate deliberately falls through to warming rather than over-refuse, so a non-git monorepo
  gets NO pre-warm guard: the in-process OOM the guard exists to prevent is reachable there.
  This is the load-bearing one.
- `plugins/ts/discovery-prune.ts` — the `willPrune` predicate reads the same listing; without it
  the peak estimate loses its pruning-awareness even where the estimate itself survives.

REPRO (the hint): `search_symbol {query:'zzzNoSuch', syntactic:true}` in a non-git dir holding
`zzzNoSuch.ts` returns the 0-match note with no file hint; the same repo under `git init` offers it.

The walk listing (`support/fs/walk.ts`) is already the sanctioned non-git fallback and is bounded
per §19, so the fix shape is the same one t-810757 took — with the SIZE estimate needing care: it
must stay cheap (a file COUNT, never per-file sizing) and a walk that hit a bound must not read as
a small repo, which would un-refuse a warm that should have been refused.

Related naming debt: `brandGitPath` (support/fs/canonicalize.ts) is now the branding chokepoint for
walk-listed paths too. The behaviour is right (both listings hand out repo-relative POSIX paths);
the name says git.
