---
id: t-120055
title: No op resolves a module path QUOTED IN PROSE (alias or relative) to a file — so `move_file` repoints importers while every path cited in a .md rots silently and then reads as authoritative
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-326222
  - t-701638
  - t-709349
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-07-28T16:10:36.915Z'
---
External report, `amiro/save-only-docs-alignment`, from a docs-vs-code alignment pass.

The symbol half went perfectly and is worth recording as such: `search_symbol` / `batch` resolved every
name (`usePageDirtyGuard`, `useNavigationDirtyGuard`, `PageEditFooter`, …) in ONE round-trip — the
intended use, working as designed.

The uncovered half was PATH claims. Docs and TSDoc comments quote import specifiers as prose:
`@/components/PopupCloseButton/PopupCloseButton`, `src/components/Form/`, `src/lib/dirty-guard.tsx`.
Nothing resolves those. **Two of the three docs touched carried a dead path**, both pointing at pre-move
locations.

The asymmetry is the point: codemaster's own `move_file` / `move_symbol` repoint every importer — that is
the product's core promise — but a path quoted in a `.md` is repointed by nothing, and a stale quote reads
as authoritative precisely because the surrounding doc was recently verified. So the tool's best feature
produces this rot as a side effect.

Ask: an op that takes a cited specifier — alias, relative, or repo-relative — and resolves it against the
project's own module resolution (the `paths`/`baseUrl` the ts plugin already applies), answering
`resolved:<file>` / `unresolved`. The machinery exists: `importers_of` already distinguishes a spec that
does not resolve under the project's own resolution from an honest resolved-zero, and says so loudly.
This is that check, exposed as a question rather than a side effect.

Cheap and high leverage for the class of work this session keeps producing: every doc track ends in a
sweep of quoted paths that currently has no verifier.

## Same-repo instance (dogfood-jul)

t-662704 cites `plugins/ts/resolve-target.ts` for `NAME_CANDIDATE_LIMIT` + `distinctDeclarations`; they live
in `resolve-contract.ts:12` and `ambiguity.ts:42`. Prose citing a module path that nothing repoints — inside
the document agents plan from. A batch of `find_definition` over the ~40 backlog bodies that carry a
`fix-locus:` would re-grade several stale entries in one call.
