---
id: t-050181
title: glob_coverage {globs, against:'tracked'} — emit matched/unmatched file ROWS so sql can anti-join two config globs against each other
status: backlog
priority: medium
parent: t-437713
type: feat
complexity: M
area: platform
source: dogfood-jul
audience: external
evidence: measured
created: '2026-07-30T11:22:19.592Z'
---
The generic shape behind "I am replacing one tool's file selection with another's" — a recurring refactor,
and the half that produced a MEASURED near-miss.

/Users/cody/Dev/amiro: `npm run format` covered `src/` only while lint-staged covered the repo, so dropping
lint-staged would have silently stopped formatting `scripts/`, `tests/`, `dev-recorder/` and root configs —
a coverage regression with NO failing gate. Caught only by hand-diffing two globs against `git ls-files`.

    glob_coverage {globs:['!(*routeTree.gen).{ts,tsx,scss,css,json}'], as:'a'}
    glob_coverage {globs:['src/**/*.{ts,tsx,scss,css,json}'],          as:'b'}
    sql: SELECT file FROM a WHERE file NOT IN (SELECT file FROM b)

Cheapest member of this epic and the one with a proof-carrying answer already expressible: the producer emits
rows, `sql` does the rest. Note §3.4 — an uncapped producer is required for the `NOT IN` to be a real set.
