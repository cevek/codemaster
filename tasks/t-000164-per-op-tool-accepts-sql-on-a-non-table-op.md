---
id: t-000164
title: "per-op tool accepts `sql` on a non-table op"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: correctness
created: '2026-07-08T00:02:43.000Z'
---
**per-op tool accepts `sql` on a non-table op** — `opToolSchema` accepts `sql` for any op, but
the per-op `inputSchema` advertises it only on table-bearing ops; a `sql` on a tableless op
still reaches dispatch and degrades honestly ("op has no table"). Optionally reject at the
facade before dispatch for a sharper error. `dx`·`low`·`cx:S`
