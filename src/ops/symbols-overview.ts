// `symbols_overview` (t-143952 / t-960572) — a first-contact / orientation browse: dump the flat,
// comma-separated, BARE names of every symbol declared in the repo, grouped per tsconfig, so an agent
// entering an unfamiliar codebase READS the map and picks a name (then a normal search_symbol /
// find_definition on it) instead of throwing guessed names at search_symbol "на бум".
//
// TWO DECOUPLED LAYERS (the design):
//   • CORE — the flat catalogue. Rides the no-program syntactic surface parse (ts.listSymbols): it
//     can neither OOM nor hang, and it NEVER warms the LS. This is the guaranteed answer — exactly
//     where the name-addressed navto path OOMs on a huge monorepo (t-167395).
//   • GROUPING — best-effort per-tsconfig grouping (ts.configMembership). The only tree-walking /
//     glob-expanding part, so the only slow one; it is bounded-by-design and DEGRADES to a single
//     flat `(all)` group on any over-bound / failure (never a hang, never a lie).
//
// ORIENTATION FACETS (t-960572), all derived from the SAME no-program pass (no extra scan, no warm):
//   query (navto fuzzy name filter, BEFORE the per-group cap) · summary/countsOnly (kind histogram +
//   per-config totals of the FULL post-filter set) · duplicatesOnly (cross-file collision landmines)
//   · kind[] (multi-kind) · subgroupByKind (partition each config into kind subsections). Every new
//   facet is OFF by default → the default flat catalogue stays byte-stable.
//
// HONESTY: syntactic = NAMES, not a type-verified index — a re-export name may appear; scope is the
// git source surface UNDER the root (an outside-root include is not covered, t-515730). Every capped
// group carries its `+N more` marker; the summary line states the global totals so even if the format
// char-cap trims a late group's tail, the agent SEES that not-all-is-shown (§3.4).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Truncation } from '../core/result.ts';
import { fail, failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { FileNames } from '../plugins/ts/syntactic-catalogue.ts';
import type { ConfigMembership } from '../plugins/ts/program/config-membership.ts';
import { aggregate, collisions, collisionToken, histogramLine } from './symbols-overview-facets.ts';
import { defineOp } from './registry.ts';

const DEFAULT_PER_GROUP = 300;
const NO_CONFIG = '(no tsconfig)';
const FLAT_GROUP = '(all)';
const COLLISIONS = '(collisions)';

const SYNTACTIC_NOTE =
  'syntactic catalogue (bare NAMES, not a type-verified index): scanned all git-tracked source under the workspace root — complete for declarations there, may include a re-export name; an outside-root tsconfig include/reference is NOT covered. Pick a name → search_symbol / find_definition on it.';
const EXPORTED_ONLY_CAVEAT =
  ' Showing the EXPORTED surface (syntactic, no checker: an export/export-default modifier or a re-export) — pass all:true to add non-exported locals.';
const ALL_NOTE = ' Showing ALL declared names incl non-exported locals (all:true).';
const HISTOGRAM_NOTE =
  ' histogram counts distinct names per-declaration-kind — a value+type merged name (const+type) counts in EACH of its kind buckets, so buckets may sum above the name-total.';
const DUP_NOTE =
  ' duplicatesOnly: only names with a REAL declaration in ≥2 files (a `find_usages {name}` ambiguity landmine) — a barrel re-export is NOT a collision. `name ×N (configs)`.';

const argsSchema = z.strictObject({
  /** Keep only this TOP-LEVEL syntactic kind (function / class / interface / type / const / let / var /
   *  enum / module), or an ARRAY of kinds (matches ANY). Type/class/enum MEMBERS are NOT catalogued;
   *  `component` is NOT available (needs react semantics) — an unmatched kind yields nothing. */
  kind: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
  /** navto fuzzy name filter (prefix / substring / CamelCase-initials), applied BEFORE the per-group
   *  cap — narrows a multi-thousand-name catalogue by NAME. Reuses the syntactic search matcher. */
  query: z.string().min(1).optional(),
  /** Lead with a kind HISTOGRAM + per-config totals of the FULL (uncapped) post-filter set. */
  summary: z.boolean().optional(),
  /** summary + OMIT the names (the shape/size signal alone). Wins over `summary`. */
  countsOnly: z.boolean().optional(),
  /** Only cross-file collision names (`name ×N (configs)`) — the ambiguous-name landmines. Wins over
   *  the normal / subgrouped body. */
  duplicatesOnly: z.boolean().optional(),
  /** Partition each tsconfig group into kind SUBSECTIONS (`config › interface: …`). Off = flat. */
  subgroupByKind: z.boolean().optional(),
  /** Default TRUE — the public export surface only (locals are orientation noise). */
  exportedOnly: z.boolean().optional(),
  /** Sugar for exportedOnly:false — add non-exported locals. Wins if both are set. */
  all: z.boolean().optional(),
  /** Glob(s) over the declaration file — scope to a subtree. `.min(1)`: an empty array matches
   *  nothing, a meaningless intent, so it fails fast rather than reading as absence (parity with `list`). */
  pathInclude: z.array(z.string()).min(1).optional(),
  pathExclude: z.array(z.string()).min(1).optional(),
  /** Per-group name cap (default 300) — even bare names can't dump 30k. The cap returns as a
   *  per-group `+N more` marker + the envelope truncation, never a silent cut (§3.4). */
  limit: z.number().int().positive().max(5000).optional(),
});

type Args = z.infer<typeof argsSchema>;

interface Group {
  names: Set<string>;
  byKind: Map<string, Set<string>>;
  alsoIn: Set<string>;
}

/** The primary tsconfig label a file's names land under (deepest-dir wins; degraded → one flat group). */
function labelForFile(file: string, membership: ConfigMembership, flat: boolean): string {
  if (flat) return FLAT_GROUP;
  return membership.byFile.get(file)?.primary ?? NO_CONFIG;
}

/** Assemble file→names into per-config groups (flat name set + per-kind subsets for subgroupByKind).
 *  Each file's names land under its PRIMARY config only (shared files never double-counted). */
function assemble(
  files: readonly FileNames[],
  membership: ConfigMembership,
  flat: boolean,
): Map<string, Group> {
  const groups = new Map<string, Group>();
  const groupOf = (label: string): Group => {
    let g = groups.get(label);
    if (g === undefined)
      groups.set(label, (g = { names: new Set(), byKind: new Map(), alsoIn: new Set() }));
    return g;
  };
  for (const { file, names } of files) {
    const label = labelForFile(String(file), membership, flat);
    const g = groupOf(label);
    for (const entry of names) {
      g.names.add(entry.name);
      for (const k of entry.kinds) {
        let set = g.byKind.get(k);
        if (set === undefined) g.byKind.set(k, (set = new Set()));
        set.add(entry.name);
      }
    }
    if (!flat) {
      const own = membership.byFile.get(String(file));
      if (own !== undefined) for (const o of own.owners) if (o !== label) g.alsoIn.add(o);
    }
  }
  return groups;
}

/** Real configs alphabetical; `(no tsconfig)` and the flat `(all)` sink to the end. Deterministic. */
function orderLabels(labels: Iterable<string>): string[] {
  const rank = (l: string): number => (l === FLAT_GROUP ? 2 : l === NO_CONFIG ? 1 : 0);
  return [...labels].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Fixed kind order within a config's subsections (count-desc, kind asc) → deterministic. */
function orderKinds(byKind: Map<string, Set<string>>): string[] {
  return [...byKind.keys()].sort(
    (a, b) => (byKind.get(b)?.size ?? 0) - (byKind.get(a)?.size ?? 0) || a.localeCompare(b),
  );
}

/** The ONE `symbol-catalogue-group` row builder — shared by the flat name rows, the kind subsections,
 *  and the collisions section, so every row that reaches `list.symbolCatalogueGroup` carries the SAME
 *  field set (no per-row divergence to drift). Takes ALREADY-SORTED display tokens (the caller owns the
 *  order: alphabetical for names, count-desc for collisions) + the `+N more` parenthetical hint. */
function catalogueRow(
  label: string,
  tokens: readonly string[],
  cap: number,
  alsoIn: readonly string[],
  moreHint: string,
): { shown: number; total: number; row: JsonValue } {
  const total = tokens.length;
  const shown = Math.min(total, cap);
  const row = tag('symbol-catalogue-group', {
    config: label,
    shown,
    total,
    ...(alsoIn.length > 0 ? { alsoIn } : {}),
    ...(total > shown ? { more: `+${total - shown} more (${moreHint})` } : {}),
    names: tokens.slice(0, shown).join(', '),
  });
  return { shown, total, row };
}

/** A flat name group / kind subsection — names sorted alphabetically. */
function nameRow(
  label: string,
  names: Set<string>,
  alsoIn: readonly string[],
  cap: number,
): { shown: number; total: number; row: JsonValue } {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  return catalogueRow(label, sorted, cap, alsoIn, 'narrow by token/path/kind');
}

/** The rendered body rows for the selected mode, plus the running shown/total for the envelope cap. */
function renderBody(
  groups: Map<string, Group>,
  global: ReturnType<typeof aggregate>,
  args: Args,
  cap: number,
): { rows: JsonValue[]; shown: number; total: number } {
  const rows: JsonValue[] = [];
  let shown = 0;
  let total = 0;
  const push = (r: { shown: number; total: number; row: JsonValue }): void => {
    rows.push(r.row);
    shown += r.shown;
    total += r.total;
  };
  if (args.duplicatesOnly === true) {
    // collisions are pre-sorted count-desc → pass tokens through the shared builder without re-sorting.
    const r = catalogueRow(
      COLLISIONS,
      collisions(global).map(collisionToken),
      cap,
      [],
      'raise limit',
    );
    push(r);
    return { rows, shown, total };
  }
  for (const label of orderLabels(groups.keys())) {
    const group = groups.get(label);
    if (group === undefined) continue;
    if (args.subgroupByKind === true) {
      let first = true;
      for (const kind of orderKinds(group.byKind)) {
        const set = group.byKind.get(kind);
        if (set === undefined) continue;
        push(
          nameRow(
            `${label} › ${kind}`,
            set,
            first ? [...group.alsoIn].sort((a, b) => a.localeCompare(b)) : [],
            cap,
          ),
        );
        first = false;
      }
    } else {
      push(
        nameRow(
          label,
          group.names,
          [...group.alsoIn].sort((a, b) => a.localeCompare(b)),
          cap,
        ),
      );
    }
  }
  return { rows, shown, total };
}

export const symbolsOverviewOp = defineOp({
  name: 'symbols_overview',
  summary:
    "Browse the repo's declared symbol NAMES as a flat catalogue (per tsconfig + kind) to orient / discover / match a hunch — NAMES only, no locations, on the OOM-safe no-program syntactic scan (no LS warm). Survey many → pick one → search_symbol / find_definition it. (Want the handle of ONE specific symbol to act on? → search_symbol.)",
  mutating: false,
  requires: ['ts'],
  argsSchema,
  // `name`→`query`: an agent conflating the two spellings (search_symbol canonicalizes on `query`)
  // reaches the fuzzy filter, disclosed via Result.intake; the canonical schema stays the sole gate.
  intake: { aliases: { name: 'query' } },
  argsHint:
    '{ query?: string, kind?: string | string[], summary?: boolean, countsOnly?: boolean, duplicatesOnly?: boolean, subgroupByKind?: boolean, exportedOnly?: boolean, all?: boolean, pathInclude?: string[], pathExclude?: string[], limit?: number }',
  example: { args: { query: 'Clinic', kind: ['interface', 'type'] } },
  notes: [
    'FLAT bare names (no file:line decoration) so thousands fit — scan the list, pick a name, then run search_symbol / find_definition on it. Deduped + sorted per group.',
    'SYNTACTIC (no program build, no LS warm): OOM-safe first-contact browse on a huge monorepo — exactly where the name-addressed path can run out of memory. Names only, NOT type-verified: a re-export name may appear; scope is git-tracked source UNDER the root (an outside-root include is not covered).',
    'grouped per tsconfig (best-effort: degrades to a single flat `(all)` group on a pathological repo). A file included by several configs lands under ONE primary config (deepest-dir wins) — never double-counted — and the group is flagged `(shared: also in …)`.',
    'FACETS: query (navto fuzzy name filter, before the cap) · kind (a kind or a kind[] — matches ANY) · summary/countsOnly (a kind histogram + per-config totals of the FULL uncapped set) · duplicatesOnly (only cross-file collision names, the `find_usages {name}` ambiguity landmines) · subgroupByKind (partition each config into kind subsections). All OFF by default → the flat catalogue is byte-stable. exportedOnly defaults TRUE; all:true adds locals. Each group caps at `limit` (default 300) with a `+N more` marker.',
  ],
  async run(ctx, args: Args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const exportedOnly = args.all === true ? false : (args.exportedOnly ?? true);
      const cap = args.limit ?? DEFAULT_PER_GROUP;
      const catalogue = ts.listSymbols({
        kind: args.kind,
        exportedOnly,
        query: args.query,
        pathInclude: args.pathInclude,
        pathExclude: args.pathExclude,
      });
      if (!catalogue.ok) return fail(catalogue.failure); // honest git / @internal-TS failure — never a false empty

      const membership = ts.configMembership();
      const flat = membership.degraded !== undefined || membership.byFile.size === 0;
      const groups = assemble(catalogue.data, membership, flat);
      const global = aggregate(catalogue.data, (file) => labelForFile(file, membership, flat));

      const wantSummary = args.summary === true || args.countsOnly === true;
      const bodyless = args.countsOnly === true && args.duplicatesOnly !== true;
      const body = bodyless
        ? { rows: [] as JsonValue[], shown: 0, total: 0 }
        : renderBody(groups, global, args, cap);

      const grouping =
        membership.degraded !== undefined
          ? `flat — grouping unavailable: ${membership.degraded}`
          : membership.byFile.size === 0
            ? 'flat — no tsconfig found'
            : 'per-tsconfig';
      let note = SYNTACTIC_NOTE + (exportedOnly ? EXPORTED_ONLY_CAVEAT : ALL_NOTE);
      if (wantSummary) note += HISTOGRAM_NOTE;
      if (args.duplicatesOnly === true) note += DUP_NOTE;

      const histogram = wantSummary ? histogramLine(global) : undefined;
      const byConfig = wantSummary
        ? orderLabels(groups.keys())
            .map((l) => `${l} ${groups.get(l)?.names.size ?? 0}`)
            .join(' · ')
        : undefined;

      const truncated: Truncation | undefined =
        body.total > body.shown
          ? {
              shown: body.shown,
              total: body.total,
              hint: 'raise limit, or narrow by query / kind / pathInclude / pathExclude',
            }
          : undefined;

      return ok(
        {
          // verdict-first (§12): the small load-bearing summary + histogram + note lead so the char-cap
          // can only ever trim the bulky catalogue tail — never these honesty lines.
          summary: `groups: ${groups.size} · names: ${global.size} (per-group cap ${cap})`,
          ...(histogram !== undefined ? { histogram } : {}),
          ...(byConfig !== undefined ? { byConfig } : {}),
          note,
          grouping,
          groups: groups.size,
          names: global.size,
          perGroupCap: cap,
          ...(bodyless ? {} : { catalogue: body.rows }),
        },
        truncated !== undefined ? { truncated } : undefined,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
