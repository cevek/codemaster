---
id: t-000015
title: "sql text-table renderer lacks the `~`-meta-key strip the generic/json paths have"
status: backlog
priority: medium
type: bug
importance: medium
complexity: S
area: bug-sweep
created: '2026-07-08T00:00:14.000Z'
---
**sql text-table renderer lacks the `~`-meta-key strip the generic/json paths have** —
`src/format/render/render-table.ts:37-51`. `renderSqlTable` prints `data.columns` as the header
and every cell raw, with no `~`-key guard (unlike `condenseSpans`/`stripShapeTags` on the
generic path and `stripShapeTags` on json). REAL mechanism, THEORETICAL trigger (needs a
producer emitting a `~`-prefixed column — none proven today). Defensive: add a `~`-strip to
match the generic-path guarantee. `bug`·`med`·`cx:S`
