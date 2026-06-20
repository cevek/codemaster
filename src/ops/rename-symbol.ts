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
import { tsTargetShape, requireTarget, targetOf } from './ts-target.ts';
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
    "{ symbolId?: 'ts:…' | name?: string | file+line+col, newName: string, dirtyOk?: boolean }",
  example: { args: { file: 'src/app.ts', line: 12, col: 8, newName: 'renamed' } },
  notes: [
    'dry-run (default) writes nothing — returns the unified diff, touched files, and the post-edit typecheck. apply:true is refused only if the edit INTRODUCES new typecheck errors (diffed against a pre-edit baseline); a repo’s pre-existing errors ride along as a preExisting count, never blocking.',
    'apply rolls back byte-exact if the post-apply typecheck shows newly-introduced errors; a name collision surfaces as a duplicate-identifier diagnostic, never a silent clobber.',
    'capture-safe: if the new name shadows / is shadowed by an in-scope binding so a rewritten reference would silently re-bind to a DIFFERENT symbol (type-compatible → invisible to the typecheck), the sites are listed under `captures` and apply is REFUSED (shown on dry-run too). summaryOnly:true returns the verdict + ONE merged `touched` list (each file with its +added/-removed line counts) instead of the full diff.',
    'cross-program: rename sites are computed across ALL loaded programs — a `test/**` reference under a sibling tsconfig (tsconfig.test.json) is rewritten too, not left dangling, and the typecheck gate runs on every affected program (matches find_usages, which fans out for reads).',
    'cross-program LIMITS: (a) the capture-safety check (the type-compatible silent re-bind) runs on the PRIMARY program ONLY — a re-bind a sibling program would see is NOT flagged (the gate still catches a resulting dangle/type error, just not a type-COMPATIBLE one). (b) inside a `transaction` the cross-program write-site fan-out is OFF: a step rewrites primary-program sites only, though the cumulative §2.8 gate still fans across every program and refuses a cross-program dangle.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    let outcome: ReturnType<TsPluginApi['renameSites']>;
    try {
      outcome = ts.renameSites(targetOf(args), args.newName);
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
      refs = ts.referenceSpans(targetOf(args));
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
      captures: outcome.captures,
      captureAction: `pick a different newName than \`${args.newName}\`, or remove the shadowing binding first`,
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
