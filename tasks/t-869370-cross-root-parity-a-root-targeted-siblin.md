---
id: t-869370
title: 'Cross-root parity: a root:-targeted sibling repo loads ITS OWN tsconfigs (t-000073 ask 3)'
status: done
priority: medium
depends_on:
  - t-000073
type: imp
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-08T09:11:26.417Z'
---
DONE (a1a045a) — satisfied by prior work + locked with tests. A root:-targeted sibling repo ALREADY loads its own tsconfigs: a per-root FULL engine (pluginsFor -> createTsPlugin(repoRoot) -> createTsProjectHost(repoRoot)) runs the SAME discovery (root + siblings + workspace members + t-232769 stray-injection) as the primary. The cross-root incompleteness in the original dogfood entries (39/42) was PRE-t-816306 (no no-root member discovery then). Verified live by the manager: find_usages(MeshBridgeHost) --root claude-ui -> complete=true, 12 usages, floor=0 (a cross-root query). Deliverable = 3 oracle-backed cross-root differential tests (complete-when-complete, floored-sibling-still-floors, cross-root x programs: resolve against target root). No production code needed.
