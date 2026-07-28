---
id: t-534107
title: Every FAIL footer prints MCP call syntax (`feedback({kind:'bug', …})`) including on the CLI path, where the working form is `codemaster op feedback '<json>'` — and the CLI is disproportionately the tool-editing population
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: bug
complexity: S
area: render
source: dogfood-jul
relates:
  - t-034392
  - t-534166
  - t-793745
surface:
  - cli
  - format
  - mcp
audience: both
evidence: repro
created: '2026-07-28T12:52:09.424Z'
---
`render-result.ts:69` appends to the footer of every FAIL: `— blocked or missing a capability? file it:
feedback({kind:'bug', title:'…', detail:'…'})`. That is MCP tool-call syntax, and it is printed on the CLI
path too, where the working form is `codemaster op feedback '<json>'`.

Same class as t-793745 (the stale-daemon banner): one shared renderer emits text that is correct for one
caller and wrong for the other, with nothing in the message indicating which.

The cost lands on the wrong population, and precisely the one we most need to hear from: whoever is on the
CLI is disproportionately the agent EDITING codemaster (t-631032 explains why they are there), i.e. exactly
the caller most likely to have something to file. The invitation to report is printed in a form they
cannot execute.

Found by the reporter while filing this very note.

Fix: the footer is transport-specific and belongs behind the same seam as the other per-surface text
(§12-cap and the staleness banner are already MCP-facade-only, per the parity work in t-631032) — or it
names both forms in one clause. Cheap either way; the point is that a shared renderer must not assert
caller-specific syntax as if it were universal.
