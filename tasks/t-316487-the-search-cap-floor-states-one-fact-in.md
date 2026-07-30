---
id: t-316487
title: "The search-cap floor states one fact in two prose channels: searchCapFloor's LOWER BOUND note now duplicates the envelope disclosure on every find_usages / find_definition answer"
status: backlog
priority: medium
parent: t-786727
tags:
  - agent-surface
  - dogfood
type: imp
complexity: S
area: impact-usages
source: dogfood-jul
relates:
  - t-002010
  - t-071368
surface:
  - ops
  - plugins/ts
  - test
audience: both
evidence: reported
created: '2026-07-28T11:15:26.930Z'
---
One resolution off a cut candidate page now produces two prose statements of the same fact in one
response:

- `Result.disclosures` → `!! CANNOT CLAIM unsafe=target-is-the-only-symbol-of-this-name …`
  (`plugins/ts/disclose-resolution.ts`, on the envelope, carried by every op).
- `data.notes` → `!! LOWER BOUND — the workspace symbol search hit the LS's own result cap …`
  (`ops/no-symbol-hint.ts` `searchCapFloor`, in the payload of `find_usages` / `find_definition`
  only).

Both name the same cause and the same remedy. Two texts for one fact is a token tax on the most
common op and a guaranteed drift point — the two sentences will diverge the first time one is edited.

Work: drop `searchCapFloor`'s `note` and keep its `fields` (`complete:false` + `searchTruncated:true`).
The split then reads cleanly — the ENVELOPE owns the claim's prose (once, for every op), `data` owns
the machine-readable set-level verdict a count-only consumer reads without parsing text. Nothing is
lost: the fields stay, and the prose still ships.

Blocked on a judgement call, not on code: `test/differential/search-truncation-honesty.test.ts:83`
asserts `/LOWER BOUND/` inside `data.notes` for the `mergeDeclarations` path. Dropping the note means
editing that assertion to read the envelope instead. That test's unedited green is currently the
proof that the envelope channel was purely additive, so re-pointing it is a deliberate step to take
once, knowingly — not a drive-by.

The `definitionFloor` note (undiscovered programs) is NOT duplicated and must stay: different cause,
and it is not yet on the envelope (t-071368).
