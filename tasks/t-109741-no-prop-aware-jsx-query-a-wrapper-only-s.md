---
id: t-109741
title: No prop-aware JSX query — a wrapper-only sweep shipped an analysis claiming a 3-file surface when the real one was 11; the miss was caught by a screenshot, not by the tool
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T08:27:07.973Z'
---
Real consequence, not a hypothetical: a design-system sweep (swap primary/secondary button styles across
every EMR form action row) shipped a wrong impact analysis.

The repo expresses "which style" two equivalent ways:
(a) named wrappers — `<BlueButton>` / `<LightBlueButton>`;
(b) the base component with an explicit prop — `<Button variant="contained">` / `<Button
variant="low-contrast">`.

The agent asked the (a) question (`find_usages role:'jsx'` on both wrappers), got size-guard-refused, fell
back to grep for `'<BlueButton'`/`'<LightBlueButton'`, and reported a 3-file change surface. Five more
forms used form (b) and were invisible to BOTH the wrapper query and the grep. The error surfaced only
when the app was run and an unchanged button appeared in a screenshot. Real surface: 11 files.

Note this is the failure mode codemaster exists to prevent — a silent miss that grep cannot see — and the
tool could not express the question either.

Wish, either shape:
  `find_usages {name:'Button', role:'jsx', props:{variant:['contained','low-contrast']}}`
or `jsx_prop_sites {component:'Button', prop:'variant'}` → sites grouped by literal value, plus explicit
`absent` and `dynamic` buckets (the dynamic bucket is load-bearing: a computed variant must be flagged,
never silently omitted, §3.3).

The syntactic JSX scan this needs already exists — `jsxCallSites` (per-attr value signal + `{...spread}`
flag) is what the react plugin's unused-props read-model rides on.
