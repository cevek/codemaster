---
id: t-662704
title: The 50-candidate view budget can drop a same-named declaration with a SEPARATE definition, flipping a name from ambiguous-refusal to silent unique resolution (and a silent write)
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-009660
  - t-233072
  - t-354613
  - t-726108
surface:
  - plugins/ts
audience: both
evidence: measured
created: '2026-07-28T08:49:08.507Z'
---
`resolveByName` retains at most `NAME_CANDIDATE_LIMIT` (50) candidates before
`distinctDeclarations` collapses them by definition (`plugins/ts/resolve-target.ts`). The dropped
candidates are never asked what they resolve to — so a dropped one carrying a SEPARATE definition
takes the name from ambiguous to unique, silently.

Repro (measured on current `main`): `src/a/base.ts` declares `export function Widget`; N barrels
`export { Widget } from './base'` re-export it (all one definition); one further barrel
`export { otherThing as Widget } from './other'` is a SECOND, unrelated definition.

```
N=48 → 50 exact-name candidates → find_usages {name:'Widget'}  FAIL 'ambiguous — shown 2 of 2'
                                  rename_symbol {name:'Widget'} REFUSED
N=49 → 51 candidates (>50)      → find_usages {name:'Widget'}  ok:true, complete=undefined
                                  rename_symbol {name:'Widget'} ok, touched=50 — the second
                                  declaration's file is NOT touched, and nothing is disclosed
```

One extra unrelated barrel flips the verdict from "refuse, it is ambiguous" to "resolve and write".

The obvious flag is wrong here and must not be applied blind: on this path the budget truncates
BEFORE the collapse, so `total > matches` fires routinely on a legitimate barrel chain that
collapses to ONE declaration — stamping `complete:false` (or refusing a write) there is a false
incompleteness, verified on a 60-barrel single-declaration fixture. The fix has to distinguish
"dropped candidates could hold another definition" from "dropped candidates are re-exports of the
one we kept". Options to weigh: collapse by definition BEFORE applying the view cap (a
`getDefinitionAtPosition` per candidate, bounded by the navto page); or keep the cap but resolve the
dropped candidates' definitions only when the kept set collapsed to one.

Pre-existing (reproduces on the pre-`t-128204` code too), and the sibling axis — the LS's own page
cap — is already closed: reads disclose `complete:false` + `searchTruncated:true`, writes refuse via
`resolveForWrite`. This is the same class through the other cap.

## Write semantics when the silent path IS hit (measured)

The mutation is CORRECT, the CLAIM is not. `renameSites` computes its edit set from the LS's
rename-locations at the RESOLVED position, which has nothing to do with the candidate list — so the
write covers its own symbol's references and cannot reach a foreign same-named symbol. Measured on a
repo holding a second, unrelated `Widget` definition: the rename touched only its own symbol's
sites, `typecheck=clean`, and the foreign definition, its barrel and its consumer were byte-identical
afterwards. The earlier review measured the same shape (`touched=50`, the foreign barrel untouched).

So the defect is the silent UNIQUENESS claim in front of a mutation — the agent is left believing it
renamed "the" `Widget` while another one still exists under that name — not corruption of a foreign
symbol and not a missed site of its own. Weigh the priority accordingly.

Note on reproducing: the silent window is arrangement-dependent. On several fixtures built for this
(55-70 barrels of one definition + one barrel of a second) BOTH definitions survived the cap and the
op refused honestly with the lower-bound marker. The review's repro stands; it is not the common
shape.
