// `search_symbol` — LS workspace symbol search (the navto provider: prefix / substring /
// camelCase-initials, NOT arbitrary-subsequence fuzzy — see the op note).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { fail, failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { SymbolView } from '../plugins/ts/query-types.ts';
import { defineOp } from './registry.ts';
import { undiscoveredHint } from './no-symbol-hint.ts';
import { fileModuleHint } from './search-file-hint.ts';
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
  /** Opt-in cheap discovery for very large monorepos. `true` switches from the precise LS navto
   *  provider to a raw AST scan (no type-check, no program build → survives/avoids OOM): COMPLETE
   *  for declarations in git-tracked source UNDER the workspace root (≥ the default's recall there),
   *  but NOISIER (extra import / re-export sites; real declarations ranked first) and NOT
   *  byte-identical to the LS. A tsconfig include/reference reaching OUTSIDE the root is NOT scanned —
   *  use the default for those. Use it if a default call fails or times out; drop it for the exact
   *  result. Default OFF (precise). */
  syntactic: z.boolean().optional(),
  /** Override the pre-warm size guard (t-333163): on a very large repo the default (navto) path
   *  refuses to warm the LS (OOM / memory-squat risk) and redirects; `force:true` warms anyway.
   *  Ignored on the `syntactic` path (already no-warm). Default OFF. */
  force: z.boolean().optional(),
});

/** The pre-warm size guard's refuse message (§1 never-crash / resource-respect): honest about WHY
 *  (OOM + throwaway memory) and actionable (the three no-warm / opt-in escapes). */
function sizeGuardRefusal(count: number, threshold: number): string {
  return (
    `repo is large (${count} source files > threshold ${threshold}) — a repo-wide navto search over ` +
    `this many files risks OOM (can kill the daemon) and holds large type-checker memory for a ` +
    `throwaway discovery query. Browse via symbols_overview, then find_definition / find_usages on the ` +
    `specific symbol; or search_symbol {syntactic:true} for an OOM-safe fuzzy search; or pass ` +
    `force:true to warm anyway.`
  );
}

/** Guardrail 4 (t-515730): every syntactic-path answer states its provenance and does NOT claim to
 *  match the LS provider. Positive scope (§3.6 report-capability), never "may have missed": states
 *  exactly what WAS scanned (all git-tracked source under the root) and the one thing that was not
 *  (an outside-root include/reference). Leads the result (verdict-first, §12). */
const SYNTACTIC_NOTE =
  'syntactic scan (NOT the LS navto provider): scanned all git-tracked source under the workspace root — complete for declarations there, plus extra import/re-export sites (real declarations ranked first); not byte-identical to the LS. A tsconfig include/reference reaching OUTSIDE the root is not covered — use the default (navto) search for those.';

/** `exportedOnly` on the syntactic path is a SYNTACTIC approximation (no checker): it drops import
 *  re-mentions and keeps export-specifiers + real declarations, but cannot tell a non-exported local
 *  `const` from an exported one — so it OVER-includes (superset-safe), never misses an export.
 *  Disclosed so an agent never reads it as the LS's precise export set (t-926410). */
const EXPORTED_ONLY_CAVEAT =
  ' exportedOnly is best-effort here (syntactic, no checker): it keeps all real declarations, so a non-exported local may appear — never a missed export.';

/** Project the syntactic SearchView into the op result — same table/tag shape as the navto path,
 *  but always carrying the provenance note (guardrail 4) and honest truncation (§3.4). */
function syntacticResult(
  view: { matches: SymbolView[]; total: number; filteredOutByPath?: number },
  query: string,
  exportedOnly: boolean,
  // Lazy: the file/module hint is computed ONLY on a genuine absence (not the path-filter self-defeat),
  // so the extra git listing is never paid on a hit or a filter miss.
  fileHint: () => string,
) {
  const { matches, total, filteredOutByPath } = view;
  const baseNote = exportedOnly ? SYNTACTIC_NOTE + EXPORTED_ONLY_CAVEAT : SYNTACTIC_NOTE;
  if (matches.length === 0) {
    // The syntactic scan covers all git-tracked source UNDER the root, so an empty result is a
    // genuine absence THERE (no undiscovered-program floor) — but an outside-root include is not
    // scanned, so disclose it (positive scope, §3.6). A path filter self-defeat is distinct (§3.4).
    const note =
      filteredOutByPath !== undefined && filteredOutByPath > 0
        ? `no matches under the path filter — ${filteredOutByPath} symbol(s) matched '${query}' but pathInclude/pathExclude excluded them all — NOT a symbol absence`
        : `no symbols matching '${query}'${fileHint()} in git-tracked source under the workspace root. ${baseNote}`;
    return ok({ note, matches: [] });
  }
  return ok(
    { note: baseNote, matches: matches.map((m) => tag('symbol', m)) },
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
}

export const searchSymbolOp = defineOp({
  name: 'search_symbol',
  summary:
    'Find symbols by (fuzzy) name across the workspace; returns SymbolIds to chain into other ops. One known target → a handle to chain. (Just browsing what EXISTS, not resolving one? → symbols_overview.)',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint:
    '{ query: string, limit?, kind?: string, exportedOnly?: boolean, pathExclude?: string[], pathInclude?: string[], syntactic?: boolean, force?: boolean }',
  // §7 Postel: the op-map advertises this op as "fuzzy-find a symbol BY NAME", so `name` is the
  // intuitive-but-wrong spelling of the canonical `query` (the single most-recurring dogfood
  // friction). Aliased, disclosed via Result.intake; the canonical schema stays the sole gate.
  intake: { aliases: { name: 'query' } },
  example: {
    args: { query: 'Dialog', kind: 'function', exportedOnly: true, pathExclude: ['**/ui/**'] },
  },
  notes: [
    'matches the LS workspace-symbol provider — prefix / substring / camelCase-initials (e.g. "fC" → formatCurrency), NOT arbitrary subsequence ("frmtCurncy" finds nothing); returns chainable SymbolIds. Narrow with kind / exportedOnly / pathInclude / pathExclude.',
    // §11: this hint MUST live in the static schema/notes — after an in-process OOM the daemon is
    // DEAD and cannot say "retry with the flag" post-hoc (t-515730). Actionable without the agent
    // knowing the isolation mode.
    'on very large monorepos the precise (default) search can be memory-heavy; if a call fails or times out, retry with `syntactic:true` — a cheap AST scan (no type-check, no program build): complete for declarations in git-tracked source under the workspace root, but noisier (extra import/re-export sites; definitions ranked first), not identical to the LS provider, and it does NOT cover a tsconfig include/reference reaching outside the root (use the default for those).',
    // t-333163: the default path pre-checks the source-file count and REFUSES to warm the LS above a
    // configurable threshold (config `ts.searchWarmMaxFiles`, default 4000) — warming a huge fan-out
    // risks OOM and squats memory for a throwaway query. The refusal redirects to symbols_overview /
    // `syntactic:true`; `force:true` warms anyway. Advertised so the behaviour is not a surprise.
    'on a repo above `ts.searchWarmMaxFiles` (default 4000 source files) the default path REFUSES to warm (OOM/memory-squat risk) and redirects to symbols_overview or `syntactic:true`; pass `force:true` to warm regardless.',
  ],
  table: searchSymbolTable,
  async run(ctx, args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      // sql-mode (§2.3): the engine threads MAX_TABLE_ROWS so a NOT IN sees every match;
      // `total > matches.length` below still reports truncation, marking the table partial.
      const limit = ctx.tableRowBound ?? args.limit ?? 25;
      const filter = {
        kind: args.kind,
        exportedOnly: args.exportedOnly,
        pathExclude: args.pathExclude,
        pathInclude: args.pathInclude,
      };
      // Opt-in cheap discovery path (t-515730): a raw AST scan, no program build. Complete for
      // declarations in git-tracked source UNDER the root (outside-root includes disclosed, not
      // scanned); the default navto path below is byte-identical at terse/normal (full attaches the
      // opt-in decl preview, below). A git / @internal-TS failure comes back as an honest ToolFailure
      // — passed through, never a false empty (§3.6).
      // §12: the small header-only decl preview per match is opt-in at `verbosity:'full'` — a direct
      // lookup then reads the signature without a chained `source`/`find_definition`. terse/normal
      // stay byte-identical (no `decl` populated), and the extra AST walk is only paid on `full`.
      const includeDecl = ctx.flags.verbosity === 'full';
      if (args.syntactic === true) {
        const res = ts.searchSymbolSyntactic(args.query, limit, filter);
        if (!res.ok) return fail(res.failure);
        return syntacticResult(res.data, args.query, args.exportedOnly === true, () =>
          fileModuleHint(args.query, ts.filesNamed(args.query)),
        );
      }
      // Pre-warm size guard (t-333163): BEFORE the navto path warms the LS, cheaply estimate the
      // fan-out surface; over the threshold, refuse + redirect instead of warming (an OOM on the
      // in-process daemon is uncatchable; even in process-mode the warmed program squats memory for
      // a throwaway query). `syntactic` (above) and `force` bypass. An estimate FAILURE (git hiccup)
      // falls THROUGH to warm — the guard is an optimization, not a correctness gate, so a git error
      // must not over-refuse a legitimate search.
      if (args.force !== true) {
        const estimate = ts.estimateSourceFileCount();
        if (estimate.ok && estimate.data > ts.searchWarmMaxFiles) {
          return fail({
            tool: 'size-guard',
            message: sizeGuardRefusal(estimate.data, ts.searchWarmMaxFiles),
          });
        }
      }
      const { matches, total, filteredOutByPath } = ts.searchSymbol(
        args.query,
        limit,
        filter,
        includeDecl,
      );
      if (matches.length === 0) {
        // §3.4: a path filter that excluded every match is a self-defeating FILTER, not a symbol
        // absence — say so, so an agent never reads the empty answer as "no such symbol". A bare
        // dir is already auto-expanded to a prefix, so this fires on a genuine path miss (a typo).
        const note =
          filteredOutByPath !== undefined && filteredOutByPath > 0
            ? `no matches under the path filter — ${filteredOutByPath} symbol(s) matched '${args.query}' but pathInclude/pathExclude excluded them all; check the path (a bare dir is auto-expanded to a prefix; a path with glob-special chars like ()@! may need escaping) — NOT a symbol absence`
            : // §3.4: a genuine no-match, but a name declared only under an unloaded nested tsconfig
              // would read the same — append the NAMED unloaded configs (empty on a clean single-repo).
              // Orthogonally, the name may be a FILE not a symbol — append the file/module hint too.
              `no symbols matching '${args.query}'` +
              fileModuleHint(args.query, ts.filesNamed(args.query)) +
              undiscoveredHint(ts.undiscoveredProgramLabels());
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
