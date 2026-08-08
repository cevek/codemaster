---
id: t-200621
title: No mutating op edits a JSX attribute, so TSX edits are done by text substitution — and a missed substitution is a silent no-op that every gate passes
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - react
type: feat
complexity: M
area: ts-refactor
source: dogfood-inbox-aug
relates:
  - t-109741
audience: external
evidence: reported
created: '2026-08-08T12:00:07.508Z'
---
The everyday TSX edit — "add / change / remove attribute A on element E, at these call sites" — has no
first-class mutating op. The mutators are symbol-addressed (rename / move / extract / change_signature) and
`codemod` is shape-addressed via ast-grep, so the cheapest path to a JSX-attribute edit is sed/python over
the file. That path's failure mode is a SILENT no-op: the pattern is a string reconstructed from the agent's
context, and one byte of drift (indentation) makes it match nothing, write nothing, and report nothing.
Nothing downstream catches it — an added optional attribute is not a type error, so typecheck, lint, knip
and the unit suite are all green over the un-made edit. A fix that did nothing is indistinguishable from a
fix that worked.

Two levers, in increasing order of value:

1. **`jsx_attr` mutating op** — set / remove an attribute on a RESOLVED component's JSX call sites (the read
   side already exists: `find_usages {props:{…}}` resolves the component through the LS, so an aliased
   `import {X as Y}` site is included and a text pattern's blind spot is not inherited). Rides the same
   dry-run + typecheck + capture gate as the other mutators.
2. **Match-count assertion for ANY shape-shaped mutation** — `codemod` knows how many nodes it rewrote.
   Surfacing "expected N, matched 0" as a REFUSAL rather than a successful empty diff turns every silent
   no-op in this class into a loud one. This is the cheaper and more general half: it is the §3 no-silent-drop
   rule applied to a mutation whose match set is empty, and it serves every caller who scripts an edit, not
   only JSX ones.

## Свидетельство

2026-08-05, external agent, amiro worktree `forms-w2-booking`. A scripted `python str.replace` meant to add
`aria-describedby={describedBy}` to one control matched 0 sites, wrote nothing, errored nothing; all repo
gates green afterwards; the defect surfaced only when the agent read the live accessibility tree in a
browser. Reported as: "the fastest path is sed/python over the file, whose failure mode is a silent no-op …
only a tool that counts its own matches can tell them apart before a human does."
