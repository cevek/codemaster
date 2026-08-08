---
id: t-904217
title: 'No FORWARD reachability op ("what does F reach"): every absence-audit starts FROM a guard name, so a wrong guess about the name returns the expected answer with full confidence'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - honesty
type: feat
complexity: L
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-777453
  - t-933867
audience: external
evidence: reported
created: '2026-08-08T12:04:41.207Z'
---
## What is missing

Every op that answers "is there a check here" runs FROM a known symbol: `find_usages(F)`, `impact(F)`, and
the documented absence-audit anti-join (family NOT IN call-sites-of-F). All three require the guard's NAME
up front. The opposite direction — "what does this function call transitively, with per-hop proof" — does
not exist (`trace_*` are data-flow: a prop down, a field to render, an invalidation, widening; `impact` is
the reverse dependency graph).

    reaches {from: <symbolId|name>, to?: <symbolId|name>, depth?: N}

- without `to` — what F reaches transitively, ranked toward guard/precondition shapes (calls that throw or
  return early), each hop carrying its `file:line` proof;
- with `to` — does a path `F → … → G` exist. Here the answer "no" is a PROOF, not the silence of a search
  that was pointed at the wrong name.

## Why this is an honesty gap and not only a convenience one

When the premise about the guard's NAME is wrong, the anti-join does not fail safe — it AMPLIFIES the error:
it returns exactly the answer the asker expected, with full confidence, because the false premise sits in
its argument `F`. None of the documented boundaries (one-member-per-file, helper-file over-report,
completeness floors, `role:'call'`) covers that case: the set is complete, the counters are right, only the
hypothesis is false. Codemaster can prove today who calls X; it cannot prove that F calls nothing resembling
X, and that is the other half of the same promise.

## Свидетельство

2026-08-02, `amiro/c-company-settings-gates`. Task: bring the frontend under the server's gates. The agent
took the guard name from neighbouring services (`requireEntityLevel`) and asked "where is it absent". In one
service it was genuinely absent — but a DIFFERENT predicate stood there, arriving as
`import static <OtherService>.requireOwner`, i.e. under a third name from another file. The in-file search
honestly returned empty, and "no guard visible" was read as "no guard". On that the agent filed a backend-gap
task, disabled the mirror in the mock, pinned "passes without permissions" in the parity suite as DESIRED,
and wrote it into the docs: four artefacts agreeing with each other and jointly lying about the server, with
a green gate confirming it. Found only by adversarial review reading the source line by line. The track hit
`[BLOCK]` on it.

The incident itself was in Java (out of plugin scope); the CLASS is not — a renamed static re-export of a
predicate, whose name is invisible from the point of use, is precisely what the repo's own instructions cite
as the reason not to grep for symbols. The same shape is live in the TS tree of that repo:
`handlers/*.ts → requireOwnerOrAdmin → myPermissions → resolveMyPermissions` (last one cross-module), where
"does this handler enforce anything" already needs two hops through renamed imports.
