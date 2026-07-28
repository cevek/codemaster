---
id: t-248218
title: '`impact_type_error`''s summary frames the OUTPUT (type errors) not the INPUT (a proposed contract change) — so the op that computes "what breaks if I change this declaration" is not found at the moment that decision is made'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-28T08:28:26.495Z'
---
Self-reported miss from worker 668b2fe3, about STEERING rather than capability.

The load-bearing decision of that track was whether `UsageLogger.begin()` should be REQUIRED or optional.
Required ⇒ every implementation must be updated and an incomplete one is a compile error; optional ⇒ a
future implementation silently omits the breadcrumb, re-opening the invisible-fatal hole being fixed. The
question that decides it is exactly "what tsc errors does making this member required introduce, and
where?" — which is precisely what `impact_type_error` computes (trial-edit overlay vs baseline).

It was not used. The worker grepped for implementations, reasoned, escalated the contract question to the
manager, and waited for a ruling: two rounds and a human-in-the-loop for something the tool computes.

Why it was missed: at the moment of decision the thought was "who implements this interface, and what
breaks if I add a member". Nothing in the name maps to that — `impact_type_error` reads as a
diagnostic-inspection op adjacent to `impact` (a reference blast radius), and its summary frames type
errors as the OUTPUT rather than a proposed change as the INPUT. The ops that DID surface were
`find_usages` and `member_usages`, both answering the strictly weaker "where is it referenced" — a
reference site that still compiles is not the interesting set.

Ask (not a rename — the name is accurate and renaming a public op is expensive): lead the summary/argsHint
with the QUESTION, in the words an agent has at that moment — "propose a change to a declaration /
signature / type — get the real tsc errors it would introduce". Same phrasing in `status`'s one-line
catalogue, since that catalogue is what an agent scans before changing a contract.

Plus a cross-reference: a `find_usages` answer on an INTERFACE or TYPE could carry one line — "changing
this declaration? `impact_type_error` reports the diagnostics your edit would introduce" — because that is
the natural next question after "here is where it is referenced", and it is exactly where the agent stops
and starts reasoning on its own. Same family as t-959904 (refusals should name the working path).
