// Auto-escalation (t-754922, ARCHITECTURE §2/§9): decide ONE workspace's engine isolation at spawn,
// BEFORE the engine (and its ts plugin) exists.
//
// Why: an OOM inside the `in-process` default is UNCATCHABLE and kills the singleton daemon (§1) —
// and the repos that hit it carry no `codemaster.config` at all, so "set isolation:'process'" was
// advice to edit a nonexistent file. So an oversized repo is raised into a killable child
// automatically: the same fatal then arrives as a structural `ToolFailure` with the daemon alive.
// Escalation guarantees crash-SAFETY, not capability — a fan-out too big for the child's heap is an
// honest failure there, not a success.
//
// CONSISTENCY with the semantic fan-out guard (`ops/guard/semantic-fanout-guard.ts`) is by
// construction, not by a parallel implementation: both call the SAME host-free
// `estimateSourceFileCount(root)` (one `git ls-files` + extension filter, no LS, no program) and
// resolve the SAME threshold expression (`config.ts.searchWarmMaxFiles ?? the shared default`). The
// guard reads the engine's ACTUAL isolation (`ctx.daemon.isolation`, set by the engine the decision
// below produced), so an escalated repo silences it automatically.
//
// §2/§8 "the orchestrator never blocks": the git listing is synchronous, and runs at most once per
// engine SPAWN (inside `getOrSpawn`, which already does `loadConfig` + `tsProjectRefusal`, and is
// followed by an LS warm orders of magnitude heavier) — never per request, never per op. The memo
// below only damps repeated spawn churn (config-drift eviction respawns on the next request).

import type { CodemasterConfig } from '../config/config.ts';
import type { Isolation, IsolationReason } from '../core/isolation.ts';
import { isOk } from '../common/result/narrow.ts';
import { DEFAULT_SEARCH_WARM_MAX_FILES, estimateSourceFileCount } from '../plugins/ts/plugin.ts';

export interface IsolationDecision {
  /** `readonly` on purpose: a caller that needs a DIFFERENT outcome (a fork that failed) must say so
   *  explicitly rather than mutate the decision — a mutated field that nothing downstream reads is
   *  exactly how a stale-looking-authoritative object drifts from the effective behaviour. */
  readonly isolation: Isolation;
  readonly reason: IsolationReason;
  /** The counted in-root source files and the threshold they were compared against — present only
   *  when the estimate succeeded, so a message can quote real numbers instead of inventing them. */
  readonly files?: number;
  readonly threshold?: number;
}

/** Resolve the effective isolation for `root`. Pure decision — spawns nothing.
 *  `processHostAvailable` is the orchestrator's `spawnProcessHost` presence: an escalation that
 *  cannot be honored degrades to `in-process` (an explicit `isolation:'process'` still fails
 *  honestly upstream — a user who ASKED for a mode is told it is unavailable, never silently
 *  downgraded). */
export function resolveIsolation(
  root: string,
  config: CodemasterConfig,
  processHostAvailable: boolean,
): IsolationDecision {
  const explicit = config.daemon?.isolation;
  if (explicit !== undefined) return { isolation: explicit, reason: 'configured' };

  const threshold = config.ts?.searchWarmMaxFiles ?? DEFAULT_SEARCH_WARM_MAX_FILES;
  const estimate = countSourceFiles(root);
  // Unknown size → never escalate. The guard downstream still refuses honestly if IT can measure.
  if (estimate === undefined) return { isolation: 'in-process', reason: 'estimate-failed' };
  if (estimate <= threshold) {
    return { isolation: 'in-process', reason: 'within-budget', files: estimate, threshold };
  }
  if (config.daemon?.autoEscalate === false) {
    return {
      isolation: 'in-process',
      reason: 'auto-escalate-disabled',
      files: estimate,
      threshold,
    };
  }
  if (!processHostAvailable) {
    return { isolation: 'in-process', reason: 'no-process-host', files: estimate, threshold };
  }
  return { isolation: 'process', reason: 'auto-escalated', files: estimate, threshold };
}

/** Per-root memo of the git source count. NOT a consistency device (the decision is pinned for the
 *  engine's whole lifetime anyway) — purely a damper on repeated spawn churn. Bounded to a handful
 *  of roots so it can never grow with usage. A repo that outgrew a cached count stays in-process
 *  until the daemon restarts; the fan-out guard's own FRESH count then refuses the READ ops it
 *  covers — but NOT the mutating ops (rename / change_signature / move / extract), which warm and
 *  fan the same way and are unguarded (t-972931). So this is a damper with a known gap, not a
 *  safety net. */
const MEMO_MAX_ROOTS = 32;
const memo = new Map<string, number>();

function countSourceFiles(root: string): number | undefined {
  const cached = memo.get(root);
  if (cached !== undefined) return cached;
  const counted = estimateSourceFileCount(root);
  // A FAILURE is deliberately NOT memoized. It is usually transient (an `index.lock` during a
  // checkout, a HEAD-less fresh `git init`), and caching it would pin the workspace to
  // `estimate-failed` — i.e. never escalated — for the daemon's whole life, long after git recovered.
  // Re-paying one cheap listing on the next SPAWN is the right trade against silently disarming the
  // OOM defence on a repo that is genuinely oversized.
  if (!isOk(counted)) return undefined;
  if (memo.size >= MEMO_MAX_ROOTS) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(root, counted.data);
  return counted.data;
}

/** Drop memoized counts — test seam (a fixture that grows a repo between spawns). */
export function resetIsolationMemo(): void {
  memo.clear();
}
