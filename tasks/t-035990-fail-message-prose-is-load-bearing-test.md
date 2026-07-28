---
id: t-035990
title: 'FAIL-message prose is load-bearing test surface: rewording a noun broke an unrelated e2e — messages are asserted verbatim far from where they are written'
status: backlog
priority: low
tags:
  - dogfood
  - testing
type: infra
complexity: S
area: correctness
source: dogfood-jul
created: '2026-07-28T09:24:32.468Z'
---
Softening one noun in an ambiguity FAIL message ("declarations" → "declaration sites") broke an e2e test
in an unrelated area, because refusal prose is asserted verbatim in tests that live nowhere near the code
that produces it.

The coupling is not wrong in itself — §3.6 makes the message part of the contract, and t-034392 /
t-959904 are entirely about message CONTENT being load-bearing for agents. The problem is that the
coupling is invisible at the edit site: nothing tells the author that this string is pinned, and the
failure surfaces as a red test in a subsystem they did not touch.

Options, cheapest first: name the pinned strings as exported constants so the assertion sites are
discoverable from the definition (`grep` the constant, not the prose); or assert on a stable substring /
message id rather than the full sentence, keeping the honesty channel free to be reworded while the
CLAIM stays pinned.

Related shape from the same track: the 300-line file cap bites exactly when threading a cross-cutting
honesty channel (the split that triggered it also produced the import cycle in t-500947). Both are
symptoms of one thing — a signal that must reach many places has no single home.
