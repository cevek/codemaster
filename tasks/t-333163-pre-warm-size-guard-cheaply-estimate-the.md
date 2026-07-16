---
id: t-333163
title: 'Pre-warm size guard: cheaply estimate the fan-out surface before warming the LS for a bare-name search_symbol; over a threshold → refuse + redirect to symbols_overview / syntactic (anti-OOM in-process, anti-memory-bloat in process-mode)'
status: backlog
priority: medium
parent: t-031282
tags:
  - dogfood
  - multi-program
  - platform
type: feat
complexity: M
area: platform
source: dogfood-jul
created: '2026-07-16T22:47:35.226Z'
---
**Motivation (two-fold).** Agents rush straight to `search_symbol`, whose default navto path fans across ALL programs and warms the LS. On a large monorepo this (a) **OOM-crashes the in-process daemon** (t-167395 — observed live: `search_symbol` on backoffice2, 14 apps / 7278 symbols, killed the daemon) and (b) **even in process-mode** (crash-isolated) loads the user's RAM with a warmed program that then squats until idle-TTL eviction — gigabytes of throwaway garbage for a one-shot discovery query that `symbols_overview` answers no-warm. Both argue for refusing the risky warm up front.

**Idea.** BEFORE warming the LS for a bare-name `search_symbol`, cheaply estimate the fan-out surface (how much would be loaded). Over a threshold → refuse with an actionable redirect instead of warming (§1 never-crash / resource-respect).

**Cheap estimate (must be cheap + §19-bounded).** Reuse the already-cached §10 git-source surface — the count (and/or summed bytes) of git-tracked `.ts/.tsx` under root, which is ~what navto would load. This is `git ls-files`-cheap and already memoized (the same surface `symbols_overview`/`search_symbol {syntactic:true}` use). MUST NOT trigger a fresh `parseJsonConfigFileContent` full tree-scan (that is exactly the ls-host hang, §19). Bytes is a closer proxy for type-checker memory than file-count; file-count is simpler. Worker picks / measures.

**Threshold — by volume, not program-count.** "> 3 programs" is weak (3 tiny ≠ 3 huge). Gate on total files (or bytes) in the fan-out surface, empirically calibrated (backoffice2 crashed; codemaster ~1k files is fine). Configurable via `codemaster.config` with a sane default.

**Scope — the warm-triggering discovery op with a cheap alternative.** Primarily `search_symbol` (default navto): highest risk (fans all programs) AND has a no-warm substitute. Do NOT blanket-refuse the semantic ops (`find_usages`/`find_definition`) — they NEED the LS and have no cheap alternative; their real fix is process-isolation (t-000052). The guard redirects the *discovery* step to the no-program path, after which a targeted op runs on a specific symbol (bounded), not a repo-wide navto.

**Honest refuse (§1).** Over threshold → `ToolFailure`/refusal: "repo is large (N files / M MB) — warming the type-checker risks OOM and loads memory for a throwaway query; browse via `symbols_overview`, then `find_definition`/`find_usages` on the specific symbol, or `search_symbol {syntactic:true}` for an OOM-safe fuzzy search." `search_symbol {syntactic:true}` is NOT guarded (it's the sanctioned no-warm escape). Consider a `force:true` override.

Complements t-167395 (the OOM) and t-000052 (process-isolation) — a cheap pre-emptive layer even before isolation lands. Source: live dogfood 2026-07-16 (backoffice2 OOM) + owner design session.
