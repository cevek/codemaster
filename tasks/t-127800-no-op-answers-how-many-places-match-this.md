---
id: t-127800
title: No op answers "how many places match this AST SHAPE" — a structural search that returns SITES (not a diff) is missing, so sizing a code class means building a second parser over a repo that already has a warm LS
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: L
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-000085
  - t-479658
audience: external
evidence: reported
created: '2026-08-08T12:01:57.754Z'
---
## What is missing

The catalogue answers questions about a SYMBOL's identity and reference graph. The other recurring question
is about a SHAPE: "where else is it done LIKE THIS", "how many sites match this form", "how many members of
this form do NOT carry X". There is no op for it, so the op-map correctly routes those to grep — and grep
answers them wrongly, not because of aliases but because the question is POSITIONAL: "`onError` as a
property of the second argument of a `.mutate` call" has no textual expression, and a hit count over a
regex reads as a measurement while being one.

`codemod` is shape-based (ast-grep) but is a MUTATION by nature: its output is a diff, and "show matches,
change nothing" through dry-run reads as a report about an edit rather than an inventory. `sql` cannot
compose over it — there are no rows to aggregate.

## Shape

    match_shape {pattern, filter?, groupBy?}   →  matched sites, proof-carrying

with the same honesty contract as every other op (truncation, completeness, `partial`/`dynamic`), and a
tabular projection so it composes through `sql`. "How many members of this family do NOT carry X" then
becomes the anti-join the `concepts` block already documents — over FORM instead of over symbol.

The value is wider than lint authoring: it is the question asked before ANY edit campaign ("how many places
will I have to touch"), and today a repo with a warm LanguageService answers it with a regex.

## Свидетельство

**2026-08-05, `amiro/forms-lint-gates`** — writing eslint rules for already-fixed invariants, under a gate
of "measure the class as a number first, then decide whether to write the guard". Six such questions in one
shift, none askable:

- how many `.mutate(` in `src`, and how many carry `onError` in the object argument (62 / 47);
- how many `useMutation({…})` without an `onError` property (74 / 60);
- how many `?? []` / `|| []` applied to `.data` / `.content` (314 / 150);
- how many `.filter()` receive a NAMED predicate rather than an inline arrow;
- how many `useAppForm` receive `onSubmit` inline vs by identifier (36 / 36 — and half turned out to be
  `validators: {onSubmit: schema}`, a different property with the same name);
- how many raw `<form>` outside the one wrapper (1).

Measured grep error: `grep -A6 useMutation | grep onError` counted 8 where the true number was 14;
`grep onSubmit:` conflated the submit handler with the validation schema. Fallback each time: a throwaway
script on `@typescript-eslint/parser` (hunted down inside `node_modules/.pnpm/...` because it is not
hoisted) or a throwaway eslint config with `no-restricted-syntax` — i.e. standing up a SECOND parser over a
repo that already holds a warm LS.

**2026-07-31, `task-manager/api-shape-only-read`** — session summary from a second agent: three times in one
session the search was for a PATTERN and not a symbol, and each time it ended in grep:

1. all lookups of the form `x in RECORD` / `RECORD[x]` where the key comes from user data (a
   prototype-pollution class: a custom field legally named `constructor` broke three paths);
2. all places where the same rule is recomputed by hand (one rule existed in two copies and had already
   diverged; another in five texts);
3. all producers of one string (`path.resolve(tasksDir)` vs raw `ctx.tasksDir` — two producers of one fact,
   which would diverge on the first symlink).

The reporter's own summary: "the common part of all three is *where else is it done THE SAME WAY*, not
*where is THIS used*" — and, after `find_usages`, the most frequent request of the session.
