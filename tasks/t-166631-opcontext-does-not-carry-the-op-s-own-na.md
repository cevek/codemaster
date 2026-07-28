---
id: t-166631
title: "`OpContext` does not carry the op's own name — a refusal cannot name itself, so the literal is threaded through ~17 call-sites with no type link, and a copy-paste with the wrong name compiles"
status: done
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

## Residual at closing: what the types make impossible, and what they do not

The op name is no longer a parameter anywhere a refusal is built. `OpContext.opName` is stamped by
the dispatcher from the `OpDefinition` it runs — the same object `opsByName` is keyed by, so there
is no second value that could disagree — and `ops/guard/refusal.ts` exposes `opRefusal(ctx, …)`,
which reads it and accepts no op-name argument. The source-derived oracle that used to check the
literal is deleted: it guarded a parameter that no longer exists.

What remains open, stated rather than instrumented: `semanticFanoutRefusal` takes a structural
`Pick<OpContext, 'opName'>`, so `semanticFanoutRefusal({ ...ctx, opName: 'other' }, …)` compiles. No
call site does it, and it takes a deliberate spread-override rather than a copy-paste — the class
this task was filed for is dead. It also cannot produce the split failure the original defect
caused: the head and the redirect read the SAME `ctx.opName`, so a wrong name moves the whole
refusal instead of making it self-contradictory.

Deliberately NOT covered by a source oracle. Adding one would restore the test-standing-in-for-a-
field pattern this task exists to remove, to cover a shape nothing produces.

`wireRefusal(requestName, …)` is the second and last entry point: the daemon failing requests whose
op never ran has no `OpDefinition`, so the wire request is the only authority for which call the
message is about. That is not a residual — it is the honest source on that path.
