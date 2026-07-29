---
id: t-301355
title: daemon verbs read connectivity as service, so `restart` can leave nothing running
status: done
priority: high
tags:
  - daemon
  - platform
type: bug
complexity: M
area: platform
relates:
  - t-000053
  - t-000057
surface:
  - daemon
  - support
audience: both
evidence: repro
created: '2026-07-29T11:50:16.916Z'
---
A daemon committed to exit still ACCEPTS — the kernel completes a connect into its backlog until
the listener closes — so a bare `tryConnect` cannot tell a live daemon from the one being replaced.
The verbs act on a closed SERVING verdict instead (`daemon/manage-probe.ts`: `serving | legacy |
wedged | draining | none`): `start` waits a `draining` daemon out (bounded) before spawning, refuses
to spawn into a socket a wedged/draining one still holds (a spawn there loses the bind race and dies
silently), and claims a start only when a daemon answered as live — a `restart` exiting 0 with
nothing running is the §3.6 lie the verdict exists to prevent.

`draining` is distinguishable because `awaitReply` settles `closed` on a dropped link rather than
running out its deadline and reporting `timeout` — "unresponsive" about a daemon provably gone is
the same lie with the opposite remedy — and because `TransportConnection.onClose` delivers an
already-happened close to a late-registered handler.

Oracles: `test/unit/daemon-manage-drain.test.ts` (the fixture declares what occupies the socket at
each probe), `test/e2e/transport-unix-socket.test.ts` (late-onClose on a real socket). Residual:
t-977443. `bug`·`high`·`cx:M`
