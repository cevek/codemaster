---
id: t-684957
title: source op rejects flat {name}/{query}; uniquely requires {targets:[…]} — recurring papercut, diverges from every sibling flat-name op (t-424583 intake residual)
status: backlog
priority: high
tags:
  - dogfood
  - intake
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-15T11:31:05.516Z'
---
**Repro (current main).** `source {name:'Plugin'}` → `DISPATCH bad_args: targets: expected array, received undefined … expected { targets: [{ symbolId? | name? | file+line+col }] }`. Same for `source {query:'X'}`.

Every sibling lookup op takes a flat key — `find_usages/find_definition/expand_type` take `{name}`, `search_symbol/list` take `{query}` — but `source` ALONE requires `{targets:[{name}]}`. Multiple independent agents (and managers) first-call it flat, hit bad_args, self-correct on retry. Recurring papercut (inbox 2026-07-11, 2026-07-12, 2026-07-13 — three separate sessions).

**Ask.** Extend the intake normalizer (src/ops/intake/) to coerce a flat `{name}`/`{query}`/`{symbolId}` (and `{names:[…]}`) into a single/multi-element `targets[]`, disclosed via `Result.intake` — exactly the alias/scalar→array pattern t-424583 shipped for search_symbol/list/move_file. `source` was not covered by t-424583, so this is its residual.

Inbox source: lines 221 / 239 / 260. Follow-up to t-424583 (DONE).
