// The args-resolution step of `runOne` (§7): the liberal intake normalizer (Postel) feeding
// the canonical zod gate, returned as one discriminated outcome. Split from engine.ts to keep
// the request lifecycle readable. The canonical schema stays the SOLE validator — intake only
// rewrites known off-canonical spellings to canonical before it; a non-alias key still fails
// (with a did-you-mean), never silently stripped (§3).

import type { OpFlags } from '../ops/contracts.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import { normalizeArgs } from '../ops/intake/normalize.ts';
import { badArgsMessage } from './dispatch-errors.ts';

export type ResolvedArgs =
  | {
      ok: true;
      /** Validated args (typed by the op's schema; `unknown` at this erased boundary). */
      args: unknown;
      /** OpFlag values lifted out of `args` — merged onto the request before `extractFlags`. */
      flags: Partial<OpFlags>;
      /** The intake rewrites that fired on this call → `Result.intake`. */
      intake: readonly string[];
    }
  | { ok: false; message: string };

export function resolveArgs(op: AnyOpDefinition, rawArgs: unknown): ResolvedArgs {
  const norm = normalizeArgs(op, rawArgs);
  if (norm.flagError !== undefined) {
    return { ok: false, message: `${norm.flagError} — expected ${op.argsHint}` };
  }
  const parsed = op.argsSchema.safeParse(norm.args);
  if (!parsed.success) {
    return { ok: false, message: badArgsMessage(op, parsed.error.issues) };
  }
  return { ok: true, args: parsed.data, flags: norm.flags, intake: norm.intake };
}
