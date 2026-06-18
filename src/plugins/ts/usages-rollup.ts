// Enclosing-declaration rollup for `find_usages` groupBy:'enclosing' — split from usages.ts
// (300-line cap). Rolls classified reference sites up to their nearest enclosing named declaration
// ("which components render <X>"), aggregating roles, per-ref program provenance (Task G) and merged
// declaration indices (mergeDeclarations, §3.3) per group. Pure over the host; no LS queries here.

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId, moduleName } from './symbol-id.ts';
import { mintEncloserId } from './encloser-id.ts';
import { findEncloser, type UsageRole } from './usage-roles.ts';
import type { GroupRow, UsageOptions } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';

/** One in-scope reference site, classified in pass 1 (role + provenance) before rollup. */
export type Ref = {
  rel: RepoRelPath;
  sourceFile: ts.SourceFile;
  start: number;
  length: number;
  role: UsageRole;
  program: string;
  declIndices?: number[];
};

/** Roll displayed refs up to their nearest enclosing named declaration. Collapse is
 *  already applied to `displayed`, so the synthetic `(top-level X)` module rows for
 *  collapsed import-only refs simply never form (§2.2). `groupTotal` is the distinct
 *  encloser count BEFORE the limit cap; refs failing the kind/exported filter go to
 *  `excluded` via the returned count. */
export function rollupGroups(
  host: TsProjectHost,
  displayed: readonly Ref[],
  options: UsageOptions,
  multiProgram: boolean,
): { groups: GroupRow[]; groupTotal: number; excluded: number } {
  const rollup = new Map<
    string,
    {
      id: string;
      name: string;
      file: RepoRelPath;
      line: number;
      col: number;
      kind: string;
      count: number;
      roles: Set<string>;
      programs: Set<string>;
      decls: Set<number>;
      exported: boolean;
      /** Span of the FIRST reference rolled up here — a representative site inside the
       *  encloser (impact points its value-flow boundary at it). */
      site: Span;
    }
  >();
  let excluded = 0;
  for (const r of displayed) {
    const row = rollupRow(host, r.sourceFile, r.rel, r.start, options);
    if (row === undefined) {
      excluded++;
      continue;
    }
    const existing = rollup.get(row.key);
    if (existing === undefined) {
      rollup.set(row.key, {
        id: row.id,
        name: row.name,
        file: r.rel,
        line: row.line,
        col: row.col,
        kind: row.kind,
        count: 1,
        roles: new Set([r.role]),
        programs: new Set([r.program]),
        decls: new Set(r.declIndices ?? []),
        exported: row.exported,
        site: spanFromRange(r.sourceFile, r.rel, r.start, r.start + r.length),
      });
    } else {
      existing.count++;
      existing.roles.add(r.role);
      existing.programs.add(r.program);
      for (const d of r.declIndices ?? []) existing.decls.add(d);
    }
  }
  const groups = [...rollup.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, options.limit)
    .map((g) => ({
      id: g.id,
      name: g.name,
      file: g.file,
      line: g.line,
      col: g.col,
      kind: g.kind,
      count: g.count,
      roles: [...g.roles].join(','),
      exported: g.exported,
      // LS structural references are certain; flat usages carry the same value.
      confidence: 'certain' as Confidence,
      site: g.site,
      ...(multiProgram ? { programs: [...g.programs].sort().join(',') } : {}),
      ...(g.decls.size > 0 ? { decls: [...g.decls].sort((a, b) => a - b).join(',') } : {}),
    }));
  return { groups, groupTotal: rollup.size, excluded };
}

function rollupRow(
  host: TsProjectHost,
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  position: number,
  options: UsageOptions,
):
  | {
      key: string;
      id: string;
      name: string;
      line: number;
      col: number;
      kind: string;
      exported: boolean;
    }
  | undefined {
  const enc = findEncloser(sourceFile, position);
  const kind = enc?.kind ?? 'module';
  if (options.enclosingKind !== undefined && kind !== options.enclosingKind) return undefined;
  if (options.exportedOnly === true && enc !== undefined && !enc.exported) return undefined;
  if (enc === undefined) {
    const name = moduleName(rel);
    // A module-level rollup is not an exported symbol — `exported: false` lets SQL drop
    // the synthetic `(top-level X)` nodes without a name LIKE-heuristic.
    return {
      key: `${rel}#<module>`,
      id: mintSymbolId(name, rel, 1, 1, host.rootTag),
      name,
      line: 1,
      col: 1,
      kind,
      exported: false,
    };
  }
  // Mint the handle on the BARE name token (`enc.idName`, anchored at `enc.start`) so a
  // class-member encloser's id chains instead of resolving `gone` — the display `name`
  // (`Class.method`) is never the id (§6 / `encloser-id.ts`).
  const { id, line, col } = mintEncloserId(sourceFile, rel, enc.idName, enc.start, host.rootTag);
  return {
    key: `${rel}#${enc.name}#${enc.start}`,
    id,
    name: enc.name,
    line,
    col,
    kind,
    exported: enc.exported,
  };
}
