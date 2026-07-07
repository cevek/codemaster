---
id: t-000069
title: "Write-gate check scope misses a gitignored-but-sibling-compiled file"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: multi-program
created: '2026-07-08T00:01:08.000Z'
---
**Write-gate check scope misses a gitignored-but-sibling-compiled file** — the §2.8 fan-out
gate's `check` scope is the git tree ∪ the PRIMARY program's `fileNames()`. A file that is
gitignored (absent from the tree listing) AND compiled only by a SIBLING tsconfig (absent from
primary `fileNames`) is in no program's check scope, so if it imports a moved/extracted module
its post-edit dangle reads clean (a §2.8 completeness gap in the unsafe direction). Rare
(gitignored + sibling-only + importer). Fix: union every built program's `fileNames()` into
the gate's check scope. `bug`·`low`·`cx:S`
