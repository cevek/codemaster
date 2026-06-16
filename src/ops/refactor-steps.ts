// The per-kind "plan against the current overlay" seam (spec-transactional-mutation). Each
// supported mutating op contributes its arg schema (the SAME zod the standalone op validates with)
// and a planner that returns a NORMALIZED `RefactorPlan` computed against a `PlanningOverlay`. The
// standalone op and the transaction step go through the identical plugin plan method + `targetOf`
// mapping — no parallel arg-handling to drift (spec §factor-out-the-seam).
//
// SCOPE: rename / move / extract / change_signature — the four that produce a plan through the
// overlay-aware plugin methods. `codemod` (reads disk directly + detects captures against the
// disk-LS) and CSS co-extract (an op-level scss join) are deferred follow-ups (docs/backlog.md).

import type { z } from 'zod';
import type { RepoRelPath } from '../core/brands.ts';
import type { HandleRebind } from '../core/ids.ts';
import type { Capture, RefactorPlan, PlanningOverlay, TsPluginApi } from '../plugins/ts/plugin.ts';
import type { OpContext } from './registry.ts';
import { targetOf } from './ts-target.ts';
import { renameSymbolOp } from './rename-symbol.ts';
import { moveFileOp } from './move-file.ts';
import { extractSymbolOp } from './extract-symbol.ts';
import { changeSignatureOp } from './change-signature.ts';

export interface StepPlanner {
  /** The standalone op's own zod schema — reused verbatim so step validation never drifts. */
  readonly schema: z.ZodType<unknown>;
  /** Plan this step against `overlay` (the cumulative prior-step state; `undefined` for the first
   *  step → plans against disk, so a single-step transaction is identical to the direct op). */
  plan(
    ctx: OpContext,
    args: unknown,
    overlay: PlanningOverlay | undefined,
  ): Promise<RefactorPlan | string>;
}

type TargetArgs = {
  symbol?: string;
  file?: string;
  line?: number;
  col?: number;
  name?: string;
};

const tsApi = (ctx: OpContext): TsPluginApi => ctx.plugins.get<TsPluginApi>('ts');

/** A symbol-anchored rename's per-file before/after pairs → a normalized in-place `RefactorPlan`
 *  (no moves/new files). A partial rename (sites outside the program) is disclosed, never hidden. */
function mutationToPlan(
  changes: readonly { path: RepoRelPath; before: string; after: string }[],
  captures: readonly Capture[],
  notes: readonly string[],
  rebind: HandleRebind | undefined,
): RefactorPlan {
  return {
    moves: [],
    newFiles: [],
    contentWrites: changes.map((c) => ({ path: c.path, content: c.after })),
    removed: [],
    overlayFiles: changes.map((c) => ({ path: c.path, content: c.after })),
    checkPaths: changes.map((c) => c.path),
    diff: changes.map((c) => ({ from: c.path, to: c.path, before: c.before, after: c.after })),
    captures: [...captures],
    ...(notes.length > 0 ? { notes } : {}),
    ...(rebind !== undefined ? { rebind } : {}),
  };
}

function planRename(
  ctx: OpContext,
  args: unknown,
  overlay: PlanningOverlay | undefined,
): Promise<RefactorPlan | string> {
  const a = args as TargetArgs & { newName: string };
  const outcome = tsApi(ctx).renameSites(targetOf(a), a.newName, overlay);
  if (typeof outcome === 'string') return Promise.resolve(outcome);
  const notes: string[] = [];
  if (outcome.dropped.length > 0) {
    notes.push(
      `rename PARTIAL: ${outcome.dropped.length} site(s) in file(s) outside the TS program left unedited (${outcome.dropped.join(', ')})`,
    );
  }
  // Honesty (§3.4): the standalone rename op also discloses old-name survivors (export*-reached
  // consumers + re-export aliases) via spans on the applied envelope. That signal needs the
  // FORMATTED post-rename content (computed only at the final apply), so a transaction can't carry
  // it per step — disclose the gap rather than under-report a clean, complete rename.
  notes.push(
    `rename '${outcome.oldName}'→'${a.newName}': old-name-survivor audit (export* consumers / re-export aliases) is not computed inside a transaction — run rename_symbol standalone to verify completeness`,
  );
  return Promise.resolve(mutationToPlan(outcome.changes, outcome.captures, notes, outcome.rebind));
}

function planMoveStep(
  ctx: OpContext,
  args: unknown,
  overlay: PlanningOverlay | undefined,
): Promise<RefactorPlan | string> {
  const a = args as { source: string; dest: string };
  return tsApi(ctx).planMove(a.source as RepoRelPath, a.dest as RepoRelPath, overlay);
}

function planExtractStep(
  ctx: OpContext,
  args: unknown,
  overlay: PlanningOverlay | undefined,
): Promise<RefactorPlan | string> {
  const a = args as TargetArgs & { dest: string; css?: string };
  if (a.css !== undefined) {
    return Promise.resolve(
      'css co-extract is not supported inside a transaction — run extract_symbol standalone (follow-up: docs/backlog.md)',
    );
  }
  return tsApi(ctx).planExtract(targetOf(a), a.dest as RepoRelPath, { css: false }, overlay);
}

function planChangeSignatureStep(
  ctx: OpContext,
  args: unknown,
  overlay: PlanningOverlay | undefined,
): Promise<RefactorPlan | string> {
  const a = args as TargetArgs & { removeParam?: number; reorder?: number[] };
  return tsApi(ctx).planChangeSignature(
    targetOf(a),
    {
      ...(a.removeParam !== undefined ? { removeParam: a.removeParam } : {}),
      ...(a.reorder !== undefined ? { reorder: a.reorder } : {}),
    },
    overlay,
  );
}

/** The supported transaction step kinds, keyed by op name (so the surface IS the op catalogue). */
export const STEP_PLANNERS: Readonly<Record<string, StepPlanner>> = {
  [renameSymbolOp.name]: { schema: renameSymbolOp.argsSchema, plan: planRename },
  [moveFileOp.name]: { schema: moveFileOp.argsSchema, plan: planMoveStep },
  [extractSymbolOp.name]: { schema: extractSymbolOp.argsSchema, plan: planExtractStep },
  [changeSignatureOp.name]: { schema: changeSignatureOp.argsSchema, plan: planChangeSignatureStep },
};

export const SUPPORTED_STEP_KINDS: readonly string[] = Object.keys(STEP_PLANNERS);
