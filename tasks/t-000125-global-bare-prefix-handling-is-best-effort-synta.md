---
id: t-000125
title: :global` bare-prefix handling is best-effort syntactic
status: backlog
priority: low
type: bug
complexity: M
area: scss
created: '2026-07-08T00:02:04.000Z'
---
**`:global` bare-prefix handling is best-effort syntactic** — `:global(.x)` and bare
`:global .x`/`:global{…}` are surfaced as `global:true` (→ always `partial`), but the
per-compound boundary of a bare prefix isn't tracked precisely. Conservative-honest (never a
false `certain`); tighten if a real repo mis-attributes. `bug`·`low`·`cx:M`
