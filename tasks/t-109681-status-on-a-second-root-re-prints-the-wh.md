---
id: t-109681
title: status on a second root re-prints the whole op catalogue and concepts verbatim — ~6KB per root hop, while the DELTA is the information
status: backlog
priority: medium
parent: t-786727
type: dx
complexity: M
area: render
source: dogfood-jul
relates:
  - t-980509
surface:
  - src/format/render/render-status.ts
audience: external
evidence: repro
created: '2026-07-30T19:58:24.654Z'
---
Called `status` (terse) on root A, then on root B in the same session. The per-repo lines
(workspace / plugins / freshness) differ — that is what the caller wanted — but the FULL ops catalogue and
the concepts block were re-emitted verbatim (identical modulo the 3 react-only ops).

So a multi-root session pays ~6KB per root hop to learn "plugins: +react, isolation=process". In a session
that touches three repos that is most of a `status` budget spent restating what the tool already said.

Shape asked for: after a same-session `status`, a later `status {root}` collapses the unchanged
catalogue/concepts to one line — `ops/concepts: same as <first root> +find_unused_props/trace_* (react)`.
The delta IS the information; the rest is a per-session fact being billed per call.

Same economy class as the other members of this epic: a channel whose content does not vary carries no
information about THIS answer, and its cost is paid every time.
