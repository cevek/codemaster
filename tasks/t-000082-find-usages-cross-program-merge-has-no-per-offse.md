---
id: t-000082
title: "find_usages` cross-program merge has no PER-OFFSET oracle"
status: backlog
priority: low
type: dx
importance: low
complexity: M
area: multi-program
created: '2026-07-08T00:01:21.000Z'
---
**`find_usages` cross-program merge has no PER-OFFSET oracle** — the differential test pins the
file SET against a cold `tsconfig.test.json` program, but not within-file ref counts/offsets or
overload/merged-symbol dedup. Add a per-offset cross-program assertion + an overloaded-symbol
dedup fixture. `dx`·`low`·`cx:M`
