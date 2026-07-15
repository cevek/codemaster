---
id: t-865312
title: Auto-index an isolated nested package (its own tsconfig, NOT in a parent `references`, NOT a workspace-member glob) — today every symbol op on it FAILs; root-override is the only escape hatch
status: backlog
priority: medium
tags:
  - dogfood
  - multi-program
type: feat
complexity: L
area: multi-program
source: dogfood-jul
created: '2026-07-15T11:32:03.668Z'
---
**Pattern (repeated across sessions).** A repo whose entire frontend lives under `web/` with its OWN `web/tsconfig.json` + `package.json`, deliberately OUTSIDE the root tsconfig (no `references`, and the root is not a pnpm/workspaces monorepo that globs it). codemaster never loads `web/` as a program, so `find_usages{name:'EnumMenu'|'RelationSections'|'MultiSelectMenu'}` etc. FAIL "no symbol named X — 1 nested tsconfig NOT loaded (web/tsconfig.json)". This makes the tool unusable for the ENTIRE frontend of such a repo — exactly where TS/React symbol/refactor queries are most valuable.

**Confirmed workaround.** Pass a top-level `root:<abs path to web/>` on any op → codemaster resolves it with full proof-spans (parity with a normal root). So the escape hatch works and is worth documenting; the wish is to remove the need for it.

**Ask.** Auto-discover a child dir carrying its own `tsconfig.json`+`package.json` (even when NOT referenced and NOT a workspaces-glob member) and load it as an independent program — OR a config knob listing extra program roots. This is the residual t-000073 (sibling discovery = adjacent-dir + `references` + workspace-member globs) does NOT cover: a truly isolated, non-referenced, non-member nested package.

Inbox source: 2026-07-09 / 2026-07-10 (lines 112 / 119 / 185). Related: t-000073 (DONE), t-816306 (DONE). The confidently-WRONG find_definition half of line 185 is filed separately as t-673978.
