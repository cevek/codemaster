---
id: t-737057
title: From a visible control label to the predicate that gates it takes 3-4 chained calls and one wrong hop gives the wrong component — the entry point of every screenshot-driven bug triage has no op
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
  - i18n
  - react
type: feat
complexity: L
area: framework
source: dogfood-inbox-aug
relates:
  - t-045024
  - t-575194
audience: external
evidence: reported
created: '2026-08-08T12:03:08.933Z'
---
A bug report arriving as a screenshot carries exactly two facts: a visible label ("Add Procedures", "Save as
draft") and an observed state (disabled). Getting from there to the expression that produces that state is
the first move of every such triage, and it is a chain today: `i18n_lookup` in reverse by value → usages of
the key → `source` of the enclosing component → read `disabled={…}` by eye. Each hop is a place to land on
the wrong component — silently, whenever the string is reused across surfaces.

Wanted: an op in the shape of `control_gate {label | i18nKey}` — locate the JSX nodes that render this string
and, for each, return the expression in `disabled` / `hidden` / an early return that gates it, together with
its resolved dependencies (permission hooks, form flags). The question is structural, not textual: every hop
is a resolution the tool already performs, the composition is what is missing.

Weaker but adjacent, from the same report: an anti-join "controls under surface X that do NOT go through
`canAction` / `usePermissions`", for auditing gating as a class. `batch` + `sql` expresses it only when a
single factory every member calls is known by name, and for hand-written JSX controls no such factory exists.

Related: t-045024 (render-tree ancestry — "under which surface is this control rendered" is the other half of
the anti-join above), t-575194 (the value-at-call-site half, which the props filter already answers once
found).

## Свидетельство

2026-08-03, external agent, /Users/cody/Dev/amiro. Triaging a QA PDF of 15 screenshots; input per item was a
button label plus "disabled". Recorded as a 3-4 call chain per control with the note that "a missed hop
silently gives the wrong component if the string is reused".
