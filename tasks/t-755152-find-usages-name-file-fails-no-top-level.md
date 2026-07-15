---
id: t-755152
title: find_usages {name, file} fails "no top-level declaration named X" for a class METHOD / type-alias MEMBER / re-exported name — resolve the member within the given file (or redirect to member_usages), don't dead-end
status: done
priority: medium
tags:
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-15T12:19:28.432Z'
---
## Verified (codemaster usage/fail.jsonl, 3 live failures AFTER 2026-07-08)
- `find_usages {name:'next', file:'src/common/ports.ts', groupBy:'enclosing'}` (task-manager) → `FAIL — no top-level declaration named 'next' in src/common/ports.ts`. `next` is a method of a type-alias object (`export type IdGen = { next(size:number):string }`) — not a top-level decl.
- `find_usages {name:'useEmployeeOption', file:'src/components/forms/fields/hooks.ts'}` (amiro) → same FAIL, though it's a hook that (per the report) lives at/through that file — likely a re-export the name+file resolver doesn't follow.

## Gap
find_usages by `name`+`file` resolves ONLY top-level declarations. A method / type-member / re-exported name in the given file dead-ends with "no top-level declaration" — the agent must hand-compute file:line:col or fall back to grep. This is NOT bad_args (the args are valid; the symbol just isn't top-level).

The member CAPABILITY exists — `member_usages` (t-000175, DONE) — but it requires the containing TYPE + member (`member_usages {name:'IdGen', member:'next'}`), which the agent doesn't reach for when it knows the name+file. 

## Ask
When name+file resolves no top-level decl, resolve a MEMBER / method / re-exported binding of that name within the file: unique match → proceed; several → return the candidate list with positions. At minimum, redirect the error to member_usages (naming the likely containing type) instead of a flat dead-end.

Inbox/archive source: 2026-07-04 (line 186), 2026-07-06 (line 359). Related: t-000175 (member_usages, DONE), t-262491.
