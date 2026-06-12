// `search_symbol` — LS workspace symbol search (fuzzy, like editor Cmd+T).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { SymbolView } from '../plugins/ts/query-types.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

/** Project SymbolView matches into rows (§3). LS workspace-symbol hits are structural —
 *  `confidence` is always `certain`. */
const searchSymbolTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'id', type: 'text' },
    { name: 'name', type: 'text' },
    { name: 'kind', type: 'text' },
    { name: 'container', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'confidence', type: 'text' },
  ],
  rows(data) {
    const matches = (data as { matches?: SymbolView[] }).matches ?? [];
    return matches.map((m): readonly Cell[] => [
      m.id,
      m.name,
      m.kind,
      m.container ?? null,
      m.span.file,
      m.span.line,
      m.span.col,
      'certain',
    ]);
  },
};

const argsSchema = z.strictObject({
  query: z.string().min(1),
  limit: z.number().int().positive().max(500).optional(),
  /** LS symbol kind: 'function' | 'const' | 'class' | 'interface' | 'type' | … */
  kind: z.string().optional(),
  exportedOnly: z.boolean().optional(),
  pathExclude: z.array(z.string()).optional(),
  pathInclude: z.array(z.string()).optional(),
});

export const searchSymbolOp = defineOp({
  name: 'search_symbol',
  summary:
    'Find symbols by (fuzzy) name across the workspace; returns SymbolIds to chain into other ops',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint:
    '{ query: string, limit?, kind?: string, exportedOnly?: boolean, pathExclude?: string[], pathInclude?: string[] }',
  example: {
    args: { query: 'Dialog', kind: 'function', exportedOnly: true, pathExclude: ['**/ui/**'] },
  },
  notes: [
    'fuzzy (editor Cmd+T style); returns chainable SymbolIds. Narrow with kind / exportedOnly / pathInclude / pathExclude.',
  ],
  table: searchSymbolTable,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      // sql-mode (§2.3): the engine threads MAX_TABLE_ROWS so a NOT IN sees every match;
      // `total > matches.length` below still reports truncation, marking the table partial.
      const limit = ctx.tableRowBound ?? args.limit ?? 25;
      const { matches, total } = ts.searchSymbol(args.query, limit, {
        kind: args.kind,
        exportedOnly: args.exportedOnly,
        pathExclude: args.pathExclude,
        pathInclude: args.pathInclude,
      });
      if (matches.length === 0) {
        return ok({ matches: [], note: `no symbols matching '${args.query}'` });
      }
      return ok(
        { matches },
        total > matches.length
          ? {
              truncated: {
                shown: matches.length,
                total,
                hint: 'raise limit, or narrow the query (it is fuzzy — a longer prefix helps)',
              },
            }
          : undefined,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
