---
id: t-751003
title: "discrimination_sites: an 'kind' in x narrowing can strip aliasSymbol → the site is a false-NEGATIVE (honest under-coverage)"
status: done
priority: low
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-08T16:00:15.135Z'
---
discrimination_sites gates on IDENTITY: the scrutinee object's type must BE the union T (reference-equality OR shared aliasSymbol), never structural assignability — else every `.kind` switch on every kind-union floods as a false-`certain`. Structural super/subtypes of T are therefore dropped as honest under-coverage.

## Resolution — by-design honest under-coverage (variant 2); actionable core = the disclosure

The original premise (an `in`-narrowing `if ('kind' in x) switch(x.kind)` strips the aliasSymbol → false-negative) is **UNVERIFIED / superseded**: empirically TS PRESERVES the alias whenever the whole union survives an `in`-narrowing (`x: T`, `T | {other}`, alias-of-alias, `T & extra` under a guard, generic `S extends T`, reassigned local — all keep `aliasSymbol === T` and are already detected).

The genuine reproducible false-negative is a scrutinee whose type is an INTERSECTION `T & X` (e.g. `Shape & { traceId?: string }`) or a mapped-type wrapper (`Readonly<T>`) — missed with OR without any `in`-guard. But this is NOT identity-recoverable: for any UNION target T (which the op requires), `(A|B) & X` DISTRIBUTES to `(A&X) | (B&X)` — a union whose arms are intersections of T's CONSTITUENTS, never T itself. So `isIntersection()` is never true at top level for a union target, and no direct constituent equals T. Recovering these needs STRUCTURAL matching over the distributed arms — exactly the flood-risk the identity gate exists to prevent, and > S complexity.

So deep recovery stays **by-design honest under-coverage**. The actionable, in-scope, flood-free fix shipped: the empty-note previously dressed a genuine `T & X` sub-type miss as "a structural supertype correctly excluded" (a §3.6 inaccuracy — a miss presented as a correct exclusion). Both the engine empty-note (`discrimination-sites.ts` `emptyNote`) and the op's static v1-scope note (`ops/discrimination-sites.ts`) now DISCLOSE intersection/mapped-type discrimination as honest under-coverage — an agent reading a 0-site answer knows a `T & X` switch was MISSED, not proven absent. Oracle test: `test/differential/discrimination-sites.test.ts` (`intersection scrutinee T & X is missed, and the empty-note honestly discloses it`).

Structural-recovery of the distributed/mapped forms is a separate LARGE effort with uncertain viability (unknown whether the distributed arms reuse T's constituent types by identity; if not, only structural-by-shape works, which floods) — not filed as a follow-up.
