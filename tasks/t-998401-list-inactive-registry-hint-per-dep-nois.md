---
id: t-998401
title: "list inactive-registry hint: per-dep noise-reduction — name only nested packages whose package.json declares the registry's activating dependency"
status: backlog
priority: low
tags:
  - dogfood
  - multi-program
type: feat
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-15T20:28:25.798Z'
---
**Context.** `list {registry}` §3.6 inactive-registry disclosure (`src/ops/list-inactive-hint.ts`) now names ALL nested packages (dirs with their own `package.json`, via `ts.nestedPackageLabels()`) when no registry-owning plugin is active at the queried root. This is the honest-wider default (over-hint ≫ silent-miss). In a large monorepo where NO package uses the registry's framework (e.g. `list{components}` with no react anywhere), it can name several packages as candidate `root:<dir>` — noise, though bounded to MAX_NAMED=3 + "+N more".

**Ask.** Filter candidates to nested packages whose OWN `package.json` declares the dependency that would activate the registry's owning framework plugin (e.g. only name a package for `components` if its package.json has `react`).

**Why deferred (blocker).** The registry→activating-dep map is `FRAMEWORK_PLUGINS` in `src/daemon/framework-plugins.ts` (L4). `list-inactive-hint.ts` lives in `ops/` (L3); importing the map upward violates the layering contract. Doing this cleanly needs plumbing the registry→dep knowledge DOWN to a layer `ops/` can import (a new `support/`/`common/` module, or a `Plugin`-surfaced "what dep activates me" accessor) — a cross-cutting refactor touching the daemon composition, out of scope for the t-865312 discovery work that introduced the wider hint.

Not a correctness gap (the current hint is honest, just occasionally noisy); purely noise-reduction. See t-865312 for the introducing change.
