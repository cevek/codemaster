---
id: t-000095
title: "name+line` WITHOUT `file` silently ignores `line` → workspace-wide `resolveByName"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:34.000Z'
---
**`name+line` WITHOUT `file` silently ignores `line` → workspace-wide `resolveByName`** —
`resolve-target.ts`. The col-less `file+line` and `name+file` branches both require `file`; a
target carrying `name+line` but no `file` matches neither, falls through to `resolveByName(name)`,
and the `line` is dropped (the resolution is workspace-wide, not line-scoped). Pre-existing (the
col-less work didn't introduce it — `name` always short-circuited the gate), low impact (an
unusual address: a name with a line but no file), but a silent input-drop (§3). Fix: a `name+line`
with no file is underspecified — fail with a pointed "pass `file` too (or drop `line`)".
`bug`·`low`·`cx:S`
