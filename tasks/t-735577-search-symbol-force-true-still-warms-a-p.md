---
id: t-735577
title: search_symbol force:true still warms a pinned in-process oversized repo — the same loaded-gun the semantic guard just closed
status: backlog
priority: medium
tags:
  - platform
type: bug
complexity: S
area: platform
created: '2026-07-27T23:12:23.379Z'
---
The semantic fan-out guard no longer lets `force:true` override an in-process refusal (t-693742: forcing the warm killed the daemon, and the refusal text advertised force as the escape).

`search_symbol`'s own PEAK guard (t-333163 / t-399909, `src/ops/search-symbol.ts`) still honors `force:true` and still advertises it. On a workspace pinned in-process (`daemon.autoEscalate:false`, an explicit `isolation`, a failed fork) that is the same loaded gun: an uncatchable OOM in the daemon heap, reachable through an option the tool itself recommends.

Where the workspace is a killable child (the normal case since t-754922) forcing is safe by construction, so the fix is the same shape as the semantic guard's: honor `force` in process-mode, refuse it in-process.
