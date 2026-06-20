// `extract_symbol` — move a top-level symbol to a new file via the LS "Move to a new file"
// refactor (§7), re-targeted to the requested `dest`. The `ts` plugin plans it (LS edits →
// tree → import rewrite); the shared `applyRefactorPlan` runs the §2.8 dry-run/apply/
// typecheck/rollback contract. The LS refusal shapes are surfaced honestly with their
// `ts-ls-failures` category; a shape the stock LS asserts on (e.g. the extracted block uses a
// css-module member) is retried through the §4 patched-LS rescue. With `css: 'copy-safe'`,
// the provably-safe CSS-module classes the block uses co-extract into a sibling sheet
// (spec-css-coextract) via the op-level join, riding the same apply machinery.

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { fail, failFromThrown } from '../common/result/construct.ts';
import type { TsPluginApi, RefactorPlan } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { tsTargetShape, requireTarget, targetOf } from './ts-target.ts';
import { applyRefactorPlan } from './refactor-plan-apply.ts';
import { applyCssCoExtract, type CssCoExtractReport } from './extract-css-coextract.ts';

const extractArgsSchema = z
  .strictObject({
    ...tsTargetShape,
    dest: z.string().min(1),
    dirtyOk: z.boolean().optional(),
    /** Co-extract the CSS-module classes the extracted block uses into a new sheet beside the
     *  extracted file (spec-css-coextract). Only the provably-safe classes move; the rest stay
     *  and are reported. Absent → no co-extract. */
    css: z.literal('copy-safe').optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });
type ExtractArgs = z.infer<typeof extractArgsSchema>;

export const extractSymbolOp = defineOp<ExtractArgs, JsonValue>({
  name: 'extract_symbol',
  summary: 'Move a top-level symbol to a new file, rewriting imports (dry-run unless apply:true)',
  mutating: true,
  requires: ['ts'],
  argsSchema: extractArgsSchema,
  argsHint:
    "{ symbolId?: 'ts:…' | name?: string | file+line+col, dest: RepoRelPath, dirtyOk?: boolean, css?: 'copy-safe' }",
  example: { args: { name: 'Helper', dest: 'src/lib/helper.ts' } },
  notes: [
    'dest is the full new file path; .ts is coerced to .tsx when the body has JSX. The source keeps importing the extracted symbol from its new home.',
    'when the LS refuses (e.g. several cross-referencing declarations in one file) the failure is reported with its ts-ls category — never a half-written file. A shape the stock LS asserts on is retried through the §4 patched-LS rescue (surfaced as a note).',
    "css: 'copy-safe' co-extracts the CSS-module classes the extracted block uses into a sibling sheet — ONLY the provably-safe ones move; the rest stay (rewritten to an sLegacy import) and every class is reported under cssCoExtract with a code. scss is type-blind, so a move is the taxonomy's proof, never the typecheck's.",
    'co-extract safety covers the source remainder + every importer of the same sheet codemaster can resolve — RELATIVE and tsconfig-`paths` ALIASED (@/…); a class an aliased sibling still uses is kept, not moved. Only a NON-tsconfig (bundler-only) alias stays invisible — verify those yourself.',
    'capture-safe: each rewritten import (the source relinked to the new file, and consumers) is re-resolved over the post-edit tree — if one lands on a DIFFERENT same-named, type-compatible export the sites are listed under `captures` and apply is REFUSED. summaryOnly:true returns the verdict + a per-file diffstat instead of the full diff.',
    'cross-program: a consumer in a `test/**` file under a sibling tsconfig is repointed too, and the typecheck gate runs on every affected program — including the program whose glob owns the new DEST file, so an extracted block erroneous under a disjoint dest tsconfig (e.g. a divergent `lib`/`strict`) is refused, not silently applied.',
    'cross-program LIMITS: (a) the capture-safety check (the type-compatible silent re-bind on a rewritten import) runs on the PRIMARY program ONLY. (b) inside a `transaction` the cross-program write-site fan-out is OFF: a step rewrites primary-program sites only, though the cumulative §2.8 gate still fans across every program and refuses a cross-program dangle.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // css co-extract needs the scss plugin; it's a config-conditional capability `requires`
    // can't express. If it's not active, do the TS extract and disclose the skip — never throw
    // (a missing optional plugin isn't a bug, §3.6).
    const wantsCss = args.css === 'copy-safe';
    const scssActive = ctx.daemon?.plugins.some((p) => p.id === 'scss') ?? false;
    let plan: RefactorPlan | string;
    try {
      plan = await ts.planExtract(targetOf(args), args.dest as RepoRelPath, {
        css: wantsCss && scssActive,
      });
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
    if (typeof plan === 'string') return fail({ tool: 'ts-ls', message: plan });

    // CSS co-extract join (spec-css-coextract §2.2) — mutates the plan with the new sheet /
    // edited source sheet / rewritten extracted file, then rides the SAME apply machinery. A
    // co-extract failure (e.g. a degenerate duplicate css import) is reported honestly before
    // anything is applied — never a misleading "codemaster bug" op-threw, never a half-write.
    let cssReports: CssCoExtractReport[];
    try {
      cssReports = wantsCss && scssActive ? applyCssCoExtract(ctx, plan) : [];
    } catch (thrown) {
      return failFromThrown('scss', thrown);
    }
    const cssNote: CssCoExtractReport[] =
      wantsCss && !scssActive
        ? [
            {
              sourceStylesheet: '*',
              targetStylesheet: '',
              moved: [],
              leftBehind: [],
              note: 'css co-extract requested but the scss plugin is not active in this repo — skipped',
            },
          ]
        : [];
    const reports = [...cssReports, ...cssNote];
    return applyRefactorPlan(ctx, plan, {
      refusalLabel: 'extract',
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
      ...(reports.length > 0 ? { cssCoExtract: reports } : {}),
    });
  },
});
