---
id: t-000070
title: "mayContain` glob-ownership is a normalized approximation"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: multi-program
created: '2026-07-08T00:01:09.000Z'
---
**`mayContain` glob-ownership is a normalized approximation** — the write gate decides which
program owns a not-yet-created move/extract DEST via `buildMembership` (picomatch over the
tsconfig include/exclude, with tsconfig's bare-dir → `dir/**/*` shorthand re-expanded by hand).
Matching itself defers to picomatch (faithful for `*`/`?`/`**`/literal-file globs), but tsconfig's
IMPLICIT excludes (node_modules / outDir / declarationDir) are not modelled — so a dest under,
e.g., a config's `outDir` could be deemed owned → a false REFUSAL (the SAFE direction for a write
gate; never a false success / missed dangle). Fix if it bites: model the implicit excludes, or
drive membership off TS's own matcher rather than re-normalizing. `bug`·`low`·`cx:M`
