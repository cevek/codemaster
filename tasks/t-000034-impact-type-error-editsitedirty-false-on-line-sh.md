---
id: t-000034
title: 'impact_type_error: editSiteDirty false-`!!` on line-shift'
status: backlog
priority: low
type: bug
complexity: M
area: phase-5
created: '2026-07-08T00:00:33.000Z'
---
**impact_type_error: editSiteDirty false-`!!` on line-shift** — if the edited declFile has a
pre-existing error AND the splice changes line count, the shifted old error resurfaces as
"introduced" in declFile → the editSiteDirty `!!` "parse cascade" note fires on a correct `replace`
with a real downstream list. Over-warning (conservative, not a lie); per-file diff can't tell a new
syntax error from a line-shifted old one. `bug`·`low`·`cx:M`
