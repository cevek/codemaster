// `list_symbols` (t-143952) — a first-contact / orientation browse: dump the flat, comma-separated,
// BARE names of every symbol declared in the repo, grouped per tsconfig, so an agent entering an
// unfamiliar codebase READS the map and picks a name (then a normal search_symbol / find_definition
// on it) instead of throwing guessed names at search_symbol "на бум".
//
// TWO DECOUPLED LAYERS (the design):
//   • CORE — the flat catalogue. Rides the no-program syntactic surface parse (ts.listSymbols): it
//     can neither OOM nor hang, and it NEVER warms the LS. This is the guaranteed answer — exactly
//     where the name-addressed navto path OOMs on a huge monorepo (t-167395).
//   • GROUPING — best-effort per-tsconfig grouping (ts.configMembership). The only tree-walking /
//     glob-expanding part, so the only slow one; it is bounded-by-design and DEGRADES to a single
//     flat `(all)` group on any over-bound / failure (never a hang, never a lie).
//
// HONESTY: syntactic = NAMES, not a type-verified index — a re-export name may appear; scope is the
// git source surface UNDER the root (an outside-root include is not covered, t-515730). Every capped
// group carries its `+N more` marker; the top summary line states the global totals so even if the
// format char-cap trims a late group's tail, the agent SEES that not-all-is-shown (§3.4).

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { Truncation } from '../core/result.ts';
import { fail, failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { TsPluginApi } from '../plugins/ts/plugin.ts';
import type { FileNames } from '../plugins/ts/syntactic-catalogue.ts';
import type { ConfigMembership } from '../plugins/ts/program/config-membership.ts';
import { defineOp } from './registry.ts';

const DEFAULT_PER_GROUP = 300;
const NO_CONFIG = '(no tsconfig)';
const FLAT_GROUP = '(all)';

const SYNTACTIC_NOTE =
  'syntactic catalogue (bare NAMES, not a type-verified index): scanned all git-tracked source under the workspace root — complete for declarations there, may include a re-export name; an outside-root tsconfig include/reference is NOT covered. Pick a name → search_symbol / find_definition on it.';
const EXPORTED_ONLY_CAVEAT =
  ' Showing the EXPORTED surface (syntactic, no checker: an export/export-default modifier or a re-export) — pass all:true to add non-exported locals.';
const ALL_NOTE = ' Showing ALL declared names incl non-exported locals (all:true).';

const argsSchema = z.strictObject({
  /** Keep only this syntactic kind: function / class / interface / type / const / let / var / enum /
   *  module / method / getter / setter / property. NOTE `component` is NOT available (it needs react
   *  semantics; the syntactic scan cannot honestly detect it) — an unknown kind matches nothing. */
  kind: z.string().optional(),
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
  alsoIn: Set<string>;
}

/** Assemble file→names into per-config groups. Each file's names land under its PRIMARY config only
 *  (shared files never double-counted); a file under no config → `(no tsconfig)`. When membership is
 *  degraded, ALL names collapse into one flat `(all)` group. */
function assemble(files: readonly FileNames[], membership: ConfigMembership): Map<string, Group> {
  const groups = new Map<string, Group>();
  const groupOf = (label: string): Group => {
    let g = groups.get(label);
    if (g === undefined) groups.set(label, (g = { names: new Set(), alsoIn: new Set() }));
    return g;
  };
  const flat = membership.degraded !== undefined || membership.byFile.size === 0;
  for (const { file, names } of files) {
    if (flat) {
      const g = groupOf(FLAT_GROUP);
      for (const n of names) g.names.add(n);
      continue;
    }
    const own = membership.byFile.get(String(file));
    const label = own?.primary ?? NO_CONFIG;
    const g = groupOf(label);
    for (const n of names) g.names.add(n);
    if (own !== undefined) for (const o of own.owners) if (o !== label) g.alsoIn.add(o);
  }
  return groups;
}

/** Real configs alphabetical; `(no tsconfig)` and the flat `(all)` sink to the end — orientation
 *  reads the real programs first. Deterministic → cold == warm (§16). */
function orderLabels(groups: Map<string, Group>): string[] {
  const rank = (l: string): number => (l === FLAT_GROUP ? 2 : l === NO_CONFIG ? 1 : 0);
  return [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Project one group to its tagged render row, applying the per-group cap. */
function renderGroup(
  label: string,
  g: Group,
  cap: number,
): { shown: number; total: number; row: JsonValue } {
  const sorted = [...g.names].sort((a, b) => a.localeCompare(b));
  const total = sorted.length;
  const shown = Math.min(total, cap);
  const alsoIn = [...g.alsoIn].sort((a, b) => a.localeCompare(b));
  const row = tag('symbol-catalogue-group', {
    config: label,
    shown,
    total,
    ...(alsoIn.length > 0 ? { alsoIn } : {}),
    ...(total > shown ? { more: `+${total - shown} more (narrow by token/path/kind)` } : {}),
    names: sorted.slice(0, shown).join(', '),
  });
  return { shown, total, row };
}

export const listSymbolsOp = defineOp({
  name: 'list_symbols',
  summary:
    "First-contact orientation: a flat, comma-separated catalogue of the repo's declared symbol NAMES, grouped per tsconfig — on the OOM-safe no-program syntactic scan (no LS warm)",
  mutating: false,
  requires: ['ts'],
  argsSchema,
  argsHint:
    '{ kind?: string, exportedOnly?: boolean, all?: boolean, pathInclude?: string[], pathExclude?: string[], limit?: number }',
  example: { args: { kind: 'function', pathInclude: ['src/**'] } },
  notes: [
    'FLAT bare names (no file:line decoration) so thousands fit — scan the list, pick a name, then run search_symbol / find_definition on it. Deduped + sorted per group.',
    'SYNTACTIC (no program build, no LS warm): OOM-safe first-contact browse on a huge monorepo — exactly where the name-addressed path can run out of memory. Names only, NOT type-verified: a re-export name may appear; scope is git-tracked source UNDER the root (an outside-root include is not covered).',
    'grouped per tsconfig (best-effort: the grouping layer degrades to a single flat `(all)` group on a pathological repo). A file included by several configs lands under ONE primary config (deepest-dir wins) — never double-counted — and the group is flagged `(shared: also in …)`.',
    'exportedOnly defaults TRUE (public surface); all:true adds non-exported locals. kind filters a syntactic kind (function/class/interface/type/const/enum/…); `component` is NOT available (needs react semantics). Each group caps at `limit` (default 300) with a `+N more` marker; the summary line states global totals.',
  ],
  async run(ctx, args: Args) {
    const ts = ctx.plugins.get<TsPluginApi>('ts');
    try {
      const exportedOnly = args.all === true ? false : (args.exportedOnly ?? true);
      const cap = args.limit ?? DEFAULT_PER_GROUP;
      const catalogue = ts.listSymbols({
        kind: args.kind,
        exportedOnly,
        pathInclude: args.pathInclude,
        pathExclude: args.pathExclude,
      });
      if (!catalogue.ok) return fail(catalogue.failure); // honest git / @internal-TS failure — never a false empty

      const membership = ts.configMembership();
      const groups = assemble(catalogue.data, membership);
      const globalNames = new Set<string>();
      for (const g of groups.values()) for (const n of g.names) globalNames.add(n);

      const rows: JsonValue[] = [];
      let shownSum = 0;
      let totalSum = 0;
      for (const label of orderLabels(groups)) {
        const group = groups.get(label);
        if (group === undefined) continue;
        const { shown, total, row } = renderGroup(label, group, cap);
        rows.push(row);
        shownSum += shown;
        totalSum += total;
      }

      const grouping =
        membership.degraded !== undefined
          ? `flat — grouping unavailable: ${membership.degraded}`
          : membership.byFile.size === 0
            ? 'flat — no tsconfig found'
            : 'per-tsconfig';
      const note = SYNTACTIC_NOTE + (exportedOnly ? EXPORTED_ONLY_CAVEAT : ALL_NOTE);

      const truncated: Truncation | undefined =
        totalSum > shownSum
          ? {
              shown: shownSum,
              total: totalSum,
              hint: 'raise limit, or narrow by kind / pathInclude / pathExclude',
            }
          : undefined;

      return ok(
        {
          // verdict-first (§12): the small load-bearing summary + note lead so the char-cap can only
          // ever trim the bulky catalogue tail — never these honesty lines.
          summary: `groups: ${rows.length} · names: ${globalNames.size} (per-group cap ${cap})`,
          note,
          grouping,
          groups: rows.length,
          names: globalNames.size,
          perGroupCap: cap,
          catalogue: rows,
        },
        truncated !== undefined ? { truncated } : undefined,
      );
    } catch (thrown) {
      return failFromThrown('ts-ls', thrown);
    }
  },
});
