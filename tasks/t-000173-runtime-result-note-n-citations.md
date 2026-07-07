---
id: t-000173
title: runtime result-note §N citations
status: backlog
priority: low
type: dx
complexity: S
area: correctness
created: '2026-07-08T00:02:52.000Z'
---
**runtime result-note §N citations** — the status-notes density pass (concepts hoist + § strip)
scoped itself to `status`-rendered text (op `notes:`/`summary` + `concepts.ts`). MANY agent-facing
RUNTIME result-note strings still carry opaque ARCHITECTURE `§` refs the agent can't resolve —
this is NOT an exhaustive list (a closed list here would itself leak by §3.4): seen across
`src/ops/*` (e.g. codemod / mutation-support / transaction / refactor-apply / refactor-plan-apply)
and `src/plugins/scss/*` (e.g. cascade/resolve). FIND THEM ALL, don't enumerate: `grep -rn "§" src/`
then keep only the hits INSIDE an agent-facing string literal (skip code comments / doc refs). Strip
the `§` (keep the substance) for the same wrong-pocket reason. Left out of the density pass to avoid
touching logic-adjacent strings. (The leaks are PRE-EXISTING, not introduced by the density pass.)
`dx`·`low`·`cx:S`
