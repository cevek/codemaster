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
relates:
  - t-137057
  - t-810757
surface:
  - ops
  - support
audience: internal
evidence: measured
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

## The id is an ADDRESS, not just a correlation key — which makes this materially more valuable

The session id in `~/.myclaude/projects/<project>/sessions/<id>/` IS the agent id. So an author stamped
into a feedback entry is not merely traceable, it is **reachable**: the reporter can be asked directly
about its own finding, and it still holds the track's context (measured on four such agents from this
week: 27–80% context in use, all addressable, archiving does not affect it).

That changes what the field buys. Today, understanding a finding means a human locating the chat, then an
agent reading a transcript and inferring intent. With the id in the envelope, the loop is: read the
finding → ask its author "did you try X, and what did it return" → get an answer from the agent that was
there. No human relay, no inference from a call log.

Worked example from this wave: t-109741's origin (`7237bc5c`) had to be recovered by grepping
`~/.myclaude/projects` for the text of the feedback call itself. It worked, but only because the entry
happened to contain distinctive strings. A finding phrased in generic terms would not be recoverable at
all — and the mechanism is doing by hand what one field would do by construction.

So the ask sharpens: stamp the agent/session id, and treat it as the reply address for the finding.
Correlation with the usage log (t-137057) then comes for free on the same key.

## Also stamp the repo's HEAD — a `file:line` filed from a moving tree decays immediately

The envelope records `repo=` but not what the repo WAS. Findings are filed mid-track, from a worktree the
reporting agent is actively editing, so every `file:line` in a feedback entry is a coordinate into a tree
that no longer exists — sometimes within hours.

This already bit two tasks from this drain (t-849286, t-159797), both of which had to be annotated
"coordinates are historical, re-derive by name". In the second case the decay is worse than drift: that
track's whole purpose was changing the contract its examples were classified against, so the examples may
have been resolved by the work that surfaced them. A reader who takes them literally audits code that no
longer has the property.

Fix: stamp `rev=<git HEAD>` (plus a dirty flag) alongside `repo=` at filing time. Then a reader can
`git show <rev>:<path>` the exact state the claim was made against, or at minimum know how far the tree has
moved. Cheap — the fingerprint machinery already computes HEAD on every request for the §3.5 freshness
check, so this is reading a value that is already in hand.

Ranked against the session-id ask above: the id gives you the REASONING behind a finding, the rev gives
you the CODE it was true of. Both are needed to reproduce; neither substitutes for the other.
