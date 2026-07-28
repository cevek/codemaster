---
id: t-326222
title: Cited fix-loci inside task BODIES go stale silently — ~40 bodies carry `fix-locus:` paths, and the backlog is the document agents plan from
status: backlog
priority: medium
tags:
  - docs
  - dogfood
type: infra
complexity: S
area: docs
source: dogfood-jul
relates:
  - t-120055
  - t-701638
  - t-826059
audience: internal
evidence: measured
created: '2026-07-28T21:24:04.300Z'
---
Measured while auditing 126 bodies: **t-662704 cites `plugins/ts/resolve-target.ts` for `NAME_CANDIDATE_LIMIT`
and `distinctDeclarations`** — both moved during this session's refactors and now live in
`resolve-contract.ts:12` and `ambiguity.ts:42`. The body reads as authoritative and points at the wrong
file.

That is exactly the class t-120055 / t-701638 describe for docs and comments — **occurring inside the
backlog itself**, i.e. in the document from which agents choose and scope work. A worker taking that task
opens the cited file, does not find the symbol, and either re-derives the location or concludes the task
is stale.

~40 bodies in that one slice carry a `fix-locus:` line, so this is a population, not an incident.

## Cheap, and it is our own tool's job

One `batch` of `find_definition` over the cited symbols re-grades the lot: symbol still there → locus
fine; moved → update the line; gone → the task may already be closed. The auditor's own note is the
sharpest part of the report:

> I did not think to run that check FIRST — around 40 bodies carry `fix-locus:`, and one batch would have
> re-graded part of `reported` as "already fixed / locus moved". This is t-826059 on itself: the op
> existed, was correct, and was not reached for exactly when it was worth the most.

So this is both a hygiene task and a live instance of the discoverability epic, self-inflicted on the
backlog we use to plan.

## What to build, if anything

Options, cheapest first: a one-off sweep now; a `fix-locus` convention that names a SYMBOL rather than a
path (symbols survive moves, paths do not — and `find_definition` resolves them); or a periodic check in
whatever runs backlog hygiene. Prefer the second: it removes the decay instead of scheduling repairs.
