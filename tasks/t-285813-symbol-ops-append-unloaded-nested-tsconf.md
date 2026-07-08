---
id: t-285813
title: "Symbol ops append 'unloaded nested tsconfig X exists' hint on a 0-match (t-000073 residual #38)"
status: in-progress
priority: medium
type: dx
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-08T09:11:26.705Z'
---
Residual #38 of t-000073 — IN PROGRESS (Track H, worker 0b023f3e). find_usages/find_definition/search_symbol that resolve a name to NOTHING emit a flat 'no symbol named X', indistinguishable from 'genuinely gone', when an unloaded nested tsconfig exists (symbol may live there). Append a hint via the existing undiscoveredProgramLabels(), analogous to find_unused_exports naming the config. Independent of ask-1 (uses existing signal). Verify current nearest-config discovery doesn't already resolve it first.
