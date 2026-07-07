---
id: t-000169
title: expand_type` enum members echo the member name and omit the value
status: backlog
priority: low
type: bug
complexity: S
area: correctness
created: '2026-07-08T00:02:48.000Z'
---
**`expand_type` enum members echo the member name and omit the value** — enum/const-enum members
render `Low: Severity.Low` (a name echo) while the actual value (`Low=0`, `High='high'`) is not
shown; the column should carry the value, not re-echo the name. `bug`·`low`·`cx:S`
