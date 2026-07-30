---
id: t-437095
title: case-folded 'file' spellings are untested on a case-SENSITIVE filesystem
status: backlog
priority: low
type: imp
complexity: S
area: correctness
source: dogfood-jul
surface:
  - test/differential/syntactic-source-boundaries.test.ts
audience: internal
evidence: unverified
created: '2026-07-30T14:54:12.048Z'
---
## The gap

`source {syntactic:true}` normalizes its `file` arg through `mintRepoRelPath` (realpath + on-disk casing),
so `SRC/WIDGET.TS` resolves to the same declaration as `src/widget.ts` — verified live on APFS.

That is exactly why it is UNTESTED: on a case-insensitive volume the assertion passes for the wrong
reason (the OS resolves the path before we do), and on a case-SENSITIVE one the same fixture would fail
because the file genuinely does not exist under that spelling. A test asserting the current behaviour
would therefore be either vacuous or red depending on the developer's filesystem — the shape CONTRIBUTING
calls a test that cannot discriminate.

The boundary suite covers the two spellings that ARE filesystem-independent (a `./`-prefix and an
absolute path); casing is the one it deliberately omits.

## What a real test needs

A fixture that DECLARES which behaviour is expected per volume — either detect case sensitivity at setup
(write `a.tmp`, stat `A.tmp`) and assert the matching branch, or assert only the invariant that holds on
both (the syntactic and checker paths AGREE on the same spelling, whatever that agreement is).

The second form is the better one: it is the property the feature actually promises — an agent switching
the flag reads the same declaration — and it holds on every filesystem.
