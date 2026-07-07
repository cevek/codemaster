---
id: t-000066
title: "idle-exit brackets only `CallTool`, not `ListTools"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: platform
created: '2026-07-08T00:01:05.000Z'
---
**idle-exit brackets only `CallTool`, not `ListTools`** — the Stage-1 idle deadline
(`src/mcp/idle-exit.ts`) is reset by any `CallTool` (per-op / `status` / `batch`) but NOT by `tools/list`.
Harmless and arguably correct (listTools is instant; an orphan that only ever lists tools
should still reap, and a tool-active client resets the deadline on its next real call), but
formally one request type sits outside the enter()/leave() bracketing. Note for when the
Stage-2 daemon owns the lifetime. `dx`·`low`·`cx:S`
