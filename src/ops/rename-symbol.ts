// `rename_symbol` — the thinnest symbol-anchored mutating op (§7). The `ts` plugin's LS
// resolves the symbol and computes every semantic reference site (aliased imports, JSX,
// re-exports — a textual replace would miss or over-match); the shared `applyMutation`
// core turns those into the dry-run/apply/typecheck/rollback envelope (§2.10). Dry-run is
// the default; writes need an explicit `apply: true`.

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import { fail, failFromThrown } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { tsTargetShape, requireTarget } from './ts-target.ts';
import { applyMutation } from './refactor-apply.ts';

const renameArgsSchema = z
  .strictObject({
    ...tsTargetShape,
    newName: z.string().min(1),
    /** Apply even when a touched file has uncommitted changes (§7). */
    dirtyOk: z.boolean().optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });

type RenameArgs = z.infer<typeof renameArgsSchema>;

export const renameSymbolOp = defineOp<RenameArgs, JsonValue>({
  name: 'rename_symbol',
  summary: 'Rename a symbol across every semantic reference site (dry-run unless apply:true)',
  mutating: true,
  requires: ['ts'],
  argsSchema: renameArgsSchema,
  argsHint:
    "{ symbol?: 'ts:…' | name?: string | file+line+col, newName: string, dirtyOk?: boolean }",
  example: { args: { file: 'src/app.ts', line: 12, col: 8, newName: 'renamed' } },
  notes: [
    'dry-run (default) writes nothing — returns the unified diff, touched files, and the post-edit typecheck. apply:true is refused unless that typecheck is clean.',
    'apply rolls back byte-exact if the post-apply typecheck fails; a name collision surfaces as a duplicate-identifier diagnostic, never a silent clobber.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    let outcome: ReturnType<TsPluginApi['renameSites']>;
    try {
      outcome = ts.renameSites(
        { symbol: args.symbol, file: args.file, line: args.line, col: args.col, name: args.name },
        args.newName,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
    if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
    const warnings =
      outcome.dropped.length > 0
        ? [
            `could not edit ${outcome.dropped.length} rename site(s) in file(s) not in the TS program (${outcome.dropped.join(', ')}) — the rename is PARTIAL`,
          ]
        : undefined;
    return applyMutation(ctx, outcome.changes, {
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
      ...(outcome.rebind !== undefined ? { handle: outcome.rebind } : {}),
      ...(warnings !== undefined ? { warnings } : {}),
    });
  },
});
