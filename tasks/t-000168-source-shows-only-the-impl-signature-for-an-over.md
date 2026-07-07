---
id: t-000168
title: source` shows only the impl signature for an overloaded function
status: backlog
priority: low
type: feat
complexity: M
area: correctness
created: '2026-07-08T00:02:47.000Z'
---
**`source` shows only the impl signature for an overloaded function** — `source` on an
overloaded `function coerce(...)` returns only the implementation declaration's span/body, never
the overload signature decls that precede it (verified: only the impl line is rendered). The
decl-span machinery (`plugins/ts/definitions.ts` / `source` op) anchors one declaration; for an
overload set it should surface all signature decls. Split out of the `expand_type` overload fix
(that fix covered `expand_type` only; `source` is `src/ops/source.ts`, a different surface).
`feat`·`low`·`cx:M`
