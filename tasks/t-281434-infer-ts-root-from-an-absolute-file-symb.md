---
id: t-281434
title: Infer TS root from an absolute file/symbolId path when no `root` is passed (convenience follow-up to t-614260)
status: backlog
priority: low
tags:
  - dogfood-jul
type: dx
complexity: M
area: platform
created: '2026-07-07T20:42:01.902Z'
---
Split off from t-614260. Once absolute-path normalization is fixed (t-614260 part a), an absolute `file`/`symbolId` still requires an explicit `--root`/`root` when the client cwd isn't inside the target repo. The filed convenience — infer the root from the absolute path itself (git-toplevel it) — was deferred because `route(cwd, root?)` is deliberately arg-AGNOSTIC: making the orchestrator peek into `req.args` for a path-shaped field to derive root couples routing to per-op arg shapes (fragile, a layering smell).

If built: do the inference at the op/resolve layer (which already knows the arg shape), not in daemon routing. Honest failure if the absolute path is outside every known repo. Low priority — passing `root` (or an in-repo cwd) already works after t-614260.
