---
id: t-000077
title: importers_of` row-dedup collapses two imports of one module on one source line
status: backlog
priority: low
type: bug
complexity: S
area: multi-program
created: '2026-07-08T00:01:16.000Z'
---
**`importers_of` row-dedup collapses two imports of one module on one source line** — the `(file:line)`
row-dedup merges two `import`s of the same module on the SAME line into one row (the second import's
detail is lost). Pathological; the importer-FILE count stays correct. `bug`·`low`·`cx:S`
