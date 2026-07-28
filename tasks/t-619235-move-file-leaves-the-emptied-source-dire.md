---
id: t-619235
title: "`move_file` leaves the emptied source directory on disk — git doesn't track empty dirs, so `git status` is clean and nothing surfaces it"
status: backlog
priority: low
tags:
  - dogfood
  - ts-refactor
type: bug
complexity: S
area: ts-refactor
source: dogfood-jul
relates:
  - t-701638
surface:
  - ops
  - support
audience: external
evidence: repro
created: '2026-07-28T08:28:16.279Z'
---
`move_file {source:'src/components/DevWorktreeBadge/DevWorktreeBadge.tsx',
dest:'src/components/BuildBadge/BuildBadge.tsx', apply:true}` did everything right — moved the sibling
`.module.scss` too, rewrote importers, typecheck clean — but left `src/components/DevWorktreeBadge/` on
disk as an empty directory.

Git does not track empty dirs, so `git status` is clean and nothing surfaces the leftover; two independent
code reviewers flagged it as confusing local state to be `rmdir`ed by hand. The invisibility is the point:
a residue the VCS cannot show is one the agent cannot verify away.

Fix: after applying a move, remove the source directory when it is left empty — or report it in the result
so the caller knows to clean it (the §3.6 "report what we did" reading). Same likely applies to
`move_symbol` / `extract_symbol` when the last symbol leaves a file.
