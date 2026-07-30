---
id: t-825985
title: 'feedback has no read side: draining the inbox is a hand-grep over a global markdown file, and the obvious count is WRONG by 20%'
status: backlog
priority: medium
parent: t-490634
type: dx
complexity: M
area: platform
source: dogfood-jul
audience: both
evidence: measured
created: '2026-07-30T11:27:10.677Z'
---
## Measured, from the triager's seat (a real drain of 20 entries / 69 KB / 606 lines)

1. `grep -c '^## '` → **24**. WRONG: one entry's body carries 4 `##` sub-headers, so the real count is 20
   (`grep -cE '^## \[(bug|wish|friction)\]'`). No delimiter distinguishes an entry header from a body
   heading, so the obvious mechanical count over-reports by 20% — and the error is silent in BOTH
   directions: writing 24 mapping rows for 20 entries yields an archive that reads as complete.
2. Reading it took two pages through a file reader (an explicit offset after a truncation notice).
3. Deduping each entry against 326 open tasks: `tm --json list | jq` plus a hand-written regex per topic.
4. Archiving by hand: copy to `archive/`, hand-write the mapping table, truncate the original to its header.
   Nothing enforces that the mapping is complete; nothing marks an entry processed in place.

The invariant "inbox non-empty ⇒ something untriaged" is only checkable by someone remembering to look.

## Wanted, in value order

- `feedback {list:true}` (or `feedback_list`) emitting ROWS — id, kind, title, repo, timestamp, line range —
  so `sql` can count / group / anti-join them and the denominator is machine-produced. This alone removes the
  whole miscount class.
- a stable per-entry ID at write time (the timestamp is already stamped — make it addressable), plus
  `feedback {drain:[ids]}` that moves exactly those entries to `archive/` and REFUSES an absent or
  already-drained id, so archive completeness is enforced by the tool rather than by discipline.
- at minimum an unambiguous entry delimiter (per-entry fenced frontmatter, or a guaranteed-unique `^## [`),
  so the trivial count is the correct count.
