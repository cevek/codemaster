// `importers_of` — who imports / re-exports from a module. Generic module-graph
// primitive: "who depends on X" without grepping import strings (aliased specifiers
// resolve through the project's own tsconfig paths).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result } from '../core/result.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { ImporterRow } from '../plugins/ts/importers.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

/** Project importer rows (§3). `at` is the op's own stable `file:line` field — split on
 *  the last colon (repo-relative POSIX paths never contain one). Import edges read off
 *  the resolved module graph are structural ⇒ `confidence` is `certain`. */
const importersOfTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'module', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'imports', type: 'text' },
    { name: 'confidence', type: 'text' },
  ],
  rows(data) {
    const view = data as { module?: string; importers?: ImporterRow[] };
    const module = view.module ?? null;
    return (view.importers ?? []).map((r): readonly Cell[] => {
      const sep = r.at.lastIndexOf(':');
      const file = sep > 0 ? r.at.slice(0, sep) : r.at;
      const line = sep > 0 ? Number(r.at.slice(sep + 1)) : Number.NaN;
      return [module, file, Number.isFinite(line) ? line : null, r.imports, 'certain'];
    });
  },
};

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
  example: { args: { module: '@/components/ui/dialog' } },
  notes: [
    'module = a repo-relative path or any import specifier the project uses (@/… aliases resolve via tsconfig paths); catches re-exports, not just direct imports.',
    "spans ALL the repo's loaded TS programs — an importer in a `test/**` file under a sibling tsconfig (tsconfig.test.json) is found, not just main-program importers.",
  ],
  table: importersOfTable,
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
