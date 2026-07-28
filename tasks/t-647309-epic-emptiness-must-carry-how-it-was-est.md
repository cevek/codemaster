---
id: t-647309
title: 'EPIC: emptiness must carry HOW it was established — five load-bearing cases where a TRUE answer reads as a proven absence'
status: backlog
priority: urgent
tags:
  - dogfood
  - epic
  - honesty
type: imp
complexity: L
area: correctness
source: dogfood-jul
relates:
  - t-000010
  - t-000011
  - t-000041
  - t-561552
  - t-610052
surface:
  - ops
  - plugins/react
  - plugins/ts
audience: both
evidence: measured
created: '2026-07-28T20:34:26.581Z'
---
Five instances found in one session, five DIFFERENT mechanisms, one symptom: the tool returns `0` /
`found:0` / a small count, the number is TRUE, and the reader concludes something the tool never
established. This is not silent truncation (§3.4 — the count is right and often the floor IS disclosed);
it is a **scope mismatch**: the question maps onto a different set than the one measured, and nothing in
the answer says the two diverged.

Close this as an INVARIANT, not as five fixes. Whoever takes one of these alone will patch a symptom and
leave the class intact — that is how it reached five.

Members — each one load-bearing. Four carry a repro or a measurement in their own body; t-288409 is
the limiting case, where no op reaches the question at all (see the membership rule below):
- **t-162650** (urgent) — `construction_sites` renders a semantic verdict over a program it never scanned
  (`files=0`), and its remedy blames the caller's scoping. TWO independent repos; second instance DID scan
  (`literals=7 files=4`) and still missed a call-argument literal with conditional spread.
- **t-100043** — `member_usages` returns `sites=1` where 6 consumers exist: the type edge is severed at the
  `ops→JsonValue` seam, so the checker has nothing to link. `impact_type_error` cannot help either.
- **t-585566** — `find_unused_props` launders a failed component lookup into `ok{found:0}`, and its own
  test pins that shape as the contract.
- **t-194771** — `trace_prop_through_tree` asserts proven-absence over a CAPPED member set, while
  `find_unused_props` over the same `firstParamTypeMembers` correctly answers `undetermined`. One seam, two
  consumers, two different honesty levels.
- **t-288409** — config-key identity (env var names) is reachable by no op, so "is `OPENAI_BASE_URL`
  referenced anywhere?" is answered only as well as the agent guessed spellings. An absence nothing
  establishes.

## The invariant to build

An empty or small result must carry WHAT WAS ACTUALLY SEARCHED: which programs were scanned (and which
were not), whether the candidate set was capped upstream of the filter, whether the edge the question
needs exists at all in the type graph. `0` then means "searched here, found nothing" rather than "nothing
exists".

Precedent already in the tree, and it is why this is tractable: `find_usages` fans across programs, tags
rows with their program, and carries `complete:false` + `!! LOWER BOUND`. The machinery exists; the other
ops neither fan nor disclose. Also see the envelope disclosure work (t-876408) — the pattern of stating a
claim ONCE at the point where it is established, so every consumer inherits it rather than remembering to.

## What takes an item OUT of this epic

**A shipped disclosure closes the item; it does not leave it a pending member.** This epic is about
UNDISCLOSED emptiness. Once an op states its own scope — the programs it searched, the cap it hit, the
edge it does not model — the answer an agent reads is qualified, and what remains is an ordinary
capability gap: smaller, differently prioritised, and not this invariant. t-610052 is the worked
example: it is reproduced, but `src/ops/trace-field-to-render.ts:49` now discloses the missing kind
gate, so it sits at `relates` rather than `parent`.

Apply this before admitting any new candidate — a repro alone does not qualify one, and re-deriving
this each time is how a member set drifts.

## Cheapest way to find the rest

From worker cb8fedab, having found the third instance in a neighbouring op while fixing its own:

> when you fix honesty in one consumer of a seam, look at the others

`find_unused_props` and `trace_prop_through_tree` read the SAME capped seam and answered differently. That
divergence is visible only to someone already holding the defect's shape — so audit by SEAM, not by op.

## Floors do not COMPOSE — nothing says how many are active at once

From the same 126-body read. About a third of that slice are defects each of which honestly classifies
itself "safe direction, under-report, never a false `certain`" and is therefore `low`. Each is right on
its own.

In aggregate, ONE answer can be simultaneously: floored by an undiscovered program, cut by the candidate
cap, severed at the `Result<JsonValue>` seam (t-100043), AND blunted by a repo-global demote — and nothing
anywhere states how many independent floors are active.

> Each disclosure says "this is a lower bound". None says "a lower bound four times over".

So the reader applies a single discount to a number that has been discounted four times, and every
individual `low` was defensible while the composite is not. This belongs to this epic rather than to a
task of its own: it is the same invariant (emptiness must carry how it was established) read at the level
of a whole answer instead of one producer.

Concrete ask when this epic is taken: the disclosure channel should carry the COUNT and the identity of
active floors, not a boolean per producer.

## Candidates — same shape, linked by `relates`, not `parent`

Four tasks describe the same shape and are attached by `relates`: **t-000010** and **t-000011**
(`find_unused_exports` — a vacuous-filter warning that fires only when the filter is FULLY vacuous; a
false-clean on a broken program), **t-000041** (`trace_type_widening` non-modeled-flow caveat), and
**t-610052** (`trace_field_to_render` answering `found:1 renderedBy:0` for a target that is not a
property).

**Membership is not derivable from `evidence`, and must not be read off it.** t-288409 is a member at
`evidence: reported`; t-610052 is a candidate at `evidence: repro`. The field records how well the
BODY is established; membership records something else — that the absence is load-bearing and that
codemaster's own surface produced or permitted it. t-288409 qualifies as the limiting case the
invariant needs: no op reaches string-literal config identity at all, so "is `OPENAI_BASE_URL`
referenced anywhere?" is an absence nothing establishes.

**Promotion criterion.** Reproduce the item on current `main` and show the answer STILL reads as a
proven absence — a `0` / `found:0` / "not among" an agent would act on, with nothing in the response
qualifying it. The second half is doing real work, not decoration: t-610052 is reproduced, but its
op's `notes` now DISCLOSE the gap (§3.6, the honest stopgap), so what an agent reads today is a
qualified answer, not a bare absence. A shipped disclosure is exactly what takes an item OUT of this
epic — the epic is about absences that carry nothing, so an absence that now carries its scope has
been answered, not deferred.

That is why these four sit at `relates`: not because `reported` disqualifies — t-288409 is a member at
`reported` — but because the shown-on-`main` test has not been run for them. t-000010 / t-000011 /
t-000041 have not been reproduced at all; t-610052 has, and its answer no longer reads as bare.
Run that test and the edge becomes `parent`.

## The fifth `relates` edge — t-561552 is excluded by scope, not by weight

**t-561552** (`name+file` reports a FALSE absence for a symbol the file plainly declares) is linked but
is NOT a member, and the reason is the epic's own scoping: every case here is one where **the number is
TRUE** and only its READING misleads. t-561552's answer is wrong outright — a different and heavier
defect class, since no amount of disclosing WHAT WAS SEARCHED repairs an answer that is false about what
it did search. Admitting it would blur the definition that makes this epic actionable.

The edge stays because the two are read together: they are the two ways an absence can fail an agent.
