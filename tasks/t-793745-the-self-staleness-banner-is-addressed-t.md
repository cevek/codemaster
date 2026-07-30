---
id: t-793745
title: The self-staleness banner is addressed to the agent editing codemaster but is prefixed to EVERY connection's answers — an agent in another repo is told to restart a daemon it did not stale, discarding a third party's warm LS
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: dx
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-000016
  - t-000017
  - t-000018
  - t-000154
  - t-034392
  - t-534107
surface:
  - daemon
  - mcp
audience: external
evidence: repro
created: '2026-07-28T12:28:47.912Z'
---
`sourceStale` is a fingerprint of **codemaster's own `src/**`**, taken once per daemon at spawn
(`daemon/source-fingerprint.ts`) and re-checked behind a short TTL. The daemon is a machine-wide
singleton (§2), and `mcp/server.ts` prefixes `staleBanner(orchestrator.sourceStale())` to every op
and batch text response on every connection.

So the banner has one producer and two audiences:

- The agent that **edits codemaster** — for whom it is exactly right: its MCP path is serving
  pre-edit behaviour and `codemaster daemon restart` is the honest remedy.
- Every agent working in **another repository** (backoffice2, amiro, task-manager) sharing that
  daemon — for whom the same line is about a source tree it does not have, triggered by a change it
  did not make. Following the instruction restarts the shared daemon and discards the warm LS of
  every other connection, including the one that actually staled it.

The line is TRUE about the daemon in both cases; it is the remedy that is mis-addressed. An
external agent has no way to tell that "the code behind this answer moved" refers to codemaster's
own source rather than to its project, and the action it is told to take has a blast radius across
agents it cannot see.

Related, and the reason this matters beyond etiquette: the cross-agent cost of `daemon restart` is
link 3 of t-631032's causal chain — it is what makes the internal agent avoid the MCP path.
Composition parity on the CLI (t-631032) removes the fork in the road; it does not make the restart
remedy local.

Directions, none decided: scope the banner to connections whose resolved repo IS the codemaster
source tree; or state the ownership in the line itself ("codemaster's own source moved — this
affects every agent on this daemon"); or make the remedy local (per-connection re-attach to a
fresh engine) so restarting is not a shared action.

Found while building the CLI composition surface (t-631032), where the same signal is correctly
absent: a one-shot process is fresh by construction and prints no banner.

## External read of the banner (dogfood-jul, /Users/cody/Dev/amiro)

Reported verbatim by an agent in ANOTHER repo: `status` opened with "!! daemon code behind source — run
`codemaster daemon restart` to pick up edits (running pre-edit behavior)", and — "as a consumer I cannot tell
whether that degrades the answers I am about to get, or is purely a developer-of-codemaster notice. One clause
saying which would settle it."

So beyond being addressed to the wrong audience, the banner does not state its own CONSEQUENCE for the answer
in hand. Both halves are one wording fix: who it is for, and whether the data is affected.


## Closure

The banner no longer instructs an uninvolved reader to restart a daemon it did not stale, and it now
states its own consequence for the answer in hand.

- OWNERSHIP + consequence, in the line itself: `!! PRE-EDIT codemaster (src/ moved since start):
  your data is re-read fresh, the ANALYSIS is old.` — the external reader's verbatim ask ("as a
  consumer I cannot tell whether that degrades the answers I am about to get") is answered by the two
  halves being stated separately: inputs current (§3.5), analysis code behind its checkout.
- The REMEDY is no longer a bare instruction: the one-shot leads (any reader editing codemaster can
  run it), and the restart clause states its blast radius instead of commanding it — under a daemon
  it "hits every connection", under `mcp --in-process` it is a named no-op.
- The AUDIENCE is discriminated by the reader, not mechanically. A mechanical test ("is the caller
  inside our own `src/`") was rejected on evidence: this machine's servers run from the main checkout
  while codemaster-editing agents work in worktrees OUTSIDE it, so that test would label exactly the
  agents this fix is for as strangers and withhold the one-shot from them. What IS decided
  mechanically is the serving TOPOLOGY, which the composition root knows exactly.

The third direction the task lists (make the remedy local — a per-connection re-attach) stays unbuilt
and unneeded for this defect: the one-shot already gives every reader an in-session path that costs
no third party anything.
