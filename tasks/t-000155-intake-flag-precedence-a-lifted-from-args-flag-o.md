---
id: t-000155
title: 'intake flag-precedence: a lifted-from-args flag overrides an explicit top-level flag'
status: backlog
priority: low
type: dx
complexity: S
area: render
created: '2026-07-08T00:02:34.000Z'
---
**intake flag-precedence: a lifted-from-args flag overrides an explicit top-level flag** — when a
call passes the SAME OpFlag both inside `args` AND at top level (e.g. `{apply:false, args:{apply:true}}`),
the intake flag-lift (`engine.ts` `extractFlags({ ...req, ...resolved.flags })`) lets the args-placed
value win. Harmless today (no agent double-specifies) and arguably the right call (the args-placed one
is the more explicit intent), but undocumented; pick a precedence and state it. `dx`·`low`·`cx:S`
