---
id: t-908793
title: 'memo(function X) / forwardRef(function X) hard-FAIL as ambiguous: the function-expression name and the const it initialises are ONE binding, and this is the most common declaration idiom in a React repo'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
type: bug
complexity: S
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-161435
  - t-193866
  - t-821130
surface:
  - plugins/ts
audience: external
evidence: repro
created: '2026-08-08T12:03:56.655Z'
---
`export const X = memo(function X(props) { … })` — the standard React memo/forwardRef idiom — presents two
declaration candidates to name resolution: the `const` binding and the NAME OF THE FUNCTION EXPRESSION that
initialises it. They sit on the SAME LINE, and the second is not a second symbol in any sense a caller can act
on: a function expression's name binds only inside its own body, and here it names the very value being
assigned to the const.

Every bare-name op therefore hard-FAILs on the most frequent way a React component is declared, and the
recovery is a round-trip (`SymbolId`, or `mergeDeclarations:true` — which additionally marks the answer
`complete:false` whenever the candidate set was capped, per `t-128204`).

## Repro on current `main` (2026-08-08, hermetic)

```
/tmp/cm-memo/src/DiffView.tsx:
  declare function memo<T>(c: T): T;
  export const DiffView = memo(function DiffView(props: { a: string }) { return props.a; });
  export const use = () => DiffView;

node src/bin.ts op find_usages '{"name":"DiffView"}' --root /tmp/cm-memo
→ FAIL tool=ts-ls — 'DiffView' is ambiguous — shown 2 of 2 distinct declaration sites …
  candidates (real declarations first):
    ts:DiffView@src/DiffView.tsx:2:39 (function)
    ts:DiffView@src/DiffView.tsx:2:14 (const)
```

Both candidates are one line, one binding.

## Ask

Collapse automatically (with a note, the way other resolutions disclose their narrowing) when a candidate is
the NAME of a function/class EXPRESSION that initialises another candidate. The rule is structural, not
heuristic — the expression name's scope is the expression itself — so it does not widen what a name means; it
stops counting one binding twice.

`t-821130` already collapses a pure re-export chain to its one underlying declaration; this is the same move
for the other shape that mints a phantom candidate.

## Свидетельство (field report, 2026-08-02, /Users/cody/Dev/claude-ui)

`export const DiffView = memo(function DiffView({...}))` → `find_usages {name:'DiffView'}` FAIL ambiguous,
two candidates at `DiffView.tsx:19:14` (const) and `19:39` (function expression). Reporter: "требовать
mergeDeclarations:true здесь — лишний раунд-трип на самой частой идиоме в React-репозитории".

Two smaller arg-surface frictions from the same session, recorded here so they are not lost (both honest
`bad_args`, both from op DESCRIPTIONS implying filters that do not exist): `scss_classes` rejects `{query}`,
`list` rejects `{kind}`, while the spec lines read "SCSS class declarations in a sheet" and "does a component
/ hook / dialog already exist → list". Either add the filters or make the description name the real args.

## The MESSAGE is separately fixable, and cheaper than the collapse

Reproduced deliberately on a 4-line hermetic fixture, so this is first-hand. What follows is about what the failure TEXT does to a reader who does not already know the answer — it can ship before, and independently of, the resolution fix.

    ts:DiffView@src/DiffView.tsx:2:39 (function), ts:DiffView@src/DiffView.tsx:2:14 (const)

1. **Both candidates carry the same file AND the same line.** That is the strongest available evidence that they are one binding, and nothing in the message uses it. A reader without the "a function expression's name binds only inside its own body" fact cannot tell this pair from a genuine two-declaration collision in one file — which does exist (two same-named locals in different scopes), so the shapes are not distinguishable by eye.

2. **`candidates (real declarations first)` steers wrong here.** It reads as a curation guarantee — the list was vetted, the leader is the one you want. The leader is `2:39`, the function-expression name: the single candidate that is never what a caller means. Ranking prose that cannot be trusted on the commonest React idiom is worse than no ranking prose, because it is believed.

3. **The offered remedy is semantically wrong for this shape.** `mergeDeclarations:true` unions "all same-named declarations"; for a `memo`/`forwardRef` component there is nothing to union — there is one symbol. It additionally stamps `complete:false` whenever the candidate set was capped, so the cheap-looking escape DEGRADES an answer that had no incompleteness in it.

**Smallest useful change short of the collapse:** when two candidates share a file and a line, say so — "2 candidates on one line — likely one binding: a function/class expression name and the const it initialises". One comparison, no change to resolution semantics, and a failed call becomes self-explaining.

Worth keeping the two apart when planning: the collapse fixes the ANSWER, this fixes what the reader concludes while the answer is still wrong.
