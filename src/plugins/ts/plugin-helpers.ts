// Per-instance bookkeeping factored out of `plugin.ts` (300-line cap): the `literalCalls` memo and
// the transaction planning-overlay helpers. Both close over the plugin's `warm()` (and `root`),
// so they are created once per plugin instance — pure construction, no behavior change.

import type { RepoRelPath } from '../../core/brands.ts';
import { isOk } from '../../common/result/narrow.ts';
import type { TsProjectHost } from './ls-host.ts';
import { scanLiteralCalls } from './literal-calls.ts';
import { scanCallArgShapes } from './call-arg-shape.ts';
import { scanFunctionDeclarations } from './function-declarations.ts';
import type { CallArgShapesResult, CallMatchSpec, LiteralCallsResult } from './call-scan-shared.ts';
import type { FunctionDeclarationsResult } from './function-declarations.ts';
import type { PlanningOverlay } from './refactor/plan.ts';
import { loadTreeFromGit, buildTree } from './refactor/tree/build.ts';
import type { VFSTree } from './refactor/tree/tree.ts';

/** A single-slot, projectVersion-keyed memo over a whole-program scan. A batch running several
 *  ops over the same scan calls it with the same key each time; the scan is a whole-program AST
 *  walk, so re-running it per op is pure waste (F-a). The key always embeds `projectVersion()`
 *  (what `freshness()` reports), so any reindex / overlay bumps it — the slot can never serve a
 *  stale scan (§3.1). `clear()` MUST run on dispose: a re-warmed host restarts `projectVersion` at
 *  the same value, so a surviving slot could otherwise collide and serve a pre-dispose scan. */
interface ScanMemo<A, R> {
  call(arg: A): R;
  clear(): void;
}

function singleSlotMemo<A, R>(
  warm: () => TsProjectHost,
  keyOf: (h: TsProjectHost, arg: A) => string,
  compute: (h: TsProjectHost, arg: A) => R,
): ScanMemo<A, R> {
  let slot: { key: string; result: R } | undefined;
  return {
    call(arg) {
      const h = warm();
      const key = keyOf(h, arg);
      if (slot?.key === key) return slot.result;
      const result = compute(h, arg);
      slot = { key, result };
      return result;
    },
    clear() {
      slot = undefined;
    },
  };
}

/** projectVersion + serialized CallMatchSpec — shared by the literalCalls and callArgShapes memos
 *  (same spec shape, same invalidation). */
function specKey(h: TsProjectHost, spec: CallMatchSpec): string {
  return `${h.projectVersion()}|${spec.functions.join(',')}|${spec.module ?? ''}|${spec.hook ?? ''}`;
}

/** The three whole-program scan memos a `ts` plugin instance owns, built in one call (keeps the
 *  factory's wiring out of plugin.ts's line budget). Each MUST be `clear()`-ed on dispose. */
export interface ScanMemos {
  literalCalls: ScanMemo<CallMatchSpec, LiteralCallsResult>;
  callArgShapes: ScanMemo<CallMatchSpec, CallArgShapesResult>;
  functionDeclarations: ScanMemo<void, FunctionDeclarationsResult>;
}

export function createScanMemos(warm: () => TsProjectHost): ScanMemos {
  return {
    literalCalls: singleSlotMemo(warm, specKey, (h, spec) => scanLiteralCalls(h, spec)),
    callArgShapes: singleSlotMemo(warm, specKey, (h, spec) => scanCallArgShapes(h, spec)),
    functionDeclarations: singleSlotMemo(
      warm,
      (h) => `v${h.projectVersion()}`,
      (h) => scanFunctionDeclarations(h),
    ),
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
