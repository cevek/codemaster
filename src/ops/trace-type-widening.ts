// `trace_type_widening` — trace where a VALUE's type WIDENS (loses precision) as it flows forward
// along assignments / calls / returns: `'red'` → `string`, a narrowed `T` → `T`, a concrete value →
// `any`/`unknown`, a literal → a larger union. Answers "I passed `'red'` and at site N it is already
// `string` — where was the precision lost?". A Phase 6 trace op (§17): it reuses the domain-neutral
// trace-hop contract (common/trace/hop.ts) and the single `trace-hop` render tag, composing the `ts`
// plugin's `wideningSinksAt` forward-flow primitive.
//
// HONESTY (§3.3): every hop carries per-hop confidence + provenance=`type` (the checker is the
// oracle). An `any`/`unknown`/untyped boundary erases precision and is flagged `dynamic` + STOPPED
// at that step, never silently bridged. Bounded (depth/visited/node caps), truncation reported.

import { z } from 'zod';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import {
  tsTargetShape,
  requireTarget,
  tsTargetIntake,
  targetOf,
  TS_TARGET_HINT,
} from './ts-target.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { traceHopTable } from './trace-hop-table.ts';
import { walkTypeWidening } from './trace-type-widening-walk.ts';

const argsSchema = z
  .strictObject({ ...tsTargetShape })
  .refine(requireTarget.predicate, { message: requireTarget.message });

export const traceTypeWideningOp = defineOp({
  name: 'trace_type_widening',
  summary:
    "Trace where a value's type WIDENS along assignments / calls / returns (literal→primitive, narrowed→T, →any/unknown, union-widen)",
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} — a VALUE (variable / parameter) whose precision to follow forward`,
  intake: tsTargetIntake,
  example: { args: { name: 'color', file: 'src/paint.ts' } },
  notes: [
    'target is the VALUE whose precision you follow (a variable / parameter — by name, file:line:col, or SymbolId). The source type is read at its OWN declaration, so a literal arg is not mis-read as the already-widened parameter type (the contextual-typing trap).',
    'one hop per forward flow-step (var-init / arg→param / return / reassignment). A WIDENED hop notes the kind (literal-widening / union-widened / to-any / to-unknown / narrowing-lost); a preserved hop is shown too so the whole path is visible. `widenings` counts the lost-precision hops.',
    'arg→param crosses INTO the callee (continues from the parameter); return / reassignment are leaves. An any/unknown/untyped boundary is flagged dynamic and STOPPED — precision is erased there, never bridged (§3.3).',
    'bounded: a visited-set (cycle/diamond), a depth cap, and a node cap — every truncation is reported (truncated:true + a note), never a silent stop. 0 flow-sinks is an honest empty trace, not a faked one.',
  ],
  table: traceHopTable,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const walked = walkTypeWidening(ts, targetOf(args));
      if ('error' in walked) return fail({ tool: 'ts-ls', message: walked.error });
      // Verdict-before-bulk (§12): the scalar verdict renders FIRST, the (re-fetchable) hop list
      // LAST, so the hard char-cap can only ever truncate hops, never the headline / notes.
      const data = {
        widenings: walked.widenings,
        found: walked.hops.length,
        truncated: walked.truncated,
        ...(walked.notes.length > 0 ? { notes: walked.notes } : {}),
        hops: walked.hops.map((h) => tag('trace-hop', h)),
      };
      return ok(data);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
