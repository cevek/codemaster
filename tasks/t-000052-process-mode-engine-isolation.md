---
id: t-000052
title: process`-mode engine isolation
status: backlog
priority: medium
parent: t-031282
type: feat
complexity: L
area: platform
created: '2026-07-08T00:00:51.000Z'
---
**`process`-mode engine isolation** — one child process per workspace (§2/§9): own heap +
`--max-old-space-size`, OS-reclaim-on-kill, real cross-workspace parallelism, and the
kill-on-deadline backstop that reaps a wedged engine/daemon (above). The daemon would own the
child engines. `feat`·`med`·`cx:L`
