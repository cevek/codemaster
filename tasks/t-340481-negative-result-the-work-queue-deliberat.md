---
id: t-340481
title: NEGATIVE RESULT — the work queue deliberately has no `harm` and no `blast` axis; recorded with the reasoning and the condition that would reverse it
status: backlog
priority: low
tags:
  - backlog-process
type: doc
complexity: S
area: docs
source: dogfood-inbox-aug
audience: internal
evidence: measured
created: '2026-08-08T12:38:06.655Z'
---
Filed as a NEGATIVE result so the next reader does not redesign this from scratch. Two axes were designed, evaluated against live data, and left out. Both are defensible; neither is being added now.

## What the queue uses instead

Three gates (`-has:children`, `-complexity:L`, `type` + `evidence`) and a sort led by `evidence`, with `priority` demoted to a tie-break — see CONTRIBUTING "What to work on next". No new field was introduced.

## Rejected axis 1 — `harm` (hang | lie | crash)

ARCHITECTURE §1 ranks the failures explicitly: a hang is worse than a wrong answer, which is worse than a crash. That ordering is real doctrine and `type: bug` does not express it — a hang and a lie are both `bug`.

Left out anyway, for two reasons:

- **It is only fillable where it is already derivable.** The proposal itself scoped it to `type ∈ {bug, perf}` because for `feat` it means "absence" and for `dx`/`imp` "friction" — i.e. outside the bug class the field would copy `type`. Inside the bug class the split hang/lie/crash is genuinely informative, which is a narrow win for a whole new field every filer must reason about.
- **The hang class is already organised structurally.** `t-031282` (EPIC §1 never-hang) carries the never-hang work with children. The class is findable without an enum on every task.

The blurriest cell was named by the proposal itself: `type: imp` (22 open tasks — honesty economy, verdict-first) all collapse to "friction" while several are direct §3.4 execution.

## Rejected axis 2 — `blast` (channel | family | op)

The most attractive of the two: §3.4/§3.6 is the repo's central idea — a claim established once at a chokepoint is inherited by every op — so a channel defect really does fix many answers at once, and the independent classifiers filled this axis on ~100 tasks with no `?`. It IS readable.

Left out because it is not yet needed and is not yet trustworthy:

- **Not needed at current pool size.** The pickable pool is ~15 tasks. A third axis to order 15 items buys nothing that reading their titles does not.
- **The available proxy is wrong in a way that flatters.** It would be derived from `surface`, which records where the FIX lands, not what the DEFECT touches. A defect visible in every op but fixed in one plugin file is under-counted; the shadow run also over-counted `channel`.

## What would reverse either decision

- `blast`: the pickable pool sustainably exceeds ~40, so that `evidence` + `type` + `complexity` stop discriminating within a sort. Then add it — and derive it from a stated property of the DEFECT, not from `surface`.
- `harm`: a hang-class defect reaches the queue and is ordered below a lie, and that is observed to be the wrong call in practice. Until then §1's ordering is carried by `urgent` and by the never-hang epic.
- Either: a filer is observed setting the axis wrong in a way that changes the queue. An axis nobody can fill correctly is worse than an absent one — `evidence: field-report` was declared, checked by nothing, and ended on zero tasks.

## Why this is written down at all

Today a genuine negative result (`t-048595`) had to be reopened because its premise had quietly stopped holding and nothing recorded the condition under which to revisit. The reasoning above is therefore paired with its own reversal test, so the next reader can check whether it still holds instead of re-deriving it or, worse, treating the area as settled.
