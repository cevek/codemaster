---
id: t-286255
title: An honesty channel that fires on 100% of requests carries no information about THIS answer — the permanent fixture-tsconfig floor teaches the reader to skip `!!`, including the one time the gap is real
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: render
source: dogfood-jul
created: '2026-07-28T12:52:01.101Z'
---
On codemaster's own repo the undiscovered-program floor and its matching `!! CANNOT CLAIM` disclosure fire
on **100% of requests**, and the configs they name are TEST FIXTURES that will never be indexed — the
suggested remedy (reference them from a parent) would destroy the reason they exist.

Both signals are correct. Neither is a bug. That is exactly what makes this worth fixing: **a channel that
is always on carries no information about the answer in front of you**, so the reader learns to skip it —
and the skipping generalizes to the one request where the gap is real.

This is the same failure as the duplicated floor note (t-034392), one level worse: duplication makes a
signal cheap, constancy makes it meaningless. `!!` is the project's loudest honesty marker; spending it on
a permanent, unactionable condition devalues it everywhere else.

Proposed direction from the reporter: let a repo DECLARE configs as deliberately-unindexed — subtracted
from the floor and from the disclosure's cause list, while staying visible in `status`. Then the floor
means "something you did not intend" again, which is the only reading that makes it worth printing.

Design constraints this must respect, or it becomes a way to lie:
- opting a config out must be a positive, visible declaration in the repo's own config — never inferred,
  never defaulted on. An agent must be able to see WHAT was excluded and by whose choice.
- `status` keeps listing them, so the exclusion is auditable rather than invisible.
- the floor still fires for any config NOT declared — the honest case is unaffected.

Related: t-034392 (duplicated note, same devaluation by a different mechanism), t-959904 (a signal that
cannot be acted on is not honest, just loud).
