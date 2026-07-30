---
id: t-063173
title: "codemaster daemon restart / stop report no blast radius: the verb drops every OTHER connection's warm LS and never says so"
status: backlog
priority: low
type: dx
complexity: S
area: platform
source: dogfood-jul
relates:
  - t-034392
  - t-187018
  - t-793745
surface:
  - src/daemon/manage.ts
audience: both
evidence: repro
created: '2026-07-30T13:39:25.071Z'
---
The daemon is a machine-wide singleton, so `codemaster daemon restart` (and `stop`) tears down the warm
LanguageService of EVERY connected client — other agents, other repos, other worktrees — not just the caller's.
`daemon/manage.ts:117` reports what it did to the daemon and never names that cost.

Distinct from t-793745 / t-034392 (the self-staleness BANNER, which addressed the wrong audience and named an
expensive remedy without its cheap alternative — both fixed): here the audience is correct by construction
(the user typed the verb), and the defect is a plain omission of the verb's blast radius. That is DX, not a
false claim, hence low.

Worth stating because the caller usually cannot see the cost: the other connections belong to other sessions,
their re-warm is silent, and the only symptom is that somebody else's next call takes tens of seconds. One
clause on the verb's own output ("N connection(s) were attached; each re-warms on its next call") closes it.
