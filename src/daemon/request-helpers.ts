// Small per-request helpers split out of `engine.ts` (one responsibility per file, and
// to keep the engine under the line cap): strip the dispatch fields off a request to get
// its `OpFlags`, and fold the batch-entry freshness note into one op's result.

import type { FreshnessNote, Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { Plugin } from '../core/plugin.ts';
import type { Clock } from '../common/async/clock.ts';
import type { OpFlags, OpRequest } from '../ops/contracts.ts';
import type { DaemonInfo } from '../ops/registry.ts';
import { mergeFreshness } from '../common/result/merge-freshness.ts';

/** The agent-facing flags carried alongside `name`/`args`/`as` on a request. */
export function extractFlags(req: OpRequest): OpFlags {
  const { name: _name, args: _args, as: _as, ...flags } = req;
  return flags;
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
