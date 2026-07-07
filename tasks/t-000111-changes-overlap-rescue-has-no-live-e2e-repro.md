---
id: t-000111
title: "Changes overlap` rescue has no live e2e repro"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:50.000Z'
---
**`Changes overlap` rescue has no live e2e repro** — the assertion routing/sanitization
(Task J) is covered by a deterministic unit test, but with the bundled TS + the extract-fork the
mutual-recursion shapes tried no longer throw `Changes overlap`, so there's no end-to-end throw
pinning it. Add an e2e repro if a shape that still asserts surfaces. `dx`·`low`·`cx:S`
