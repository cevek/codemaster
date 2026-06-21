// The liberal intake layer (§7 Postel / ARCHITECTURE.md §7) — the single, INVISIBLE
// normalizer the dispatcher runs on `args` BEFORE the canonical zod parse. It maps a known
// off-canonical spelling (a `symbol` for `name`, a `path` for `module`, an `apply` misplaced
// inside `args`, a scalar where an array was wanted, a `path:line:col` string in `name`) to
// the op's canonical shape, then the canonical schema is the sole gate: a key that is NOT a
// known alias still fails, with the clean canonical hint + a did-you-mean — never silently
// stripped (a silent strip is an input-lost lie, §3). What it rewrote on a given call is
// disclosed via `Result.intake`; nothing here ever appears in `status`/`argsHint`.

import type { OpFlags } from '../contracts.ts';
import type { AnyOpDefinition } from '../registry.ts';
import { canonicalKeys } from './shape-keys.ts';
import { liftFlags } from './lift-flags.ts';
import { applyAliases } from './aliases.ts';
import { coerceArrayFields } from './coerce-array.ts';
import { coerceTargetArray } from './targets.ts';
import { classifyTargetString, targetFields, targetRewriteLabel } from './smart-string.ts';

export interface Normalized {
  /** The normalized args, fed straight to `op.argsSchema.safeParse` (which takes `unknown`). */
  args: unknown;
  /** OpFlag values lifted out of `args` — merged onto the request before `extractFlags`. */
  flags: Partial<OpFlags>;
  /** The rewrites that fired on this call (e.g. `['symbol→name']`) → `Result.intake`. */
  intake: readonly string[];
  /** Set when a lifted flag had the wrong type — the dispatcher rejects with this as
   *  `bad_args` (a wrong-typed flag is never silently coerced). */
  flagError?: string;
}

/** Smart-parse a top-level `name` string into a position / SymbolId when it denotes one
 *  (the `name: "path:line:col"` and `name: "ts:…@…"` fail shapes). A plain name is untouched. */
function smartName(args: Record<string, unknown>): readonly string[] {
  const name = args['name'];
  if (typeof name !== 'string') return [];
  const classified = classifyTargetString(name);
  const label = targetRewriteLabel(classified);
  if (label === undefined) return [];
  delete args['name'];
  Object.assign(args, targetFields(classified));
  return [label];
}

/** Normalize `args` against an op's intake metadata. Pure over `args` (operates on a clone).
 *  Returns the normalized args + the flags to lift + the per-call disclosure notes. */
export function normalizeArgs(op: AnyOpDefinition, rawArgs: unknown): Normalized {
  // Only object args are normalizable; a primitive/array/null flows straight to the canonical
  // gate (which gives the pointed shape error).
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { args: rawArgs, flags: {}, intake: [] };
  }
  const args: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };
  const notes: string[] = [];

  const lifted = liftFlags(args, canonicalKeys(op.argsSchema));
  notes.push(...lifted.notes);
  if (lifted.error !== undefined) {
    return { args, flags: lifted.flags, intake: notes, flagError: lifted.error };
  }

  const intake = op.intake;
  notes.push(...applyAliases(args, intake?.aliases).notes);
  notes.push(...coerceArrayFields(args, intake?.arrayFields).notes);
  if (intake?.locationTarget === true) notes.push(...smartName(args));
  notes.push(...coerceTargetArray(args, intake?.targetArray).notes);

  return { args, flags: lifted.flags, intake: notes };
}
