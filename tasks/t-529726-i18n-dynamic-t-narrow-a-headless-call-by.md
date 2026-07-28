---
id: t-529726
title: 'i18n dynamic t(): narrow a headless call by its ARGUMENT TYPE (checker literal unions) — the only path that lifts the demote on a real repo'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: L
area: impact-usages
source: dogfood-jul
relates:
  - t-158131
  - t-228385
surface:
  - plugins/i18n
  - plugins/ts
audience: external
evidence: measured
created: '2026-07-28T16:42:29.448Z'
---
`find_unused_i18n_keys` bounds a dynamic `t()` call from the SOURCE TEXT of its argument
(`plugins/i18n/dynamic-prefix.ts`): a bare template with a static head (`` t(`errors.codes.${x}`) ``)
demotes only that namespace. Every other shape has no textual bound and demotes globally.

**The measurement that makes this the load-bearing gap.** On the repo that generated the reports
(amiro), the dynamic `t()` population is:

- **68 headless calls** — `t(row.labelKey)`, `t(kindLabelKey(kind))`, `t(key)`, `t(field.labelKey)`;
- **0** leading-substitution templates;
- a handful of static-head templates (already scoped).

So 68/68 of what actually blocks that repo is unbounded by any text analysis, and a global demote
there is the honest verdict — `prefix=` narrowing cannot lift it, whatever the presentation says.

**What the checker gives that the text cannot.** `t(row.labelKey)` where `labelKey` has a literal
union type (`'patient.record.a' | 'patient.record.b'`) is EXACTLY determinable: the call's possible
keys are the union members, so it demotes those keys and nothing else — and where the union is a
closed set of literals, the keys are USED, not merely demoted. A widened `string` stays unbounded
and keeps the global demote. This is the whole class the text analysis is structurally blind to.

Surface: the argument's resolved type is a `ts`-plugin fact (`plugins/ts/**`), so it needs a
domain-neutral seam (the `firstParamTypeMembers` / `callArgShapes` precedent — a generic
"literal-union members of this call argument, or `widened`"), consumed by the i18n plugin which owns
the key policy. Cost is a checker read per dynamic call site — bound it (§1: no per-call work that
scales with repo size).

**Risk asymmetry (non-negotiable).** A false narrowing = a live locale string reported dead =
a deleted production string. Only a CLOSED literal union counts; `string`, a widened union, `any`,
an unresolved type, or a union with any non-literal member → keep the global demote. Under-narrowing
is cheap; over-narrowing is catastrophic. The oracle must carry both arms, the negative one first.

Related: t-949045 (scoped verdict + blocker attribution — the presentation half, done).
