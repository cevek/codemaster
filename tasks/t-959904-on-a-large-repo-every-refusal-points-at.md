---
id: t-959904
title: On a large repo every refusal points at ANOTHER refusal instead of at the op that would actually answer — make the redirects name the working path (the ambiguity error is the model to copy)
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: dx
complexity: M
area: render
source: dogfood-jul
created: '2026-07-27T23:33:13.806Z'
---
Converging report from all three workers of the OOM wave, sharpest from fd3acb2a: on a ~6k-file repo
codemaster is HONEST but nearly answerless, and its refusals chain into each other rather than landing
the agent on something that works.

Concretely, the loop an agent actually walks on backoffice2: `search_symbol` → size-guard, redirects to
`symbols_overview`; `find_usages` → fan-out guard, redirects to config/isolation; `list` → guard;
`find_unused_*` → guard. Each message is individually honest and individually actionable, and together
they read as "this tool does not work here". Meanwhile the ops that DO answer on that repo —
`symbols_overview`, `search_symbol {syntactic:true}`, `source`, `expand_type`, file-pinned
`find_definition` — carried three separate investigations to completion. That capability is real and
almost invisible at the moment of refusal.

The model to copy already exists in-repo: the ambiguity failure of `find_usages` (N declarations listed
with kinds + "pass file:line:col or a SymbolId — or mergeDeclarations:true") tells the agent exactly what
to do NEXT and why, in one line. Two workers independently called it the best error surface in the tool
and the size-guard redirect the weakest by comparison.

Ask: a refusal should name the concrete op+args that answers the SAME question on THIS repo, not a
configuration change or another guarded op. "You asked who renders <X> on a 6k repo — a file-pinned
find_definition + a syntactic search will answer; a repo-wide fan-out will not" beats "set
daemon.isolation".

Related (each fixes one link of the chain, none fixes the chain): t-034392 (stale banner steers to grep),
t-128204 (ambiguity ranks aliases first), t-691093 (`list` registry discovery), t-817058 (crash dump
buries the verdict). This task is the umbrella: refusals must be navigational, not merely honest.
