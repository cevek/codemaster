---
id: t-000524
title: An import specifier whose module spec doesn't resolve reports ITSELF as its definition, so same-symbol aliases never collapse (loose-root monorepo)
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-000075
  - t-000076
  - t-000078
  - t-000080
  - t-021513
  - t-286255
  - t-648252
  - t-821130
  - t-899082
surface:
  - plugins/ts
audience: external
evidence: measured
created: '2026-07-28T07:00:42.499Z'
---
Measured on /Users/cody/Dev/backoffice2 (a loose-root monorepo: root `tsconfig.json` globs `apps/emr/**`,
while the `@/…` `paths` that resolve those files live in the member config).

```
codemaster op find_definition '{"file":"apps/emr/src/forms/ProviderForm/ProviderForm.tsx","line":16,"col":10}'
→ definitions (1): ts:SaveButton@apps/emr/src/forms/ProviderForm/ProviderForm.tsx:16:10 · alias
```

The position is the `SaveButton` of `import { SaveButton } from '@/…'`. The answering program is the
primary (primary-first `sourceFileAcross`), whose options carry no member `paths`, so the module spec does
not resolve and TS returns the import specifier as its own definition. `find_definition` therefore answers
"the definition of this alias is this alias" — true but useless, and it never reaches the declaration.

Downstream: the `{name}` ambiguity candidate list cannot collapse those aliases into the one declaration
they all name (`ambiguity.ts` keys candidates by resolved definition), so `find_usages {name:"SaveButton"}`
stays ambiguous with 8 unresolvable alias candidates beside the real declaration instead of resolving
outright. Not a lie — two unresolved aliases cannot be PROVEN to name one symbol — but the resolution is
recoverable: the file's own nearest config resolves the spec.

`typeAuthorityFor` does NOT fix it: it routes away from the primary only when the primary is a no-config
FALLBACK, and here the root config is real. What is missing is a definition/resolution query answered by
the program whose config is nearest the FILE (the same principle §5-L2 already applies to the file-driven
nearest-config discovery on the read path).

Hermetic repro not yet written (needs a two-config fixture: a loose root that globs a member whose
`paths` only the member config declares); the live measurement above is on current `main`.

## Negative result already paid for (don't re-run it)

Routing the definition query through `typeAuthorityFor(abs).service` was implemented and measured on the
live stand: the backoffice2 output was UNCHANGED (still 8 unresolvable alias candidates), because that seam
leaves the primary only when the primary is a no-config FALLBACK — backoffice2's root config is real, so it
returns the primary and the same unresolved answer. The attempt was reverted rather than left in as a
plausible-looking no-op. The fix has to be a resolution query answered by the file's NEAREST-config program,
which is not an existing seam.

## Field measurement: this is what makes a barrel-heavy monorepo unusable (dogfood-jul, /Users/cody/Dev/backoffice2)

`services/api` re-exports ~18 submodules and every consumer does `import { useX } from "services/api"`, so the
ambiguity gate counts each import binding as a declaration site. Verbatim:

    find_usages {name:"useUpsertFormV2", groupBy:"enclosing"}
    → FAIL tool=ts-ls — "useUpsertFormV2" is ambiguous — shown 3 of 3 distinct declaration sites
        ts:useUpsertFormV2@apps/emr/src/services/api/forms/emr.ts:135:14 (const)
        ts:useUpsertFormV2@apps/emr/src/containers/FormController/hooks.ts:8:5 (alias)
        ts:useUpsertFormV2@apps/emr/src/forms/MultimediaFormV2/hooks.ts:20:5 (alias)

Worst case measured:

    source {targets:[{name:"useMedicalEntriesV2"}]}
    → ambiguous — shown 8 of 19 distinct declaration sites !! 11 more not shown
       (1 const in services/api/medicalEntries/medicalEntries.ts; the other 18 all (alias))

So 19 "declaration sites" for ONE declaration, the candidate page TRUNCATES, and the answer then carries the
`!! CANNOT CLAIM` floor — over what is not an ambiguity at all. ARCHITECTURE §5-L2 states the collapse
already happens ("a barrel chain is one symbol seen N times; within one definition a real declaration
displaces the alias pointing at it"), so either this resolution path is the unresolvable-spec case this task
names, or collapse-by-definition is comparing identities minted by different programs. DISCRIMINATE FIRST
(a fixture barrel whose spec resolves vs one whose spec does not) — if both fail to collapse, the cause is
cross-program definition identity and this task is inside the multi-program blast radius, not beside it.

Note the answer already knows which is which: it prints `(const)` vs `(alias)` and sorts real declarations
first.

### Asks from the field, in cost order
- when the exact-name matches resolve to exactly ONE non-alias declaration, RESOLVE to it instead of failing
  (`preferDeclarations`, or make it the default);
- do not let alias entries consume the candidate-page budget — that is what pushed `useMedicalEntriesV2`
  into truncation and produced a floor-only answer;
- if aliases must stay visible, report them as `aliases: N` on the envelope rather than as candidates to
  disambiguate between.

### Cost
Two extra round-trips per symbol on EVERY lookup in a barrel-based repo. In the measured session the
re-addressed calls then OOMed, so this friction consumed the budget the real query needed.


## Cause, discriminated (fixture-proven, not inferred)

Three arms over one fixture shape (barrel `services/api/index.ts` re-exporting a single `const`
declaration, plus consumers doing a multi-line `import { useX } from <spec>`):

| arm | shape | outcome |
| --- | --- | --- |
| A | one program, spec RESOLVES (relative) | collapses → resolves to the declaration |
| C | TWO programs (loose root + member package), spec RESOLVES (root also declares `paths`) | collapses → resolves |
| B | TWO programs, spec resolves in NO answering program (`@/*` only in the member config) | 4 navto matches → 4 "distinct declaration sites": 1 const + one alias per consumer |

The barrel's own `export { useX } from './hooks'` never appears as a candidate — its relative spec
resolves in the primary too. What splits is exactly the set of aliases whose spec the ANSWERING
program cannot resolve.

Cross-program identity is NOT the cause, structurally: the collapse key is
`` `${def.fileName}:${def.textSpan.start}` `` — a path+offset string with no program scoping, so two
programs asked about one declaration produce a byte-identical key by construction. Arm C confirms it
behaviourally. This bug is therefore beside the multi-program blast radius, not inside it.

## Fix

`plugins/ts/ambiguity.ts` `definitionOf`: an ALIAS candidate whose owning program answered with the
specifier ITSELF (or with nothing) is re-asked across the other BUILT programs containing that file.
The member's own config resolves the spec, so the collapse is PROVEN by the project's own module
resolution — no second resolver of ours (§3.1).

- **Unanimity, not first hit.** Every containing program is asked; the definition is taken only when
  those that resolved it AGREE. Two sibling configs can map one spec to different files (a `paths`
  override, src-vs-dist types) — taking whichever we asked first would merge an alias into a
  declaration it may not name AND make the answer an artifact of iteration order. On disagreement the
  candidate stays distinct (honest ambiguity). This is also why the retry needs no ordering rule at
  all, and why no `configPath`/depth heuristic was introduced.
- **BUILT programs, never a file-driven `ensureProgramFor` load.** The built set is exactly what the
  write path's edit-site fan-out (`builtContaining`) and the §2.8 gate (`built()`) already read, so a
  collapse can never rest on evidence a mutation cannot see, and the verdict is session-order
  independent (§16 cold == warm — a lazily-loaded program set would answer "ambiguous" cold and
  "resolved" warm).
- **§7 write gate is not weakened.** `resolveForWrite`'s own refusal trigger (`searchTruncated`) is
  untouched, and the edit-site fan-out is unchanged. What changes is that the uniqueness gate now
  PASSES ON PROOF where it previously could not prove — the same evidence class arm A/C accepts today.

## Cost (§1), measured — and the OOM class it had to avoid

The obvious selection is wrong and dangerously so: `builtContaining` answers containment with
`containsFile`, which is `service.getProgram()?.getSourceFile(...)` — so merely FILTERING with it
BUILDS every program in the set. On a loose-root monorepo that is the ~25-program heap (~6.1 GB) the
t-167395 discovery prune exists to avoid by keeping navto on the primary alone; an in-process OOM is
uncatchable and kills the daemon (§1 ranks that below a wrong answer). Worse, the §9 pre-warm guard
admits the op on the PRUNED peak (backoffice2 ~6107 files) and the un-pruned fan-out it would then
trigger is what that guard refuses (~18k). And `getProgram()` is not cancellable (§19), so the
deadline could not rescue it.

So selection is build-free: `resolutionPrograms` reads `isTracked` — an O(1) lookup in the file list
globbed at construction — and only the programs that OWN the file are ever built (typically one
beside the primary). The remaining cost, and where it lands:

- `find_usages {name}` — was FAIL, now resolves; adds ~nothing (its reference fan-out builds the
  owning programs anyway).
- `find_definition {name}`, `expand_type {name}`, `impact {name}` — were FAIL, now resolve; each now
  builds the file's OWNING program, which it otherwise short-circuits past on the primary.
- `source {targets:[{name}]}` — already resolved pre-fix; unchanged.

Trigger stays the narrowest that can help: an ALIAS candidate, only after its own program failed to
resolve it, only on the bare-`{name}` path (`distinctDeclarations` is reached solely from
`resolveByName` / `resolveAllByName`, and only with ≥2 navto matches). A `symbolId` / `file:line:col`
/ `name+file` target never reaches it. Per-candidate work is one `getDefinitionAtPosition` per
consulted program; materialization is once per session.

CROSS-TRACK: safe while a bare-name resolve happens where the owning program is built anyway. If a
cheap no-program path (an oversized-repo `source`) is later routed through a checker-based resolve,
this would turn that query into an owning-program build — on the repo where the field session OOMed.

## Two honesty rules the selection carries (both mutation-pinned)

1. **A foreign config is not an authority.** A config that merely GLOBS the file may carry its own
   `paths` and resolve the same specifier elsewhere. Letting it settle what the file's imports mean
   collapses an alias into a declaration the file does not name — a confident answer about the wrong
   symbol. So the file's own nearest enclosing tsconfig must be among the admitted programs; absent
   it the answer is "cannot say" (NEG-4 pins this: 5 candidates, not 2).
2. **A position is only comparable where the identifier still stands.** The offset comes from the
   OWNING program's SourceFile, and a planning overlay lives on the primary alone (§5-L2) — inside a
   `transaction` a sibling reads DISK at that offset, where the position can denote an unrelated
   node. The retry re-reads the name there before trusting the answer (`holdsName`). Reachable, since
   a transaction step takes a bare `{name}`. This guard is NOT pinned by a test — see t-899082.

Also fixed in passing: `definitionAt` swallowed every LS throw, including the deadline's
`OperationCanceledException` — which would have turned a timeout into a confident
`'X' is ambiguous — shown N of N distinct declaration sites`, a fabricated count over a search that
never finished (§3.4). Cancellation is now rethrown so the op reports an honest `timeout`.

## Residual, NOT fixed here (different cause, different remedy)

The fixed arm-B answer carries no disclosure at all (`disclosures: undefined`). But on a repo with
UNDISCOVERED nested tsconfigs the bare-name answer still carries the `!! CANNOT CLAIM` floor via
`doubtOf` → `unindexed: undiscoveredProgramLabels()`, which this fix does not touch. That is honest
and has its own remedy (index the config) — it is not this bug, and not evidence that this fix
failed. See relates.

## Tests

`test/differential/ambiguity-alias-collapse.test.ts` — 9 arms: A / B / C, a cold==warm arm (over an
UNDISCOVERED member, so a file-driven load exists to be wrongly trusted), a self-answering-third-
program arm, and four anti-lie negatives (NEG-1 two real declarations stay ambiguous with the aliases
collapsed away; NEG-2 a spec no program resolves stays distinct; NEG-3 two programs disagreeing
collapse into neither; NEG-4 a foreign config is not the authority).

Mutation-checked — each mutant and what catches it:

| mutant | killed by |
| --- | --- |
| retry disabled (pre-fix) | ARM B, self-answering arm, NEG-1 |
| unanimity → first hit | NEG-3 |
| a self-answer counts as an opinion | self-answering arm |
| drop the nearest-config authority gate | NEG-4 |
| built set → every loaded program | cold == warm |
| drop the `holdsName` offset guard | NOTHING — t-899082 |
| drop the owner-skip | NOTHING (pure redundancy: the owner re-answers self and is skipped) |
