---
id: t-287742
title: '`feedback` records repo/version/ops but not WHO filed it — a finding cannot be traced back to the session that produced it, so repro requires asking a human to find the transcript'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: feat
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T08:31:12.083Z'
---
Every inbox entry carries `repo=`, `cm=<version>`, `plugins=`, `ops=` — enough to know WHERE it happened
and against what build, but nothing about WHO filed it. So a finding cannot be walked back to the session
that produced it.

This bites exactly where the stakes are highest. t-109741 (a design-system sweep that shipped an analysis
claiming a 3-file surface when the real one was 11) is written up from the reporter's own summary. Whether
the tool COULD NOT express the question, or could and the agent did not find how, changes what gets built
— capability vs steering — and only the call sequence answers that. Today recovering it means asking a
human which chat it was.

Ask: stamp an agent/session identifier into the envelope when one is available (the MCP client is already
identified at `initialize`; a `clientInfo`-derived id costs nothing). Fall back to a stable per-connection
id when no client identity is offered — an opaque handle is still enough to correlate a batch of findings
filed by the same session, which is most of the value.

Nothing here needs to be personally identifying: the goal is correlation, not attribution. A hash that is
stable within a session and meaningless outside it does the whole job.

Same envelope should carry the op sequence that PRECEDED the feedback call if it is cheaply available —
the usage log already has it (t-137057), so a timestamp + session id is enough to join them after the
fact rather than duplicating data.
