---
id: t-340801
title: Symbol-addressed ops cannot anchor on a type declared in node_modules (UseMutationResult, UseQueryResult, FormApi…) — so member-level auditing of ANY library surface is impossible, and the FAIL reads like a typo diagnosis
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T12:08:36.771Z'
---
Filed from /Users/cody/Dev/amiro by an EXTERNAL user of the tool (an agent doing product work, not editing
codemaster) — the population that reports least and is constrained most.

Audit wanted: "which UI controls fire a mutation on change instead of on Save". That is exactly one query —
every reference site of the `mutate` / `mutateAsync` MEMBER of react-query's `UseMutationResult`, grouped by
enclosing declaration. `member_usages` is precisely the right op, because it resolves by checker identity,
so an unrelated `.mutate` never matches.

```
member_usages {name:'UseMutationResult', member:'mutate', pathInclude:['src/**']}
→ FAIL tool=ts-ls — no symbol named 'UseMutationResult'
```

The type lives in `node_modules/@tanstack/react-query` — i.e. exactly where the interesting library-defined
result types live: `UseMutationResult`, `UseQueryResult`, `FormApi`, `RefObject`… Repo code never declares
them. **So member-level auditing of any library surface is impossible today**, and that is most of the
surface worth auditing in a React app: the framework defines the shapes, the app consumes them.

Wishes, in the reporter's order of usefulness:

1. Let a symbol-addressed op resolve a name/SymbolId from declaration files OUTSIDE the workspace — or
   accept `{module:'@tanstack/react-query', name:'UseMutationResult'}` as a target — so `member_usages` can
   anchor on a dependency's type.
2. Failing that, allow anchoring on a USE site: `{file,line,col}` at a local `const m = useUpdateThing()`
   plus a `member`. The checker already knows `m`'s type, so member identity is resolvable without naming
   the declaring type at all. (Cheaper, and it composes with how an agent actually navigates — it has a
   call site in front of it, not a library type name.)
3. The FAIL message is a separate defect: "no symbol named X" reads as a TYPO diagnosis and sends the
   caller to re-check spelling. When the name DOES resolve in `node_modules` but is excluded by workspace
   scoping, say THAT — it is a different fix for the caller (§3.6, and the same shape as t-959904: an
   honest refusal that points the wrong way).

Fallback actually used: text grep for `.mutate(` / `.mutateAsync(` — layer-blind (it hits wrapper hooks
like `use-service-actions.ts`, not the control that triggers them) and with no read/write/destructure
classification. So the silent-miss risk landed on a real audit.

Related: t-849286 (react-query consumption shape), t-959904 (refusals that point the wrong way),
t-109741 (the other case where a missing query shape put a wrong analysis into a shipped change).
