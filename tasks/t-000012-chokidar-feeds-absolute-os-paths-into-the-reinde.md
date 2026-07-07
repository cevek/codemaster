---
id: t-000012
title: "chokidar feeds absolute OS paths into the reindex pipeline"
status: backlog
priority: medium
type: bug
importance: medium
complexity: S
area: bug-sweep
created: '2026-07-08T00:00:11.000Z'
---
**chokidar feeds absolute OS paths into the reindex pipeline** —
`src/support/watch/chokidar.ts:48-51` (`pending.add(path)` collects chokidar's absolute path
→ `onChanged(batch)`). Plugins key by `RepoRelPath` (forward-slash, root-relative, case-folded,
§19). If the downstream reindex doesn't re-mint these through the canonicalization chokepoint,
a watcher-driven invalidation can miss its target on case-insensitive volumes / Windows
separators (freshness then rides the slower read-time backstop). Confirm the re-mint happens in
engine/plugin reindex. `bug`·`med`·`cx:S`
