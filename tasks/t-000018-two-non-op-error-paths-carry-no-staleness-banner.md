---
id: t-000018
title: "two non-op error paths carry no staleness banner"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: bug-sweep
created: '2026-07-08T00:00:17.000Z'
---
**two non-op error paths carry no staleness banner** — `runOpTool`'s `result === undefined` ("no
result (codemaster bug)") sentinel and the `handleCall` top-level `catch` (internal-error) return
bare error text with no banner (`src/mcp/server.ts`). Both are exception/edge paths (an empty
results array from a non-failing outcome; an escaped throw), negligible in practice — flagged for
completeness so the banner-coverage isn't mistaken as total. `bug`·`low`·`cx:S`
