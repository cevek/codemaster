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
import type {
  GroupRow,
  SymbolView,
  UsageOptions,
  UsageView,
  UsagesView,
} from '../plugins/ts/query-types.ts';
import { USAGE_ROLES } from '../plugins/ts/usage-roles.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';
import { TS_TARGET_HINT, requireTarget, tsTargetShape } from './ts-target.ts';

// ── tabular projection (§3) ──────────────────────────────────────────────────────
// One relation over reference sites. Two output shapes feed it: single-target
// (`{definition, usages|enclosers, …}`) and multi-symbol (`{targets:[…], unresolved}`).
// `encloser*`/`count`/`is_exported` are NULL on flat rows; `file/line/col` are the usage
// site on flat rows and the encloser's anchor on grouped rows. `encloser_file` +
// `is_exported` let SQL keep only exported enclosers (and drop the synthetic
// `(top-level X)` module nodes) without a name LIKE-heuristic.
type Section = {
  symbol: string | null;
  usages?: UsageView[] | undefined;
  enclosers?: GroupRow[] | undefined;
  excludedByFilter?: number | undefined;
};

function sectionRows(s: Section): readonly Cell[][] {
  const rows: Cell[][] = [];
  for (const u of s.usages ?? []) {
    rows.push([
      s.symbol,
      u.span.file,
      u.span.line,
      u.span.col,
      u.role,
      null,
      null,
      null,
      null,
      null,
      null,
      u.confidence,
    ]);
  }
  for (const g of s.enclosers ?? []) {
    rows.push([
      s.symbol,
      g.file,
      g.line,
      g.col,
      g.roles,
      g.name,
      g.id,
      g.kind,
      g.file,
      g.exported ? 1 : 0,
      g.count,
      g.confidence,
    ]);
  }
  return rows;
}

function sectionsOf(data: JsonValue): Section[] {
  const d = data as {
    targets?: {
      symbol: string;
      usages?: UsageView[];
      enclosers?: GroupRow[];
      excludedByFilter?: number;
    }[];
    definition?: SymbolView;
    usages?: UsageView[];
    enclosers?: GroupRow[];
    excludedByFilter?: number;
  };
  if (d.targets !== undefined) {
    return d.targets.map((t) => ({
      symbol: t.symbol,
      usages: t.usages,
      enclosers: t.enclosers,
      excludedByFilter: t.excludedByFilter,
    }));
  }
  return [
    {
      symbol: d.definition?.name ?? null,
      usages: d.usages,
      enclosers: d.enclosers,
      excludedByFilter: d.excludedByFilter,
    },
  ];
}

const findUsagesTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'symbol', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'role', type: 'text' },
    { name: 'encloser', type: 'text' },
    { name: 'encloser_id', type: 'text' },
    { name: 'encloser_kind', type: 'text' },
    { name: 'encloser_file', type: 'text' },
    { name: 'is_exported', type: 'int' },
    { name: 'count', type: 'int' },
    { name: 'confidence', type: 'text' },
  ],
  rows(data) {
    return sectionsOf(data).flatMap(sectionRows);
  },
  notes(data) {
    const notes: string[] = [];
    for (const s of sectionsOf(data)) {
      if (s.excludedByFilter !== undefined && s.excludedByFilter > 0) {
        notes.push(
          `${s.symbol ?? '<target>'}: ${s.excludedByFilter} reference(s) excluded by your path/kind filters`,
        );
      }
    }
    const unresolved =
      (data as { unresolved?: { name: string; reason: string }[] }).unresolved ?? [];
    for (const u of unresolved) notes.push(`unresolved symbol '${u.name}': ${u.reason}`);
    return notes;
  },
};

const ROW_CAP_HINT = 'raise limit (or in sql-mode the per-call row bound was hit)';

// Row dimension of the TABLE projection: usages in flat mode, enclosers in grouped mode.
// `total` is the pre-cap count, so `total > shown` is the producer's own truncation — the
// signal sql-batch turns into a `partial` table (a capped table feeding NOT IN lies, §2.3).
function rowsShown(view: UsagesView): number {
  return view.groups?.length ?? view.usages?.length ?? 0;
}
function rowsTotal(view: UsagesView): number {
  if (view.groups !== undefined) return view.groupTotal ?? view.groups.length;
  return view.total;
}

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
  example: {
    args: {
      symbols: ['DialogContent', 'SheetContent'],
      role: 'jsx',
      groupBy: 'enclosing',
      filter: { pathExclude: ['**/ui/**', '**/*.test.*'] },
    },
  },
  table: findUsagesTable,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    const options: UsageOptions = {
      // sql-mode (§2.3): a capped producer feeding a NOT IN lies. The engine threads the
      // SAME MAX_TABLE_ROWS it enforces, so the op caps exactly where the engine would —
      // and reports `truncated` below so the table is marked partial, never silently short.
      limit: ctx.tableRowBound ?? args.limit ?? 200,
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
        let shownRows = 0;
        let totalRows = 0;
        for (const name of args.symbols) {
          const outcome = ts.findUsages({ name }, options);
          if (typeof outcome === 'string') {
            unresolved.push({ name, reason: outcome });
            continue;
          }
          const { view } = outcome;
          shownRows += rowsShown(view);
          totalRows += rowsTotal(view);
          targets.push({
            symbol: name,
            ...(view.definition !== undefined ? { definition: view.definition.id } : {}),
            ...(view.groups !== undefined ? { enclosers: view.groups } : {}),
            ...(view.usages !== undefined ? { usages: view.usages } : {}),
            total: view.total,
            ...(view.excluded > 0 ? { excludedByFilter: view.excluded } : {}),
          });
        }
        return ok(
          {
            targets,
            ...(unresolved.length > 0 ? { unresolved } : {}),
          },
          // Multi-symbol has no single per-result limit, but a capped producer feeding a
          // NOT IN still lies (§2.3) — report the aggregate so sql-batch marks it partial.
          totalRows > shownRows
            ? { truncated: { shown: shownRows, total: totalRows, hint: ROW_CAP_HINT } }
            : undefined,
        );
      }

      const outcome = ts.findUsages(args, options);
      if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
      const { view, rebind } = outcome;
      const shown = rowsShown(view);
      const total = rowsTotal(view);
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
          ...(total > shown ? { truncated: { shown, total, hint: ROW_CAP_HINT } } : {}),
        },
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
