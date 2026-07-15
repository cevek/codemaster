---
id: t-262491
title: find_usages by bare name hard-FAILs on an ambiguous name — add opt-in mergeAmbiguous / pick:'all' to union reference sites grouped per declaration in one call
status: backlog
priority: high
tags:
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-15T11:32:08.764Z'
---
`find_usages {name:'X'}` where the bare name resolves to >1 declaration hard-FAILs (it lists the candidate decls + tells you to pass file:line:col or a SymbolId). Honest and defensible, but for a "where is this touched ANYWHERE" sweep across all same-named decls the caller must re-issue per declaration and mentally merge (or fall back to grep).

**Ask.** An opt-in flag (`{name, mergeAmbiguous:true}` or `pick:'all'`) that unions reference sites across ALL same-named declarations in one call, clearly grouped by resolved declaration in the output — turning the FAIL into a usable multi-decl result while keeping today's strict default. Recurring across many sessions (also present in the pre-2026-07-07 archive).

Inbox source: 2026-07-08 / 2026-07-06 (lines 101 / 106; also 275/280 in the prior archive).
