---
id: t-000072
title: "absOf` is `path.join` (OS-sep), not posix — Windows-latent path-form skew in the gate"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: multi-program
created: '2026-07-08T00:01:11.000Z'
---
**`absOf` is `path.join` (OS-sep), not posix — Windows-latent path-form skew in the gate** —
`owns`/`affected`/`entriesFor` compare `ctx.absOf(rel)` against `containsFile`/`mayContain`.
`mayContain` re-runs `toPosix` defensively, but `containsFile` passes the path straight to
`getSourceFile`. On darwin/linux `path.join` keeps `/` so they agree; on Windows the `\` spelling
could make the two ownership predicates disagree → under-include (a missed dangle). Pre-existing
(`absOf` predates this work); not a bug on the current platform. Fix: route `absOf` through
`toPosix`. `bug`·`low`·`cx:S`
