---
id: t-455134
title: 'A symbol whose SECOND identity is a string literal cannot be renamed safely: rename_symbol rewrites the TS property and leaves every literal that names it, green in tsc and silently addressing a field that no longer exists'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - ts-refactor
type: feat
complexity: L
area: ts-refactor
source: dogfood-inbox-aug
relates:
  - t-288409
  - t-562577
audience: external
evidence: reported
created: '2026-08-08T12:04:00.254Z'
---
A whole class of symbols carries TWO identities: the TS declaration, and a STRING LITERAL that names the same
thing at every binding and read site. Form field paths, i18n keys, query-key factories, string-keyed store
collections and `data-test-id`s are all this shape. `rename_symbol` handles the first identity and is blind
to the second, so the rename typechecks clean while every literal keeps addressing the old name — a silent
runtime miss, not a compile error.

The literals are only PARTLY type-checked, and the unchecked remainder is where the damage sits: a path
assembled at runtime and cast (`` `field.${uuid}` as DeepKeys<T> ``) is checked nowhere, and neither is a
derived test id. So the failure survives every gate the repo has.

Two asks, the second being most of the value:

1. `rename_symbol` optionally FOLLOWS string literals that are contextually typed as `keyof T` / a
   template-literal path type of T at their use site, rewriting them with the declaration.
2. Independently of any rename: REPORT the ones it cannot follow — a list of "here is where this name is
   built at runtime or cast, check these by hand" turns a silent miss into a bounded manual task. A read-only
   sibling of the same query ("which string literals in the repo are contextually typed as `keyof X`") lets
   an agent audit the class with no mutation at all.

The class definition is "a symbol's name also lives as a literal in a checked-or-castable position" — a
specific form library is evidence, not the boundary. i18n-key renaming and query-key factories are the other
known instances and should be treated as siblings of this task, not duplicates of it.

## Свидетельство

2026-08-07, external agent, amiro worktree `sync-w1a-team-access`. Migrating a TanStack-form draft shape in
`src/features/team`: `accessGrants`/`coveredClinics`/`unrestrictedVisibility` → `accessType`/`clinicAccess`.
Unfollowable sites reported:
`form.setFieldValue(`clinicAccess.${clinicUuid}` as DeepKeys<AccessFormFields>, next as never)`,
`editedSuffixes(edited, 'clinicAccess')`,
`const CLINIC_ACCESS = 'clinicAccess' satisfies keyof TeamMemberFormFields`,
plus `<form.Field name="patientsVisibilityType">` and `Pick<T, 'a'|'b'>` slices. The whole rename was done
with grep and manual edits because "this property AND the string literals that name it" cannot be asked for.
