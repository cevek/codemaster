// Pure view-shaping helpers for `find_usages` (split out to keep the op under the line cap):
// target-element classification, the row-count axis, the density hoists (constant columns lifted
// to headers), and the advisory notes. No I/O, no plugin calls — they reshape a `UsagesView` for
// rendering. The op (find-usages.ts) owns dispatch; these own presentation.

import type { JsonValue } from '../core/json.ts';
import type { TsTargetInput } from '../plugins/ts/plugin.ts';
import type { GroupRow, UsageView, UsagesView } from '../plugins/ts/query-types.ts';
import { classifyTargetString } from './intake/smart-string.ts';

/** Classify a `symbols[]` element into the canonical target it denotes — a `ts:` SymbolId, a
 *  `file:line[:col]` position, or a bare name — so a held SymbolId in the array resolves exactly
 *  as the single-target `symbolId` form does (§7 Postel), not as a literal name. Mirrors the
 *  single-target intake; the array elements are never touched by the dispatcher normalizer. */
export function targetOfElement(s: string): TsTargetInput {
  const c = classifyTargetString(s);
  switch (c.kind) {
    case 'symbolId':
      return { symbolId: c.symbolId };
    case 'location':
      return c.col !== undefined
        ? { file: c.file, line: c.line, col: c.col }
        : { file: c.file, line: c.line };
    case 'name':
      return { name: c.name };
  }
}

// Row dimension of the TABLE projection: usages in flat mode, enclosers in grouped mode.
// `total` is the pre-cap count, so `total > shown` is the producer's own truncation — the
// signal sql-batch turns into a `partial` table (a capped table feeding NOT IN lies, §2.3).
export function rowsShown(view: UsagesView): number {
  return view.groups?.length ?? view.usages?.length ?? 0;
}
export function rowsTotal(view: UsagesView): number {
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
export function listableField(view: UsagesView): Record<string, JsonValue> {
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

export type Hoisted = {
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
export function hoistView(view: UsagesView, role: string | undefined, sqlMode: boolean): Hoisted {
  if (sqlMode) return { usages: view.usages, groups: view.groups };
  let { usages, groups } = view; // both narrowed/hoisted below
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
export function usageNotes(
  view: UsagesView,
  role: string | undefined,
  verbosity: string,
): string[] {
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
