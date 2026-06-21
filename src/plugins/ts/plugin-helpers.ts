// Per-instance bookkeeping factored out of `plugin.ts` (300-line cap): the `literalCalls` memo and
// the transaction planning-overlay helpers. Both close over the plugin's `warm()` (and `root`),
// so they are created once per plugin instance — pure construction, no behavior change.

import type ts from 'typescript';
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
  /** The shared prologue of every overlay-aware plan method (planMove / planExtract / planMoveSymbol
   *  / planChangeSignature): warm the host, build the plan tree (overlay or disk), snapshot the
   *  primary compiler options, then run `body` under the overlay shadow. Returns the tree-load error
   *  verbatim; otherwise `body`'s result. Factored out so the four methods can't drift on the
   *  load/overlay handshake (and to keep plugin.ts under the line cap). */
  planUnderOverlay<T>(
    overlay: PlanningOverlay | undefined,
    body: (h: TsProjectHost, tree: VFSTree, options: ts.CompilerOptions) => T,
  ): Promise<T | string>;
}

export function createPlanningHelpers(warm: () => TsProjectHost, root: string): PlanningHelpers {
  const runWithOverlay = <T>(overlay: PlanningOverlay | undefined, fn: () => T): T => {
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
  };
  const planTree = async (
    overlay: PlanningOverlay | undefined,
  ): Promise<{ tree: VFSTree } | { error: string }> => {
    if (overlay !== undefined) return { tree: buildTree(overlay.listing) };
    const t = await loadTreeFromGit(root);
    return isOk(t) ? { tree: t.data } : { error: t.failure.message };
  };
  return {
    runWithOverlay,
    planTree,
    async planUnderOverlay(overlay, body) {
      const h = warm();
      const t = await planTree(overlay);
      if ('error' in t) return t.error;
      const options = h.service.getProgram()?.getCompilerOptions() ?? {};
      return runWithOverlay(overlay, () => body(h, t.tree, options));
    },
  };
}
