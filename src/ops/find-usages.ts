// `find_usages` — semantic references from the live LS, with generic AST-level
// refinements (no domain semantics; the agent supplies the names):
//   role:'jsx'           keep only `<X/>` tag references (or call/type/import/…)
//   groupBy:'enclosing'  roll references up to their nearest enclosing named
//                        declaration — "which components render X" as one call
//   filter               pathExclude/pathInclude globs; encloser kind/exportedOnly
//   symbols:[…]          several targets in one call, sectioned per target
// Caps and filters are explicit (`total`/`excluded`/truncation) — never silent (§3.4).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result } from '../core/result.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { UsageOptions } from '../plugins/ts/queries.ts';
import { USAGE_ROLES } from '../plugins/ts/usage-roles.ts';
import { defineOp } from './registry.ts';
import { TS_TARGET_HINT, requireTarget, tsTargetShape } from './ts-target.ts';

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    /** Several targets by exact name, answered as one sectioned result. */
    symbols: z.array(z.string().min(1)).min(1).max(20).optional(),
    limit: z.number().int().positive().max(2000).optional(),
    role: z.enum(USAGE_ROLES).optional(),
    groupBy: z.literal('enclosing').optional(),
    filter: z
      .strictObject({
        pathExclude: z.array(z.string()).optional(),
        pathInclude: z.array(z.string()).optional(),
        /** Encloser kind, grouped mode: function | method | class | module. */
        kind: z.string().optional(),
        /** Grouped mode: only exported enclosers. */
        exportedOnly: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((t) => t.symbols !== undefined || requireTarget.predicate(t), {
    message: `${requireTarget.message} — or pass symbols: [names]`,
  });

export const findUsagesOp = defineOp({
  name: 'find_usages',
  summary:
    'Semantic reference sites of symbol(s); role filter (jsx/call/type/import), rollup to enclosing declaration, path filters',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} | { symbols: string[] } — plus { limit?, role?: 'jsx'|'call'|'type'|'import'|'read'|'write'|'decl', groupBy?: 'enclosing', filter?: {pathExclude?, pathInclude?, kind?, exportedOnly?} }`,
  example: `op({name:'find_usages', args:{symbols:['DialogContent','SheetContent'], role:'jsx', groupBy:'enclosing', filter:{pathExclude:['**/ui/**','**/*.test.*']}}})`,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    const options: UsageOptions = {
      limit: args.limit ?? 200,
      role: args.role,
      groupBy: args.groupBy,
      pathExclude: args.filter?.pathExclude,
      pathInclude: args.filter?.pathInclude,
      enclosingKind: args.filter?.kind,
      exportedOnly: args.filter?.exportedOnly,
    };
    try {
      if (args.symbols !== undefined) {
        const targets: JsonValue[] = [];
        const unresolved: JsonValue[] = [];
        for (const name of args.symbols) {
          const outcome = ts.findUsages({ name }, options);
          if (typeof outcome === 'string') {
            unresolved.push({ name, reason: outcome });
            continue;
          }
          const { view } = outcome;
          targets.push({
            symbol: name,
            ...(view.definition !== undefined ? { definition: view.definition.id } : {}),
            ...(view.groups !== undefined ? { enclosers: view.groups } : {}),
            ...(view.usages !== undefined ? { usages: view.usages } : {}),
            total: view.total,
            ...(view.excluded > 0 ? { excludedByFilter: view.excluded } : {}),
          });
        }
        return ok({
          targets,
          ...(unresolved.length > 0 ? { unresolved } : {}),
        });
      }

      const outcome = ts.findUsages(args, options);
      if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
      const { view, rebind } = outcome;
      const shown = view.groups?.length ?? view.usages?.length ?? 0;
      return ok(
        {
          ...(view.definition !== undefined ? { definition: view.definition } : {}),
          ...(view.groups !== undefined ? { enclosers: view.groups } : {}),
          ...(view.usages !== undefined ? { usages: view.usages } : {}),
          total: view.total,
          ...(view.excluded > 0 ? { excludedByFilter: view.excluded } : {}),
        },
        {
          ...(rebind !== undefined ? { handle: rebind } : {}),
          ...(view.total > shown && view.groups === undefined
            ? {
                truncated: { shown, total: view.total, hint: 'pass a higher limit' },
              }
            : {}),
        },
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
