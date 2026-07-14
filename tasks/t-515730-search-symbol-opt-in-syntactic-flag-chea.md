---
id: t-515730
title: 'search_symbol: opt-in `syntactic` flag — cheap discovery to survive in-process OOM on huge monorepos'
status: in-progress
priority: high
parent: t-167395
tags:
  - dogfood
  - multi-program
  - platform
type: feat
complexity: M
area: ts-core
source: dogfood-jul
created: '2026-07-14T12:28:12.555Z'
---
## Why
First-contact `search_symbol` (fuzzy) fans navto out across ALL programs → OOM on a huge monorepo. In `isolation=in-process` (today's default) an OOM is UNCATCHABLE → kills the shared daemon → every warm repo lost → `MCP error -32000: Connection closed` → instant, irreversible loss of agent trust. We cannot reliably pre-empt OOM in-process (V8 aborts before any budget hook). So give the agent a cheap opt-in path + a PRE-EMPTIVE hint. Parent t-167395 has the full investigation.

## What: a new opt-in flag on search_symbol (default OFF)
Proposed name `syntactic: true` (alt `fast`). Default stays navto (exact; the `matches the LS workspace-symbol provider` contract intact). Flag switches to the syntactic path proven in the investigation: `sourceFile.getNamedDeclarations()` + `ts.createPatternMatcher` over parsed SourceFiles, NO program build (~1 s / ~0.2 GB on ANY topology; measured backoffice2 6082 files). Both TS fns are pure + project-agnostic (TS 6.0.3 vs 5.6.3 → identical matches), so use codemaster's OWN bundled TS for the matcher; parse with the project's TS. `getNamedDeclarations` is `@internal` but runs on SourceFiles we parse — a cheap AST-walk fallback exists (`declarations-on-line.ts::isTargetableDeclaration`).

## Honesty guardrails (so "cheap" never becomes a lie)
1. **Imprecision = over-completeness, NEVER a SILENT omission (within a disclosed scope).** The flag is COMPLETE for declarations in the §10 git source surface UNDER the workspace root (≥ navto's recall THERE). "Not super-precise" = noisier (extra import/re-export re-mention sites) + own ranking + not byte-identical to LS — NOT "may silently miss a symbol declared under the root". SCOPE (BLOCK 1, empirically established): the absolute "⊇ navto" held only while every navto-visible file sits under the git root; a tsconfig `include`/`reference` reaching OUTSIDE the root (`../shared`) is navto-visible but NOT git-listable at the root, so it is out of scope and DISCLOSED (result note + schema/notes, positive "scanned all source under <root>; outside-root not covered — use the default"), never silently dropped. Detecting which configs escape the root = config inspection = program-discovery (Track 2), out of this path's boundary. A discovery path that can *silently* miss is a trust-killer; complete-under-a-stated-scope + honest disclosure is fine (§3.6).
2. **GATE before build: run down the stragglers to ZERO under-root misses.** Harness (2 repos, ~30 queries) showed MISSraw≈0 but 1 straggler on a few queries (`Option`/`OPTIONS`/`DentalEvaluation`: a position-key artifact — `X as Yprefix` ImportSpecifier / expando `BinaryExpression` anchor divergence, NOT a recall gap). Guaranteed: syntactic-raw ⊇ navto FOR SOURCE UNDER THE ROOT. One silent under-root miss = §3.4 lie. This is the merge gate.
3. **Provenance + proof per site.** Every result carries proof-span + kind + `provenance: syntactic` (already in §3.3 model). Nothing is passed off as navto.
4. **Result note in flag mode:** "syntactic index (not the LS navto provider): complete for declarations; includes extra import/re-export sites (definitions ranked first); differs from precise search — drop `syntactic` for the exact LS result (may be memory-heavy on huge monorepos)." Do NOT emit the `matches the LS provider` claim in flag mode.
5. **Ranking:** real declarations (const/function/class/interface/type/enum/enum-member) FIRST, then by PatternMatcher kind (exact>prefix>substring>camelCase). So the result cap shows definitions; import re-mention noise falls into the truncated tail under the honest `… N more` marker.

## Why NOT reproduce navto's dedup (recorded so nobody retries it)
navto's include/dedup is SYMBOL-IDENTITY (checker) based: it keeps an import-alias site iff the name has no in-repo definition (external lib symbol), and dedups a local name's imports to its definition. A name-based syntactic rule ("drop imports of names with an in-repo real decl") is PERFECT on codemaster (local-heavy: miss=0) but MISSES 1511 on backoffice2 (`Option` 346, `Form` 338, `Modal` 176, `Button` 135…) because common names are BOTH local decls AND library imports (`@mui` `Button` ≠ local `Button`) — only resolution tells the symbols apart. So we do NOT reproduce navto; we ship an honest under-root superset (guardrail 1) instead.

## Pre-emptive hint (delivery matters)
The hint MUST live in the static `inputSchema`/op-notes (always in the agent's context, §11) — after an in-process OOM the daemon is DEAD, so codemaster cannot say "I crashed, retry with the flag" post-hoc. Wording actionable without the agent knowing the mode: "On very large monorepos the precise search can be memory-heavy; if a call fails or times out, retry with `syntactic:true` (cheap, complete, but noisier and not identical to the LS)." After the crash the next call respawns a fresh daemon (lazy singleton), so a flagged retry succeeds.

## Scope / relationship
- The OOM-danger framing is IN-PROCESS-specific (process mode → OOM is a survivable honest `ToolFailure`, daemon lives). The flag itself is a useful perf option in both modes; the "risk of crash" wording is gated to in-process (engine knows `config.daemon.isolation`; surface in `status`).
- Necessary but NOT sufficient: the default still OOMs for an UNAWARE agent's first call. Pair with Fix A (skip file-covered programs — lightens the default on loose-root; parent task) and process-mode isolation (durable never-crash; t-000052).

## DoD
`syntactic:true` returns a proven under-root superset (0 under-root misses vs navto on both fixtures) with provenance:syntactic + note + definition-first ranking; default unchanged; pre-emptive hint in schema; outside-root scope disclosed positively (BLOCK 1); oracle test = syntactic-raw ⊇ navto over the harness query set on a loose-root monorepo fixture AND a local-heavy fixture, PLUS an outside-root scenario asserting the honest scope-disclosure behavior (not a dropped case); no program built on the flag path (assert plugin stays cold / no LS warm); parsed-surface cache invalidates on an untracked add→modify→remove (§10-surface fingerprint, not projectVersion).
