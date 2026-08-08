---
id: t-549028
title: 'The repo-wide dead-code family cannot be scoped to what an edit touched: path filters are flat on three ops, absent on find_unused_props, and nested under filter{} on find_usages — so the transferable model says "no filter exists" and the agent leaves for grep'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: dx
complexity: M
area: render
source: dogfood-inbox-aug
surface:
  - mcp
  - ops
audience: external
evidence: repro
created: '2026-08-08T12:01:58.215Z'
---
The four ops that report a repo-wide CONDITION — `find_unused_scss_classes`, `find_unused_exports`, `find_unused_i18n_keys`, `find_unused_props` — are most useful immediately after an edit, scoped to what the edit touched. That mode is unreachable in practice for two reasons, one missing capability and one vocabulary defect:

1. **`find_unused_props` has no path filter at all** (verified on current `main`: no `pathInclude` in its `argsSchema`), while the other three take flat `pathInclude` / `pathExclude`.
2. **The arg SHAPE is inconsistent across the family's neighbourhood.** `find_usages` nests its filter as `filter: {pathInclude, pathExclude}`; the dead-code ops take it top-level. An agent carrying the `find_usages` model looks for `filter:{…}`, does not find it, and concludes the op has no filter — which is what happened in the field on an op that HAS had `pathInclude` since 2026-06-16. A capability that exists but is not where the transferable model puts it is, for an agent, an absent capability.

`sql` is not a workaround here: the producer itself caps, so a post-filter cannot recover the rows that were never emitted.

Ask: (a) give `find_unused_props` the same path filter; (b) settle ONE spelling for path scoping across the family and the read ops that neighbour it (either flat everywhere or `filter:{}` everywhere), with intake aliasing the other form so neither guess hard-fails; (c) better still for this family, accept a changed-file scope (they already read the git state — the freshness header is derived from it), so "did MY change leave something dead" is one call.

Related, filed separately: the response cap's remedy line does not name these ops' own narrowing lever.

## Свидетельство

2026-08-05, external field report, `amiro` worktree `forms-w3-ceiling`, cm=0.1.0. The agent moved two SCSS classes into a new module and asked the one question a reviewer would ask — did the move leave anything dead. `find_unused_scss_classes {}` returned 421 entries of pre-existing repo debt and hit `!! OUTPUT CAPPED` before reaching the alphabetical range of its own files. Reporter: "There is no `filter: {pathInclude}` on this op the way `find_usages` has one, and `sql` cannot help because the producer itself is capped, so I fell back to grep." Wanted: `{filter:{pathInclude:['src/features/sales/SalesView/AddSalePanel/**']}}`.

Verified on current `main` (2026-08-08): `find_unused_scss_classes`, `find_unused_exports`, `find_unused_i18n_keys` accept flat `pathInclude`/`pathExclude`; `find_unused_props` accepts none; `find_usages` nests them under `filter`. So the capability the reporter needed existed under a different spelling — the defect is the vocabulary split, plus the genuine `find_unused_props` gap.

Adjacent arg-vocabulary tasks: [[t-837168]], [[t-378009]], [[t-424583]].
