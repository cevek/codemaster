---
id: t-000083
title: "construction-sites.ts` exceeds the 300-line cap"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:22.000Z'
---
**`construction-sites.ts` exceeds the 300-line cap** (347 → 353 after the encloser-id
unification) — pre-existing debt, nudged by the shared-helper import + wrapped call. Split the
scan loop / target-description / encloser-view helpers into a sibling module (sibling to the
already-extracted `construction-encloser.ts` / `construction-confidence.ts`). `dx`·`low`·`cx:S`
