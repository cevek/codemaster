---
id: t-279768
title: 'ls-host: converge inline rootTag derivation onto deriveRootTag (symbol-id.ts)'
status: backlog
priority: low
tags:
  - cleanup
  - dogfood
created: '2026-07-14T14:11:39.170Z'
---
`deriveRootTag(root)` now lives in `plugins/ts/symbol-id.ts` (single-sourced, used by the syntactic-search path). `ls-host.ts:~356` still has the identical inline `fnv1a64Hex(toPosix(root)).slice(0,8)`. Converge it onto `deriveRootTag`. Deferred here because ls-host.ts is the program-discovery seam (Track 2 / a separate edit-disjoint track) — out of the t-515730 (syntactic-flag) boundary. Pure refactor, no behavior change.
