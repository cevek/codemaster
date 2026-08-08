---
id: t-729701
title: NEGATIVE RESULT — no separate backlog-lint script; the one rule that pays already rides the queue's health line, and the rest are heuristics that miss the expensive case
status: backlog
priority: low
tags:
  - backlog-tooling
  - dogfood
type: infra
complexity: S
area: docs
source: dogfood-inbox-aug
audience: internal
evidence: measured
created: '2026-08-08T12:52:37.639Z'
---
Filed as a NEGATIVE result so the next reader does not re-derive it. A standalone backlog validator (`scripts/backlog-lint.mjs`, six rules) was drafted and **deliberately not shipped**.

## Why not

**The one rule that pays is already at the point of use.** "A task with no `type`/`complexity`/`evidence` is invisible to the queue at any priority" is real and expensive — but `npm run queue` prints it in its health line on every run. A second home for it would restate the same fact where nobody runs it, and a check nobody runs is a claim of coverage rather than coverage.

**Structural integrity is nominally `tm lint`'s.** Broken `relates`/`parent`, an epic with no children, a `depends_on` pointing at `done` — these belong to the task-manager, not to a codemaster-side script. Splitting them across two tools means two places to notice a schema change.

**The two remaining rules are heuristics, and one of them provably misses its own motivating case.** The duplicate-title check was justified by a real event: two agents filed one capability in parallel (t-911243 / t-031616) and it was caught by accident. But they described that capability in DIFFERENT WORDS — the backlog is written in invariants, the inbox in symptoms — so title-token similarity would not have matched them. A guard that misses the most expensive instance of its class buys the appearance of coverage and none of it; and a guard that has to be curated is one people learn to silence (CONTRIBUTING: "a guard people are trained to silence is dead"). The same objection applies to "strong `evidence` without a proof in the body": the check would fire on prose it cannot parse, and the response would be to widen the exception list.

## What replaced it

Nothing, and that is the point. The queue's own health line reports what was filtered and why (invisible tasks, proven work removed by the type gate, a head cohort running low) — the §3.4 rule the tool applies to its own results, applied to the backlog: a filtered set names what the filter removed.

## When this becomes worth revisiting

- The **invisible** count stops being ~0 in normal operation, i.e. tasks routinely land without the three fields and nobody notices until planning — then the check belongs in CI, not in a report.
- A duplicate is found that title-similarity WOULD have caught, i.e. the failure mode is careless restatement rather than genuine vocabulary drift. Today's evidence says it is the latter.
- `depends_on` starts being used. It is currently dead (437 of 438 open tasks are `ready`, exactly one is blocked), so rules about the dependency graph guard nothing.

Recording the conditions rather than only the decision, because a negative result whose premise has quietly stopped holding reads as settled when it is not — the defect this backlog hit today with t-048595.
