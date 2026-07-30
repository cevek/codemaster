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
import { forceFlagGuardNotOverridable } from './force-flag.ts';
import { failFromThrown, fail, ok, partial } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import {
  tsTargetShape,
  requireTarget,
  tsTargetIntake,
  targetOf,
  TS_TARGET_HINT,
} from './ts-target.ts';
import { TS_TARGET_ONE_OF } from './ts-target.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { semanticFanoutRefusal } from './guard/semantic-fanout-guard.ts';
import { traceHopTable } from './trace-hop-table.ts';
import { walkTypeWidening } from './trace-type-widening-walk.ts';
import {
  wideningEmptinessNote,
  wideningFloorNotes,
  wideningScopeData,
  wideningTableNotes,
} from './trace-type-widening-scope.ts';
import type { JsonValue } from '../core/json.ts';
import type { TableSpec } from './registry.ts';

/** The shared trace-hop projection PLUS this op's scope + floor notes. The sql/table surface would
 *  otherwise show hop rows with no scope at all — the same bare-counter defect the text surface
 *  closes (t-919920), and a `NOT IN` over an incomplete fan is exactly where it costs most. */
const wideningHopTable: TableSpec<JsonValue> = {
  columns: traceHopTable.columns,
  rows: traceHopTable.rows,
  notes(data) {
    const out = [...wideningTableNotes(data)];
    for (const n of (data as { notes?: string[] }).notes ?? []) out.push(n);
    return out;
  },
};

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    /** Bypass the in-process semantic-fanout size guard (t-411303) and warm anyway. */
    force: forceFlagGuardNotOverridable(),
  })
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
  requiredOneOf: TS_TARGET_ONE_OF,
  example: { args: { name: 'color', file: 'src/paint.ts' } },
  notes: [
    'on an oversized IN-PROCESS repo (> `ts.searchWarmMaxFiles`, default 4000) this op REFUSES to warm (would OOM-kill the daemon), naming why the workspace was not auto-escalated into a killable child (`force:true` does NOT override). The refusal is addressing-INDEPENDENT: each step fans across the programs containing the value, so a file+line[:col] / name+file target fans exactly as a bare name does. No refusal in process-mode.',
    'target is the VALUE whose precision you follow (a variable / parameter — by name, file:line:col, or SymbolId). The source type is read at its OWN declaration, so a literal arg is not mis-read as the already-widened parameter type (the contextual-typing trap).',
    'one hop per forward flow-step (var-init / arg→param / return / reassignment). A WIDENED hop notes the kind (literal-widening / union-widened / to-any / to-unknown / narrowing-lost); a preserved hop is shown too so the whole path is visible. `widenings` counts the lost-precision hops.',
    'arg→param crosses INTO the callee (continues from the parameter); return / reassignment are leaves. An any/unknown/untyped boundary is flagged dynamic and STOPPED — precision is erased there, never bridged (§3.3).',
    'bounded: a visited-set (cycle/diamond), a depth cap, and a node cap — every truncation is reported (truncated:true + a note), never a silent stop. 0 flow-sinks is an honest empty trace, not a faked one.',
    "cross-program: each step fans across EVERY loaded program containing the value's file (a `test/**` sibling, a monorepo package), re-resolving the value per program because a widening verdict is invalid across checkers; a reference two programs both see is judged ONCE, by the value's type authority. `programsScanned` states that scope POSITIVELY, per program with its own denominator — so a small reference count can never be mistaken for \"traced the repo\". A hop judged by a non-authority program carries `prog <label>`, since its verdict holds under THAT program's compilerOptions. A repo tsconfig codemaster never loaded, a spent per-step budget, a program whose own options resolve no value at this position, and files under no tsconfig are DISTINCT floors, each named with the lever that can change it.",
    '`found: 0` is a claim about the VALUE only when the trace was complete: a fan that consulted every containing program and found no sink HAS established that the value never flows onward, while an incomplete one states the shortfall instead. A step whose fan could consult NO program fails outright rather than answering 0.',
  ],
  table: wideningHopTable,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // §9 pre-warm guard, UNCONDITIONALLY (t-467009): every forward step now fans across the programs
    // containing the value's file and warms each one's checker, so the fan follows the DECLARATION —
    // a `name+file` / position target fans exactly as a bare name does, and gating on addressing
    // (`isFanCapableTarget`) would under-guard the very exposure the fan created. `force` does NOT
    // override it (t-693742): forcing the warm here kills the daemon the agent is talking to.
    const refusal = semanticFanoutRefusal(ctx, ts, args.force, args);
    if (refusal !== undefined) return fail(refusal);
    try {
      const walked = walkTypeWidening(ts, targetOf(args), ctx.deadline);
      if ('error' in walked) return fail({ tool: 'ts-ls', message: walked.error });
      const undiscovered = ts.undiscoveredProgramLabels();
      // Verdict-first (§12): the floor notes precede the walk's own caveats, and the emptiness line
      // — which says whether `found: 0` is a claim about the value at all — leads them.
      const notes = [...walked.notes];
      notes.unshift(...wideningFloorNotes(walked.coverage, undiscovered));
      const empty = wideningEmptinessNote(walked.coverage, undiscovered, walked.hops.length);
      if (empty !== undefined) notes.unshift(empty);
      // Verdict-before-bulk (§12): the scalar verdict + the positive scope render FIRST, the
      // (re-fetchable) hop list LAST, so the hard char-cap can only ever truncate hops.
      const data = {
        widenings: walked.widenings,
        found: walked.hops.length,
        truncated: walked.truncated,
        ...wideningScopeData(walked.coverage, undiscovered),
        ...(notes.length > 0 ? { notes } : {}),
        hops: walked.hops.map((h) => tag('trace-hop', h)),
      };
      // §19 loop boundary: the deadline stopped the walk mid-way. The hops found ARE real data, so
      // the honest shape is `partial` — never `ok`, which would read as a finished trace.
      if (walked.coverage.deadlineHit === true) {
        return partial(data, {
          tool: 'timeout',
          message: `the trace's wall-clock budget expired after checking ${walked.coverage.examined} of ${walked.coverage.refs} forward reference(s) — the hops listed are real, the rest were never analysed`,
        });
      }
      return ok(data);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
