---
id: t-439939
title: trace_field_to_render launders a could-not-determine resolution into ok{found:0}, which reads as a proven absence
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T11:15:42.270Z'
---
When a bare name's candidate page is cut so hard that the name never reaches it, `resolveByName`
fails honestly: `could not determine whether 'X' exists — the workspace symbol search hit the LS's
own result cap, so its page may not contain it`. That is a "couldn't", not a "doesn't exist" (§3.6).

`trace_field_to_render` converts it into a SUCCESS: `if (typeof def === 'string') return
ok(notFound(args.field, def))` (`ops/trace-field-to-render.ts`) — an `ok` envelope with `found:0`.
The shape an agent reads as "this field is rendered nowhere" is therefore also the shape produced by
"we could not find out". The reason string rides along inside `notFound`, but the verdict field says
absence.

Repro (hermetic): a repo with 300 `export const email = N` and one `interface User { Email: string }`
— `find_definition {name:'Email'}` FAILS with the cap message, while `trace_field_to_render
{field:'Email'}` answers `ok`, `found:0`.

Not covered by the envelope disclosure (`Result.disclosures`): the claim is stated only for a
resolution that SUCCEEDED off a cut page. A resolution that failed because of the cut invalidates a
different assertion — "no symbol of this name exists" — which the current `UnsafeClaim` vocabulary
does not name.

Two ways out, pick deliberately:
1. `trace_field_to_render` distinguishes a genuine 0-match from an unresolvable target and returns a
   `ToolFailure` for the latter (the shape every sibling op already uses).
2. Add the second `UnsafeClaim` member (`name-does-not-exist`, an assertion — NOT an event name) and
   disclose it on the failed-resolve path, so any op that turns a failed resolution into an
   absence-shaped answer inherits the correction.

(1) is narrower and fixes the op; (2) closes the class. Audit the other ops for the same laundering
before choosing — `notFound`-style wrappers are the pattern to grep for.
