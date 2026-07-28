---
id: t-233072
title: 'A name with >200 case-colliding declarations becomes unaddressable by bare name: reads floor and writes refuse, with no escape but re-querying navto or the syntactic scan'
status: backlog
priority: low
tags:
  - agent-surface
  - dogfood
type: dx
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-662704
  - t-726108
surface:
  - plugins/ts
audience: both
evidence: measured
created: '2026-07-28T09:08:40.720Z'
---
The LS's navto page is asked for `NAME_CANDIDATE_LIMIT * 4` items and sorts case-INSENSITIVELY
within its `exact` bucket. A name whose case-variants alone overflow that bucket (measured: 260
declarations of `unique1` beside the type `Unique1`) therefore always comes back cut, and the
honesty machinery correctly refuses to pretend otherwise: reads carry `complete:false` +
`searchTruncated:true`, and mutating ops refuse via `resolveForWrite`.

The refusal is HONEST — a same-named declaration genuinely can be hidden behind the cut, and no
ordering trick inside the exact bucket recovers it — and it is strictly better than the pre-fix
behaviour, which answered `no symbol named 'X'` or `gone` on the same input. But the ergonomic cost
is real: for such a name, bare-`{name}` addressing stops working entirely and the agent must know to
pass `name+file` / `file:line:col`.

Escapes worth weighing: re-query navto with a larger budget when the exact bucket came back
saturated (bounded retry, one extra call, only on the rare cut); or fall back to the no-program
syntactic scan (`symbols_overview` / `search_symbol {syntactic:true}`), which has no page cap and
already enumerates declarations by name. The message today names `name+file` and `symbols_overview`
as the remedy, so the agent is not stranded — this is about not needing the detour.
