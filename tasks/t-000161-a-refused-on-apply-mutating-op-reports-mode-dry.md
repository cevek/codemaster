---
id: t-000161
title: "A refused-on-`apply` mutating op reports `mode=dry-run"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: correctness
created: '2026-07-08T00:02:40.000Z'
---
**A refused-on-`apply` mutating op reports `mode=dry-run`** — `move_symbol … apply:true` that the
typecheck gate refuses still renders `mode=dry-run` (+ `applied=false` + the reason). `mode` is
conflating "was apply requested" with "did anything get written"; a refused apply is neither a
dry-run nor an applied edit. Report `mode=refused` (or `requested=apply applied=false`) so the
agent isn't told it ran a dry-run it didn't ask for. `bug`·`low`·`cx:S`
