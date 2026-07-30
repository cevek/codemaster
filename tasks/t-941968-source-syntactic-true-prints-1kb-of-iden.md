---
id: t-941968
title: source {syntactic:true} prints ~1KB of identical scope doctrine BEFORE every body — a per-session fact billed per call, and it inverts verdict-first
status: backlog
priority: high
parent: t-786727
type: imp
complexity: S
area: render
source: dogfood-jul
relates:
  - t-229522
  - t-286255
surface:
  - src/plugins/ts/syntactic-scope.ts
audience: external
evidence: measured
created: '2026-07-30T19:58:25.089Z'
---
Every `source {syntactic:true}` answer opens with the full `SYNTACTIC_SCOPE` paragraph (~1100 chars ≈ 275
tokens: git-listed surface, walk fallback, outside-root caveat, overload note, drop-the-flag steer) and only
then the code body.

Two defects, and the second is the one that matters:

1. **Per-call tax for a per-session fact.** The text is identical on every call; by the third call in a
   session it is pure cost.
2. **It inverts verdict-first (§12).** The payload of this op IS the code, and it now sits BELOW ~1KB of
   boilerplate. The rendering contract says the load-bearing part leads and the re-fetchable bulk trails;
   here the invariant prose leads and the answer trails.

The honesty content is correct and must not be dropped — this is about WHERE it lives. Shape asked for: a
one-line scope tag on the answer (`syntactic · git-surface · not type-verified — details: status {op:'source'}`)
with the full doctrine in `status` / op notes, or emitted in full once per session per root.

Note the tension to resolve explicitly, since it is the reason the doctrine was put inline: a scope claim
that lives only in `status` is one an agent may never read, and the answer would then assert an unqualified
surface. The one-line tag must therefore still be a claim, not a pointer — it says what the surface IS and
where the full statement lives.
