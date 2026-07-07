---
id: t-000176
title: initialize`/reconnect "warm and ready (freshness:…)" line
status: backlog
priority: medium
type: dx
complexity: S
area: platform
created: '2026-07-08T00:02:55.000Z'
---
**`initialize`/reconnect "warm and ready (freshness:…)" line** — dogfood friction (amiro,
2026-06-28): after an MCP disconnect→reconnect the agent couldn't trust the first op would land,
so it fell back to grep. The MCP `initialize` response re-fires on every (re)connect (it's the
bridge re-attaching to the warm daemon) — emitting a one-line "warm and ready, roots=…,
freshness=…" there would rebuild trust on reconnect at near-zero cost. `mcp/` facade; own track.
`dx`·`med`·`cx:S`
