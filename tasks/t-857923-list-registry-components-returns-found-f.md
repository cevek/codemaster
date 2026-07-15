---
id: t-857923
title: "list registry:'components' returns a bare found=false/available(0) where the react plugin is INACTIVE at the queried root (components live in an unindexed nested package) — silent miss, no honest 'plugin not active / try root:<dir>' (VERIFIED: works on amiro=652, task-manager web=10)"
status: done
priority: medium
tags:
  - dogfood
type: bug
complexity: M
area: framework
source: dogfood-jul
created: '2026-07-15T11:32:39.069Z'
---
## Verified (usage log + agent transcripts, 2026-07-15)
`list {registry:'components'}` was called 3× across repos:
- **amiro** (transcript sessions/fe340853): `found=true`, owner=react, **652** component entries with proof spans — the registry WORKS.
- **task-manager** at root: `found=false`, `available (0)`, `entries (0)`. Same repo with `root:'…/web'` (the nested SPA): `found=true`, 10 components (Card/Board/…).
- **claude-ui** at root with `pathInclude:['**/*Header*','**/*Top*','**/ChatView*','**/AppShell*']`: `found=false`, `available (0)`, `entries (0)`.

## Root cause (NOT a broken registry, NOT a pathInclude bug)
`found=false` occurs ONLY where the react plugin is INACTIVE at the queried root — the components live in an UNINDEXED nested/sibling program (task-manager's `web/`; a claude-ui monorepo app). The tell is `available (0)`: when react IS active it exposes 6 registries (components/dialogs/hooks/mutations/queries/queryKeys — as amiro shows); here ZERO registries = plugin produced nothing for that root. So pathInclude is a red herring — the registry was empty BEFORE any filter (the claude-ui call would have returned 0 regardless of globs).

This is the SAME class as t-865312 (isolated nested package not auto-indexed): pointing `root:` at the actual react package makes it work (task-manager web → 10; amiro → 652).

## The distinct bug to fix here (honesty)
`list` returns a bare `found=false / available(0) / entries(0)` that reads as "this repo has NO components" — a §3.6 silent miss. When `available (0)` (no plugin produced any registry) AND an unindexed nested tsconfig / inactive framework plugin exists, `list` must say so honestly: e.g. "react plugin not active at this root — components may live in an unindexed nested package; try root:<dir>" or an explicit "plugin not active". Distinguish "registry genuinely empty" from "no framework-active program indexed here".

## Fix split
- Make it WORK at root → t-865312 (auto-index the nested package).
- Make it HONEST when it can't → this task (turn the bare found=false/available(0) into an actionable "plugin-not-active / try root" disclosure).

Inbox source: 2026-07-14 (line 299). Related: t-865312, t-000026 (react autodetection), t-673978 (the find_definition analogue of the same silent-miss class).
