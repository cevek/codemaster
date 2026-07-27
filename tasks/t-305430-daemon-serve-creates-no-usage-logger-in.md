---
id: t-305430
title: "`daemon serve` creates no usage logger: in the DEFAULT (bridge+daemon) topology all telemetry is the bridge's, and daemon-side dispatch is unlogged"
status: backlog
priority: high
tags:
  - dogfood
  - platform
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-27T22:38:11.031Z'
---
`defaultUsageLogger()` is constructed at exactly one site, `src/bin.ts` `case 'mcp'`, and reaches
`serveMcp` on the three serving paths (`--in-process`, the daemon-unreachable fallback, and the
bridge). `daemon serve` (`src/bin.ts:151`) builds an orchestrator and calls `serveDaemon` — it
constructs NO usage logger, so nothing dispatched inside the daemon is logged there.

Consequences:
- Telemetry in the default topology is bridge-side. What it records is what the BRIDGE saw (including
  a transport error when the daemon dies), not what the daemon did — the args/response are the
  bridge's view, and a call served entirely daemon-side has no daemon-side record.
- The crash breadcrumb (t-807677) is likewise stamped by the bridge process. A daemon-only fatal is
  therefore attributed through the bridge's reply failure rather than by a daemon-side breadcrumb.

Decide explicitly: either the daemon is the telemetry owner (logger constructed in `daemon serve`,
bridge stops logging to avoid double-counting each call), or the bridge stays the owner and the
daemon's lack of a log is documented as intended. Today it is neither — an omission, not a decision.
