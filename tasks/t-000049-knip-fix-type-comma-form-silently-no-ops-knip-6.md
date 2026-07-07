---
id: t-000049
title: "knip --fix-type` comma form silently no-ops (knip@6.15)."
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: platform
created: '2026-07-08T00:00:48.000Z'
---
**`knip --fix-type` comma form silently no-ops (knip@6.15).** `fix-and-check` strips dead
exports with **two repeated** flags (`--fix-type exports --fix-type types`) **on purpose** —
the documented comma form (`--fix-type exports,types`, or `=exports,types`) parses but fixes
nothing in knip 6.15.0 (the gate still reports the dead export, autofix never fires). Don't
"simplify" the script back to the comma form. Re-check on a knip bump; collapse to the comma
form (or upstream a fix) once it actually applies. `dx`·`low`·`cx:S`
