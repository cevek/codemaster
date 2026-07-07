---
id: t-237692
title: find_unused_scss_classes global-class pool is whole-program flat (no per-sheet attribution) — a same-named live class keeps a dead one alive (honest false-negative)
status: backlog
priority: low
type: bug
complexity: M
area: scss
source: dogfood-jul
created: '2026-07-07T21:52:03.172Z'
---
Residual from t-513259. The string-literal className resolution for GLOBAL sheets pools class tokens across the WHOLE program with no per-sheet attribution (global classes share one namespace). Consequence: a genuinely-dead global class that shares a NAME with a live class used elsewhere is hidden — a §3-compliant honest FALSE-NEGATIVE (never a false `certain`-dead; it under-reports, doesn't over-report). Also: const-folded strings (`const c='x'; className={c}`) aren't resolved (no dataflow) → stay `partial`.

Low value (misses-a-dead beats false-dead). Fix would need per-sheet attribution or light dataflow. fix-locus: src/plugins/ts/class-name-literals.ts, src/plugins/scss/plugin.ts.

Secondary cleanup: test/fixtures/repos/kitchensink/src/styles/theme.css has a now-STALE comment claiming theme-root is "referenced via string classNames codemaster can't resolve" — codemaster CAN resolve them now (t-513259); theme-root stays partial only because it's referenced nowhere. Update the comment to present-state.
