---
id: t-000108
title: "move_symbol note(b) wording — \"fan-out is OFF\" reads as a disable-able mechanism"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:47.000Z'
---
**move_symbol note(b) wording — "fan-out is OFF" reads as a disable-able mechanism** — the
transaction cross-program note says the write-site fan-out is OFF inside a transaction, but
move_symbol is primary-only **by construction** (no `rewriteImports` branch — the LS drives the
repoint on the primary service), so there is nothing to switch off. The limitation-direction is
honest, but the phrasing implies a move_symbol-specific sibling-write path that gets gated.
Optionally reword to "primary-only by construction" for parity-accuracy. `dx`·`low`·`cx:S`
