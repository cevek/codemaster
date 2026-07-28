---
id: t-561552
title: topLevelDeclarationsNamed is blind to a top-level binding pattern / namespace import-export, so name+file reports a false absence for a symbol the file plainly declares
status: backlog
priority: medium
tags:
  - dogfood
  - honesty
type: bug
complexity: M
area: platform
created: '2026-07-28T18:41:41.813Z'
---
`src/plugins/ts/declarations-on-line.ts` `topLevelDeclarationsNamed` walks `sf.statements` and
anchors a declaration only when its name is a bare identifier. Three top-level forms it therefore
does not see, although each declares the name:

```ts
export const { alpha, beta } = obj;   // binding pattern
import * as everything from './m';    // NamespaceImport
export * as ns from './m';            // NamespaceExport
```

codemaster contradicts itself on them — `search_symbol {query:'alpha'}` returns
`ts:alpha@src/m.ts:2:16 · const`, and `find_definition {file, line, col}` resolves it, while
`{name:'alpha', file}` cannot anchor it.

Two consumers still carry the blind spot (a third, the col-less miss message, no longer asks the
walk anything):

1. `src/plugins/ts/resolve-target.ts` `resolveNameInFile` — the miss message no longer claims the
   file declares no such symbol (it reports the capability limit and names `search_symbol`), so
   the LIE is gone; the CAPABILITY gap is not. `name+file` remains unable to address a symbol the
   repo declares, on every op that routes through it.
2. `src/plugins/ts/rebind-symbol-id.ts` — the §6 rebind consults the same walk, so a handle held
   on such a declaration can read `gone` ("no symbol of this name/kind remains in the workspace")
   while the declaration is untouched. Reachability is low today: no codemaster path MINTS such a
   SymbolId (navto does not index the namespace form either), so it needs a hand-written handle —
   but `gone` is the §6 claim the agent's whole chain rests on, so it should not be reachable at
   all.

Fix at the walk, which closes both at once: recurse into a `VariableDeclaration`'s
`BindingPattern` elements, and anchor `NamespaceImport` / `NamespaceExport` (and, decide
deliberately, an `ImportSpecifier`'s local name — that one changes what `name+file` resolves for
ordinary imports, so it is a separate call).

Note the interaction: `declarationsOnLine` shares `isTargetableDeclaration` with this walk, so
widening it also makes a destructuring LINE anchorable by `file+line` (today it reads as
"the line anchors no declaration"). That is an improvement, but it changes the col-less
resolution path and its tests — do the two together, not by accident.

## Third consumer: the workspace name search says it outright

`src/plugins/ts/resolve-target.ts` `resolveByName` answers a flat `no symbol named 'ns'` for
`export * as ns from './other'` — the unhedged false absence, one call away from the `name`+`file`
message that now deliberately refuses to name a name-based call as a discriminator (because navto
misses exactly these forms while `{file,line,col}` resolves them).

Note the asymmetry to preserve when fixing: a workspace name search DOES find an `import * as X`
alias and a top-level binding pattern; it misses `export * as ns` and an object-literal property.
So "navto is blind to these forms" is true of some and false of others — any message or fix must
be scoped per form, not stated as a universal (that overclaim was itself a defect once).
