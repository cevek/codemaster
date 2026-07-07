---
id: t-000154
title: self-staleness banner missed after `daemon restart
status: backlog
priority: medium
type: bug
complexity: M
area: full-density
created: '2026-07-08T00:02:33.000Z'
---
**self-staleness banner missed after `daemon restart`** — ROOT CAUSE NOW KNOWN (see the
2026-06-21 bug-sweep HIGH items above): the "no daemon running" + stale-serving combo is the
**socket-path env-divergence** (bridge in `/tmp`, restart in `$TMPDIR` → different sockets) PLUS
the **one-shot staleness banner** (op/batch re-warns only once). The banner half is FIXED
(always-on prefix — see the FIXED HIGH item above); the socket half is being fixed on branch
`socket-path-fix`. `bug`·`med`·`cx:M`
