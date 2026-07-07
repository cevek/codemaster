---
id: t-000086
title: "codemod: introduced-identifier capture"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:25.000Z'
---
**codemod: introduced-identifier capture** — only metavar-PRESERVED refs are checked; a rewrite
that INTRODUCES an identifier binding a same-named local isn't flagged (flagging would
over-refuse, §1). §2.8 typecheck is the only guard (misses a same-typed shadow). `bug`·`low`·`cx:M`
