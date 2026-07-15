---
id: t-381844
title: find_usages via a re-export alias mislabels the target's own function declaration as role 'write' instead of 'decl' (§3 role mislabel in classifyRole)
status: backlog
priority: medium
tags:
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-15T18:24:07.192Z'
---
**Repro (current main, hermetic).** When `find_usages` resolves a symbol THROUGH a re-export specifier (`export {X} from '…'`), the target's own function declaration site is classified `role: 'write'` instead of `role: 'decl'`. The SAME decl site resolved directly (not via the alias) is correctly `decl`.

**Cause:** `classifyRole` falls into the `isWriteAccess` branch when the LS reference is not flagged `isDefinition` for an alias-anchored symbol. Pre-existing `classifyRole` behavior — NOT introduced by t-755152 (surfaced in its re-export test output).

**Impact:** §3 — a definition presented as a write is a wrong, proof-carrying label an agent will trust. Fix `classifyRole` (or the alias-resolution path feeding it) so the decl site is `decl` regardless of whether resolution went through a re-export alias.

Source: track E codemaster feedback (verified live before filing). Related: t-755152 (member/re-export fallback, DONE).
