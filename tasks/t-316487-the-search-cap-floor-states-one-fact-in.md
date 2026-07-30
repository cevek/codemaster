---
id: t-316487
title: 'One floor states one fact in N prose channels: the search-cap floor duplicates the envelope disclosure, and the undiscovered-program floor prints THREE times in one answer'
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
  - t-034392
  - t-071368
surface:
  - ops
  - plugins/ts
  - test
audience: both
evidence: reported
created: '2026-07-28T11:15:26.930Z'
---
A floor is one fact. Today one floor produces up to THREE prose statements of that same fact in a
single response — a token tax on the most common ops, and a guaranteed drift point, since the
sentences diverge the first time one of them is edited. Two distinct sources feed the class:

## Source 1 — the search-cap floor (a cut candidate page)

- `Result.disclosures` → `!! CANNOT CLAIM unsafe=target-is-the-only-symbol-of-this-name …`
  (`plugins/ts/disclose-resolution.ts`, on the envelope, carried by every op).
- `data.notes` → `!! LOWER BOUND — the workspace symbol search hit the LS's own result cap …`
  (`ops/no-symbol-hint.ts` `searchCapFloor`, in the payload of `find_usages` / `find_definition`
  only).

Both name the same cause and the same remedy.

Work: drop `searchCapFloor`'s `note` and keep its `fields` (`complete:false` + `searchTruncated:true`).
The split then reads cleanly — the ENVELOPE owns the claim's prose (once, for every op), `data` owns
the machine-readable set-level verdict a count-only consumer reads without parsing text. Nothing is
lost: the fields stay, and the prose still ships.

Blocked on a judgement call, not on code: `test/differential/search-truncation-honesty.test.ts:83`
asserts `/LOWER BOUND/` inside `data.notes` for the `mergeDeclarations` path. Dropping the note means
editing that assertion to read the envelope instead. That test's unedited green is currently the
proof that the envelope channel was purely additive, so re-pointing it is a deliberate step to take
once, knowingly — not a drive-by.

## Source 2 — the undiscovered-program floor (measured, current main)

`node src/bin.ts op find_usages '{"name":"staleBanner"}'` on codemaster's own repo prints the SAME
three fixture tsconfigs THREE times in one ~20-line answer:

1. the `undiscoveredPrograms (3):` data block (the machine-readable list),
2. `!! LOWER BOUND — 3 repo tsconfig(s) NOT loaded as programs (…); usages under them were NOT
   counted …` (the `definitionFloor` note in `data.notes`),
3. `!! CANNOT CLAIM … 3 nested tsconfig(s) are NOT loaded as programs (…)` (the envelope disclosure).

So the undiscovered-program floor IS duplicated in prose today — the envelope disclosure names it as
a cause of the unsafe claim, in parallel with the note. Seven of ~20 response lines restate one fact.
A duplicated honesty signal trains the reader to skim past `!!` markers, which is the opposite of
what the marker is for — the reason this is a correctness concern and not formatting.

Scope note: hoisting this second floor onto the envelope is t-071368, and the SCOPE decision the two
levels share is t-885983. This task owns the DE-DUPLICATION of the prose once those land — one fact,
one prose channel, machine-readable fields alongside it.

Reported from two directions: the search-cap half from a dogfood read of a `find_usages` answer, the
undiscovered-program half measured while fixing t-034392 (whose second paragraph this task owns).
