// `transaction` — apply an ORDERED chain of mutating ops atomically: each step plans against the
// previous step's post-edit overlay, ONE §2.8 typecheck gates the cumulative result, and the WHOLE
// sequence rolls back byte-exact if any step can't plan, the final gate is unclean, or any step
// CAPTURES (spec-transactional-mutation). It is another `op` (not a 4th MCP tool — §11): the chain
// is `args.steps`. Dry-run (default) previews the cumulative diff + final verdict without writing.
//
// Reuse, not reinvention: each step's plan comes from the SAME overlay-aware plugin method the
// standalone op uses (refactor-steps.ts), and the composed plan is gated/committed/rolled-back by
// the SAME `applyRefactorPlan` backbone — so `diff(dry) == diff(apply)` is structural (one plan,
// one code path) and a single-step transaction is identical to the direct op.

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { fail, messageOfThrown } from '../common/result/construct.ts';
import { isOk } from '../common/result/narrow.ts';
import { jsonValueSchema as jsonValue } from '../common/json/value-schema.ts';
import { gitLsFiles } from '../support/git/ls-files.ts';
import { brandGitPath } from '../support/fs/canonicalize.ts';
import type { RefactorPlan, TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { applyRefactorPlan } from './refactor-plan-apply.ts';
import { TxnCompose } from './transaction-compose.ts';
import { STEP_PLANNERS, SUPPORTED_STEP_KINDS } from './refactor-steps.ts';
import { extractSymbolOp } from './extract-symbol.ts';

const txnArgsSchema = z.strictObject({
  steps: z.array(z.strictObject({ name: z.string().min(1), args: jsonValue.default({}) })).min(1),
  /** Apply even when a touched file (union over all steps) has uncommitted changes (§7). */
  dirtyOk: z.boolean().optional(),
});
type TxnArgs = z.infer<typeof txnArgsSchema>;

export const transactionOp = defineOp<TxnArgs, JsonValue>({
  name: 'transaction',
  summary:
    'Apply an ordered chain of mutating ops atomically — one typecheck gate, all-or-nothing rollback (dry-run unless apply:true)',
  mutating: true,
  requires: ['ts'],
  argsSchema: txnArgsSchema,
  argsHint: '{ steps: [{ name: string, args: {…} }, …], dirtyOk?: boolean }',
  example: {
    args: {
      steps: [
        { name: 'rename_symbol', args: { name: 'foo', newName: 'bar' } },
        { name: 'move_file', args: { source: 'src/a.ts', dest: 'src/b.ts' } },
      ],
    },
  },
  notes: [
    `steps are applied IN ORDER: step i+1 plans against step i's post-edit overlay (use the post-rename/move NAMES and PATHS in later steps). Supported step kinds: ${SUPPORTED_STEP_KINDS.join(', ')} (codemod / css co-extract are not yet transaction steps).`,
    'ONE §2.8 typecheck gates the cumulative result and the union of touched files is dirty-gated ONCE. dry-run (default) previews the cumulative diff + final verdict without writing; diff(dry-run) == diff(apply).',
    'all-or-nothing: if a step cannot be planned the op refuses naming the step index and writes NOTHING; if the final gate is unclean or ANY step CAPTURES (a type-compatible silent re-bind), the WHOLE sequence rolls back byte-exact (apply) or is refused (dry-run). summaryOnly:true returns the verdict + ONE merged `touched` list (each file with its +added/-removed line counts; a moved-away/deleted source marked `(removed)`) instead of the full diff.',
    'cross-program LIMIT: a step’s WRITE-site fan-out is restricted to the PRIMARY program (a planning overlay is active, so a sibling LS would read stale disk) — a step rewrites primary-program reference/call sites only. The CUMULATIVE §2.8 gate STILL fans across every affected program (including the program that owns a move/extract DEST), so a cross-program dangle a step left un-rewritten is caught and rolls the whole transaction back; only a type-COMPATIBLE cross-program re-bind (capture) is missed, as for the standalone ops.',
    'capture detection is per-step against the prior overlay; rename capture is overlay-complete. KNOWN GAP (E-g): a move/extract step that FOLLOWS another structural step resolves its IMPORT-capture against the pre-transaction layout, NOT prior steps’ edits — so a later import that lands on a DIFFERENT same-named, type-compatible target because of a prior step is NOT detected. The whole-program typecheck catches a resulting dangle / type-mismatch, but is BLIND to a type-compatible re-bind (the exact class this gate exists for). Chain such steps in separate transactions if in doubt.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const root = ctx.daemon?.root;
    if (root === undefined)
      return fail({ tool: 'engine', message: 'no workspace root in op context' });
    const ts = ctx.plugins.get<TsPluginApi>('ts');

    // The base layout every step's overlay is derived from (the same source as loadTreeFromGit).
    const ls = await gitLsFiles(root);
    if (!isOk(ls)) return fail(ls.failure);
    const compose = new TxnCompose(root, ls.data.map(brandGitPath));

    for (const [i, step] of args.steps.entries()) {
      const planner = STEP_PLANNERS[step.name];
      if (planner === undefined) {
        return fail({
          tool: 'transaction',
          message: `step ${i} '${step.name}' is not a supported transaction step — supported: ${SUPPORTED_STEP_KINDS.join(', ')} (codemod / css co-extract are follow-ups). Nothing written.`,
        });
      }
      const parsed = planner.schema.safeParse(step.args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((x) => `${x.path.join('.') || '<args>'}: ${x.message}`)
          .join('; ');
        return fail({
          tool: 'transaction',
          message: `step ${i} '${step.name}' has invalid args: ${issues}. Nothing written.`,
        });
      }
      // First step plans against disk (overlay undefined → identical to the direct op); later
      // steps plan against the accumulated overlay.
      const overlay = i === 0 ? undefined : compose.overlay();
      let plan: RefactorPlan | string;
      try {
        plan = await planner.plan(ctx, parsed.data, overlay);
      } catch (thrown) {
        return fail({
          tool: 'ts-ls',
          message: `step ${i} '${step.name}' threw while planning: ${messageOfThrown(thrown)}. Nothing written.`,
        });
      }
      if (typeof plan === 'string') {
        return fail({
          tool: 'transaction',
          message: `step ${i} '${step.name}' could not be planned: ${plan}. Nothing written (no prefix applied).`,
        });
      }
      const composeError = compose.applyStep(plan, `step ${i} '${step.name}'`);
      if (composeError !== undefined) {
        return fail({
          tool: 'transaction',
          message: `step ${i} '${step.name}' ${composeError}. Nothing written.`,
        });
      }
    }

    if (compose.isEmpty()) {
      return fail({
        tool: 'transaction',
        message: 'the chain produced no edits (every step was a no-op) — nothing to apply',
      });
    }

    // Honesty (§3): a transaction-labelled plan does NOT trigger applyRefactorPlan's extract-only
    // §1b hedge, so an `introduced` count when the chain contains an extract MAY be a pre-existing
    // error merely relocated into the extracted block — disclose it rather than assert it as fact.
    const hasExtract = args.steps.some((s) => s.name === extractSymbolOp.name);
    const hedge: string[] = hasExtract
      ? [
          'this chain contains an extract: an `introduced` typecheck error MAY instead be a pre-existing error relocated into the extracted block, which the transaction gate cannot yet distinguish (§1b)',
        ]
      : [];
    let programFiles: readonly RepoRelPath[];
    try {
      programFiles = ts.programTsFiles();
    } catch (thrown) {
      return fail({
        tool: 'ts-ls',
        message: `could not enumerate the program's TS files for the whole-program gate: ${messageOfThrown(thrown)}. Nothing written.`,
      });
    }
    const composed = compose.build(programFiles, hedge);
    if (typeof composed === 'string') return fail({ tool: 'transaction', message: composed });

    return applyRefactorPlan(ctx, composed, {
      refusalLabel: 'transaction',
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
      captureAction:
        'remove the shadowing binding, reorder the steps, or drop the capturing step — then retry',
    });
  },
});
