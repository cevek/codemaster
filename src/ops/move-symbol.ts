// `move_symbol` — relocate one top-level symbol from its current file into an EXISTING file
// `dest`, rewriting every importer and the source's own back-reference (§7). The delta vs
// `extract_symbol` (which targets a NEW file) is the merge into an existing file: the `ts`
// plugin drives the LS "Move to file" refactor, which merges the moved symbol's imports into
// dest's existing imports, handles existing-locals, and repoints all importers; the shared
// `applyRefactorPlan` runs the §2.8 dry-run/apply/typecheck/rollback contract. A dest name
// collision, a nested target, or a dest not in the project are honest refusals — never a
// half-written file.

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { fail, failFromThrown } from '../common/result/construct.ts';
import type { TsPluginApi, RefactorPlan } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { tsTargetShape, requireTarget, targetOf } from './ts-target.ts';
import { applyRefactorPlan } from './refactor-plan-apply.ts';

const moveSymbolArgsSchema = z
  .strictObject({
    ...tsTargetShape,
    dest: z.string().min(1),
    dirtyOk: z.boolean().optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });
type MoveSymbolArgs = z.infer<typeof moveSymbolArgsSchema>;

export const moveSymbolOp = defineOp<MoveSymbolArgs, JsonValue>({
  name: 'move_symbol',
  summary:
    'Move a top-level symbol into an EXISTING file, repointing direct importers (dry-run unless apply:true; a re-export barrel of the symbol is refused — see notes)',
  mutating: true,
  requires: ['ts'],
  argsSchema: moveSymbolArgsSchema,
  argsHint:
    "{ symbolId?: 'ts:…' | name?: string | file+line+col, dest: RepoRelPath (an existing file), dirtyOk?: boolean }",
  example: { args: { name: 'helper', dest: 'src/lib/util.ts' } },
  notes: [
    'dest must be an EXISTING file in the project — the moved symbol is merged into it (its imports folded into dest’s, every importer repointed, the source keeps a back-import if it still uses the symbol). To move into a NEW file use extract_symbol; to relocate MANY symbols into one module atomically, chain extract_symbol + move_symbol steps in a single `transaction` (one gate, all-or-nothing).',
    'dry-run (default) writes nothing; apply is refused only if the move INTRODUCES new typecheck errors (vs a pre-edit baseline — pre-existing repo errors ride along as a preExisting count), and rolls back byte-exact if the post-apply typecheck shows newly-introduced errors.',
    'a name already declared at top level in dest is REFUSED with a collision message (never clobbered/shadowed); a target nested inside another declaration is REFUSED (only a TOP-LEVEL symbol moves); a JSX body needs a .tsx dest (a non-.tsx dest is REFUSED).',
    'DIRECT importers are repointed; a re-export barrel (`export { X } from`) of the moved symbol is NOT repointed by the LS, so it would dangle — the §2.8 gate then REFUSES the whole move (honest, never a half-move). Repoint such a barrel by hand or move the barrel’s own export.',
    'capture-safe: each importer specifier the move added/changed to reach dest is re-resolved over the post-edit tree — if one lands on a DIFFERENT same-named, type-compatible export the sites are listed under `captures` and apply is REFUSED. summaryOnly:true returns the verdict + ONE merged `touched` list (each file with its +added/-removed line counts; a moved-away/deleted source marked `(removed)`) instead of the full diff.',
    'cross-program: an importer in a `test/**` file under a sibling tsconfig is repointed too, and the typecheck gate runs on every affected program (including the program that owns the dest file, so a merge erroneous under a sibling tsconfig is refused).',
    'cross-program LIMITS: (a) the capture-safety check (the type-compatible silent re-bind on a rewritten import) runs on the PRIMARY program ONLY. (b) inside a `transaction` the cross-program write-site fan-out is OFF: a step rewrites primary-program sites only, though the cumulative §2.8 gate still fans across every program and refuses a cross-program dangle.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    let plan: RefactorPlan | string;
    try {
      plan = await ts.planMoveSymbol(targetOf(args), args.dest as RepoRelPath);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
    if (typeof plan === 'string') return fail({ tool: 'ts-ls', message: plan });
    return applyRefactorPlan(ctx, plan, {
      refusalLabel: 'move-symbol',
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
      captureAction:
        'the move relinks an importer onto a different same-named export — choose a different dest or relink manually',
    });
  },
});
