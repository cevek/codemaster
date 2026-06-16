// Per-instance bookkeeping factored out of `plugin.ts` (300-line cap): the `literalCalls` memo and
// the transaction planning-overlay helpers. Both close over the plugin's `warm()` (and `root`),
// so they are created once per plugin instance — pure construction, no behavior change.

import type { RepoRelPath } from '../../core/brands.ts';
import { isOk } from '../../common/result/narrow.ts';
import type { TsProjectHost } from './ls-host.ts';
import { scanLiteralCalls } from './literal-calls.ts';
import type { CallMatchSpec, LiteralCallsResult } from './call-scan-shared.ts';
import type { PlanningOverlay } from './refactor/plan.ts';
import { loadTreeFromGit, buildTree } from './refactor/tree/build.ts';
import type { VFSTree } from './refactor/tree/tree.ts';

export interface LiteralCallsMemo {
  call(spec: CallMatchSpec): LiteralCallsResult;
  /** Drop the slot — MUST be called on dispose: a re-warmed host restarts `projectVersion` at the
   *  same value, so a surviving slot could otherwise collide and serve a pre-dispose scan (§3.1). */
  clear(): void;
}

/** F-a memo: a batch running several i18n ops calls `literalCalls` with the SAME spec each time;
 *  the scan is a whole-program AST walk, so re-running it per op is pure waste. Single-slot cache
 *  keyed on `projectVersion()` (what `freshness()` reports) + the serialized spec — any reindex /
 *  overlay bumps the version and invalidates it, so the memo can never serve a stale scan (§3.1). */
export function createLiteralCallsMemo(warm: () => TsProjectHost): LiteralCallsMemo {
  let slot: { key: string; result: LiteralCallsResult } | undefined;
  return {
    call(spec) {
      const h = warm();
      const key = `${h.projectVersion()}|${spec.functions.join(',')}|${spec.module ?? ''}|${spec.hook ?? ''}`;
      if (slot?.key === key) return slot.result;
      const result = scanLiteralCalls(h, spec);
      slot = { key, result };
      return result;
    },
    clear() {
      slot = undefined;
    },
  };
}

export interface PlanningHelpers {
  /** A plan op run as a transaction step plans against the cumulative prior-step state, never disk:
   *  shadow the LS with `overlay` for the SYNCHRONOUS plan body and ALWAYS clear it (try/finally) —
   *  the overlay must never leak into the transaction's final disk-baseline gate (§2.4). */
  runWithOverlay<T>(overlay: PlanningOverlay | undefined, fn: () => T): T;
  /** Build the move-tree from the overlay's listing (prior moves/new files baked in) or, with no
   *  overlay, from git (the standalone path). */
  planTree(overlay: PlanningOverlay | undefined): Promise<{ tree: VFSTree } | { error: string }>;
}

export function createPlanningHelpers(warm: () => TsProjectHost, root: string): PlanningHelpers {
  return {
    runWithOverlay(overlay, fn) {
      if (overlay === undefined) return fn();
      const h = warm();
      h.setOverlay(
        overlay.files.map((f) => ({ abs: h.absOf(f.path as RepoRelPath), content: f.content })),
        overlay.removed,
      );
      try {
        return fn();
      } finally {
        h.clearOverlay();
      }
    },
    async planTree(overlay) {
      if (overlay !== undefined) return { tree: buildTree(overlay.listing) };
      const t = await loadTreeFromGit(root);
      return isOk(t) ? { tree: t.data } : { error: t.failure.message };
    },
  };
}
