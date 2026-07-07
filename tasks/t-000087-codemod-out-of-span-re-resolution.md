---
id: t-000087
title: 'codemod: out-of-span re-resolution'
status: backlog
priority: low
type: bug
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:26.000Z'
---
**codemod: out-of-span re-resolution** — a rewrite that adds/deletes a decl can re-resolve a
reference OUTSIDE the rewritten span; only in-span refs are checked. §2.8 catches a dangle, not
a type-compatible re-bind. `bug`·`low`·`cx:M`
