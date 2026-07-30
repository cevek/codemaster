---
id: t-803219
title: a dense renderer prints only the fields it knows — a new data key (an honesty channel) is dropped with no trace
status: backlog
priority: high
type: bug
complexity: M
area: render
source: dogfood-jul
surface:
  - src/format/render/render-source.ts
audience: external
evidence: measured
created: '2026-07-30T11:57:36.644Z'
---
## The class

`renderSource` (and any renderer of its shape) enumerates the keys it knows — `sources`, `unresolved` —
and emits nothing for the rest. An op that adds a data field gets it rendered in `format:'json'` and
SILENTLY DROPPED in the DEFAULT text mode, which is the mode agents read.

Measured on `source`: a top-level `note` carrying the "this answer is NOT type-verified" scope statement
was present in the data and absent from the rendered text. A review reads the MEANING of the op that
populated the field and sees an honesty channel; the machine reads the BYTES and sees none. Nothing
fails — no type error, no test — so the channel is gone until someone diffs the two modes by eye.

`source`'s own `note` is rendered (verdict-first) as of t-229522. The CLASS is open: every
key-enumerating renderer has the same hole, and the next op to add a field will re-open it.

## Why it is an honesty defect, not a formatting one

The dropped field's whole purpose is to qualify what the answer may be read as claiming (§3.4/§3.6).
Dropping it does not degrade the answer — it INVERTS it: a syntactic, unverified body reads exactly like
a type-verified one.

## Shape of a fix (not decided)

Candidates: (a) a renderer contract that FAILS LOUD on an unrendered key (the `~shape` unknown-tag
precedent — §12 already does this for tags); (b) route op-level notes through the envelope's reserved
honesty segment rather than `data`, so no per-renderer wiring can forget them; (c) a cross-mode test
matrix asserting every data key surfaces in the text render.

(a)+(c) mirror the existing shape-tag coverage guard, which is the precedent that worked.
