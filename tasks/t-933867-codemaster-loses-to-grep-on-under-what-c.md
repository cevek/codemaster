---
id: t-933867
title: codemaster loses to grep on "under WHAT CONDITION is F called" — find_usages answers with sites, not guards; and ABSENCE of a call (which ops lack F) is unanswerable without an sql-joinable op-registry × call-sites producer
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-27T23:45:21.976Z'
---
Reported by worker 896f426e, the one agent of the OOM wave whose whole job was reconciling DOCS against
CODE — i.e. continuously asking "what is actually true here now". It used grep for 100% of that and
reached for codemaster zero times. It never lied, hung, or served stale; it lost on round-trips.

## 1. The question is the CONDITION, not the site

To document the semantic-fanout guard's real coverage the worker needed, per call site, the guard
CONDITION — `if (isFanCapableTarget(args))` in the trace ops, `if (owner.id === 'ts' ||
owner.deps.includes('ts'))` in `list` — not merely where `semanticFanoutRefusal` appears.

`find_usages` returns `file:line` + enclosing symbol, which leaves ~15 follow-up reads to recover the
surrounding `if`. `grep -rln` + reading the blocks is two calls. So the tool's answer was correct and
still more expensive than the fallback it exists to replace.

Ask: for a call-site result, carry the ENCLOSING GUARD — the condition chain the site sits under
(`if`/`&&`/early-return), the way trace ops already carry per-hop context. Even one line of it collapses
the follow-up reads. This generalizes well past this case: "where is X called, and when" is the normal
shape of the question; "where is X called" alone almost never is.

## 2. Absence is structurally unanswerable — the bigger half

The wave's real defects were ABSENCES: `list` had no guard (crashed the daemon), `find_unused_i18n_keys`
/ `find_missing_i18n_keys` still have none (t-004414). No op answers "which ops do NOT call F" — the
anti-join. Today that is a hand audit, which is exactly how the t-411303 audit missed `list` and produced
the incident this wave cleaned up.

The engine for it already exists: `batch + sql` runs a read-only SELECT over aliased op tables (§11), and
anti-joins are named in the docs as the motivating use. What is missing are the two PRODUCERS:
- the op registry as rows (op name, plugin deps, flags — one row per op), and
- call-sites of a named function as rows (site, enclosing symbol, enclosing condition per item 1).

With both, `SELECT ops.name FROM ops LEFT JOIN callsites ON … WHERE callsites.name IS NULL` is the audit
that no human has to repeat. Producers run uncapped in sql-mode precisely so `NOT IN` cannot lie (§11) —
which is the property an audit needs and a capped list cannot give.

This is the highest-leverage item from the wave's dogfood: it turns the class of bug that caused the
incident (an op silently missing a guard) from a recurring manual sweep into a query.

## Resolution — the second half of this task's premise was WRONG

**"Absence is structurally unanswerable" is false: it needs no new op.** The anti-join runs today over
two `find_usages` producers, because the FAMILY is itself a call-site set — every op is exactly one
`defineOp(…)` call:

```
batch requests: {as:"fam", find_usages {name:"defineOp", role:"call", filter:{pathInclude:["src/ops/**"]}}}
                {as:"f",   find_usages {name:"semanticFanoutRefusal", role:"call", conditions:true}}
sql:            SELECT fam.file FROM fam WHERE fam.file NOT IN (SELECT file FROM f)
```

Measured on this repo: the `fam` producer returns 37 files in `src/ops/**` — SET-IDENTICAL to the 37
entries of `builtinOps()`, not merely equal in count (a text search for `defineOp({` finds only 29:
the generic and line-broken call forms are invisible to it). 15 files call the guard; the holes
include `find-unused-i18n-keys.ts` and `find-missing-i18n-keys.ts` — reproducing the wave's hand
audit (t-004414) exactly.

So the two producers this task asked for are NOT built, and `list` gains no `ops` registry (the op
catalogue is engine state; `ctx.daemon.opNames` carries names only, and enriching it means editing
`daemon/**` for a capability that already exists). Anyone re-reading this task should not file them
again. What was actually missing was DISCOVERABILITY and the CONDITION.

**Shipped instead:**

1. `concepts: absence-audit` — the recipe in the terse default `status` render (first contact; the
   reason the reporting worker never reached for it is that nothing named it), with its limits and
   completeness floors in `find_usages`' notes. Behaviour-tested, not prose-tested
   (`test/e2e/sql-absence-audit.test.ts`): the exact hole set, the one-member-per-file precondition
   catching the case it exists for, and an aliased/line-broken member a text producer would miss.
   The residual error direction is stated: with both producers complete the answer is an UPPER bound
   (a false alarm costs one read; a missed hole is the bug being audited for).
2. `find_usages {conditions:true}` — item 1 of this task. The enclosing conditional-BRANCH chain per
   site, rendered `⟨a && !(b)⟩`, sql column `condition`. It answers the coverage question the wave
   opened 15 blocks for: `list`'s `⟨owner.id === 'ts' || owner.deps.includes('ts')⟩` and the traces'
   `⟨isFanCapableTarget(args)⟩`, in one call.
3. An honesty gap found on the way: the undiscovered-program LOWER-BOUND floor was never projected
   into a sql answer at all (sql returns `{columns, rows}` + `TableSpec.notes` only), so an
   anti-join over an incomplete reference set read as a clean set — the one direction an absence
   audit must never take. `findUsagesTable.notes` now emits it.

**Why the annotation is trustworthy:** three oracles, each with its limits stated. The fixture table;
a top-down descent (catches mechanics, NOT a wrong rule — it shared the case-expression hole and
stayed green); and EXECUTION — an executable fixture run over every input combination, asserting a
site fires ⟺ its reported chain evaluates true. Every rule is mutation-pinned. Empty-vs-absent is
load-bearing end to end: `''` = measured "no enclosing branch" (never "always runs"), NULL = not
annotated, leading `<unstated>` = the chain is a subset.

Residuals filed: t-278380 (member_usages has no `conditions`), t-109609 (default-value
short-circuits, disclosed not measured), t-077593 (per-row climb cost + `⟨no branch⟩` density),
t-974740 / t-309134 (the mirrored-renderer pattern this avoided), t-213394, t-730980.
