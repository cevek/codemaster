---
id: t-026851
title: Shared "slice(0,N).join + +N more" formatter for op notes (dedupe ~6 sites)
status: backlog
priority: low
tags:
  - dx
  - refactor
created: '2026-07-15T22:14:30.986Z'
---
The `slice(0, N).join(', ') + "+K more"` idiom is duplicated across ≥6 op-layer sites (`ops/no-symbol-hint.ts`, `ops/list-inactive-hint.ts`, `ops/importers-of.ts` ×2, `ops/find-usages-view.ts`, `ops/list-symbols.ts`). Rule-of-three long passed; a shared `namedWithMore(labels, max)` helper at the `ops/` (or `common/`) level would collapse them.

Pre-existing debt surfaced during the t-517121 copy-paste review (NOT introduced by that change — its `fileModuleHint` deliberately does not join the pile). Low priority, mechanical.
