---
id: t-000007
title: a non-`tsconfig*.json`-named `extends` target is not detected
status: backlog
priority: low
type: bug
complexity: S
area: multi-program
created: '2026-07-08T00:00:06.000Z'
---
**a non-`tsconfig*.json`-named `extends` target is not detected** — the structural trigger
keys on `isTsconfigBasename`, so an `extends: "./base.json"` / `"configs/strict.json"` parent
edit does NOT re-glob the child → stale options until an unrelated source add/remove. Fix idea:
on warm, resolve+track each program's `extends` chain and trigger on any member's change (still
§19-bounded — resolved once per program, not per call). `bug`·`low`·`cx:S`
