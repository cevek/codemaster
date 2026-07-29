---
id: t-977443
title: Bridge convergence hands back a daemon in teardown (connectivity, not service)
status: backlog
priority: medium
tags:
  - daemon
  - platform
type: bug
complexity: M
area: platform
relates:
  - t-000053
  - t-301355
surface:
  - daemon
audience: both
evidence: reported
created: '2026-07-29T11:50:29.927Z'
---
`connectOrSpawnDaemon` treats a successful `connect()` as a live daemon, but a daemon in teardown
still accepts until its listener closes. So a bridge starting in the window around a `daemon
restart` — or an idle-exit — converges on the daemon that is leaving: its first request comes back
as the closed-mid-call error and the spawn that would have produced a live daemon never fires. The
`mcp` path recovers only because the NEXT call reconnects.

The management verbs answer this with a SERVING verdict (t-301355), which the bridge cannot simply
reuse: a `daemon-info` round-trip on every connect puts a reply deadline in the hot start-up path
the convergence exists to keep cheap.

Options to weigh: probe only after a first request fails with the closed-mid-call code, then
re-converge once · close the listener before draining links so a connect in that window fails fast ·
a serving handshake that rides the existing round-trip. `bug`·`med`·`cx:M`
