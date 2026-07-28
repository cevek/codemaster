---
id: t-793745
title: The self-staleness banner is addressed to the agent editing codemaster but is prefixed to EVERY connection's answers — an agent in another repo is told to restart a daemon it did not stale, discarding a third party's warm LS
status: backlog
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
