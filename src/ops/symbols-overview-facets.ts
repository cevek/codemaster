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

/** Render a collision to its flat `name ×N (A|B)` token — configs referenced by their LEGEND CODE
 *  (`configLegend`), `|`-joined with no `, ` so the flat catalogue's `, ` name-join stays cleanly
 *  splittable. The long config paths live once in the legend, never repeated per collision (§12). */
export function collisionToken(c: Collision, codeOf: Map<string, string>): string {
  // `?? cfg` is a defensive fallback: the legend is a SUPERSET of every shown collision's configs
  // (built from ALL collisions), so a miss is unreachable today — but if a future caller rebuilt the
  // legend from the post-cap subset, this emits the raw label rather than a dangling, unresolvable code.
  const codes = c.configs.map((cfg) => codeOf.get(cfg) ?? cfg);
  const where = codes.length > 0 ? ` (${codes.join('|')})` : '';
  return `${c.name} ×${c.count}${where}`;
}

/** Deterministic spreadsheet-style code for the Nth legend entry: A…Z, then AA, AB, … (0→A). */
function letterCode(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Build the duplicatesOnly config LEGEND: every distinct config label across ALL collisions (a superset
 *  of the shown, post-cap set — so every rendered code always resolves), sorted path-asc → assigned A,
 *  B, C… deterministically (cold == warm). Returns the one-line `A=…, B=…` legend + the code map the
 *  collision tokens reference. No config is dropped — each label appears once in the legend (short form,
 *  as everywhere in the op) instead of repeated inline per collision row. */
export function configLegend(cols: readonly Collision[]): {
  legend: string;
  codeOf: Map<string, string>;
} {
  const configs = [...new Set(cols.flatMap((c) => c.configs))].sort((a, b) => a.localeCompare(b));
  const codeOf = new Map<string, string>();
  const parts: string[] = [];
  configs.forEach((cfg, i) => {
    const code = letterCode(i);
    codeOf.set(cfg, code);
    parts.push(`${code}=${cfg}`);
  });
  return { legend: parts.join(', '), codeOf };
}
