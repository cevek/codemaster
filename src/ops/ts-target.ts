// Shared target schema for symbol-addressed TS ops: a SymbolId from a previous
// answer, an explicit position, or an unambiguous name. zod-validated at the
// boundary with a pointed message (§7). Ops with extra args spread `tsTargetShape`
// into their own strictObject and re-apply `requireTarget`.

import { z } from 'zod';

export const tsTargetShape = {
  symbol: z.string().optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
  name: z.string().optional(),
};

type TargetFields = {
  symbol?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
  name?: string | undefined;
};

export const requireTarget = {
  predicate: (t: TargetFields): boolean =>
    t.symbol !== undefined ||
    t.name !== undefined ||
    (t.file !== undefined && t.line !== undefined && t.col !== undefined),
  message: "pass 'symbol' (a ts: SymbolId), or 'name', or all of file+line+col",
};

export const tsTargetSchema = z
  .strictObject(tsTargetShape)
  .refine(requireTarget.predicate, { message: requireTarget.message });

export const TS_TARGET_HINT =
  "{ symbol?: 'ts:…', name?: string, file?: string, line?: number, col?: number }";
