---
id: t-427337
title: OpIntake.targetArray now carries two behaviors (element-coercion + flat→targets[] collapse) but its JSDoc documents only the first
status: backlog
priority: low
tags:
  - dogfood
  - intake
type: doc
complexity: S
area: render
source: dogfood-jul
created: '2026-07-15T18:21:32.303Z'
---
`OpIntake.targetArray` (registry/contracts) now drives BOTH element-coercion of `targets[]` entries AND the flat `{name}`/`{query}`/`{symbolId}`/`{names:[]}`→`targets[]` collapse (added for `source`). The JSDoc documents only element-coercion. Latent (source is the only op with `targetArray` today), so no live misread, but the next op adopting it would be misled.

**Fix:** update the JSDoc to describe both behaviors, or split into two fields. Trivial.

Source: track A (t-954279) DONE ⚑2.
