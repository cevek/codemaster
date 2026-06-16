// Workspace symbol search (LS navto provider) — prefix / substring / camelCase-initials, NOT
// arbitrary-subsequence fuzzy (the matcher is the LS's, not ours). One read-side
// query module among definitions/usages/type-expand. Results are proof-carrying SymbolViews
// anchored on the NAME token (where quickInfo/references resolve), with explicit total
// vs shown so a cap never reads as completeness (§3.4).

import type ts from 'typescript';
import { matchesAnyGlob } from '../../common/glob/match.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId } from './symbol-id.ts';
import type { SymbolView } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';

export type SearchView = {
  matches: SymbolView[];
  /** Eligible matches seen (post node_modules filter) — may exceed `matches.length`
   *  when the cap hit; the op surfaces that as explicit truncation (§3.4). The LS
   *  itself was asked for a bounded set, so this is a floor, not a guess. */
  total: number;
};

export type SearchFilter = {
  kind?: string | undefined;
  exportedOnly?: boolean | undefined;
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
};

export function searchSymbols(
  host: TsProjectHost,
  query: string,
  limit: number,
  filter?: SearchFilter,
): SearchView {
  // Across ALL loaded programs (spec Task G): a symbol DECLARED only in a sibling-program file (a
  // `test/**` helper under `tsconfig.test.json`) is invisible to the primary navto — so a name-
  // addressed `find_usages`/`find_definition` would falsely report "no symbol named". Union navto
  // over every program and dedup by declaration site (a symbol in a shared src file appears in
  // several programs). excludeDtsFiles: with it off, the LS spends the whole budget on lib.d.ts /
  // node_modules declarations and a small limit comes back EMPTY after our filter (an honest-
  // looking lie); project-local .d.ts symbols are out of search scope for now (Phase 3 schema).
  const views: SymbolView[] = [];
  const seen = new Set<string>(); // `fileName|textSpan.start` — one declaration counted once
  let total = 0;
  for (const p of host.programs()) {
    const program = p.getProgram();
    if (program === undefined) continue;
    for (const item of p.service.getNavigateToItems(query, limit * 4, undefined, true)) {
      if (item.fileName.includes('/node_modules/')) continue;
      const key = `${item.fileName}|${item.textSpan.start}`;
      if (seen.has(key)) continue;
      if (filter?.kind !== undefined && item.kind !== filter.kind) continue;
      if (filter?.exportedOnly === true && !item.kindModifiers.split(',').includes('export')) {
        continue;
      }
      const rel = host.relOf(item.fileName);
      if (filter?.pathExclude !== undefined && matchesAnyGlob(rel, filter.pathExclude)) continue;
      if (filter?.pathInclude !== undefined && !matchesAnyGlob(rel, filter.pathInclude)) continue;
      seen.add(key);
      total++;
      if (views.length >= limit) continue; // keep counting — a silent cutoff is a lie
      const view = navigateToView(host, program, item);
      if (view !== undefined) views.push(view);
    }
  }
  return { matches: views, total };
}

function navigateToView(
  host: TsProjectHost,
  program: ts.Program,
  item: ts.NavigateToItem,
): SymbolView | undefined {
  const sourceFile = program.getSourceFile(item.fileName);
  if (sourceFile === undefined) return undefined;
  const rel = host.relOf(item.fileName);
  // navto's textSpan covers the whole declaration (`export function …`); anchor the
  // SymbolId and span on the NAME token instead — that's where quickInfo/references
  // resolve, and where the §6 same-symbol check (`text.startsWith(name, offset)`)
  // must look.
  const declText = sourceFile.text.slice(
    item.textSpan.start,
    item.textSpan.start + item.textSpan.length,
  );
  const nameIdx = declText.indexOf(item.name);
  const nameStart = nameIdx >= 0 ? item.textSpan.start + nameIdx : item.textSpan.start;
  const span = spanFromRange(sourceFile, rel, nameStart, nameStart + item.name.length);
  return {
    id: mintSymbolId(item.name, rel, span.line, span.col, host.rootTag),
    name: item.name,
    kind: item.kind,
    span,
    ...(item.containerName !== '' ? { container: item.containerName } : {}),
  };
}
