---
id: t-000017
title: facade-level rejects (pre-dispatch) stay banner-free on a stale daemon
status: backlog
priority: low
type: bug
complexity: S
area: platform
created: '2026-07-08T00:00:16.000Z'
---
**facade-level rejects (pre-dispatch) stay banner-free on a stale daemon** — two per-op paths
reject BEFORE the orchestrator round-trip, so they carry no self-staleness marker even when the
daemon is source-stale: `badArgsOp` (`src/mcp/server.ts` `runOpTool`, the `!built.ok` branch) and
the `unknown tool` guard (the `opNames.has` miss). On a stale daemon with an old arg-schema/op
catalogue these could themselves be staleness artifacts, so the restart remedy doesn't reach
them. Narrow + low-value (the format is unparsed in the bad-args case, so json-suppression is
ambiguous; the `unknown tool` guard fires off the BRIDGE's own catalogue, not the daemon's, so it
isn't really a daemon-staleness signal). `bug`·`low`·`cx:S`
