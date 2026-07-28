---
id: t-480164
title: the prop-provenance predicate lives in two places (ts seam + react plugin) — a shared common/ home is required the moment it gates rather than orders, or a third consumer appears
status: backlog
priority: low
tags:
  - debt
  - render
type: imp
complexity: S
area: render
relates:
  - t-194771
  - t-309134
  - t-803574
  - t-974740
surface:
  - common
  - plugins/react
  - plugins/ts
audience: internal
evidence: repro
created: '2026-07-28T17:25:08.229Z'
---
"Is this declaration the repo's own, or a dependency's?" is answered in TWO places, on purpose,
in two different representations of a path:

- `src/plugins/react/prop-origin.ts` — over a `RepoRelPath` (a `Span.file`, already through
  `host.relOf`): an in-root dependency file reads `node_modules/…` with NO leading slash, so the
  test is a leading-segment / embedded-segment / absolute-path triple. This one is a GATE: it
  decides which props the default `find_unused_props` view lists and which it counts in
  `hiddenExternal`.
- `src/plugins/ts/first-param-members.ts` (`isDependencyDeclared`) — over an ABSOLUTE
  `ts.SourceFile.fileName`, the tree's own `/node_modules/` idiom plus an outside-the-root check
  via `relOf`. This one is a PRIORITIZATION: it only decides which members survive `MEMBER_CAP`
  when the cap bites.

The duplication is deliberate and currently safe: a drift between the two costs member ORDER under
a cap, never a verdict. Unifying them today would mean canonicalizing one call site's path
representation into the other's — changing the seam's semantics to remove a drift that harms
nothing.

That trade flips under either condition, and then a shared `common/path/…` home is required:

1. a THIRD consumer appears, or
2. the seam-side test stops ordering and starts GATING (excluding members, not ranking them) —
   at which point a drift becomes a wrong answer, not a wrong order.

Whoever unifies: the two inputs are NOT interchangeable. A `RepoRelPath` for an out-of-root file
is passed through ABSOLUTE by `relOf`, and an in-root dependency path has no leading slash, so a
single predicate needs an explicit canonicalization step at one of the call sites (or two typed
entry points over one rule) — a bare `.includes('/node_modules/')` silently misses the in-root
relative form, which is the common case on the react side.

**Related:** t-974740 and t-309134 are the same rule at a different site — one fact rendered/decided in two places, with `common/` as the home once the duplicate starts gating rather than ordering. t-309134 is where that precedence gets written down.
