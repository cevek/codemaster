---
id: t-950634
title: "A feedback test writes into the USER'S GLOBAL inbox: probing the op in a scratch workspace leaves entries a human must triage"
status: backlog
priority: medium
parent: t-490634
type: bug
complexity: S
area: platform
source: dogfood-jul
relates:
  - t-825985
surface:
  - src/ops/feedback.ts
audience: internal
evidence: measured
created: '2026-07-30T15:12:51.546Z'
---
## Observed, twice, in one session

A track verifying that `feedback` still records in a non-git / non-TS workspace ran the op against
`/private/tmp/cm-nongit` and `/private/tmp/cm-neither`. Both probes landed in
`~/.codemaster/feedback/inbox.md` — the REAL, machine-global inbox — as two entries titled `probe-nongit`
and `probe-neither` with the body `probe`.

They are not noise in a log. The inbox is a work queue with a stated invariant: **non-empty ⇒ something is
untriaged**. Every probe breaks that invariant and costs the triager a read to discover the entry is a test
artefact — and the triager cannot tell a probe from a real finding without reading it, which is precisely
the cost the invariant exists to avoid.

## Why it is the op's problem, not the tester's discipline

`feedback` is the one op whose entire effect is a WRITE to a user-global path, and it has no seam to redirect
that write. The usage logger already solved the same problem (`CODEMASTER_USAGE_DIR`, and the library default
is a no-op so tests touch no disk). `feedback` has neither: any test, any smoke run, any agent verifying that
the channel works, writes to the human's queue.

## Fix

Give it the same treatment as the usage logger: an env override for the inbox directory (or an injected sink
whose test default is in-memory), so verifying the channel does not require polluting it. Then a test can
assert the record was written — which is the only real assertion for this op — without a human paying for it
afterwards.

SECOND OCCURRENCE, same session: two more probes (`probe-nots-after`, `probe-unsupported`) reached the real inbox while a track verified the op across workspace shapes. Four artefacts from two tracks in one day — so this is the normal cost of testing the op, not an isolated slip, and it will recur on every future change to the same surface.
