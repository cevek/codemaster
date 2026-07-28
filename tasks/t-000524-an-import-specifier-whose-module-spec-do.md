---
id: t-000524
title: An import specifier whose module spec doesn't resolve reports ITSELF as its definition, so same-symbol aliases never collapse (loose-root monorepo)
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-000076
  - t-000078
  - t-000080
  - t-821130
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
