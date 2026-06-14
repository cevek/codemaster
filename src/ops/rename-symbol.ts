// `rename_symbol` — the thinnest symbol-anchored mutating op (§7). The `ts` plugin's LS
// resolves the symbol and computes every semantic reference site (aliased imports, JSX,
// re-exports — a textual replace would miss or over-match); the shared `applyMutation`
// core turns those into the dry-run/apply/typecheck/rollback envelope (§2.10). Dry-run is
// the default; writes need an explicit `apply: true`.

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import type { JsonValue } from '../core/json.ts';
import { fail, failFromThrown } from '../common/result/construct.ts';
import { findReExportAliasSites, type TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';
import { tsTargetShape, requireTarget } from './ts-target.ts';
import { applyMutation } from './refactor-apply.ts';
import { buildOldNameSurvives, touchedSet } from './rename-survivors.ts';

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

    // Completeness signal (KS-1): the LS rename is faithful and compiles clean, but the old
    // name can survive as re-export aliases it introduced and as consumers reached only via
    // `export *` (which `findRenameLocations` does not traverse). `referenceSpans` DOES walk the
    // star, so the reference sites the rename's touch-set never rewrote are exactly those
    // survivors — disclosed as a note, never blocking (§3.4 / spec §2). The LS call is wrapped
    // (§3.6): a fault degrades the signal (no consumers; the alias scan still runs) — it never
    // fails the rename, which is correct independent of this disclosure. A `string` (target
    // could not be resolved for references) degrades the same way.
    let refs: ReturnType<TsPluginApi['referenceSpans']>;
    try {
      refs = ts.referenceSpans({
        symbol: args.symbol,
        file: args.file,
        line: args.line,
        col: args.col,
        name: args.name,
      });
    } catch {
      refs = 'reference resolution failed';
    }
    const touched = touchedSet(outcome.changes.map((c) => c.path));
    // Exclude `dropped` files too: a ref there is already surfaced as PARTIAL (could-not-edit),
    // and is not a faithful `export *` survivor — don't double-count / mislabel it.
    const dropped = touchedSet(outcome.dropped);
    // A survivor is a ref the rename never rewrote that STILL SPELLS the old name. The
    // `text === oldName` guard drops a star-reached aliased binding's local usages (e.g. a
    // `foo()` from `import { formatLabel as foo }`) — those don't spell the old name, so the
    // "keep `<old>`" claim stays literally true of every span we report (§3.2).
    const exportStarConsumers =
      typeof refs === 'string'
        ? []
        : refs.spans.filter(
            (s) =>
              s.text === outcome.oldName &&
              !touched.has(String(s.file)) &&
              !dropped.has(String(s.file)),
          );

    return applyMutation(ctx, outcome.changes, {
      ...(args.dirtyOk !== undefined ? { dirtyOk: args.dirtyOk } : {}),
      ...(outcome.rebind !== undefined ? { handle: outcome.rebind } : {}),
      ...(warnings !== undefined ? { warnings } : {}),
      buildNote: (changes) => {
        // Aliases are AST-found in the FORMATTED post-rename content (per touched file), so the
        // spans match exactly what apply writes (§3.2). The op resolves the helper through the
        // plugin's public surface — the TS parse stays in the ts plugin (§4 one parser/domain).
        const reExportAliases = changes.flatMap((c) =>
          findReExportAliasSites(c.path, c.after, args.newName, outcome.oldName),
        );
        return buildOldNameSurvives(
          outcome.oldName,
          args.newName,
          reExportAliases,
          exportStarConsumers,
        );
      },
    });
  },
});
