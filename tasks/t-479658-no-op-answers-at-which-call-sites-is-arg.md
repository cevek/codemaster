---
id: t-479658
title: No op answers 'at which call sites is argument N a literal/constant' — a shared-gate refactor degenerates into reading every call site by hand
status: backlog
priority: high
parent: t-560034
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-000063
audience: external
evidence: reported
created: '2026-07-30T11:19:06.320Z'
---
## Reported (/Users/cody/Dev/task-manager, a shared-gate refactor: one `coerceValue` called from 4 sites)

The repeated question was not "who calls X" — `find_usages` answers that perfectly, and the
enclosing-function grouping made "which paths does this gate own" answerable in one call — but "at which
call site is argument K a literal that would now be REFUSED". Every call site had to be read by hand.

    call_arguments {name:'coerceValue', argIndex:1}

returning per-site the argument expression (literal / variable / expression) with its resolved type would
have replaced 4 file reads with one call. The `ts` plugin already has `callArgShapes` internally
(`t-000063` re-exports its result types), so the data is close to hand.

No other friction that session: `find_usages` on `coerceValue`/`parseKV`/`formatDetail` was exactly right
and surfaced a caller (`retypeFieldValue`) that a plain-name grep would have found but not contextualised.

## Field evidence — three further independent reports (dogfood-inbox-aug)

The op is requested by three more agents in two repos, twice with a shipped defect behind it. Two of them
independently proposed the same surface (`args:true` / `argument_values` on `find_usages`, mirroring the
existing JSX `props:` filter), which is the asymmetry to close: for JSX the query exists and is excellent
(`props:{variant:['contained']}`, non-literal values kept at `dynamic`); for a plain call there is no
counterpart, and `destructures:` reports what a site CONSUMES, never what it PASSES.

Three axes are asked for, all off one mechanism (the argument expression at a call site):

1. **Literal VALUES at a positional argument** — the vocabulary inventory, to anti-join through `sql`
   against a dictionary that does not live in the repo at all.
2. **A KEY of an options-object argument** — "which call sites pass / omit `onError`", the
   options-object dialect of the same question.
3. **A literal VALUE for such a key** (`retry:false`, `enabled:false`), which `props:` already supports on
   the JSX side.

Honesty requirement stated identically by all reporters: a non-literal argument or a spread must stay at
`confidence:'dynamic'` with its source text, never be dropped — a spread is exactly where a hand audit goes
wrong, and grep's silence there is what produces false confidence in the expensive direction.

### Свидетельство

- 2026-08-02, `amiro/s-sales-money-surfaces` (RU report) and 2026-08-02, `amiro/z-authz-simplify` (EN
  report) — two agents, two worktrees, same class: `canAction(action: string)` is a fail-closed permission
  gate, so a retired code silently disables the control it guards. Both needed the set of literals reaching
  parameter 0; both fell back to `grep -rhno "canAction('[A-Z_]*')" src`. Real outcome: 12 literals in `src`
  against 14 live server keys — one stale (`CANCEL_SETTLED_INVOICE`), and its control was dead for EVERY
  role including owner, unnoticed. The grep also produced a false positive from a COMMENT, which a
  semantically resolved site excludes by construction.
- 2026-08-05, `amiro/forms-silent-writes` — options-object axis, twice in one track. `useMutation({…})`
  across a generated hooks file: "how many mutation hooks declare `onError`" decided whether a global
  `defaultOptions.mutations.onError` could be introduced. Answer was 0 of 128 and it INVERTED the plan;
  obtained with `grep -c onError`, which cannot tell an `onError` in a mutation options object from one in
  an unrelated literal in the same file. Second: an audit over ~184 `.mutate`/`.mutateAsync` call sites for
  `onError` as the second argument's key — same fallback.

Generality claimed by both reporters: this is the shape of every string-keyed vocabulary in a TS app —
permission codes, feature flags, query keys, analytics event names, i18n namespaces, `data-test-id`s,
`localStorage` keys — and `i18n_lookup` is effectively this op hardcoded for one function.

Priority raised `low → urgent` on that basis: three independent external reports, a grep fallback each time,
and a live silent-defect class behind two of them.
