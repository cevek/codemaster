---
id: t-979112
title: The deadline-cut scan fixture cannot discriminate a walked-file counter mis-wire — opDeadlineMs:0 cuts BEFORE the fan, so files === walkedFiles === 0 and every substitution reads 'walking 0 of 0'
status: backlog
priority: medium
parent: t-532530
type: infra
complexity: S
area: correctness
source: dogfood-jul
audience: internal
evidence: measured
created: '2026-07-30T15:54:11.866Z'
---
## What is unpinned

`test/differential/scan-coverage-honesty.test.ts` — the arm
`an expired budget: the PARTIAL note counts FILES, never claims a finished candidate sweep` — states
the honesty property that a shortfall is denominated in FILES (`ops/scan-coverage.ts`, the
`!! PARTIAL SCAN` note: `after walking ${walkedFiles} of ${files} in-scope file(s)`).

Its fixture runs `opDeadlineMs: 0`, which is already expired at the first poll, so the walk breaks
BEFORE any program in the fan is consulted: `programsScanned` is empty, `scanned.files` is 0, and the
note reads `walking 0 of 0 in-scope file(s)`.

Both counters are therefore 0, and any substitution of one for the other renders the identical text.

## Measured

Mutating `coverage.walkedFiles` to `coverage.files` in the `PARTIAL SCAN` note leaves the whole file
green (7/7) — including the positive `assert.match(n, /walking 0 of \d+ in-scope file\(s\)/)` that
reads as the pin for this property.

So the file-vs-candidate denomination — the point of the note — is asserted by nothing.

## What would discriminate it

A cut landing MID-walk (`walkedFiles > 0 && walkedFiles < files`), where the two counters differ and
a substitution changes the rendered text.

That is timing-dependent under a real wall-clock deadline: a budget large enough to open some files
and small enough to stop before the last one is a flake on a loaded machine, so the naive attempt
(pick a millisecond value) is the wrong first move. A deterministic route — a clock/deadline seam
that expires after N polls rather than N milliseconds, or a per-file hook the fixture drives — is
what the arm needs, and the injected `clock` in `common/async` (§16 determinism: no `sleep` in
scenarios) is where it starts.

## Scope

Adjacent to t-160641 (which audits NEGATIVE assertions over honesty-channel prose); this is a
non-discriminating FIXTURE on the positive side, found by the same mutation run.
