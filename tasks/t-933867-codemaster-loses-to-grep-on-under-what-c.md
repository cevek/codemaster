---
id: t-933867
title: codemaster loses to grep on "under WHAT CONDITION is F called" — find_usages answers with sites, not guards; and ABSENCE of a call (which ops lack F) is unanswerable without an sql-joinable op-registry × call-sites producer
status: backlog
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
