---
id: t-701638
title: 'move_file: emit an advisory (non-mutating) list of stale prose/comment/`.md` mentions of the moved basename/module-stem'
status: backlog
priority: high
parent: t-915659
tags:
  - dogfood
type: feat
complexity: M
area: ts-refactor
source: dogfood-jul
relates:
  - t-120055
  - t-326222
  - t-619235
surface:
  - ops
audience: external
evidence: reported
created: '2026-07-07T20:06:58.240Z'
---
Inbox entry 2 (`code-diff`), 2026-07-01. `move_file` repoints import specifiers only; non-import string references to the old basename survive silently (a jsdoc "reuses the `working-tree` primitives", two `docs/backlog.md` filename mentions) — the class of stale refs `tsc` never flags. Ask: after a `move_file`, emit an advisory list of remaining occurrences of the old basename/module-stem in comments, jsdoc, and `.md` files across the repo, so the caller can decide which are the moved module vs. an unrelated homonym. Surfacing candidates only — auto-editing prose would be wrong (can't disambiguate homonyms, e.g. the git "working tree" concept legitimately keeps the name). Same advisory would suit rename_symbol.

## Второй независимый репорт + a co-located-sibling half (dogfood-inbox, 2026-08-05, external)

`amiro` worktree `forms-amiro/forms-clear-policy`, cm=0.1.0. `move_file src/lib/locale-codes.ts → src/lib/checked-formats.ts` (apply:true): 7 importers repointed, typecheck clean, zero manual edits — everything a compiler can see moved. What stayed was found by a REVIEWER, not the agent:

- two doc comments naming `@/lib/locale-codes` while EXPLAINING why the code lives there (`.../EditWorkspaceDialog/schema.ts:15`, `.../WorkspaceDialog/schema.ts:7`) — the highest-value comments in the file, now pointing at a module that does not exist;
- `docs/forms.md:401`, which by the repo's own convention is the subsystem's source of truth, naming the module's test file;
- `src/lib/locale-codes.test.ts` did not move while its subject became `checked-formats.ts`.

The reporter's argument for why this class survives is the strongest case for the advisory: after the op returns, the old path exists nowhere to grep FOR — the op is the only participant that knows both the old and the new path at the same moment. Priority raised low→high on the second independent external report.

**Additional ask from this report, in scope of the same advisory:** note when a co-located `*.test.*` / `*.story.*` / `*.module.scss` sibling of the moved file was NOT part of the move. In a co-location repo, `X.test.ts` orphaned from `X.ts` is a rename that half-happened and nothing fails — the test still imports the moved symbol through the rewritten path and passes. (`.module.scss` companions are already moved, cf. [[t-622192]]; the report is about the siblings that are not.)

Same argument extends to `move_symbol` / `extract_symbol` (a symbol named in prose) and most strongly to `rename_symbol`, where the old name is unfindable afterwards by construction.
