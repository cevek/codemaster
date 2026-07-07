---
id: t-994174
title: Path-filtered ops silently return 0 on a bare-dir `pathInclude` — reads as symbol absence (search_symbol has no `filterMatchedNoFiles` warning)
status: done
priority: high
tags:
  - dogfood-jul
type: bug
complexity: S
area: full-density
created: '2026-07-07T20:04:23.454Z'
---
**Confirmed on current `main`, 2026-07-08.** A bare directory in `pathInclude` (no `/**`) matches 0 files and, for `search_symbol`, is reported as a plausible **symbol absence** rather than a filter miss — a completeness lie (an agent concludes the symbol doesn't exist). Inbox entries 20, 27, 172-ish, 237, 394.

Probes:
- `search_symbol {query:'Engine', pathInclude:['src/daemon']}` → `matches (0); note=no symbols matching 'Engine'`. With `['src/daemon/**']` → **17 matches**.
- `find_unused_exports {pathInclude:['src/core']}` → already warns `filterMatchedNoFiles=pathInclude/pathExclude matched 0 files — NOT proof that no exports are dead`.

So the honesty warning exists for `find_unused_exports` but **not** for `search_symbol` (and likely other path-filtered ops: `find_usages.filter`, `list`, `construction_sites`). Ask: either (a) treat a bare dir path as an implicit prefix / auto-`/**` glob, or (b) extend the `filterMatchedNoFiles` warning to **every** path-filtered op so a self-defeating filter never reads as an empty/absent result. Cross-links t-000010 (the complementary find_unused_exports per-pattern-miss warning).
