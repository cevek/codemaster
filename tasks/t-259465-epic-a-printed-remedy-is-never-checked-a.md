---
id: t-259465
title: 'EPIC: a printed remedy is never checked against the mechanism — the lever a refusal names cannot change the outcome, and unlike the other two honesty epics this one is STATICALLY TESTABLE'
status: backlog
priority: urgent
tags:
  - agent-surface
  - dogfood
  - epic
  - honesty
type: imp
complexity: M
area: correctness
source: dogfood-jul
audience: both
evidence: measured
created: '2026-07-28T21:23:08.452Z'
---
Found from a position no single track had: one agent read 126 task bodies in a row and saw the same defect
described five times, never named as a class.

**The defect:** a note or refusal prints a remedy, and nothing anywhere checks that the named lever can
actually change the outcome. The message is honest about the failure and wrong about the fix.

Instances already in the backlog, each written up as its own bug:
- **t-162650** — "widen `pathInclude` if you scoped it", on a path where widening cannot add a program.
- **t-340801** — `no symbol named 'X'` reads as a typo diagnosis when the name resolves fine and is merely
  outside the workspace scope.
- **t-000108** — the message names a fan-out lever that does not exist.
- **t-158131**, **t-155425** — same shape.
- Plus a live one from filing this very report: codemaster's own `feedback` op rejects `detail` over 4000
  chars WITHOUT naming the actual length, so the remedy ("summarize") is given while the measurement
  needed to apply it is withheld. The tool does it to its own reporters.

## Why this is a third epic and not part of the other two

- **t-826059** — the agent never reaches for the tool.
- **t-647309** — the answer is true and reads as proven absence.
- **This one** — the agent WAS reached, the failure WAS honest, and the sentence sends them somewhere that
  cannot work. That is a distinct failure: a wrong remedy costs a full round-trip AND teaches the agent
  that the tool's guidance is unreliable, which is worse than silence.

## What makes it the cheapest of the three: it is statically enforceable

The other two need judgement about scope and about whether a question was asked. This one has a mechanical
invariant:

> the argument / op / flag named in a refusal must be one the answering op actually consumes

A lint over hint and refusal texts against the ops' own arg schemas catches **four of the five** known
instances, and prevents the class from recurring rather than fixing five sentences. The schemas are
already canonical and machine-readable (the `tools/list` work made them the single source), so the
checker has something real to check against.

Prior art for the enforcement shape: `FULL_DISPOSITION` (a new tag with no entry is a compile error) and
`TS_TARGET_ONE_OF` (the predicate is BUILT from the declaration, so the advertised and validating forms
cannot diverge). Same idea applied to prose.

Related but distinct: t-959904 (a refusal must name a call that works HERE) is the positive half — that
one is about naming a good next step; this one is about not naming an impossible one.

## Field measurement (dogfood-jul): four of five instances are catchable by ONE static lint

Reading 126 defect bodies of the impact-usages/ts-core/multi-program slice back to back, five bodies
describe this class and none names it: t-162650 ("widen pathInclude" cannot add a program), t-340801 ask 3
("no symbol named X" reads as a typo diagnosis when the name resolves in node_modules), t-158131 (the
demoted-namespace list names no route to the uncapped set), t-000108 ("fan-out is OFF" names a switch that
does not exist — move_symbol is primary-only by construction), t-155425 ("primary program only" is wrong in
a no-root repo).

It sits beside two neighbours already tracked — t-826059 ("the tool is not reached for") and t-647309
("emptiness does not say how it was established") — and is the THIRD: the tool DOES reach the agent, and the
sentence it hands over points at a lever that cannot move the outcome.

Unlike its neighbours it is STATICALLY TESTABLE: every arg / op / flag named in a note or refusal must be
one the answering op actually consumes, and a remedy must be reachable from the state the call is already
in. A lint over hint/refusal texts against the ops own arg schemas catches four of the five above.
