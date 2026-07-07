---
id: t-000147
title: expand_type` `at`-loc correctness validated by neither suite
status: backlog
priority: low
type: dx
complexity: S
area: full-density
created: '2026-07-08T00:02:26.000Z'
---
**`expand_type` `at`-loc correctness validated by neither suite** — `span-validity.test.ts` correctly
dropped `expand_type` from the proof-span sweep (it no longer emits a Span, only the `at` string), but
`expand-type.test.ts` oracle-checks members/signatures/type, NOT the location. The `at` derives from the
same `info.textSpan`/`spanFromRange` as the old validated span (drift unlikely), but the net is thinner.
Add a loc-correctness assert in `expand-type.test.ts`. `dx`·`low`·`cx:S`
