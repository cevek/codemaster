// `impact` — type-aware blast radius (read-only, §17 Phase 5). "If I change X, what
// transitively depends on it?" — the bounded transitive closure of dependents, computed
// as a BFS over `find_usages` (encloser rollup → those enclosers' usages → …). Composed
// at the op level over the ts plugin's public API; adds no plugin capability (§5-L3).
//
// Honesty (the prime risk for THIS op — §1 "impact is the prime unbounded-traversal
// risk"): a HARD depth cap AND a global node cap bound every traversal; a truncated
// closure is flagged `!!` and never reads as complete. A value-flow escape (a callable
// target read as a value, where dynamic dispatch could carry impact past what find_usages
// sees) is flagged `dynamic` and NOT bridged — the closure is reported PARTIAL (§3.3).
// Filters (kind/path/exported) are a PROJECTION over the complete closure, never a pruner
// of the walk (pruning would hide transitive dependents — the under-report direction). The
// traversal invariants live in ./impact-closure.ts (pure, independently tested).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Result } from '../core/result.ts';
import { failFromThrown, fail, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { matchesAnyGlob } from '../common/glob/match.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { GroupRow, UsageOptions } from '../plugins/ts/query-types.ts';
import { omitGroupSite } from '../plugins/ts/group-row.ts';
import { defineOp } from './registry.ts';
import { TS_TARGET_HINT, requireTarget, tsTargetShape, tsTargetIntake } from './ts-target.ts';
import { buildClosure, type ClosureResult, type Expand } from './impact-closure.ts';
import { outcomeFromView } from './impact-expand.ts';

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 12;
const DEFAULT_NODES = 200;
const MAX_NODES = 2000;

const argsSchema = z
  .strictObject({
    ...tsTargetShape,
    /** Transitive depth to walk (default 3). Bounded — a deep closure is the prime
     *  never-hang risk (§1); the node cap is the harder bound. */
    depth: z.number().int().min(1).max(MAX_DEPTH).optional(),
    /** Global cap on total dependents across all depths (default 200). The true never-hang
     *  guard: total LS work is `nodes × find_usages`. */
    nodes: z.number().int().min(1).max(MAX_NODES).optional(),
    /** Keep only dependents whose enclosing declaration is this kind
     *  (function | method | class | const | variable | module). A VIEW — never prunes the
     *  traversal. */
    kind: z.string().optional(),
    /** Keep only exported dependents (a view). */
    exportedOnly: z.boolean().optional(),
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
    /** Counts-per-depth only — gauge the blast radius without the node list. */
    summary: z.boolean().optional(),
  })
  .refine(requireTarget.predicate, { message: requireTarget.message });

type ImpactArgs = z.infer<typeof argsSchema>;

/** A dependent passes the display filters? Applied to the COMPLETE closure (a view), so a
 *  hidden node never prunes the walk that found nodes beyond it. */
function passesFilter(row: GroupRow, args: ImpactArgs): boolean {
  if (args.kind !== undefined && row.kind !== args.kind) return false;
  if (args.exportedOnly === true && !row.exported) return false;
  if (args.pathInclude !== undefined && !matchesAnyGlob(row.file, args.pathInclude)) return false;
  if (args.pathExclude !== undefined && matchesAnyGlob(row.file, args.pathExclude)) return false;
  return true;
}

/** Compose the load-bearing honesty notes (§12 verdict-before-bulk: these precede the node
 *  list, so a truncated render can only ever drop the re-fetchable bulk, never the caps). */
function impactNotes(
  closure: ClosureResult,
  maxDepth: number,
  maxNodes: number,
  excluded: number,
  shown: number,
  total: number,
): string[] {
  const notes: string[] = [];
  if (closure.capped?.by === 'nodes') {
    notes.push(
      `!! reached node cap (${maxNodes}) — dependent set INCOMPLETE (${closure.capped.boundaryNodes} node(s) left un-expanded); raise nodes: or narrow with kind/path filters.`,
    );
  } else if (closure.capped?.by === 'depth') {
    notes.push(
      `!! reached depth cap (${maxDepth}) — ${closure.capped.boundaryNodes} boundary node(s) not expanded; raise depth: to walk deeper.`,
    );
  }
  if (closure.hubTruncated) {
    notes.push(
      `!! a hub had more direct dependents than the per-query cap (${maxNodes}) — some dependents omitted; narrow with kind/path filters.`,
    );
  }
  if (closure.unexpandable > 0) {
    notes.push(
      `!! ${closure.unexpandable} dependent(s) could not be re-expanded (module-level rollups / unresolved ids reached by a value or call) — their transitive dependents are NOT included; closure may be incomplete.`,
    );
  }
  if (closure.dynamicBoundaries.length > 0) {
    notes.push(
      `closure PARTIAL: ${closure.dynamicBoundaries.length} value-flow boundary(ies) — a callable target is read as a value (possible dynamic dispatch); consumers reached dynamically are NOT traversed (see dynamicBoundaries).`,
    );
  }
  if (excluded > 0) {
    notes.push(
      `${excluded} dependent(s) hidden by your kind/path/exported filter (shown ${shown}/${total}); the closure itself is unaffected by the filter.`,
    );
  }
  return notes;
}

/** Project the closure into the verdict-first envelope: identity → summary → caps/partial
 *  notes → dynamic boundaries → the dependents-by-depth bulk (omitted under `summary`). The
 *  summary describes the COMPLETE closure; filters only shrink the bulk listing (a view). */
function shape(
  target: { id: string; name: string; kind: string },
  closure: ClosureResult,
  args: ImpactArgs,
  maxDepth: number,
  maxNodes: number,
): JsonValue {
  const byDepth: Record<string, number> = {};
  let reached = 0;
  for (const n of closure.nodes) {
    const d = String(n.depth);
    byDepth[d] = (byDepth[d] ?? 0) + 1;
    if (n.depth > reached) reached = n.depth;
  }

  const displayed = closure.nodes.filter((n) => passesFilter(n.row, args));
  const total = closure.nodes.length;
  // The filter shapes the (omitted-under-summary) dependents LISTING. Under `summary:true`
  // there is no listing to reconcile a "shown X/Y" against, so the filter-hidden note and
  // the `shown` field are suppressed — the summary reports the full-closure risk profile.
  const excluded = args.summary === true ? 0 : total - displayed.length;

  const notes = impactNotes(closure, maxDepth, maxNodes, excluded, displayed.length, total);
  const boundaries = closure.dynamicBoundaries.map((b) => {
    // Point at the exact value-read TOKEN (`encloser.site`, captured during rollup) rather
    // than the encloser's name — a tighter proof of where dispatch could escape. Falls back
    // to the encloser span when no site was captured (always present for a real ref).
    const at = b.encloser.site ?? {
      file: b.encloser.file,
      line: b.encloser.line,
      col: b.encloser.col,
    };
    return `${at.file}:${at.line}:${at.col} · ${b.encloser.name} reads ${b.readsAsValue} as a value (roles=${b.encloser.roles})`;
  });

  const dependents: Record<string, GroupRow[]> = {};
  if (args.summary !== true) {
    // Strip the internal `site` span (it only fed the precise boundary above) — a per-row
    // span across the whole closure would bloat the listing for no agent-facing gain.
    for (const n of displayed)
      (dependents[String(n.depth)] ??= []).push(tag('group-row', omitGroupSite(n.row)));
    // Sort each depth bucket by fan-in (count desc) — proximity across depths, fan-in within.
    for (const rows of Object.values(dependents)) rows.sort((a, b) => b.count - a.count);
  }

  const complete =
    closure.capped === undefined &&
    closure.dynamicBoundaries.length === 0 &&
    !closure.hubTruncated &&
    closure.unexpandable === 0;

  return {
    target: tag('target-ref', target),
    summary: {
      depth: reached,
      dependents: total,
      ...(excluded > 0 ? { shown: displayed.length } : {}),
      complete,
      byDepth,
    },
    ...(notes.length > 0 ? { notes } : {}),
    ...(boundaries.length > 0 ? { dynamicBoundaries: boundaries } : {}),
    ...(args.summary !== true ? { dependents } : {}),
  };
}

export const impactOp = defineOp({
  name: 'impact',
  summary:
    'Type-aware blast radius: the bounded transitive set of dependents of a symbol (BFS over find_usages), proof-carrying, depth/node-capped',
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint: `${TS_TARGET_HINT} — plus { depth?: 1-${MAX_DEPTH} (default ${DEFAULT_DEPTH}), nodes?: 1-${MAX_NODES} (default ${DEFAULT_NODES}), kind?, exportedOnly?, pathInclude?, pathExclude?, summary?: boolean }`,
  intake: tsTargetIntake,
  example: { args: { name: 'createEngine', depth: 2 } },
  notes: [
    'bounded BFS over find_usages: who transitively depends on the target (encloser rollup → those enclosers’ usages → …). Each dependent is a chainable SymbolId, grouped by its SHALLOWEST depth (proximity), sorted by fan-in within a depth.',
    'HARD bounds (never-hang): a depth cap AND a global node cap (total work = nodes × find_usages). Hitting either — or a dependent that cannot be re-expanded (a module-level rollup) — is flagged `!!`; a truncated closure NEVER reads as complete.',
    'value-flow boundary: a dependent that reads a callable target as a VALUE (not call/jsx) is where dynamic dispatch can carry impact past what find_usages sees — flagged `dynamic`, NOT traversed, the closure reported PARTIAL (never silently bridged).',
    'summary:true returns counts-per-depth only (gauge risk without the node list). kind/path/exportedOnly are a VIEW over the complete closure (they shrink the listing, never the walk); hidden counts are surfaced.',
  ],
  async run(ctx, args): Promise<Result<JsonValue>> {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    const maxDepth = args.depth ?? DEFAULT_DEPTH;
    const maxNodes = args.nodes ?? DEFAULT_NODES;
    // Traverse UNFILTERED — filters are applied as a projection in `shape` so a hidden node
    // never prunes the walk. `limit` = the global node cap so one hub can't blow the budget.
    const options: UsageOptions = { limit: maxNodes, groupBy: 'enclosing' };
    try {
      // Resolve the target once (+ surface a §6 rebind) and read its definition — the BFS
      // seed and the identity the closure is reported for.
      const seed = ts.findUsages(args, options);
      if (typeof seed === 'string') return fail({ tool: 'ts-ls', message: seed });
      if ('unresolved' in seed) {
        return fail({ tool: 'ts-ls', message: seed.unresolved }, { handle: seed.rebind });
      }
      const def = seed.view.definition;
      if (def === undefined) {
        return fail({
          tool: 'ts-ls',
          message: 'could not resolve a definition to compute impact for',
        });
      }

      // The seed's own expansion is already in `seed.view` — memoize it so the BFS never
      // re-queries the target (a redundant call, and a fragile round-trip through its id).
      // Deeper frontier nodes are re-queried by their chainable SymbolId; a node whose id no
      // longer resolves is a dead-end the closure counts (`unexpandable`), never fatal.
      const seedExpansion = outcomeFromView(seed.view);
      const expand: Expand = (id) => {
        if (id === def.id) return seedExpansion;
        const outcome = ts.findUsages({ symbolId: id }, options);
        if (typeof outcome === 'string' || 'unresolved' in outcome) return { ok: false };
        return outcomeFromView(outcome.view);
      };

      const closure = buildClosure({ id: def.id, name: def.name }, expand, { maxDepth, maxNodes });
      const data = shape(
        { id: def.id, name: def.name, kind: def.kind },
        closure,
        args,
        maxDepth,
        maxNodes,
      );
      const extras = seed.rebind !== undefined ? { handle: seed.rebind } : undefined;
      return ok(data, extras);
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
