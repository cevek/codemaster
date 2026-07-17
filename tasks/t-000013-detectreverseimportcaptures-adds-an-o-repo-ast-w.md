---
id: t-000013
title: detectReverseImportCaptures` adds an O(repo) AST walk to every `move_file`/`extract_symbol
status: done
priority: medium
parent: t-031282
type: perf
complexity: M
area: ts-refactor
created: '2026-07-08T00:00:12.000Z'
---
**`detectReverseImportCaptures` adds an O(repo) AST walk to every `move_file`/`extract_symbol`**
— `src/plugins/ts/refactor/capture/imports.ts:160-210`, reached unconditionally via
`assemblePlan` from `planMove` + `planExtractTo`. It `forEachChild`-traverses EVERY source file
in the program on every dry-run and apply; the touted memo bounds only `resolveModuleName`
calls, not the walk. CONTRIBUTING bans per-call work scaling with repo size; tiny-fixture tests
can't catch it. MED not HIGH because `rewriteImports` already imposes one O(repo) pass, so this
~doubles an already-O(repo) op rather than introducing the first. Confirm with a timed
`move_file` dry-run on a multi-thousand-file repo. `perf`·`med`·`cx:M`
