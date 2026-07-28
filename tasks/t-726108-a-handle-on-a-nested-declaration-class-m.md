---
id: t-726108
title: A handle on a NESTED declaration (class method / interface member) can't rebind from its own file, so a fuzzy flood makes it unrelocatable
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
relates:
  - t-233072
  - t-662704
surface:
  - plugins/ts
audience: both
evidence: measured
created: '2026-07-28T09:07:34.809Z'
---
The §6 rebind re-reads the handle's OWN file first (`plugins/ts/rebind-symbol-id.ts`), which is what
makes a held handle survive a fuzzy flood: the workspace symbol search can be filled by
case-colliding names, but the handle already names its file.

That first step uses `topLevelDeclarationsNamed`, which walks `sourceFile.statements` only. A handle
minted on a NESTED declaration — a class method, an interface member — is therefore invisible to it
and falls through to the workspace search, which the flood defeats.

Repro (measured): a repo with 250 × `export const span` plus `src/t0.ts` declaring
`export class Holder { Span(): void {} }`. Take the handle, shift the declaration one line, then
`find_definition {symbolId}` / `rename_symbol {symbolId}`:

```
FAIL "could not re-locate 'Span' (handle ts:Span@src/t0.ts:2:3) — the workspace symbol search hit
      the LS's own result cap, so this is NOT evidence the symbol is gone; re-address it by
      name+file or file:line:col"
```

Honest (it does not claim `gone` — the pre-fix code did, which was the §6 lie), but a precisely
addressed handle is unusable where it should be the easiest case. Fix shape: extend step 1 to nested
declarations before falling through — the `declarationsOnLine` walk already visits them, so the
missing piece is a name-scoped variant of it rather than new traversal machinery.

Same-file MERGED sets (an overload set, `interface` + `namespace`) are handled: several top-level
matches of one name in one file are one symbol, so the first is taken.
