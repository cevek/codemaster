# Spec: cross-repo queries — per-request `root` in batch (+ cross-root sql)

Status: **approved**. Implementation order for this round: **this spec →
[spec-text-overlay.md](spec-text-overlay.md) → [spec-i18n-plugin.md](spec-i18n-plugin.md)**
(one PR each, field-impact order).

## 1. Problem

The #1 field gap: real tasks span sibling repos (a design-reference frontend, a
second TS service) and agents fell back to grep for ~2/3 of the relevant code. The
orchestrator is already multi-workspace (`repoId → engine`) and all three tools
accept a tool-level `root` — but one batch cannot mix repos, and nothing tells the
agent the capability exists. Java/non-TS repos stay out of scope (§1 non-goal).

## 2. Fixed decisions

- **`root?: string` on each batch request** (`opRequestSchema`). Resolution:
  request-level `root` > tool-level `root` > client cwd. Canonicalized through the
  existing chokepoint; same lazy spin-up / governor / path-sweeper lifecycle (§9) —
  no new lifecycle code.
- **Orchestrator groups requests by resolved root**, dispatches one sub-batch per
  engine, reassembles results **in original request order**. Freshness stays pinned
  per (engine, its batch entry) — §11 promises per-plugin consistency, never a
  global version across workspaces; nothing new to promise.
- **A request whose root doesn't resolve** (missing dir, not a repo) gets a
  `DispatchError` with the offending path; the other requests still run. The whole
  batch fails only on malformed args.
- **Cross-root sql.** Single-root sql (no per-request roots, or all equal) keeps
  today's in-engine path untouched. A sql batch with **mixed roots** runs the join
  at the **orchestrator**: each producer executes in its owning engine (same
  `tableRowBound` threading, same uncapped-producer rule), its projected rows come
  back across the host boundary (thin data — exactly what the §2 seam is for), and
  one SQLite evaluates the SELECT. Refactor seam: `SqlBatchCtx` already takes a
  `runProducer` callback — generalize `opsByName`/`hasPlugin` to per-request
  resolvers; `runSqlBatch` itself stays single. Honesty envelope unchanged
  (`partial` tables, hard row bound). The sql result's `FreshnessNote` is the
  worst-of merge across the touched engines (`mergeFreshness`), each engine's
  plugins named.
- **SymbolIds do not cross roots.** A `ts:…` handle minted in repo A passed to a
  request rooted in repo B fails resolution with a pointed message ("SymbolId from
  a different workspace — re-search in this root"), never a silent miss.
- **Discoverability** (the actual field failure): one concepts line + one guidance
  line ("any call or batch request may carry `root` — neighbouring TS repos are
  first-class"), a sentence in `SERVER_INSTRUCTIONS`, and `status` lists the warm
  engines (root paths), so an agent sees multi-root is live.

## 3. Tests (§16 — independent oracles)

| Claim                                                              | Oracle                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| mixed-root batch: each answer correct, order preserved             | run the same op single-root against each fixture repo; results must be identical                            |
| request-level root overrides tool-level                            | fixture pair, deliberate conflict                                                                           |
| unresolvable root → per-request DispatchError, siblings unaffected | fixture                                                                                                     |
| cross-root sql anti-join                                           | two temp-git repos; join computed by hand in the test from the two single-root results                      |
| cross-root freshness honest                                        | mutate repo B (watcher silenced) → B-rooted results carry `reindexed`/`PENDING`; A-rooted results untouched |
| engine count + governor                                            | batch across 2 roots spins 2 engines; LRU budget still enforced (existing governor test extended)           |

## 4. Non-goals

No auto-discovery/auto-indexing of sibling repos (explicit `root` only — surprise
heap growth is a §9 hazard). No cross-root SymbolId resolution. No `root` on the
sql string itself (roots live on requests). No non-TS language support.
