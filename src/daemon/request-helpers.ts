// Small per-request helpers split out of `engine.ts` (one responsibility per file, and
// to keep the engine under the line cap): strip the dispatch fields off a request to get
// its `OpFlags`, and fold the batch-entry freshness note into one op's result.

import type { FreshnessNote, Result, ToolFailure } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { Plugin } from '../core/plugin.ts';
import type { Clock } from '../common/async/clock.ts';
import type { OpFlags, OpRequest } from '../ops/contracts.ts';
import type { DaemonInfo } from '../ops/registry.ts';
import { mergeFreshness } from '../common/result/merge-freshness.ts';

/** The agent-facing flags carried alongside `name`/`args`/`as`/`root` on a request.
 *  `root` is routing (resolved by the orchestrator before dispatch), not an op flag. */
export function extractFlags(req: OpRequest): OpFlags {
  const { name: _name, args: _args, as: _as, root: _root, ...flags } = req;
  return flags;
}

/** Assemble the per-call `FreshnessNote` from the touched plugins' pending state (§3.5).
 *  Returns `undefined` only when the answer is fully fresh AND nothing was reindexed at
 *  entry AND no drift-check failure AND no clean commit to anchor — otherwise the note is
 *  surfaced (a silent reindex-at-entry is the §1.3 lie this guards against).
 *
 *  When `driftFailure` is set the backstop could not establish what changed (e.g. the
 *  drift `git diff` failed): we surface it as `unverified` AND suppress `indexedAtCommit`
 *  — stamping a commit whose changes we could not confirm were applied would be the exact
 *  silent-stale lie §3.5 exists to catch (a clean-tree checkout whose diff failed). */
export function buildFreshnessNote(
  order: readonly Plugin[],
  reindexed: number,
  cleanAtCommit: string | undefined,
  driftFailure: ToolFailure | undefined,
): FreshnessNote | undefined {
  const pendingTotal = order.reduce((sum, p) => sum + p.pending().length, 0);
  if (
    pendingTotal === 0 &&
    reindexed === 0 &&
    driftFailure === undefined &&
    cleanAtCommit === undefined
  ) {
    return undefined;
  }
  const staleFiles = [...new Set(order.flatMap((p) => [...p.pending()]))];
  const anchorCommit = driftFailure === undefined ? cleanAtCommit : undefined;
  return {
    plugins: order.map((p) => ({ id: p.id, fingerprint: p.freshness() })),
    pending: pendingTotal,
    ...(reindexed > 0 ? { reindexed } : {}),
    ...(staleFiles.length > 0 ? { staleFiles } : {}),
    ...(anchorCommit !== undefined ? { indexedAtCommit: anchorCommit } : {}),
    ...(driftFailure !== undefined
      ? { unverified: { tool: driftFailure.tool, message: driftFailure.message } }
      : {}),
  };
}

/** The daemon-attached context handed to every op (§ feedback-channel) — built fresh per
 *  call so `nowMs` reflects the injectable clock at op entry. `meta` is the engine's deps
 *  (structurally a superset of the fields named here). */
export function buildDaemonInfo(
  meta: { clock: Clock; version: string; root: string; stateDir: string },
  plugins: readonly Plugin[],
  opNames: readonly string[],
): DaemonInfo {
  return {
    nowMs: meta.clock.now(),
    version: meta.version,
    root: meta.root,
    stateDir: meta.stateDir,
    plugins: plugins.map((p) => ({ id: p.id, version: p.version })),
    opNames,
  };
}

/** Merge the freshness captured once at batch entry into a per-op result (worst-of), so
 *  every op in a batch reports the same consistent per-plugin view (§11). */
export function withBatchFreshness(
  result: Result<JsonValue>,
  batchFreshness: FreshnessNote | undefined,
): Result<JsonValue> {
  const merged = mergeFreshness([batchFreshness, result.freshness]);
  return merged === undefined ? result : { ...result, freshness: merged };
}
