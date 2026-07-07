---
id: t-000139
title: "**`~<rootTag>` printed on every SymbolId"
status: backlog
priority: medium
type: dx
importance: medium
complexity: L
area: density
created: '2026-07-08T00:02:18.000Z'
---
**`~<rootTag>` printed on every SymbolId — two-halves task (resolver-semantics THEN render-strip,
land together or not at all)** — the workspace tag (`~d19d0f20`) is identical on every id of a
single-root answer (it exists ONLY to refuse a cross-root rebind, §6), so it's ~10ch of pure
repeat × every id-bearing row (×200 in a busy `find_usages`) — the single biggest aggregate
constant in the tool. **Empirically confirmed (the blocker, tested mint-in-A/resolve-against-B):**
a tag-LESS id resolved against a DIFFERENT root that holds a same-named symbol at identical
relpath+name+pos returns a **`certain`** positional bind to the wrong symbol (resolve-target.ts:167-178)
— the exact silent §6 cross-root lie; the TAGGED id correctly returns `gone` (cross-repo.test.ts:207).
So a text-side strip ALONE re-opens that hole on the default (text) output path, and a header
caveat does NOT fix it (the caveat sits in answer 1; the lie is the `certain` resolve in a
_later_ call, where there is no flag — honest disclosure must sit AT the resolve, not remote).
**Unblock = TWO halves that MUST land in one change:** (1) resolver-semantics — a tag-less id
resolves _current-root-only_ (any cross-root ⇒ `gone`), so the resolve ITSELF becomes honest (a
real §6 task with its own cross-root surface); THEN (2) the render-strip — already designed
(`format/render/strip-root-tag.ts`: derive the single distinct `~<8hex>` over id-shaped leaves,
strip `:\d+~<tag>$`, 0/multi-tag honest fallback; JSON keeps the FULL tagged id; state the root
once in the header). DANGER: today the tag-less mis-resolve is LATENT (nothing strips); shipping
half (2) without half (1) ACTIVATES it. The token win is also concentrated where it's least
needed (json — the programmatic chaining path — already keeps the full id). `dx`·`med`·`cx:L`
