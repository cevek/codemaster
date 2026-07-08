---
id: t-751003
title: "discrimination_sites: an 'kind' in x narrowing can strip aliasSymbol → the site is a false-NEGATIVE (honest under-coverage)"
status: backlog
priority: low
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-08T16:00:15.135Z'
---
From t-304222 (bug-reviewer, non-blocking). discrimination_sites gates on identity (getNonNullableType(objType).aliasSymbol === targetType.aliasSymbol). An in-operator narrowing — if ("kind" in x) switch(x.kind) — can narrow x to a synthesized type whose aliasSymbol is stripped, so the site is MISSED (false-negative). Honest under-coverage per never-fabricate (a miss beats a false-certain), and the op notes already disclose the v1 scope limit (in-narrowing excluded). Extend the discriminant/scrutinee resolution to recover the alias through an in-narrowing. fix-locus: src/plugins/ts/discrimination-gate.ts + discrimination-analyze.ts.
