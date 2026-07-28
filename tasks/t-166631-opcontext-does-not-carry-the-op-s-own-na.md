---
id: t-166631
title: "`OpContext` does not carry the op's own name — a refusal cannot name itself, so the literal is threaded through ~17 call-sites with no type link, and a copy-paste with the wrong name compiles"
status: backlog
priority: high
tags:
  - dogfood
  - platform
type: feat
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T13:18:26.888Z'
---
An op cannot ask "what am I called". So making a refusal name the call that answers here (t-959904)
required threading the op's name as a literal through ~17 call-sites, each of which must match its own
`defineOp({name})` — with no link in the types. **A copy-paste carrying a neighbour's name compiles
silently**, and the resulting refusal would confidently name the wrong op.

The worker covered it with a required parameter plus a source-derived oracle, i.e. a TEST standing in for
a field. That works and is fragile in the usual way: the oracle protects today's call-sites and not the
next one.

Broader than the refusal surface — every "which op said this" consumer reinvents it:
- the daemon-side telemetry breadcrumb derives `tool` from the REQUEST COUNT because the invoking name
  never crosses the socket (§13, and the residual ambiguity is t-954198);
- debug traces are namespaced `op:<name>` by hand;
- the disclosure ledger (t-876408) labels records by target, not by producer.

Ask: put the op's identity on `OpContext`, populated by the dispatcher from `OpDefinition.name` — the one
place that already knows it, by construction rather than by convention. Then the literal disappears from
every call-site, the oracle becomes unnecessary, and a wrong name becomes impossible rather than merely
tested-against.
