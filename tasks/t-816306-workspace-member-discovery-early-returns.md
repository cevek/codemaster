---
id: t-816306
title: Workspace-member discovery early-returns when there is NO root tsconfig.json (fallback primary) — claude-ui (the headline repo) is STILL fully floored despite t-000073
status: done
priority: high
type: bug
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-08T11:16:40.958Z'
---
PART 1 DONE (53ff931): workspace-member discovery now fires with NO root tsconfig.json — discoverSiblingConfigs no longer early-returns on undefined primary; seeds source-2 (members) + source-3 (references BFS) independently, primary stays the '(no tsconfig)' fallback (no rootTag/overlay/gate blast radius). claude-ui: floor 10→4, the 7 clean members load as correct per-package programs. Verified live (independently re-run): find_usages createCodexAppServerProvider / MeshBridgeHost --root claude-ui → floor 4, complete=false, MeshBridgeHost (smoke.ts alias-imported) honestly reads complete=false — the miss disclosed, NO completeness lie (the coverage-proof keeps stray-bearing members floored because the fallback doesn't glob scripts/*.ts).

NOT fully 'claude-ui complete': it stays complete=false because 3 members carry git-tracked scripts/*.ts strays their own tsconfig excludes (include:['src']) → no program compiles them → honestly floored (host-global floor). That real ceiling = the follow-on task (git-tracked source outside every tsconfig). Base-subtraction (part 2) deferred (no-op on claude-ui + soundness risk).
