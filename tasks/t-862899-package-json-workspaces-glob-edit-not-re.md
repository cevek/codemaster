---
id: t-862899
title: package.json 'workspaces' glob edit not re-discovered until reindex/respawn (freshness asymmetry with the wired pnpm-workspace.yaml path)
status: backlog
priority: low
depends_on:
  - t-000073
type: bug
complexity: S
area: multi-program
source: dogfood-jul
created: '2026-07-08T09:46:36.342Z'
---
Fast-follow from t-000073 (ask 1). pnpm-workspace.yaml IS wired into the structural-reindex trigger, but editing a package.json 'workspaces' glob whose member tsconfig already exists on disk isn't re-discovered until the next tsconfig-change reindex or respawn. CONSERVATIVE / safe direction — the un-rediscovered member stays FLOORED (more-partial), never a false certain-dead, so not a never-lie violation. Close by adding package.json to the discovery-relevant reindex trigger IF it can be scoped to not churn on every install (the reason it was left out). Non-blocking.
