---
id: t-194771
title: trace_prop_through_tree claims "'X' is not among the root's declared props" over a member set that may have been capped — the same proven-absence-over-an-unseen-set as find_unused_props' undetermined branch
status: backlog
priority: medium
tags:
  - dogfood
  - honesty
type: bug
complexity: S
area: render
created: '2026-07-28T17:32:27.275Z'
---
`src/ops/trace-prop-through-tree-walk.ts:210-231` (`checkPropDeclared`) reads the root's declared
props through `ts.firstParamTypeMembers` and, on a miss, states:

```
'X' is not among the root's declared props — tracing the identifier as written
```

`firstParamTypeMembers` caps the member set at `MEMBER_CAP` (500,
`src/plugins/ts/first-param-members.ts`) and reports the cut in `view.truncated`. The miss branch
ignores that flag, so on a component whose props type carries more than 500 apparent members (a
wrapper over two DOM-attribute intersections reaches this) the note asserts an absence over
members that were never seen.

`find_unused_props` answers the identical question under the identical cap and refuses to make the
claim: a requested name absent from a CAPPED set is reported `undetermined`, not `notDeclared`
(§3.4/§3.6). This op should say the same kind of thing — "the declared-member set was capped at
N/M, so '`X`' may be declared past the cut" — instead of a flat "not among".

The seam now orders project-declared members ahead of dependency-declared ones when the cap bites,
so the practical exposure is smaller (a repo's own prop survives the cut); the claim is still
unsupported for a prop declared by a dependency's type.

Fix: read `out.view.truncated` in `checkPropDeclared` and degrade the note (and the `boolean`
return, which currently collapses "absent" and "unseen" into `false`) to an explicit
could-not-determine.
