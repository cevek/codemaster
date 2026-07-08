---
id: t-816306
title: Workspace-member discovery early-returns when there is NO root tsconfig.json (fallback primary) — claude-ui (the headline repo) is STILL fully floored despite t-000073
status: in-progress
priority: high
type: bug
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-08T11:16:40.958Z'
---
Surfaced by t-851482's measurement (Track C, Wave 4). t-000073 added workspace-member tsconfig discovery, but it only fires when a ROOT tsconfig.json exists: discoverSiblingConfigs early-returns [] when primaryConfigPath===undefined (discover.ts:46). REAL claude-ui has NO root tsconfig.json (only tsconfig.base.json + per-package configs; findConfigFile walks up, finds none) → primary = the '(no tsconfig)' FALLBACK → member discovery early-returns → NONE of the 10 members load → claude-ui is STILL 100% floored, the exact monorepo pain (9 inbox entries) t-000073 was meant to fix.

REPRO (live, current main): find_usages createCodexAppServerProvider --root claude-ui → complete=false, undiscoveredPrograms = ALL 10 members + tsconfig.base.json, allProgram=(no tsconfig). So t-000073's 'un-floor claude-ui' does NOT actually reach claude-ui (its DONE verification checked the discovery FUNCTION finding 10 configs on disk, not that they get LOADED — loading requires a primary config).

FIX DIRECTION: fire member discovery even without a primary tsconfig — either seed discovery from the workspace manifest independently of primaryConfigPath, or when primary is the fallback, use a discovered member (or tsconfig.base.json's references) to seed. HIGH: this is the headline repo; t-000073's real-world win depends on it. Does NOT reopen t-000073 (its root-tsconfig-present behavior is delivered + tested) — this is the distinct no-root-tsconfig case.
