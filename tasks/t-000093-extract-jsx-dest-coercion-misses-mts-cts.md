---
id: t-000093
title: "extract JSX-dest coercion misses `.mts`/`.cts"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:32.000Z'
---
**extract JSX-dest coercion misses `.mts`/`.cts`** — `move-to-file.ts` coerces a JSX body's dest
`.ts`→`.tsx` only when it ends `.ts` (not `.mts`/`.cts`), and unlike `move_symbol` does not refuse
a non-`.tsx` JSX dest — a JSX body extracted to a `.mts`/`.cts` dest is created as-is and caught
only by the §2.8 typecheck (a less pointed message). Parity-nit with `move_symbol`'s upfront JSX
refusal. `dx`·`low`·`cx:S`
