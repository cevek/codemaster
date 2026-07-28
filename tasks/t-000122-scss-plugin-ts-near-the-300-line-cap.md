---
id: t-000122
title: scss/plugin.ts` near the 300-line cap
status: backlog
priority: low
type: dx
area: scss
relates:
  - t-000152
surface:
  - plugins/scss
audience: internal
evidence: measured
created: '2026-07-08T00:02:01.000Z'
---
**`scss/plugin.ts` near the 300-line cap** — ~290 real lines after the index/demotion/scrub
work; the next scss change should split it by responsibility (e.g. lift `unusedClasses`/`demote`
into their own module) rather than grow it. `dx`·`low`

**Related:** t-000152 (`find-usages.ts` at exactly 300) is the same cap pressure in `ops/`. Both want a pre-emptive split before the next change, not a raised cap.
