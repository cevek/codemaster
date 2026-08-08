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

## Field measurement (dogfood-jul, /Users/cody/Dev/amiro) + a cheaper first step

    find_unused_i18n_keys {prefix: "patient.record.prescriptions"}
    → degraded=true globalDemote=true · unused (0) · scanned 31 keys / 2110 usages · blocking 79
      hint: "narrowing does not lift this demote: no key anywhere is provable"

The three named blockers are dynamic `t()` calls in navigation/activity code (`AppSidebar.tsx:52:66`,
`MobileNav.tsx:27:59`, `ActivitySection.tsx:189:36`) — none of which can reach
`patient.record.prescriptions.*`. A repo this size always has a handful of dynamic calls somewhere, so the op
effectively answers "cannot prove anything" for EVERY prefix, forever. The caller fell back to reading the
locale JSON and grepping — exactly what the op exists to replace.

### The cheaper mechanism, short of checker literal-union narrowing

A dynamic key almost always has a STATIC PREFIX (`t(`nav.${item.key}`)`, `t(`activity.${kind}`)`), and that
prefix is recoverable from the template literals HEAD — it bounds the blast radius syntactically, with no
checker. Then a query whose prefix is DISJOINT from every dynamic head answers at full confidence, and only
overlapping queries demote. Only a fully headless `t(key)` deserves todays global demote.

### Minimum viable, independent of both

Report WHICH blockers have a static head and what it is ("3 blockers, 1 of them unbounded"), so the caller
judges overlap instead of being told outright that narrowing is pointless.

## Свидетельство (2026-08-05, `amiro/qa2-hide-conditions-tab`) — field report, and why it is NOT t-949045

```
find_unused_i18n_keys {prefix:'patient.record.tabs'}
→ degraded=true globalDemote=true  unused (0)
  reason "cannot prove any key dead — a dynamic t() call with no static prefix exists"
  114 blocking sites, e.g. AppSidebar.tsx:52:66 · labelKey, MobileNav.tsx:27:59 · labelKey
```

**This is the path t-949045 explicitly did NOT change, and its output confirms t-949045 shipped**: the
blocking call sites are now NAMED (114 of them), which is exactly the actionable half that task added.
What remains is the population t-949045 measured and deferred here — headless `t(item.labelKey)` calls
with no textual bound. So this is neither a regression nor an under-fix of that task; it is the
unfinished half, and it lives on this one.

The report adds one ask this task does not carry, and it is the cheap escape hatch: an explicit
CALLER-RESPONSIBILITY opt-out (`ignoreDynamicSites: [file:line]`, or
`assumeStaticOutside: ['patient.record.tabs', …]`), so a caller who has vetted a known-enumerable site
gets a real answer for everything else. That turns "the op cannot help in this repo, ever" into "the op
helps for everything the caller has vetted" WITHOUT touching `isKeyDemoted`'s inference — worth
considering as a shippable first slice ahead of the checker work.

Field cost as stated: this repo will always have such sites (a stored `labelKey` passed to `t()` is an
established idiom there), so the op can name no dead key anywhere, for any prefix, indefinitely — while
`i18n_lookup` reports the same keys as having 0 usages. Two ops, opposite impressions, neither
actionable. The literal-occurrence half of that pair is filed as t-777834.
