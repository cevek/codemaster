// t-679091 — the pre-warm guard for heavy SEMANTIC fan-out ops (find_usages / impact /
// importers_of, and find_definition when bare-name-addressed). The sibling of the search_symbol
// size-guard (t-333163), for the ops that warm the LS and fan references/imports across EVERY
// loaded program — the OOM surface Fix A's discovery pruning does NOT cover on a references
// monorepo (its primary doesn't subsume, so the fan-out builds all programs).
//
// §1 requires "don't crash", NOT "make the op succeed". t-000052 shipped the process-mode
// mechanism (killable child + child-exit→ToolFailure{oom}) but it is OFF by default (`isolation`
// defaults `in-process`, ARCHITECTURE §2), where an OOM is uncatchable and kills the singleton
// daemon. So IN-PROCESS, when the repo exceeds the same cheap git-source count the size-guard uses,
// refuse with an actionable redirect to `isolation:'process'` instead of warming into the OOM.
// Process-mode never refuses (it survives the OOM honestly). `force:true` overrides. An estimate
// FAILURE falls through (an optimization, never over-refuse — mirrors the size-guard).

import type { ToolFailure } from '../../core/result.ts';
import type { TsPluginApi } from '../../plugins/ts/plugin.ts';
import type { DaemonInfo } from '../registry.ts';

/** Refuse a heavy semantic fan-out when the in-process daemon would OOM on it — else `undefined`
 *  (warm as normal). Called at the TOP of a guarded op's `run()`, BEFORE any resolve/warm (a
 *  name-addressed call warms the LS inside `resolveByName`→`searchSymbols`, so a guard placed after
 *  resolve has already paid the OOM). Params are narrowed to exactly what the check reads (the
 *  isolation mode + the cheap estimate), so it composes with the full `OpContext`/`TsPluginApi` and
 *  is unit-testable without faking either whole. */
export function semanticFanoutRefusal(
  ctx: { daemon?: Pick<DaemonInfo, 'isolation'> | undefined },
  ts: Pick<TsPluginApi, 'estimateSourceFileCount' | 'searchWarmMaxFiles'>,
  force: boolean | undefined,
): ToolFailure | undefined {
  if (force === true) return undefined;
  // Only in-process: a forked child (process-mode) has its own killable heap → the t-000052
  // mechanism turns the OOM into an honest ToolFailure without touching the daemon. `undefined`
  // isolation (a synthetic context that never wired daemon info) is treated as NOT in-process → no
  // refusal, so the guard can never over-refuse where it can't confirm the risk.
  if (ctx.daemon?.isolation !== 'in-process') return undefined;
  const estimate = ts.estimateSourceFileCount();
  // Estimate failure (git hiccup) or a repo within budget → warm as normal. The guard is an
  // optimization against a known-oversized repo, never a correctness gate.
  if (!estimate.ok || estimate.data <= ts.searchWarmMaxFiles) return undefined;
  return {
    tool: 'size-guard',
    message: fanoutRefusalMessage(estimate.data, ts.searchWarmMaxFiles),
  };
}

function fanoutRefusalMessage(count: number, threshold: number): string {
  return (
    `repo is large (${count} source files > threshold ${threshold}) — this op warms the type-checker ` +
    `and fans references across every program, which risks OOM and (in-process) can kill the daemon. ` +
    `Set \`daemon.isolation: 'process'\` in codemaster.config to run this repo in a killable child ` +
    `(it survives the OOM as an honest failure, daemon stays up); or pass \`force:true\` to warm anyway.`
  );
}
