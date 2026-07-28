---
id: t-009660
title: 'Name-resolve candidate counts are not cold==warm: the loaded program set grows with a session (file-driven nearest-config programs), so a warm daemon can see more declarations than a cold one'
status: backlog
priority: low
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T07:34:40.638Z'
---
`searchSymbols` fans navto over `host.programs()`, which includes the file-driven nearest-config
programs loaded lazily by earlier READ calls (§5-L2). So the candidate set a name resolves to — and
therefore the ambiguity count, and whether a name is ambiguous at all — can differ between a cold
daemon and a warm one that happened to load a nested config earlier in the session.

§16 invariant 3 (`cold == warm`) is stated per plugin for op answers; this path can violate it
without any file changing. The mechanism predates the ambiguity-honesty work (t-128204) — that
change only made the count prominent enough to notice, and its own ordering is deterministic given
a fixed program set.

Not a lie in the §3 sense (each listed candidate is real and proof-carrying), but a reproducibility
gap: an agent re-running the same query after unrelated calls can get a different verdict. Options
to weigh: resolve names over the BUILT set only (primary + siblings, the same set the write paths
already use for exactly this determinism reason), or disclose the session-loaded programs in the
message.
