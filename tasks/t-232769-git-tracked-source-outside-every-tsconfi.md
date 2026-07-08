---
id: t-232769
title: Git-tracked source outside EVERY tsconfig (e.g. package scripts/*.ts) is unsearched → keeps claude-ui at complete=false even after member discovery
status: done
priority: high
type: imp
complexity: L
area: multi-program
source: dogfood-jul
created: '2026-07-08T12:47:45.993Z'
---
DONE (75fc140). Git-tracked source outside a member's tsconfig include (claude-ui packages/*/scripts/*.ts) is now SEARCHED: each member's strays are injected into that member's OWN SingleProgram (its compilerOptions/paths) → alias imports resolve exactly as the member's src → the member un-floors. Coverage-union counts ONLY correct-resolution coverage (real-config programs + injected strays), EXCLUDING the no-config fallback glob → a fallback-only-globbed file never subtracts its config (stays floored, any repo). Guards: OWN-GLOB (a stray a wrong-options ancestor globs still injects into its member), POLLUTION gate (a declare-global/ambient/non-module stray is NOT injected — would shift the member's real symbols), WARM-ADD refresh (reindex injects a just-added stray). new program/coverage.ts (computeCoverage); single.ts injectedFiles; ls-host memoizes. 7 discriminating differential tests incl the anti-lie fallback-only + pollution cases.

VERIFIED-LIVE (manager re-ran at merge): find_usages(MeshBridgeHost) --root claude-ui → complete=TRUE, floor=0 (was complete=false, floor=4); the 3 scripts/smoke.ts alias-usages found + attributed to each member's own program (correct resolution). THE HEADLINE MONOREPO IS NOW HONESTLY COMPLETE.
