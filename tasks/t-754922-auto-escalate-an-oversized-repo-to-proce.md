---
id: t-754922
title: Auto-escalate an oversized repo to process-mode isolation transparently (no manual config) — the root fix for the OOM-crash class
status: backlog
priority: urgent
parent: t-031282
tags:
  - multi-program
  - platform
type: feat
complexity: L
area: platform
created: '2026-07-17T01:14:53.910Z'
---
Option 2 from the t-167395 backstop decision — the TRANSPARENT fix (vs the honest-refusal guard, which is the now-fix in the sibling high task). Instead of refusing a heavy fan-out op on an oversized in-process repo, DETECT the big repo at spawn (same cheap file-count as the size-guard) and raise THAT engine into process-mode even under the `in-process` default — so the op SUCCEEDS in an isolated, memory-bounded, killable child, transparently, with no manual config.

## Why DEFERRED, not now
Auto-escalation makes the op succeed by auto-routing the BIGGEST repos onto the NEWEST, least-proven code path — process-mode, whose full live `mcp → socket → serve-engine` path is not yet integration-tested (t-000052's own "не покрыто в изоляции"). Auto-mounting prod's hardest cases onto an un-proven path without explicit opt-in is exactly the bet §1 says not to make. It must EARN its way in.

## Preconditions (gate before picking this up)
1. The live process-mode integration E2E (`mcp` bridge → daemon socket → `serve-engine` child under a real MCP client) passes — the manager's post-keystone E2E.
2. Process-mode has accrued opt-in mileage (users running `isolation:'process'` without incident).

Until then the honest-refusal guard (sibling high task) holds the §1 line under the default config. This task is the transparency upgrade on top.

## Gate rewrite (manager call, dogfood-jul)

Precondition 2 as originally written — "process-mode has accrued opt-in mileage (users running
`isolation:'process'` without incident)" — is a SELF-DEADLOCK and is hereby replaced. It can never be
satisfied: the repos that need escalation carry no codemaster.config at all (backoffice2 has none), and
nobody opts into a mode they never hear about. A gate that cannot open is not caution, it is a
permanent block dressed as one.

What replaces it:

1. **(met)** The live process-mode integration E2E passes — t-605174, done.
2. **(new, must be verified before this task starts)** A child OOM in process-mode empirically produces
   an honest `ToolFailure{oom}` at the client with the daemon surviving — NOT another
   `MCP error -32000: Connection closed`. ARCHITECTURE §9/§19 CLAIMS this; the claim is untested.
   Auto-routing the heaviest repos onto a path that dies silently would relocate the crash, not fix it.
3. **(new)** A config escape hatch — `daemon.autoEscalate: false` — so a user can pin the old behavior.

Why the priority moved to urgent: the honest-refusal guard this task was deferred BEHIND has now failed
twice in production. `list {registry:'components'}` OOM-killed the daemon with no guard at all
(t-820448), and `force:true` — the escape the guard's own message advertises — killed it again
(t-693742). The per-op guard sprinkle treats the crash by removing the capability: on backoffice2
codemaster currently answers almost nothing. Escalation is the fix that makes the tool both safe AND
useful; the guard becomes advisory (anti-memory-bloat, its original t-333163 framing) once a warm that
would OOM lands in a killable child instead of the singleton daemon.

Honest scope: escalation guarantees crash-SAFETY, not capability. backoffice2's un-pruned fan-out is
~18k files (§9); in a child that is an honest `ToolFailure{oom}` instead of a dead daemon. That is
"codemaster stops lying and stops dying", not "find_usages now works there".
