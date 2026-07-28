---
id: t-002010
title: The sql assemble() catch arm returns a bare DispatchError, so it is the one envelope exit with no disclosure channel
status: backlog
priority: low
tags:
  - agent-surface
type: imp
complexity: S
area: impact-usages
source: dogfood-jul
relates:
  - t-071368
  - t-316487
surface:
  - daemon
audience: both
evidence: reported
created: '2026-07-28T11:49:25.620Z'
---
`daemon/sql-batch.ts` `assemble()` has three failure exits. Two carry the producers' resolve-time
disclosures (the runner-load failure and the SELECT-not-run arm); the third — the `catch` that
reports a bad SELECT as `{kind:'bad_args'}` — returns a `DispatchError`, which structurally has no
envelope and therefore no `disclosures` field.

Trigger: `batch([{name:'find_usages', args:{name:'Span'}, as:'t'}], {sql:'SELECT nonexistent_col FROM t'})`
against a repo where `Span` resolves off a cut candidate set → `bad_args` with no claim.

Nothing is LOST: no answer is returned, the agent must fix its SQL, and re-running re-discloses. That
is why this is not a correctness defect. What it is: the one exit of a function whose two siblings
were deliberately given the channel, which is exactly the shape that reads as an oversight to the next
person editing it — and the arm agents hit most often, since it fires on their own SQL.

Options: route it through `fail({tool:'sql', …}, {disclosures})` (changes the error KIND for a bad
SELECT, so check what consumes `bad_args` first — the pointed schema listing is the reason it is a
dispatch error today), or leave the shape and append the claim to the message. Decide which, then
make the third exit stop being the odd one out.
