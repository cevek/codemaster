---
id: t-980509
title: '`status` reports the isolation MODE but never the evidence, and costs an engine spawn to ask — no read-only "what would this repo get, and why" surface'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: feat
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T08:27:26.318Z'
---
On a 6.1k-file repo the recurring question is "will this workspace run in-process or in a child, and on
what evidence" — it decides whether a heavy op is safe to attempt at all.

Today `status` prints `isolation=process` but not WHY. When the answer was surprising, the only way to get
the reason was enabling `CODEMASTER_DEBUG` and grepping the daemon log for one trace line.

The inputs already exist at spawn — the source count, the threshold it was compared against, and the
closed `IsolationReason` union (`core/isolation.ts`) that the refusal messages already consume. Surfacing
them is nearly free:
  `isolation=process (auto-escalated: 6107 files > 4000)`
  `isolation=in-process (within budget: 629 files)`
  `isolation=in-process (pinned by config)`

Second, smaller, and it compounds: `status` itself routes and SPAWNS. So on an unfamiliar oversized repo
the very first orienting call is also the first memory commitment — exactly backwards. A pure
"what would happen" mode (routing + size decision only, no engine) would make it safe to ask before
committing.

Related: t-187018 (no read-only path to the isolation guarantee at all).
