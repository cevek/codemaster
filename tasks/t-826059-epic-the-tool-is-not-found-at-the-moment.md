---
id: t-826059
title: 'EPIC: the tool is not found at the moment of need — capability exists, the agent does not reach for it'
status: backlog
priority: urgent
tags:
  - agent-surface
  - dogfood
  - epic
type: imp
complexity: L
area: render
source: dogfood-jul
surface:
  - cli
  - daemon
  - docs
  - format
  - mcp
  - ops
  - ops/guard
  - plugins/scss
  - plugins/ts
audience: both
evidence: measured
created: '2026-07-28T20:48:24.952Z'
---
Twelve workers reported their own tool usage this session. Eleven reported zero or near-zero symbol calls,
each with a DIFFERENT measured reason — and in most cases the op that would have answered existed and was
correct. This epic is that class: **not missing capability, but capability that is not reached for.**

The measured reasons, each now a member task:
- **t-089408** — the symbol question has no SALIENCE: a doc-sync track is ~95% legitimate grep, so the 5%
  that must not be grep arrives in the same shell rhythm. Includes the correction that matters: 4 of 5
  question types genuinely do NOT belong to the tool, so the honest denominator is small and an
  over-firing nudge becomes noise.
- **t-034392** (urgent) — the staleness banner names only the expensive remedy; three independent workers
  lost their one load-bearing question to it. The banner is honest; the ECONOMICS break.
- **t-011315** — `codemod` IS the read op for declaration-shape questions and is filtered out by its own
  mutation label before its semantics are read.
- **t-248218** — `impact_type_error` is framed by its OUTPUT (type errors) not its INPUT (a proposed
  contract change), so it is not found at the moment that decision is made.
- **t-193866** — ambiguity candidate lists carry no signal to decide between candidates, so the pick costs
  a round-trip.
- **t-959904** — refusals name another refusal instead of the call that answers here.
- **t-702879** / **t-245013** / **t-691093** / **t-158109** — same class, different mechanisms (a refusal
  losing its subject; an unavailable-plugin message that never states the activation rule; registry names
  discoverable only by triggering an error; a nudge that fires post-hoc and cannot discriminate).

## Why one epic and not eleven fixes

Each member is individually cheap and individually looks cosmetic. Together they decide whether the tool
gets used at all — which is the only thing that determines whether any other work in this backlog
matters. Fixing them one at a time also keeps re-deriving the same lesson: the answer's QUALITY was never
the deciding factor in a single report.

## The two facts any fix must respect

1. **Not every fallback to grep is a defect** (t-089408, worker a42c3d8e): "does this folder exist", "what
   does this header say", "is this sentence in the prose" are correctly `ls`/Read/grep. A remedy that
   assumes every grep is a miss will over-fire and be ignored — which is the state the existing PostToolUse
   nudge is already in.
2. **The competitor is not grep's output, it is a call already being made** (worker cdc7d789): the one
   codemaster-shaped question of that track rode along inside a bash call being made anyway, at marginal
   cost ≈ 0, versus a dedicated round-trip. A strictly better answer loses to a free rider.

Related classes: t-647309 (emptiness must carry how it was established) — that one is about answers being
wrong-by-scope; this one is about answers never being requested.
