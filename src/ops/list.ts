// `list` — the GENERIC registry dispatcher (§11). It owns no domain knowledge: it
// enumerates the registries the active plugins expose (`Plugin.listRegistries`, §5-L2),
// routes a `list {registry}` call to the owning plugin's `list(registry)`, and projects
// the proof-carrying entries. A framework plugin contributes registries by implementing
// the two optional `Plugin` members — NO edit to this op (the react / react-query tracks
// plug in the same way). `requires: []` — the op is always in the catalogue; a registry
// that no active plugin owns returns the honest available-list, never a guess (§3.6).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Plugin } from '../core/plugin.ts';
import type { ListEntry, ListView } from '../core/list.ts';
import type { Truncation } from '../core/result.ts';
import { failFromThrown, ok } from '../common/result/construct.ts';
import { matchesAnyGlob } from '../common/glob/match.ts';
import { tag } from '../common/shape-tag/tag.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

const ROW_CAP_HINT = 'raise limit, or narrow with pathInclude/pathExclude';

/** Path filter over the entry's DECLARATION file (`span.file`), glob-matched — mirrors
 *  `find_usages`'s filter. pathInclude keeps only matching files; pathExclude drops matching
 *  ones; the dropped count is returned so the filter never reads as completeness (§3.4). */
function filterByPath(
  entries: readonly ListEntry[],
  include: readonly string[] | undefined,
  exclude: readonly string[] | undefined,
): { matched: ListEntry[]; excluded: number } {
  if (include === undefined && exclude === undefined) return { matched: [...entries], excluded: 0 };
  const matched = entries.filter((e) => {
    const f = e.span.file;
    if (include !== undefined && !matchesAnyGlob(f, include)) return false;
    if (exclude !== undefined && matchesAnyGlob(f, exclude)) return false;
    return true;
  });
  return { matched, excluded: entries.length - matched.length };
}

/** Fold the op-level `limit` cap with any plugin-reported cap (`view.truncation`, defensive —
 *  no shipping plugin sets it) into ONE honest envelope: `total` is the larger of the two so a
 *  combined cap never under-reports (§3.4). `undefined` when nothing was capped. */
function combineTruncation(
  shown: number,
  matchedTotal: number,
  opCapped: boolean,
  pluginTrunc: ListView['truncation'],
): Truncation | undefined {
  if (opCapped) {
    return { shown, total: Math.max(matchedTotal, pluginTrunc?.total ?? 0), hint: ROW_CAP_HINT };
  }
  return pluginTrunc !== undefined ? { ...pluginTrunc } : undefined;
}

/** Display form of a composite key (`['todos', <dynamic>]` → `todos / <dyn>`) or a plain
 *  name. A dynamic segment is shown as `<dyn>`, never a guessed literal (§3.3). */
function keyDisplay(entry: {
  name?: string;
  segments?: readonly { value?: string; dynamic: boolean }[];
}): string {
  if (entry.name !== undefined) return entry.name;
  const segs = entry.segments ?? [];
  return `[${segs.map((s) => (s.dynamic ? '<dyn>' : (s.value ?? '?'))).join(', ')}]`;
}

/** Compact provenance display, e.g. `heuristic:react`. */
function provDisplay(p: { kind: string; by?: string }): string {
  return p.by !== undefined ? `${p.kind}:${p.by}` : p.kind;
}

/** A JsonValue-safe projection of one `ListEntry` (the core contract carries optional
 *  fields whose `undefined` is not a `JsonValue` — omitted via conditional spread). */
function serializeEntry(e: ListEntry): JsonValue {
  return {
    key: keyDisplay(e),
    kind: e.kind,
    confidence: e.confidence,
    provenance: provDisplay(e.provenance),
    file: e.span.file,
    line: e.span.line,
    col: e.span.col,
    ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.segments !== undefined
      ? {
          segments: e.segments.map((s) => ({
            dynamic: s.dynamic,
            ...(s.value !== undefined ? { value: s.value } : {}),
          })),
        }
      : {}),
    ...(e.detail !== undefined ? { detail: e.detail } : {}),
    proof: { ...e.span },
  };
}

interface ListRow {
  key: string;
  kind?: string;
  name?: string;
  file: string;
  line: number;
  col: number;
  confidence?: string;
  provenance?: string;
  detail?: string;
}

function isRecord(v: JsonValue): v is Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Hoist a column that is CONSTANT across every entry into a header field, dropping it from each row
 *  — `list components` otherwise repeats `· component · heuristic:react` on all 652 rows, pure noise.
 *  `kind`, `provenance`, and `confidence` are hoisted when uniform; `confidence` only when its
 *  uniform value is non-`certain` (a `certain` tail is already invisible, so hoisting it would add
 *  envelope noise for nothing — e.g. ~100 dynamic queryKeys collapse one `allConfidence=unresolved`
 *  instead of `· unresolved` per row). The hoisted value still fills the sql table via the
 *  `allKind`/`allProvenance`/`allConfidence` fallback (listTable.rows). Single-entry answers keep
 *  everything inline (nothing to dedupe). A mixed column stays per-row. */
function hoistUniform(serialized: readonly JsonValue[]): {
  entries: JsonValue[];
  allKind?: string;
  allProvenance?: string;
  allConfidence?: string;
} {
  const rows = serialized.filter(isRecord);
  if (rows.length < 2) return { entries: [...serialized] };
  const uniform = (k: string): string | undefined => {
    const vals = new Set(rows.map((r) => JSON.stringify(r[k])));
    return vals.size === 1 && rows[0]?.[k] !== undefined ? String(rows[0][k]) : undefined;
  };
  const allKind = uniform('kind');
  const allProvenance = uniform('provenance');
  const uniformConf = uniform('confidence');
  const allConfidence =
    uniformConf !== undefined && uniformConf !== 'certain' ? uniformConf : undefined;
  if (allKind === undefined && allProvenance === undefined && allConfidence === undefined)
    return { entries: [...serialized] };
  const entries = rows.map((r) => {
    const o = { ...r };
    if (allKind !== undefined) delete o['kind'];
    if (allProvenance !== undefined) delete o['provenance'];
    if (allConfidence !== undefined) delete o['confidence'];
    return o;
  });
  return {
    entries,
    ...(allKind !== undefined ? { allKind } : {}),
    ...(allProvenance !== undefined ? { allProvenance } : {}),
    ...(allConfidence !== undefined ? { allConfidence } : {}),
  };
}

const listTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'key', type: 'text' },
    { name: 'kind', type: 'text' },
    { name: 'name', type: 'text' },
    { name: 'file', type: 'text' },
    { name: 'line', type: 'int' },
    { name: 'col', type: 'int' },
    { name: 'confidence', type: 'text' },
    { name: 'provenance', type: 'text' },
    { name: 'detail', type: 'text' },
  ],
  rows(data) {
    const d = data as {
      entries?: ListRow[];
      allKind?: string;
      allProvenance?: string;
      allConfidence?: string;
    };
    const entries = d.entries ?? [];
    // kind/provenance/confidence may have been hoisted off the rows (hoistUniform) — fall back to
    // the header value so the sql projection stays complete.
    return entries.map((e): readonly Cell[] => [
      e.key,
      e.kind ?? d.allKind ?? null,
      e.name ?? null,
      e.file,
      e.line,
      e.col,
      e.confidence ?? d.allConfidence ?? null,
      e.provenance ?? d.allProvenance ?? null,
      e.detail ?? null,
    ]);
  },
  notes(data) {
    const d = data as { found?: boolean; registry?: string; available?: string[]; note?: string };
    if (d.found === false) {
      const avail = (d.available ?? []).join(', ') || '(none — no registry-owning plugin active)';
      return [`no such registry '${d.registry ?? ''}' — available: ${avail}`];
    }
    return d.note !== undefined ? [d.note] : [];
  },
};

const argsSchema = z.strictObject({
  registry: z.string(),
  /** Glob(s) over the entry's declaration file — keep only matching entries. `.min(1)`: an empty
   *  array is a meaningless intent (it would match nothing → drop ALL entries), so it fails fast
   *  rather than silently emptying the result. */
  pathInclude: z.array(z.string()).min(1).optional(),
  /** Glob(s) over the entry's declaration file — drop matching entries. `.min(1)` (see pathInclude). */
  pathExclude: z.array(z.string()).min(1).optional(),
  /** Cap the entry set; the cap is reported as truncation, never silent (§3.4). */
  limit: z.number().int().positive().optional(),
});

/** Discover every registry the active plugins own → a `registry → owner` map (first-wins;
 *  a duplicate claim is recorded so a collision is reported, never silently shadowed). */
function discover(
  ids: readonly string[],
  get: (id: string) => Plugin,
): {
  owners: Map<string, Plugin>;
  conflicts: string[];
} {
  const owners = new Map<string, Plugin>();
  const conflicts: string[] = [];
  for (const id of ids) {
    const plugin = get(id);
    for (const reg of plugin.listRegistries?.() ?? []) {
      const prior = owners.get(reg);
      if (prior === undefined) owners.set(reg, plugin);
      else
        conflicts.push(
          `registry '${reg}' claimed by both '${prior.id}' and '${id}' — using '${prior.id}'`,
        );
    }
  }
  return { owners, conflicts };
}

export const listOp = defineOp({
  name: 'list',
  summary:
    'List a named registry (components, hooks, dialogs, routes, queries, …) — routed to the owning plugin',
  mutating: false,
  requires: [],
  argsSchema,
  argsHint: '{ registry: string, pathInclude?: string[], pathExclude?: string[], limit?: number }',
  example: { args: { registry: 'components', pathInclude: ['src/features/**'] } },
  notes: [
    'GENERIC dispatcher: the available registries depend on which plugins are active (a framework plugin contributes its own); `status` is not pre-loaded with them.',
    'an unknown or inactive registry returns the honest available-list, never a guessed result.',
    'entries are proof-carrying (file:line + span); a framework-convention inference carries provenance `heuristic:<plugin>` and a confidence that reflects the underlying fact (a computed value reads `dynamic`, never asserted certain).',
    'density: a column CONSTANT across every entry (kind, provenance, confidence) is stated ONCE as `allKind`/`allProvenance`/`allConfidence` and omitted from each row — read the effective value as `entry.kind ?? allKind`. Confidence is hoisted only when its uniform value is non-`certain` (a `certain` tail is invisible anyway). A mixed answer keeps the column per-row. `available` is shown only when the registry is NOT found (the did-you-mean list).',
    'bounded: limit caps the entry set (the cap returns as truncation `{shown,total,hint}`, never silent); pathInclude/pathExclude are globs over the entry DECLARATION file — dropped entries are reported as `excludedByFilter`, so a filter never reads as completeness. In sql-mode the producer is UNCAPPED (limit ignored — a capped table feeding NOT IN would lie); path filters still apply (an explicit WHERE, not a cap).',
  ],
  table: listTable,
  async run(ctx, args) {
    try {
      const { owners, conflicts } = discover(ctx.plugins.ids, (id) => ctx.plugins.get<Plugin>(id));
      const available = [...owners.keys()].sort();
      const owner = owners.get(args.registry);
      if (owner === undefined || owner.list === undefined) {
        return ok({
          registry: args.registry,
          found: false,
          available,
          entries: [],
          ...(conflicts.length > 0 ? { conflicts } : {}),
        });
      }
      const view: ListView = owner.list(args.registry);
      // Op-level scoping (§5-L3: the entries are materialized in memory, so the path glob + cap run
      // here, never in the plugin). Path filter ALWAYS applies (an explicit WHERE). The user's `limit`
      // is IGNORED in sql-mode — the cap becomes `tableRowBound` (the SAME MAX_TABLE_ROWS the engine
      // enforces), so the op caps exactly where the engine would and reports it (a producer capped
      // BELOW that would feed NOT IN silently short, §11) — mirrors find_usages/importers_of.
      const sqlMode = ctx.tableRowBound !== undefined;
      const { matched, excluded } = filterByPath(view.entries, args.pathInclude, args.pathExclude);
      const cap = sqlMode ? ctx.tableRowBound : args.limit;
      const capped = cap === undefined ? matched : matched.slice(0, cap);
      const opCapped = capped.length < matched.length;
      const hoisted = hoistUniform(capped.map(serializeEntry));
      return ok(
        {
          registry: args.registry,
          found: true,
          owner: owner.id,
          // `available` is the did-you-mean list for an UNKNOWN registry (found:false) — it just
          // restates `status` when the registry WAS found, so it is omitted here (density).
          // Constant-across-all columns stated once here, dropped from every row (a header before
          // the bulk — §12 verdict-before-bulk; the cap can only ever truncate the row tail).
          ...(hoisted.allKind !== undefined ? { allKind: hoisted.allKind } : {}),
          ...(hoisted.allProvenance !== undefined ? { allProvenance: hoisted.allProvenance } : {}),
          ...(hoisted.allConfidence !== undefined ? { allConfidence: hoisted.allConfidence } : {}),
          // Small load-bearing count BEFORE the row bulk (§12) — a filter dropped entries, never silent.
          ...(excluded > 0 ? { excludedByFilter: excluded } : {}),
          entries: hoisted.entries.map((e) => tag('list-entry', e as Record<string, JsonValue>)),
          ...(view.note !== undefined ? { note: view.note } : {}),
          ...(conflicts.length > 0 ? { conflicts } : {}),
        },
        // Fold the op-level cap with any plugin-reported cap onto the canonical §3.4 envelope field,
        // so the renderer shows it and a sql producer marks its table `partial` — never silent.
        ((): { truncated: Truncation } | undefined => {
          const t = combineTruncation(capped.length, matched.length, opCapped, view.truncation);
          return t !== undefined ? { truncated: t } : undefined;
        })(),
      );
    } catch (thrown) {
      return failFromThrown('list', thrown);
    }
  },
});
