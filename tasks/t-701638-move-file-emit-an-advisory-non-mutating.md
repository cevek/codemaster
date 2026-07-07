---
id: t-701638
title: 'move_file: emit an advisory (non-mutating) list of stale prose/comment/`.md` mentions of the moved basename/module-stem'
status: backlog
priority: low
tags:
  - dogfood-jul
type: feat
importance: low
complexity: M
area: ts-refactor
created: '2026-07-07T20:06:58.240Z'
---
Inbox entry 2 (`code-diff`), 2026-07-01. `move_file` repoints import specifiers only; non-import string references to the old basename survive silently (a jsdoc "reuses the `working-tree` primitives", two `docs/backlog.md` filename mentions) — the class of stale refs `tsc` never flags. Ask: after a `move_file`, emit an advisory list of remaining occurrences of the old basename/module-stem in comments, jsdoc, and `.md` files across the repo, so the caller can decide which are the moved module vs. an unrelated homonym. Surfacing candidates only — auto-editing prose would be wrong (can't disambiguate homonyms, e.g. the git "working tree" concept legitimately keeps the name). Same advisory would suit rename_symbol.
