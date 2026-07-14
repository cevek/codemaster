---
id: t-210262
title: 'search_symbol syntactic: incremental re-parse on drift (currently full surface rebuild)'
status: backlog
priority: low
tags:
  - dogfood
  - multi-program
  - perf
created: '2026-07-14T14:11:50.717Z'
---
`syntactic-search.ts::surfaceSources` currently does a FULL re-list + re-parse of the whole §10 surface whenever the surface key changes (any edit). The hot (cache-hit) path is already O(changed) — this is only the drift path. For a 25k-file monorepo where the agent edits between searches, an incremental re-parse (reuse cached SourceFiles whose per-file stat is unchanged, re-parse only the changed set) would cut the drift cost from O(surface) parse to O(changed) parse. Deferred per manager: don't gold-plate until a scale test forces it; correctness (invalidation) is already proven. Needs per-file (path→{mtimeNs,size,SourceFile}) records instead of the single whole-surface key.
