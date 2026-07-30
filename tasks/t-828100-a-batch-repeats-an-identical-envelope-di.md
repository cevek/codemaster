---
id: t-828100
title: A batch repeats an IDENTICAL envelope disclosure once per request — 13 copies of one ~700-char CANNOT CLAIM block in a 15-request call
status: backlog
priority: medium
parent: t-786727
type: imp
complexity: S
area: render
source: dogfood-jul
relates:
  - t-847874
surface:
  - src/common/result/merge-disclosures.ts
  - src/mcp/render-response.ts
audience: both
evidence: measured
created: '2026-07-30T11:17:55.785Z'
---
## Measured (codemaster's own repo, one `batch` of 15 `find_definition {name}`, verbosity terse)

13 resolved, 2 failed ambiguous. Every one of the 13 carried a BYTE-IDENTICAL disclosure — same claim,
same three fixture tsconfigs, same remedy — plus the same 4-line `undiscoveredPrograms (3):` list above
each payload. ~13 × ~800 chars ≈ 10 KB of one repeated fact against the 60 KB MCP seam cap (§12); a batch
of ~70 such requests is disclosure-only. Only `target="name 'X'"` differs.

## Why it is a §12 defect, not taste

ARCHITECTURE §12 already states the collapse rule INSIDE one envelope: "entries sharing one claim collapse
to a single line listing their targets, so a 20-target op does not spend the reserved budget restating one
fact." A batch is that exact shape one level up — N sections sharing one claim, one cause, one remedy —
and the collapse does not cross sections.

## Ask

Hoist a disclosure shared by every section of a batch to ONE batch-level statement listing the targets it
qualifies. Nothing is lost: the claim, cause and remedy are stated once and still attach to every answer,
which is the point of the ambient ledger.

Distinct from `t-316487` (one fact in two PROSE CHANNELS of one answer) and from `t-000075` (the floor is
repo-global rather than symbol-scoped). `t-286255` owns the "fires on 100% of calls" half.

SECOND SURFACE: `sql`. A `batch {r: find_usages …, f: find_usages …}` + `sql` prints the identical `!! LOWER BOUND` line ONCE PER PRODUCER TABLE — plus the `CANNOT CLAIM` disclosure making a third statement of the same underlying gap, in one response. So the repetition is not specific to per-request sections: it recurs wherever an envelope is assembled OVER producers, which is precisely where the merge helper already forwards the channels.

One merged line naming BOTH affected tables carries the same honesty at a third of the cost. Note this also compounds with the remedy defect (t-259465): all three copies name a repo edit the external caller cannot perform, while the ops involved accept `programs:[…]` per call — so the response spends triple tokens restating an unusable instruction.
