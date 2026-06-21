// Shared target schema for symbol-addressed TS ops: a SymbolId from a previous
// answer, an explicit position, or an unambiguous name. zod-validated at the
// boundary with a pointed message (§7). Ops with extra args spread `tsTargetShape`
// into their own strictObject and re-apply `requireTarget`.
//
// The CANONICAL shape is `symbolId` (a `ts:` SymbolId) — one name per field, clean of
// aliases. The natural `target` spelling and a bare `symbol` are accepted by the LIBERAL
// intake layer (`tsTargetIntake`, §7 Postel), which rewrites them to `symbolId`/`name`
// BEFORE this schema validates — so the canonical surface stays alias-free while either
// spelling still works. The intake metadata is invisible to `status`/`argsHint`.

import { z } from 'zod';
import type { OpIntake } from './registry.ts';

export const tsTargetShape = {
  /** A `ts:`-prefixed SymbolId from a previous answer — NOT a bare name (that goes under
   *  `name`). Named `symbolId`, not `symbol`, so a bare identifier has no field to land in. */
  symbolId: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
  name: z.string().optional(),
};

type TargetFields = {
  symbolId?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
  name?: string | undefined;
};

export const requireTarget = {
  predicate: (t: TargetFields): boolean =>
    t.symbolId !== undefined ||
    t.name !== undefined ||
    (t.file !== undefined && t.line !== undefined && t.col !== undefined),
  message: "pass 'symbolId' (a ts: SymbolId), or 'name', or all of file+line+col",
};

export const tsTargetSchema = z
  .strictObject(tsTargetShape)
  .refine(requireTarget.predicate, { message: requireTarget.message });

export const TS_TARGET_HINT =
  "{ symbolId?: 'ts:…', name?: string, file?: string, line?: number, col?: number }";

/** The liberal intake (§7 Postel) every symbol-addressed op spreads into its `intake`: the
 *  `symbol`→`name` and `target`→`symbolId` aliases plus `name` smart-string parsing
 *  (a `ts:…` SymbolId → `symbolId`, a `path:line:col` → `file/line/col`). Shared so the
 *  rule lives once; an op needing extra coercions spreads this and adds its own fields. */
export const tsTargetIntake: OpIntake = {
  aliases: { symbol: 'name', target: 'symbolId' },
  locationTarget: true,
};

/** Project the shared target fields off a validated args object into the `TsTargetInput` the
 *  plugin's resolver consumes — the one place the symbol/file/line/col/name mapping lives, so a
 *  symbol-anchored op and the `transaction` step that wraps it never drift (no parallel literal). */
export function targetOf(a: TargetFields): TargetFields {
  return {
    symbolId: a.symbolId,
    file: a.file,
    line: a.line,
    col: a.col,
    name: a.name,
  };
}
