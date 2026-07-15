---
id: t-272300
title: Detect phantom/undeclared dependencies — per workspace package, flag every bare-module import whose specifier is NOT in that package's own package.json (resolved only via pnpm hoisting)
status: backlog
priority: medium
tags:
  - dogfood
  - multi-program
type: feat
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-15T11:32:15.779Z'
---
**Motivating incident.** A "fails only locally" import error: `apps/emr` imports `@mui/material` in 98 files (+ `@mui/icons-material` in 9), but neither is declared in `apps/emr/package.json` — they resolve only via pnpm hoisting to the workspace-root node_modules. Works in CI/clean installs, breaks locally when node_modules drifts.

**Ask.** An op that flags, per workspace package, every bare-module import whose package specifier is NOT in that package's own dependencies/peerDependencies/devDependencies (resolved-but-undeclared = phantom). codemaster already builds the import graph + resolves specifiers, so it has the data. Output rows: `{importer, specifier, resolvedFrom (which package.json actually provides it), importSiteCount}`.

This is an import-graph question grep can't answer cleanly (grep lists import sites but can't cross-check declaration/hoist origin). Note: the reporting agent flagged this as a scope-boundary wish — it did NOT route the actual investigation through codemaster because it was a fs/dependency-resolution question — but the phantom-import DETECTION itself sits in codemaster's import-graph wheelhouse.

Inbox source: 2026-07-14 (line 284).
