---
id: t-720379
title: ARCHITECTURE.md §9 documents the refusal redirect that was removed, and argues for restoring the refusal→refusal chain
status: backlog
priority: high
tags:
  - agent-surface
  - docs
type: doc
complexity: S
area: docs
source: dogfood-jul
created: '2026-07-28T12:59:48.216Z'
---
The refusal redirects render from `src/ops/guard/navigate.ts`; three ARCHITECTURE.md passages still
describe the previous behaviour. The first is not merely stale — it instructs a reader to re-create a
defect the code now has a test against.

## §9, pre-warm size guard (the blocking one)

Present text:

> the op REFUSES with an honest, actionable redirect (browse via `symbols_overview`, then a targeted
> `find_definition`/`find_usages`; or `search_symbol {syntactic:true}` for an OOM-safe fuzzy scan)
> instead of warming — never a crash, never a silent squat.

`search_symbol`'s guard emits exactly two calls, in this order: `search_symbol {query,syntactic:true}`,
then `symbols_overview {query}`. It names neither `find_usages` nor `find_definition`, deliberately:
wherever that threshold trips, a repo-wide fan is precisely what cannot run, so naming one is a
refusal pointing at the next refusal. `test/unit/refusal-navigation.test.ts` fails if it does.

An agent reading this line as present-state will "restore" `find_usages` into the table and then fix
the test rather than the doc. Suggested replacement:

> the op REFUSES to warm and names the calls that answer the same question here
> (`ops/guard/navigate.ts`): `search_symbol {syntactic:true}` — the same fuzzy search over the AST
> alone — then `symbols_overview {query}`. It deliberately does NOT name a bare-name
> `find_usages`/`find_definition`: wherever this threshold trips, a repo-wide fan is exactly what
> cannot run, so a redirect there would be one refusal pointing at the next.

Note the doc is not simply wrong to mention `find_definition {name,file}` — that IS a live redirect,
but from the FAN-OUT guard's definition-addressed ops, not from this pre-warm guard. The error is the
attribution.

## §9, fan-out refusal content

> The refusal names the ONE cause that left this workspace in-process … with its remedy (§3.6).

Still true, but it is now the trailing, demoted clause. The message leads with a runnable redirect,
because its usual reader is an agent inside a repo it does not own: it can make another call, and it
can neither restart a machine-global daemon nor edit that repo's config. Suggest inserting before
"The refusal names the ONE cause…":

> The refusal leads with a runnable redirect (`ops/guard/navigate.ts` — an op+args that answers the
> same question with no program build and no fan), then names the ONE cause … with its remedy,
> explicitly labelled as needing config/daemon access the caller may not have (§3.6).

## §15, repo layout

    guard/    # semantic-fanout-guard.ts + fan-capable.ts — the in-process OOM refusal (§9)

`navigate.ts` is missing, and the annotation's scope is now wrong: the table serves three surfaces,
one of which is not the in-process refusal — `search_symbol`'s pre-warm guard and
`daemon/process-host`'s oom/timeout path (a process-mode failure). Suggested:

    guard/    # semantic-fanout-guard.ts + fan-capable.ts (the in-process OOM refusal, §9)
              # + navigate.ts (the shared "what answers this here" redirect table — also rendered by
              #   search_symbol's pre-warm guard and daemon/process-host's oom/timeout path)

## Also

`src/config/config.ts` jsdoc for `searchWarmPeakMaxFiles` enumerates the old redirect targets. Same
class, but a config-author comment rather than a spec — lower stakes.

Checked and clean: `src/README.md` (L4→L3 is permitted and has precedent — `daemon/resolve-args.ts` →
`ops/intake/`), §11, CONTRIBUTING.md, test/README.md.
