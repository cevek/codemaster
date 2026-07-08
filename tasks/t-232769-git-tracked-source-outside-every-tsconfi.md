---
id: t-232769
title: Git-tracked source outside EVERY tsconfig (e.g. package scripts/*.ts) is unsearched → keeps claude-ui at complete=false even after member discovery
status: backlog
priority: high
type: imp
complexity: L
area: multi-program
source: dogfood-jul
created: '2026-07-08T12:47:45.993Z'
---
The REAL ceiling keeping claude-ui usable, surfaced by t-816306 part 1. After no-root member discovery, claude-ui is floor 4 / complete=false because 3 members (agent-codex-appserver, agent-grok, chat-model) carry git-tracked scripts/*.ts files (smoke tests, session validators) their OWN tsconfig excludes (include:['src']) → no TS program compiles them → the coverage-proof honestly keeps those members floored → host-global floor → EVERY find_usages on claude-ui stays complete=false. These strays have real cross-package alias usages (import @claude-ui/*) codemaster never searches. This is the git-tracked-source-surface ceiling (per the t-851482 discriminator: git-tracked .ts = in the source surface). Bigger question — options: widen a member's search to git-tracked TS under its dir that no program owns (with correct per-member resolution)? an optional syntactic scan of unowned source? Whatever the fix, it must resolve aliases correctly (a fallback-glob without paths/baseUrl would re-introduce the honest→lying hole). HIGH because it's the actual blocker to making the headline monorepo usable.
