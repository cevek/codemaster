---
id: t-000040
title: 'trace_type_widening: literal→union kind label'
status: backlog
priority: low
type: bug
complexity: S
area: trace
relates:
  - t-000041
surface:
  - ops
audience: both
evidence: reported
created: '2026-07-08T00:00:39.000Z'
---
**trace_type_widening: literal→union kind label** — `'a'` → `'a' | 'b'` is classified
`kind:'literal-widening'`, not `'union-widened'` (the `isLiteral(src) && !isLiteral(sink)` check
runs before `sink.isUnion()`, and a union-of-literals is not `isLiteral`). The widened verdict is
CORRECT (certain, widened:true) — only the kind label contradicts the op's own taxonomy. Check
`sink.isUnion()` before the literal branch. `bug`·`low`·`cx:S`
