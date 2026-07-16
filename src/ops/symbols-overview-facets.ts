// `symbols_overview` orientation facets (t-960572) — the cheap aggregates derived from the SAME
// no-program syntactic pass the catalogue already runs (no LS warm, no second scan): the kind
// HISTOGRAM and the cross-file COLLISION set. All counts are of the FULL post-filter set (never the
// per-group cap) — capping a count would lie about the repo's size / ambiguity (§3.4).

import type { FileNames } from '../plugins/ts/syntactic-catalogue.ts';

/** Global per-name aggregate over the whole filtered catalogue. `kinds` unions every file's kinds for
 *  the name (a value+type merge counts in BOTH histogram buckets — the disclosed multi-bucket rule);
 *  `realFiles` counts distinct files with a REAL declaration (a barrel `export {X}` re-export is NOT
 *  one), so `realFiles ≥ 2` is a genuine `find_usages {name}`-ambiguity landmine, not a re-export. */
export interface GlobalName {
  kinds: Set<string>;
  realFiles: number;
  realConfigs: Set<string>;
}

/** One cross-file name collision: `count` distinct real-decl files across `configs`. */
export interface Collision {
  name: string;
  count: number;
  configs: string[];
}

/** Fold the per-file catalogue into the global per-name aggregate. `labelOf` maps a file to its
 *  primary tsconfig label (the op's grouping) — used only to attribute a collision's configs. */
export function aggregate(
  files: readonly FileNames[],
  labelOf: (file: string) => string,
): Map<string, GlobalName> {
  const global = new Map<string, GlobalName>();
  for (const { file, names } of files) {
    const label = labelOf(String(file));
    for (const entry of names) {
      let g = global.get(entry.name);
      if (g === undefined)
        global.set(entry.name, (g = { kinds: new Set(), realFiles: 0, realConfigs: new Set() }));
      for (const k of entry.kinds) g.kinds.add(k);
      if (entry.real) {
        g.realFiles++;
        g.realConfigs.add(label);
      }
    }
  }
  return global;
}

/** Multi-bucket kind histogram: for each kind, the number of distinct global names declared with it.
 *  A name with N kinds contributes to N buckets, so buckets may SUM to more than the name-total (the
 *  disclosed rule — no arbitrary "primary kind" tie-break). Sorted count-desc, then kind asc →
 *  deterministic (cold == warm). Empty string when there are no names. */
export function histogramLine(global: Map<string, GlobalName>): string {
  const counts = new Map<string, number>();
  for (const g of global.values()) for (const k of g.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${kind} ${n}`)
    .join(' · ');
}

/** The cross-file collision set (`realFiles ≥ 2`), sorted by count-desc then name — the ambiguous-name
 *  landmines. A single-real-decl name (incl. a barrel re-export, which adds no real decl) is excluded. */
export function collisions(global: Map<string, GlobalName>): Collision[] {
  const out: Collision[] = [];
  for (const [name, g] of global) {
    if (g.realFiles < 2) continue;
    out.push({
      name,
      count: g.realFiles,
      configs: [...g.realConfigs].sort((a, b) => a.localeCompare(b)),
    });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Render a collision to its flat `name ×N (config | config)` token — ` | `-joined configs (config
 *  labels themselves contain `/`, so a `/` separator would be unreadable) with no `, ` so the flat
 *  catalogue's `, ` name-join stays cleanly splittable. */
export function collisionToken(c: Collision): string {
  const where = c.configs.length > 0 ? ` (${c.configs.join(' | ')})` : '';
  return `${c.name} ×${c.count}${where}`;
}
