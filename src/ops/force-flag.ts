// The `force` arg, described (§3.6 in the schema itself). It is declared on 16 ops and means TWO
// different things — it overrides `search_symbol`'s pre-warm SIZE estimate, but it does NOT
// override the semantic fan-out guard (§9), which refuses because forcing that warm OOM-kills the
// in-process daemon (§1 ranks a crash below a wrong answer). An undescribed boolean left the agent
// to assume the usual "force = try anyway" and retry where the retry is guaranteed useless
// (t-837168). Two shared constants, so the two meanings can't be mixed up per-op.

import { z } from 'zod';

/** The refusal this flag CANNOT override (the semantic fan-out guard, §9). */
export const forceFlagGuardNotOverridable = (): z.ZodOptional<z.ZodBoolean> =>
  z
    .boolean()
    .optional()
    .describe(
      'Does NOT override the oversized-in-process fan-out refusal (§9) — forcing that warm kills the daemon. Re-run under process isolation instead.',
    );

/** `search_symbol`'s pre-warm size guard, which force DOES override (that one is an optimization,
 *  not a crash-safety gate). */
export const forceFlagOverridesPreWarm = (): z.ZodOptional<z.ZodBoolean> =>
  z
    .boolean()
    .optional()
    .describe(
      'Override the pre-warm size refusal and warm the LS anyway (may be slow / memory-heavy on a large repo).',
    );
