---
id: t-457010
title: "Coverage-floor freshness: a NEW source-file add creating a stray under an already-covered member isn't reflected until a structural change/restart (structural-only memo invalidation)"
status: backlog
priority: low
type: bug
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-08T11:40:47.965Z'
---
From t-851482 (both reviewers confirm STRICT IMPROVEMENT, not a regression). The coverage memo invalidates only on structural (tsconfig/workspace-manifest) change, so adding a new .ts stray under an already-covered member isn't reflected until cold boot/structural change — stale only in the narrow no-structural-change warm window. Pre-t-851482 the strayed member was subtracted PERMANENTLY (lie never lifted); now it floors on cold boot/structural change. Tighten by folding member-dir source-file adds into the coverage-relevant reindex trigger. fix-locus: src/plugins/ts/ls-host.ts reindex/memo invalidation.
