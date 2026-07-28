---
id: t-000083
title: construction-sites.ts` exceeds the 300-line cap
status: backlog
priority: low
type: dx
complexity: S
area: ts-refactor
relates:
  - t-000039
  - t-000084
  - t-123203
surface:
  - ops
audience: internal
evidence: reported
created: '2026-07-08T00:01:22.000Z'
---
**`construction-sites.ts` exceeds the 300-line cap** (347 → 353 after the encloser-id
unification) — pre-existing debt, nudged by the shared-helper import + wrapped call. Split the
scan loop / target-description / encloser-view helpers into a sibling module (sibling to the
already-extracted `construction-encloser.ts` / `construction-confidence.ts`). `dx`·`low`·`cx:S`
