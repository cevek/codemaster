// `search_symbol` — LS workspace symbol search (the navto provider: prefix / substring /
// camelCase-initials, NOT arbitrary-subsequence fuzzy — see the op note).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
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
  /** Glob(s) over the match's declaration file. `.min(1)`: an empty array is a meaningless intent
   *  (matches nothing → drops every result), so it fails fast rather than reading as absence — parity
   *  with `list`. A wildcard-less entry is auto-expanded to a directory prefix (see the op run). */
  pathExclude: z.array(z.string()).min(1).optional(),
  pathInclude: z.array(z.string()).min(1).optional(),
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
  // §7 Postel: the op-map advertises this op as "fuzzy-find a symbol BY NAME", so `name` is the
  // intuitive-but-wrong spelling of the canonical `query` (the single most-recurring dogfood
  // friction). Aliased, disclosed via Result.intake; the canonical schema stays the sole gate.
  intake: { aliases: { name: 'query' } },
  example: {
    args: { query: 'Dialog', kind: 'function', exportedOnly: true, pathExclude: ['**/ui/**'] },
  },
  notes: [
    'matches the LS workspace-symbol provider — prefix / substring / camelCase-initials (e.g. "fC" → formatCurrency), NOT arbitrary subsequence ("frmtCurncy" finds nothing); returns chainable SymbolIds. Narrow with kind / exportedOnly / pathInclude / pathExclude.',
  ],
  table: searchSymbolTable,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      // sql-mode (§2.3): the engine threads MAX_TABLE_ROWS so a NOT IN sees every match;
      // `total > matches.length` below still reports truncation, marking the table partial.
      const limit = ctx.tableRowBound ?? args.limit ?? 25;
      const { matches, total, filteredOutByPath } = ts.searchSymbol(args.query, limit, {
        kind: args.kind,
        exportedOnly: args.exportedOnly,
        pathExclude: args.pathExclude,
        pathInclude: args.pathInclude,
      });
      if (matches.length === 0) {
        // §3.4: a path filter that excluded every match is a self-defeating FILTER, not a symbol
        // absence — say so, so an agent never reads the empty answer as "no such symbol". A bare
        // dir is already auto-expanded to a prefix, so this fires on a genuine path miss (a typo).
        const note =
          filteredOutByPath !== undefined && filteredOutByPath > 0
            ? `no matches under the path filter — ${filteredOutByPath} symbol(s) matched '${args.query}' but pathInclude/pathExclude excluded them all; check the path (a bare dir is auto-expanded to a prefix; a path with glob-special chars like ()@! may need escaping) — NOT a symbol absence`
            : `no symbols matching '${args.query}'`;
        return ok({ matches: [], note });
      }
      return ok(
        { matches: matches.map((m) => tag('symbol', m)) },
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
