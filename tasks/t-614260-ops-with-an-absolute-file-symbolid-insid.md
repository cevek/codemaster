---
id: t-614260
title: Ops with an absolute `file`/`symbolId` inside a worktree FAIL "file not in the TS project" unless a redundant `root` is also passed — infer root from the absolute path
status: backlog
priority: medium
tags:
  - dogfood-jul
type: dx
importance: medium
complexity: M
area: platform
created: '2026-07-07T20:05:53.628Z'
---
Inbox entries 31 + 341 (part), 2026-07-06. `impact_type_error {file:'/Users/cody/Dev/worktrees/task-manager/track-f-config/src/model/config.ts'}` (an absolute path unambiguously inside a git worktree) → `FAIL tool=ts-ls — file not in the TS project: <that path>`. Re-issuing the identical call with an added top-level `root:'/Users/cody/Dev/worktrees/task-manager/track-f-config'` worked.

An absolute `file`/`symbolId` path already pins the workspace — the root is inferrable as the nearest enclosing `tsconfig`/`package.json` at-or-above the path. As-is, an agent working in a worktree that isn't codemaster's default cwd hits an opaque FAIL on the first call and must know to add `root`.

Ask: (a) auto-resolve `root` from an absolute `file`/`symbolId`, or (b) make the FAIL name the fix — `pass root=<inferred dir>`. Entry 341 is the sibling-root cousin: `find_usages` with a `file` arg belonging to a sibling root FAILs with no `did you mean root:<x>?` hint.
