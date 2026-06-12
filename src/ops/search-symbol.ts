// `search_symbol` — LS workspace symbol search (fuzzy, like editor Cmd+T).

import { z } from 'zod';
import { failFromThrown, ok } from '../common/result/construct.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import { defineOp } from './registry.ts';

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
  example: `op({name:'search_symbol', args:{query:'Dialog', kind:'function', exportedOnly:true, pathExclude:['**/ui/**']}})`,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const limit = args.limit ?? 25;
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
