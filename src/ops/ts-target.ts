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

/** The flat target field names (the keys of `tsTargetShape`) — the shared source of truth for
 *  the intake flat→targets[] collapse (`flat-target.ts`), so a new target field can't be silently
 *  missed by a hand-maintained copy. */
export const TS_TARGET_KEYS = Object.keys(tsTargetShape) as ReadonlyArray<
  keyof typeof tsTargetShape
>;

type TargetFields = {
  symbolId?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
  name?: string | undefined;
};

/** The accepted target ADDRESSINGS, as key-sets: satisfy ALL keys of ANY one branch.
 *  `file+line` is enough — the column is OPTIONAL: with it, an exact position; without it, the
 *  resolver takes the declaration on that line (or lists them). `name` alone, or `name+file`
 *  (file-scoped), also resolve. The resolver (resolve-target.ts) is the one place these dispatch.
 *
 *  This is the SINGLE source for two surfaces (§11 anti-drift): the zod `.refine` predicate below
 *  IS built from it, and the advertised `inputSchema` renders it as `anyOf:[{required:…},…]`
 *  (`ops/tool-schema/input-schema.ts`). So the CANONICAL shape a harness gates on and the shape
 *  that actually validates cannot disagree — by construction, not by a test that must be
 *  remembered. (The §7 intake accepts alias spellings on top of this; aliases are never advertised,
 *  so the advertised form is the canonical one — see `OpDefinition.requiredOneOf`.) */
export const TS_TARGET_ONE_OF: ReadonlyArray<ReadonlyArray<keyof typeof tsTargetShape>> = [
  ['symbolId'],
  ['name'],
  ['file', 'line'],
];

export const requireTarget = {
  predicate: (t: TargetFields): boolean =>
    TS_TARGET_ONE_OF.some((branch) => branch.every((key) => t[key] !== undefined)),
  message: "pass 'symbolId' (a ts: SymbolId), or 'name', or file+line (col optional)",
};

export const TS_TARGET_HINT =
  "{ symbolId?: 'ts:…', name?: string, file?: string, line?: number, col?: number }";

/** The liberal intake (§7 Postel) every symbol-addressed op spreads into its `intake`: the
 *  `symbol`→`name`, `target`→`symbolId`, and `query`→`name` aliases plus `name` smart-string
 *  parsing (a `ts:…` SymbolId → `symbolId`, a `path:line:col` → `file/line/col`). Shared so
 *  the rule lives once; an op needing extra coercions spreads this and adds its own fields.
 *
 *  `query`→`name` is the reverse of search_symbol/list's `name`→`query`: an agent anchors on
 *  `query` after a fuzzy search, then carries it to a flat-name op (find_usages / find_definition
 *  / expand_type / …). No ts-target op has `query` as a canonical field, so the map is safe;
 *  search_symbol/list do NOT spread this intake, so there is no bidirectional loop. */
export const tsTargetIntake: OpIntake = {
  aliases: { symbol: 'name', target: 'symbolId', query: 'name' },
  locationTarget: true,
};

/** Echo a target back the way the agent addressed it — for the `unresolved` section, where the entry
 *  must be recognizable as the input that failed. One home for the same reason `targetOf` is: an op with
 *  two resolution paths must not echo one target two ways depending on which path ran. */
export function describeTsTarget(t: TargetFields): string {
  if (t.symbolId !== undefined) return t.symbolId;
  if (t.file !== undefined && t.line !== undefined) {
    return t.col === undefined ? `${t.file}:${t.line}` : `${t.file}:${t.line}:${t.col}`;
  }
  if (t.name !== undefined) return t.file === undefined ? t.name : `${t.name} in ${t.file}`;
  if (t.file !== undefined) return t.file;
  return '<target>';
}

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
