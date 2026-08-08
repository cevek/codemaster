---
id: t-702832
title: '`member_usages` and `expand_type` are the right answers to two very common questions and their names/summaries do not say so: "field of THIS type, not a property anywhere" and "what fields does this generated DTO have" both go to grep/regex first'
status: backlog
priority: medium
parent: t-826059
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-inbox-aug
relates:
  - t-011315
  - t-100043
  - t-248218
surface:
  - mcp
  - ops
audience: external
evidence: reported
created: '2026-08-08T12:01:58.061Z'
---
Capability present, correct, not reached — the epic's shape, on two specific ops:

1. **`member_usages` reads as a narrower `find_usages`.** The question it uniquely answers is "usages of member
   M OF TYPE T" — the only way to ask about a common field name (`amount`, `total`, `access`) without drowning
   in unrelated properties, and the only route to `api.<operationId>` (a property of a generated object
   literal, not a symbol). From the op name and summary an agent reads "usages of a member" ≈ a restricted
   find_usages and does not connect it to either question. Both were asked with grep by agents who had the op
   in their tool list.
2. **Nothing routes "what fields does this DTO have" to `expand_type`.** Generated DTOs sit as one-line type
   aliases in `src/api/generated/types.ts`; the first instinct is a regex over the file, which works badly.
   `expand_type` is the correct and much cheaper answer.

Fix is on the surface, not in the engine: a worked example per op in the catalogue — `member_usages` for
"usages of `api.<operationId>`" and for "field `X` of type `T` specifically, not property `X` anywhere", and a
line in `expand_type`'s notes that for generated one-line DTOs it is cheaper than reading the file. §11 makes
the per-session schema tax deliberate, so an example that redirects a recurring miss is what the budget is for
(watch t-566356: the argsHint budget is already contested).

## Свидетельство (field reports, external agents)

- 2026-08-03, amiro — «`member_usages` в списке есть — возможно, это ровно он, и тогда трение в другом: из
  имени опа не читается, что он решает задачу "поле конкретного типа", а не "свойство вообще"; на глаз он
  звучит как более узкий `find_usages`.» The question was narrowing `amount` to `PaymentV2Dto` specifically;
  the miss cost the second consumer of a changed semantic, found by review.
- 2026-08-07, amiro-frontend — «`member_usages` may cover this; I did not find it via the op map, and the op
  map's framing ("symbol identity / type / reference graph") does not suggest it for a property of a generated
  object. A worked example in `status` for "usages of api.&lt;operationId&gt;" would have redirected me.»
- 2026-08-05, amiro-frontend — «`expand_type` тут правильный оп, но ничто на него не наводит, когда
  спрашиваешь "какие поля у этого DTO". Может стоить строки в notes.» Same agent's `member_usages` call, once
  found, closed half the track's question in one call.

Three reports, two repos, three agents.
