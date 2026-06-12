// `importers_of` — who imports / re-exports from a module. Generic module-graph
// primitive: "who depends on X" without grepping import strings (aliased specifiers
// resolve through the project's own tsconfig paths).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result } from '../core/result.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';

const argsSchema = z.strictObject({
  /** Repo-relative path ('src/components/ui/dialog.tsx') or any import specifier
   *  the project itself would use ('@/components/ui/dialog'). */
  module: z.string().min(1),
});

export const importersOfOp = defineOp({
  name: 'importers_of',
  summary: 'Files that import or re-export from a module (tsconfig-paths aware)',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: "{ module: string } — a repo-relative path or an import specifier ('@/…')",
  example: `op({name:'importers_of', args:{module:'@/components/ui/dialog'}})`,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const view = ts.importersOf(args.module);
      if (view.total === 0) {
        return ok({
          module: view.module,
          importers: [],
          note: 'no importers found — check the specifier (path or alias) against tsconfig',
        });
      }
      return ok({ module: view.module, importers: view.importers, total: view.total });
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
