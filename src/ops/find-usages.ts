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
import type { Result, ToolFailure } from '../core/result.ts';
import { failFromThrown, fail, ok, partial } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi, TsTargetInput } from '../plugins/ts/plugin.ts';
import type { GroupRow, UsageOptions, UsageView, UsagesView } from '../plugins/ts/query-types.ts';
import { USAGE_ROLES } from '../plugins/ts/usage-roles.ts';
import { createJsScanner } from '../support/text-search/scan.ts';
import { defineOp } from './registry.ts';
import { findUsagesTable } from './find-usages-table.ts';
import { TEXT_ONLY_CAP, attachOverlay, overlayFor } from './find-usages-text.ts';
import { TS_TARGET_HINT, requireTarget, tsTargetShape } from './ts-target.ts';

const ROW_CAP_HINT = 'raise limit (or in sql-mode the per-call row bound was hit)';

// Row dimension of the TABLE projection: usages in flat mode, enclosers in grouped mode.
// `total` is the pre-cap count, so `total > shown` is the producer's own truncation — the
// signal sql-batch turns into a `partial` table (a capped table feeding NOT IN lies, §2.3).
function rowsShown(view: UsagesView): number {
  return view.groups?.length ?? view.usages?.length ?? 0;
}
function rowsTotal(view: UsagesView): number {
  if (view.groups !== undefined) return view.groupTotal ?? view.groups.length;
  // Flat: truncation is about rows raising `limit` would reveal — the DISPLAYABLE set,
  // i.e. matches minus collapsed imports (raising the limit never un-collapses; that's
  // collapseImports:false). Keeps "shown X/Y" from miscounting a collapse as a cap (§3.4).
  return view.total - (view.importsCollapsed ?? 0);
}

/** `{ listable }` ties the raw `total` to the listed `usages (M):`/`shown` counts when imports are
 *  collapsed (total = listable + importsCollapsed). FLAT mode only: in groupBy the listed rows are
 *  ENCLOSERS (a different axis), so a usages-based `listable` would tie to nothing — omit it there.
 *  Emitted ONLY when the listed rows are TRUNCATED (listable > shown): without truncation listable
 *  equals the `usages (N):` header count, so it just repeats N — the gap is already explained by
 *  `total` + `importsCollapsed` (density audit). */
function listableField(view: UsagesView): Record<string, JsonValue> {
  const collapsed = view.importsCollapsed ?? 0;
  if (view.usages === undefined || collapsed <= 0) return {};
  const listable = view.total - collapsed;
  return listable > view.usages.length ? { listable } : {};
}

/** A copy of `row` without key `k` — used to lift a constant column into a header without mutating
 *  the plugin's cached row (tear-free reads, §19). */
function omitKey<T extends object, K extends keyof T>(row: T, k: K): T {
  const { [k]: _drop, ...rest } = row;
  return rest as T;
}

/** The most common single-program label across a view's rows (flat `program`, or a grouped row
 *  whose `programs` is a single program — a comma-joined multi-program set is never a candidate).
 *  `undefined` when no row carries a program (a single-program repo — the plugin omits the field). */
function dominantProgram(view: UsagesView): string | undefined {
  const counts = new Map<string, number>();
  const bump = (p: string): void => {
    counts.set(p, (counts.get(p) ?? 0) + 1);
  };
  for (const u of view.usages ?? []) if (u.program !== undefined) bump(u.program);
  for (const g of view.groups ?? [])
    if (g.programs !== undefined && !g.programs.includes(',')) bump(g.programs);
  let best: string | undefined;
  let bestN = 0;
  for (const [p, n] of counts)
    if (n > bestN) {
      best = p;
      bestN = n;
    }
  return best;
}

type Hoisted = {
  usages?: UsageView[] | undefined;
  groups?: GroupRow[] | undefined;
  role?: string;
  allProgram?: string;
  progNote?: string;
};

/** Lift columns that are CONSTANT across the listed rows into header fields (mirrors `list`'s
 *  `hoistUniform`), so a 86-row answer doesn't repeat `· call` / `· prog tsconfig.json` on every
 *  line. TEXT/JSON path only — sql-mode keeps every per-row value (the table projects `role` /
 *  `program` per row, and a header-hoisted column there would lie under a NOT IN). */
function hoistView(view: UsagesView, role: string | undefined, sqlMode: boolean): Hoisted {
  if (sqlMode) return { usages: view.usages, groups: view.groups };
  let usages = view.usages;
  let groups = view.groups;
  const out: Hoisted = {};
  // Item 4: a single `role` filter pins every flat row's role — state it once, drop it per-row.
  if (role !== undefined && usages !== undefined) {
    usages = usages.map((u) => omitKey(u, 'role'));
    out.role = role;
  }
  // Item 6: most rows carry the SAME program (the primary, since refs are surfaced primary-first) —
  // hoist the dominant into `allProgram`, drop it per-row, leave the rest tagged. The note carries
  // the full by-NAME asymmetry so a bare row is unambiguous regardless of which program was hoisted:
  // a sibling label (tsconfig.test.json) = present ONLY there; the primary label = present there,
  // POSSIBLY elsewhere too (primary-preferred dedup keeps one label). Ties resolve to the
  // first-surfaced program (primary), so allProgram is the primary in the common case.
  const dominant = dominantProgram(view);
  if (dominant !== undefined) {
    if (usages !== undefined)
      usages = usages.map((u) => (u.program === dominant ? omitKey(u, 'program') : u));
    if (groups !== undefined)
      groups = groups.map((g) => (g.programs === dominant ? omitKey(g, 'programs') : g));
    out.allProgram = dominant;
    out.progNote = `allProgram=${dominant}: a row without a \`prog …\` tag was surfaced by it; a tagged row by the named program. A sibling label (e.g. tsconfig.test.json) means present ONLY there; the primary (tsconfig.json) means present there, POSSIBLY elsewhere.`;
  }
  out.usages = usages;
  out.groups = groups;
  return out;
}

/** Compose the advisory microtext for a usages view (§2.2/§2.3): the import-collapse
 *  count, and — when a role filter is active — what the role-unfiltered answer looked
 *  like. The generalized principle: an empty filtered answer must show what the
 *  unfiltered answer looked like, else "0" is indistinguishable from "none exist" (a
 *  §3.4-class lie). */
function usageNotes(view: UsagesView, role: string | undefined, verbosity: string): string[] {
  const notes: string[] = [];
  if (view.importsCollapsed !== undefined && view.importsCollapsed > 0) {
    notes.push(
      `imports: ${view.importsCollapsed} collapsed (their files appear via real usages) — collapseImports:false or role:'import' to list`,
    );
  }
  if (role !== undefined && view.roleBreakdown !== undefined) {
    const byCount = Object.entries(view.roleBreakdown).sort((a, b) => b[1] - a[1]);
    if (view.total === 0) {
      const all = byCount.map(([r, c]) => `${r}=${c}`).join(' ');
      const dominant = byCount[0]?.[0];
      notes.push(
        all.length === 0
          ? `0 usages role=${role} (no references of any role found)`
          : `0 usages role=${role} (all roles: ${all} — try role:${dominant})`,
      );
    } else if (verbosity !== 'terse') {
      const others = byCount.filter(([r]) => r !== role).map(([r, c]) => `${r}=${c}`);
      if (others.length > 0) notes.push(`(other roles: ${others.join(' ')})`);
    }
  }
  return notes;
}

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    /** Several targets by exact name, answered as one sectioned result. */
    symbols: z.array(z.string().min(1)).min(1).max(20).optional(),
    limit: z.number().int().positive().max(2000).optional(),
    role: z.enum(USAGE_ROLES).optional(),
    /** Hide an import once its file also has a real usage (§2.2). Default true; the
     *  count is reported and import-only/re-export files always stay. */
    collapseImports: z.boolean().optional(),
    /** Add textual occurrences (comments/strings/docs) of the name, deduped against the
     *  semantic refs, identity unproven (§ text-overlay). */
    text: z.boolean().optional(),
    /** Union usages across ALL same-named declarations (the interface-decl + host-decl + impl
     *  triplet), instead of failing on the ambiguity. Per-site provenance kept (`usages[].decls`
     *  index into `mergedDeclarations`). Only for a `name` target. */
    mergeDeclarations: z.boolean().optional(),
    groupBy: z.literal('enclosing').optional(),
    filter: z
      .strictObject({
        pathExclude: z.array(z.string()).optional(),
        pathInclude: z.array(z.string()).optional(),
        /** Encloser kind, grouped mode: function | method | class | const | variable | module. */
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
  argsHint: `${TS_TARGET_HINT} | { symbols: string[] } — plus { limit?, role?: 'jsx'|'call'|'type'|'import'|'reexport'|'read'|'write'|'decl', collapseImports?: boolean (default true), text?: boolean, mergeDeclarations?: boolean, groupBy?: 'enclosing', filter?: {pathExclude?, pathInclude?, kind?, exportedOnly?} }`,
  example: {
    args: {
      symbols: ['DialogContent', 'SheetContent'],
      role: 'jsx',
      groupBy: 'enclosing',
      filter: { pathExclude: ['**/ui/**', '**/*.test.*'] },
    },
  },
  notes: [
    'role = what a ref syntactically IS: jsx (<X/> tags, closing deduped) · call · type · import · reexport (barrel `export {X} from` — never collapsed) · read · write · decl.',
    'role:read/write is SYNTACTIC (is the identifier read vs assigned) — it does NOT resolve store-field access: a zustand `useStore(s => s.count)` or a `set(...)` call reads as a `call`, not a read/write of `count`. Use it for variable/binding reads-vs-writes, not store-field tracing.',
    'collapseImports (default true): an import is hidden once its file also has a real usage (count returns as importsCollapsed); import-only files & re-exports always stay. collapseImports:false or role:import to list all. sql-mode keeps every import row.',
    "groupBy:'enclosing' rolls refs up to the nearest enclosing declaration ('which components render <X>'), sorted by count; encloser ids chain into other ops.",
    'filter {pathExclude/pathInclude globs, kind, exportedOnly}: dropped refs are reported as excludedByFilter — a filter never reads as completeness.',
    'symbols:[…] answers several targets in one sectioned call (unresolvable names → unresolved). A role filter matching 0 still prints the full role distribution + the dominant role to try.',
    "deleting a symbol? text:true adds comment/string/doc occurrences of the name, deduped against semantic refs and flagged 'text-only (identity NOT proven)' — role/path filters don't touch the text side.",
    "reference sites span ALL the repo's loaded TS programs — a usage in a `test/**` file under a sibling tsconfig (tsconfig.test.json), a build script, or Vite's app/node split is found and counted, not just main-program refs (deduped where programs overlap).",
    'multi-program: each usage carries the `program` that surfaced it (sql column `program`). HONEST ASYMMETRY — a sibling label (tsconfig.test.json) means present ONLY there; the primary label means present in primary, POSSIBLY elsewhere too. Emitted only when >1 program is loaded.',
    'density (text/json, NOT sql): a column CONSTANT across the listed rows is hoisted to a header and dropped per-row — a single `role` filter → `role=<r>` (read effective role as `row.role ?? role`); the dominant program → `allProgram=<p>` (read `row.program ?? allProgram`). `listable` (collapsed-import count tie) appears ONLY when the rows are truncated. sql-mode keeps every value per row.',
    "mergeDeclarations:true — for an AMBIGUOUS name (the interface-decl + host-decl + impl triplet), union the usages of ALL same-named declarations instead of failing. The merged decls are listed in `mergedDeclarations`; each usage's `decls` indexes into it (per-site provenance — unrelated same-named symbols are never silently conflated).",
  ],
  table: findUsagesTable,
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    // sql-mode signal (§2.3): the engine sets tableRowBound only when this op feeds a
    // SQLite table. Import collapse is forced OFF there — the table projects from the
    // UNCOLLAPSED ref set, so "files that import X but don't render it" (NOT IN over the
    // import rows) stays trustworthy (§2.2).
    const sqlMode = ctx.tableRowBound !== undefined;
    const verbosity = ctx.flags.verbosity ?? 'terse';
    const options: UsageOptions = {
      // sql-mode (§2.3): a capped producer feeding a NOT IN lies. The engine threads the
      // SAME MAX_TABLE_ROWS it enforces, so the op caps exactly where the engine would —
      // and reports `truncated` below so the table is marked partial, never silently short.
      limit: ctx.tableRowBound ?? args.limit ?? 200,
      role: args.role,
      collapseImports: sqlMode ? false : (args.collapseImports ?? true),
      groupBy: args.groupBy,
      mergeDeclarations: args.mergeDeclarations,
      pathExclude: args.filter?.pathExclude,
      pathInclude: args.filter?.pathInclude,
      enclosingKind: args.filter?.kind,
      exportedOnly: args.filter?.exportedOnly,
    };
    const scanner = ctx.textScanner ?? createJsScanner();
    const textRoot = ctx.daemon?.root;
    const textCap = sqlMode ? (ctx.tableRowBound ?? TEXT_ONLY_CAP) : TEXT_ONLY_CAP;
    try {
      if (args.symbols !== undefined) {
        const targets: Record<string, JsonValue>[] = [];
        const unresolved: JsonValue[] = [];
        let shownRows = 0;
        let totalRows = 0;
        for (const name of args.symbols) {
          const outcome = ts.findUsages({ name }, options);
          if (typeof outcome === 'string') {
            unresolved.push(tag('unresolved-name', { name, reason: outcome }));
            continue;
          }
          if ('unresolved' in outcome) {
            // By-name targets never carry a rebind (no handle was held), but the type admits
            // it; record the reason in the sectioned `unresolved` list either way.
            unresolved.push(tag('unresolved-name', { name, reason: outcome.unresolved }));
            continue;
          }
          const { view } = outcome;
          shownRows += rowsShown(view);
          totalRows += rowsTotal(view);
          const notes = usageNotes(view, args.role, verbosity);
          const hoisted = hoistView(view, args.role, sqlMode);
          if (hoisted.progNote !== undefined) notes.push(hoisted.progNote);
          targets.push({
            symbol: name,
            ...(view.definition !== undefined ? { definition: view.definition.id } : {}),
            ...(view.mergedDeclarations !== undefined
              ? { mergedDeclarations: view.mergedDeclarations.map((m) => tag('symbol', m)) }
              : {}),
            ...(hoisted.role !== undefined ? { role: hoisted.role } : {}),
            ...(hoisted.allProgram !== undefined ? { allProgram: hoisted.allProgram } : {}),
            ...(hoisted.groups !== undefined
              ? { enclosers: hoisted.groups.map((g) => tag('group-row', g)) }
              : {}),
            ...(hoisted.usages !== undefined
              ? { usages: hoisted.usages.map((u) => tag('usage', u)) }
              : {}),
            total: view.total,
            ...listableField(view),
            ...(view.excluded > 0 ? { excludedByFilter: view.excluded } : {}),
            ...(view.importsCollapsed !== undefined
              ? { importsCollapsed: view.importsCollapsed }
              : {}),
            ...(view.roleBreakdown !== undefined ? { roleBreakdown: view.roleBreakdown } : {}),
            ...(notes.length > 0 ? { notes } : {}),
          });
        }
        let textFailure: ToolFailure | undefined;
        if (args.text === true) {
          const entries = targets.map((t) => ({
            name: t['symbol'] as string,
            target: { name: t['symbol'] as string },
          }));
          const { byName, failure } = await overlayFor(ts, scanner, textRoot, textCap, entries);
          textFailure = failure;
          for (const t of targets) {
            const tally = attachOverlay(t, byName.get(t['symbol'] as string));
            shownRows += tally.shown;
            totalRows += tally.total;
          }
        }
        const data = { targets, ...(unresolved.length > 0 ? { unresolved } : {}) };
        // A capped producer (semantic OR text) feeding NOT IN lies (§2.3) — report the
        // aggregate so sql-batch marks the table partial.
        const truncated =
          totalRows > shownRows
            ? { truncated: { shown: shownRows, total: totalRows, hint: ROW_CAP_HINT } }
            : undefined;
        if (textFailure !== undefined) return partial(data, textFailure);
        return ok(data, truncated);
      }

      const outcome = ts.findUsages(args, options);
      if (typeof outcome === 'string') return fail({ tool: 'ts-ls', message: outcome });
      if ('unresolved' in outcome) {
        // §6: the held handle's symbol is gone — state the structured `{status:'gone'}` on
        // `handle` (empty data), never a guessed rebind to an unrelated same-named symbol.
        return fail({ tool: 'ts-ls', message: outcome.unresolved }, { handle: outcome.rebind });
      }
      const { view, rebind } = outcome;
      let shown = rowsShown(view);
      let total = rowsTotal(view);
      const notes = usageNotes(view, args.role, verbosity);
      // R1 — honest disclosure (§3.6): mergeDeclarations was requested but the target addresses ONE
      // declaration (a SymbolId/position), so it could not apply. Say so instead of silently dropping
      // the flag. (When it DID apply, `view.mergedDeclarations` is present and this never fires.)
      if (args.mergeDeclarations === true && view.mergedDeclarations === undefined) {
        notes.push(
          'mergeDeclarations ignored — a symbol/position target addresses ONE declaration; pass a `name` to union all same-named declarations',
        );
      }
      const hoisted = hoistView(view, args.role, sqlMode);
      if (hoisted.progNote !== undefined) notes.push(hoisted.progNote);
      const data: Record<string, JsonValue> = {
        ...(view.definition !== undefined ? { definition: tag('symbol', view.definition) } : {}),
        ...(view.mergedDeclarations !== undefined
          ? { mergedDeclarations: view.mergedDeclarations.map((m) => tag('symbol', m)) }
          : {}),
        // Hoisted header columns (role / allProgram) precede the row bulk so the verdict reads first.
        ...(hoisted.role !== undefined ? { role: hoisted.role } : {}),
        ...(hoisted.allProgram !== undefined ? { allProgram: hoisted.allProgram } : {}),
        ...(hoisted.groups !== undefined
          ? { enclosers: hoisted.groups.map((g) => tag('group-row', g)) }
          : {}),
        ...(hoisted.usages !== undefined
          ? { usages: hoisted.usages.map((u) => tag('usage', u)) }
          : {}),
        total: view.total,
        // When imports are collapsed in a FLAT usages list, `total` (raw) exceeds the listed set by
        // exactly `importsCollapsed` — surface `listable` so `total=N` ties to the `usages (M):`
        // header and the truncation's `shown X/Y` (Y = listable), instead of two unexplained totals.
        // Gated to flat mode: in groupBy the listed rows are ENCLOSERS (a different axis), so a
        // usages-based `listable` would tie to nothing — omit it there.
        ...listableField(view),
        ...(view.excluded > 0 ? { excludedByFilter: view.excluded } : {}),
        ...(view.importsCollapsed !== undefined ? { importsCollapsed: view.importsCollapsed } : {}),
        ...(view.roleBreakdown !== undefined ? { roleBreakdown: view.roleBreakdown } : {}),
        ...(notes.length > 0 ? { notes } : {}),
      };
      let textFailure: ToolFailure | undefined;
      if (args.text === true) {
        const name = view.definition?.name ?? args.name;
        const entries = name !== undefined ? [{ name, target: args as TsTargetInput }] : [];
        const { byName, failure } = await overlayFor(ts, scanner, textRoot, textCap, entries);
        textFailure = failure;
        if (name !== undefined) {
          const tally = attachOverlay(data, byName.get(name));
          shown += tally.shown;
          total += tally.total;
        }
      }
      const extras = {
        ...(rebind !== undefined ? { handle: rebind } : {}),
        ...(total > shown ? { truncated: { shown, total, hint: ROW_CAP_HINT } } : {}),
      };
      if (textFailure !== undefined) {
        return partial(data, textFailure, rebind !== undefined ? { handle: rebind } : undefined);
      }
      return ok(data, extras);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
