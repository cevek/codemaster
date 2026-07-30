---
id: t-811950
title: An auto-escalated OVERSIZED repo gets the DEFAULT ~4 GB child heap — the escalation isolates the OOM instead of surviving it, so every reference question on a 6k-file monorepo is unanswerable
status: done
priority: high
parent: t-338692
type: bug
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-163532
  - t-187018
  - t-283990
  - t-396905
  - t-544207
surface:
  - src/config/config.ts
  - src/daemon/heap-ceiling.ts
  - src/daemon/process-host-factory.ts
audience: external
evidence: measured
created: '2026-07-30T11:17:14.589Z'
---
## Measured

`/Users/cody/Dev/backoffice2` (pnpm monorepo, ~10 apps + packages/common, 6101 src files) auto-escalates to
`process` isolation (6101 > `searchWarmMaxFiles` 4000). Every checker-backed op then dies:

    FAIL tool=oom — … isolated engine process ran out of memory (code=null signal=SIGABRT)

The relayed child fatal dump (`~/.codemaster/backoffice2-088897ca/child-stderr.log`) names the ceiling it
died at — three separate pids, same shape:

    30607 ms: Mark-Compact 4048.0 (4140.6) -> 4033.6 (4142.3) MB … allocation failure
    FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory

So the ceiling is **~4144 MB — Node's own default**, and the death is at 25–31 s, i.e. inside the PROGRAM
BUILD, not the query. It fails identically when addressed by an exact `symbolId` (no candidate page, no
name ranking) and even for `source`, i.e. "print these two declarations".

## The defect

`daemon.maxOldSpaceMB` defaults to "≥ Node's own ~4 GB" (ARCHITECTURE §19). Auto-escalation
(`escalate.ts`) fires precisely BECAUSE the repo was measured oversized — and then hands that child the
same heap a normal one gets. The escalation therefore converts "OOM kills the daemon" into "OOM kills the
op honestly", which defends §1/§3 at ZERO capability: the machine has RAM to spare and the answer was
reachable, but nothing raises the ceiling.

The oversized-ness that TRIGGERED the escalation is exactly the signal the child's ceiling should scale
with (and it is already computed — `estimateSourceFileCount`).

## Scope

- Decide the ceiling from the escalation's OWN measurement (+ machine RAM as the upper bound), rather
  than a fixed default. An honest cap is still a cap: over it, refuse — but refuse at a ceiling that
  reflects the box, not one 4 GB below it.
- `t-187018` is the adjacent ask (no per-call / per-session LEVER to set it); this one is about the
  DEFAULT being wrong for the one case we already know is oversized. Both are needed: a caller inside
  someone else's repo can set neither today.
- Verify on backoffice2 by measurement, not by reasoning: raise the ceiling, re-run the three
  `find_usages` calls, record peak RSS + wall-clock. If ~6 GB answers, the whole class closes for this
  repo shape.


## Measured — the ceiling this repo actually needs (recorded here, not only in a chat)

Box: 32 GB RAM / 12 cores, macOS, node v22.21.1 (its OWN default heap limit on this box: **4144 MB**).
Repo: `/Users/cody/Dev/backoffice2`, read-only. Method: a real engine built EXACTLY as
`src/daemon/engine-child.ts` builds it (`createEngine` + `builtinPlugins`/`builtinOps`,
`isolation:'process'`) inside ONE process, so `--max-old-space-size` on that process IS the child's
ceiling; RSS via `/usr/bin/time -l`, live heap via `v8.getHeapStatistics()`.

`find_usages` (`name+file` = `packages/common/components/ActionButtons/ActionButtons.tsx`):

| flag (MB) | V8 limit | outcome | wall | live heap | peak RSS |
| --- | --- | --- | --- | --- | --- |
| 4096 | 4144 | SIGABRT/134 | 28.3 s | — | 4.27 GB |
| 5120 | 5168 | SIGABRT/134 | 32.4 s | — | 5.30 GB |
| 5632 | 5680 | **OK** (11 usages) | 29.7 s | 5197 MB | 5.26 GB |
| 6144 | 6192 | **OK** | 31.0 s | 5200 MB | 4.82 GB |

So: **fail at limit 5168 / ok at limit 5680 — the need is ≈5.2 GB live heap, 27–31 s.** The same
≈5.2 GB for two other shapes: file-pin in another package (`apps/emr/.../AccordionHeader.tsx`:
5171 MB / 26.9 s) and a BARE name (5226 MB / 27.1 s). The fan is therefore NOT the cost — one
type-authority program's checker is.

`--max-old-space-size=4096` yields limit 4144 = exactly Node's own default here, so the old fixed
default raised NOTHING: the mechanism existed and was a no-op, and the escalated child died at the
ceiling it would have had unflagged, ~1.1 GB short.

**On an 8 GB box the formula gives today's 4096**, i.e. this repo stays honestly unanswerable there.
That is the stated cap (half the box within [4096, 8192] MB, `daemon/heap-ceiling.ts`) against
machine-wide swap thrash — §1 ranks thrash below both a crash and a refusal because it stalls every
workspace — not an oversight; `daemon.maxOldSpaceMB` is the explicit escape.

## Measured — two premises of neighbouring tasks, corrected at the source

- **Discovery prune ENGAGES here.** 26 programs constructed (1.7 s, 278 MB RSS); primary
  `tsconfig.json` globs 6128 files; Σ `fileNames()` across all programs = **18374**;
  `estimateSearchPeak` = `{peakFiles: 6128, pruned: true}`; undiscovered =
  `["apps/patient-care/tsconfig.test.json"]`. So ~10 checkers do NOT sum, and §9's "backoffice2's
  pruned peak ~6107 files passes the threshold" is operative on this repo.
- **The death is NOT in the program build.** Parse+bind of that same primary costs 839–881 MB and
  4.5–5.8 s and SUCCEEDS at the 4 GB default; the ~4.3 GB delta is the checker / `findReferences`
  phase. Rates: ~0.14 MB/file parse+bind vs ~0.85 MB/file checker-backed — which is why the ceiling
  is derived from the box and not from a file count (no single MB/file coefficient exists).
- **`source` does NOT OOM here.** File-pinned: 839 MB / 4.5 s. By BARE name with 27 same-named
  declarations (`AppLayout`, the ambiguity path): 881 MB / 5.8 s. Both pass at the 4 GB default.

## Verified through the real path (not by reasoning)

Unmodified CLI one-shot, no config in the target repo, auto-escalation forking the child:
`ps` shows the child is `node --max-old-space-size=8192 … daemon serve-engine`, and all three
`find_usages` forms ANSWER: 38 s / 32 s / 40 s wall including cold start + fork + child startup
(inside the 120 s op deadline and the 150 s bridge deadline).
