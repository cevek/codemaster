// Shared target schema for symbol-addressed TS ops: a SymbolId from a previous
// answer, an explicit position, or an unambiguous name. zod-validated at the
// boundary with a pointed message (§7). Ops with extra args spread `tsTargetShape`
// into their own strictObject and re-apply `requireTarget`.

import { z } from 'zod';

export const tsTargetShape = {
  /** A `ts:`-prefixed SymbolId from a previous answer — NOT a bare name (that goes under
   *  `name`). Named `symbolId`, not `symbol`, so a bare identifier has no field to land in. */
  symbolId: z.string().optional(),
  /** Alias for `symbolId`: agents naturally pass the SymbolId under `target`. Normalized to
   *  `symbolId` at the one resolver chokepoint (`symbolId ?? target`), so every symbol-addressed
   *  op accepts either spelling — and the same not-a-SymbolId detection guards both. */
  target: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
  name: z.string().optional(),
};

type TargetFields = {
  symbolId?: string | undefined;
  target?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
  name?: string | undefined;
};

export const requireTarget = {
  predicate: (t: TargetFields): boolean =>
    t.symbolId !== undefined ||
    t.target !== undefined ||
    t.name !== undefined ||
    (t.file !== undefined && t.line !== undefined && t.col !== undefined),
  message: "pass 'symbolId' (a ts: SymbolId; alias 'target'), or 'name', or all of file+line+col",
};

export const tsTargetSchema = z
  .strictObject(tsTargetShape)
  .refine(requireTarget.predicate, { message: requireTarget.message });

export const TS_TARGET_HINT =
  "{ symbolId?: 'ts:…' (alias: target), name?: string, file?: string, line?: number, col?: number }";

/** Project the shared target fields off a validated args object into the `TsTargetInput` the
 *  plugin's resolver consumes — the one place the symbol/file/line/col/name mapping lives, so a
 *  symbol-anchored op and the `transaction` step that wraps it never drift (no parallel literal).
 *  `target` is the SymbolId alias of `symbolId`; both forward, the resolver collapses them. */
export function targetOf(a: TargetFields): TargetFields {
  return {
    symbolId: a.symbolId,
    target: a.target,
    file: a.file,
    line: a.line,
    col: a.col,
    name: a.name,
  };
}
