---
id: t-786727
title: "EPIC: the honesty channel's ECONOMY — one claim, stated once, at one decided scope, with its composition stated"
status: backlog
priority: high
type: imp
complexity: L
area: correctness
source: dogfood-jul
relates:
  - t-100043
  - t-259465
  - t-338692
  - t-647309
audience: both
evidence: measured
created: '2026-07-30T11:24:16.461Z'
---
## The class

§3 makes every uncertainty explicit and §12 reserves budget so an honesty channel can never be trimmed off
the tail. Both hold. What is unmanaged is the channel's ECONOMY, and every member below is one failure of it:

- **repetition** — one claim restated per section of a batch (measured: 13 × ~800 chars ≈ 10 KB of one fact
  against the 60 KB seam cap), and one fact told in two prose channels of a single answer;
- **saturation** — a channel that fires on 100% of requests carries no information about THIS answer, and
  the day a floor is real it looks identical to the 200 that were not;
- **scope** — the same condition is wanted NARROWER by one task and BROADER by another; landing both
  naively puts two confidences about one read in one envelope, which the closed `UnsafeClaim` union exists
  to prevent;
- **composition** — several independent floors can be active at once and nothing states how many, so each
  one is locally right, individually `low`, and collectively unpriced.

They are one epic because they trade against each other: narrowing the scope reduces saturation, hoisting a
claim reduces repetition, and both change what "how many floors are active" has to count. Fixing them
independently is how two of them already ended up in direct conflict.

## Design constraint every member inherits

A claim's identity is (what the answer may not be read as claiming) — never the upstream EVENT that made it
unsafe, and never two causes with different remedies folded into one entry. "A config we did not LOAD"
(remedy: index it) and "a program we loaded and chose not to SEARCH" (remedy: widen the scope) are two
claims, whatever their rendered sentence looks like.
