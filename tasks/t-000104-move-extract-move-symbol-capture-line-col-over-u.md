---
id: t-000104
title: "move/extract/move_symbol: capture `line:col` over UNFORMATTED LS output"
status: backlog
priority: low
type: bug
importance: low
complexity: L
area: ts-refactor
created: '2026-07-08T00:01:43.000Z'
---
**move/extract/move_symbol: capture `line:col` over UNFORMATTED LS output** — the proof
coordinate is computed on raw LS edits, but the agent sees the prettier-formatted diff → on a
real capture the `file:line:col` can point at a reflowed line. Detail string still names the
specifier; apply is refused either way (correct verdict). Needs the format pass visible to
capture detection. `bug`·`low`·`cx:L`
