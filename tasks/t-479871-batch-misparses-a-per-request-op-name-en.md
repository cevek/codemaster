---
id: t-479871
title: '`batch` misparses a per-request `{op, name}` envelope — dispatches the `name` VALUE as the op ("unknown op ''<symbol>''")'
status: done
priority: high
type: bug
complexity: S
area: correctness
source: dogfood-jul
created: '2026-07-07T20:04:30.680Z'
---
**Confirmed on current `main` via the MCP `batch` tool, 2026-07-08.** (inbox entry 36.)

`batch {requests:[{op:'find_usages', name:'Plugin'}]}` → `[0] Plugin` then `DISPATCH unknown_op: unknown op 'Plugin' (known: search_symbol, …)`. The `{op,name}` flat form is a natural guess (the standalone tools take `{name,…}` flat), but the batch request envelope is `{name:'<op>', args:{…}}` — so `op` is **silently ignored** and the request's `name` value (`'Plugin'`) is read as the op to dispatch, and even used as the result label.

Two fixes:
1. The dispatcher-level intake normalizer (§7) is **not** applied to batch request envelopes (spec: "the normalizer is dispatcher-level — `transaction` sub-steps validate against the op schema directly, are canonical-only"; batch appears to be in the same canonical-only boundary). Either apply the alias layer to batch requests, or accept `op` as an alias for the envelope `name`.
2. The error is misleading — it reports the **arg value** as an unknown op while listing known ops as if the op were wrong. It should detect the malformed envelope and say `expected {name:'<op>', args:{…}}`.

Workaround (standalone per-op tools) is clean, so severity is bounded, but it's a documented-looking trap.
