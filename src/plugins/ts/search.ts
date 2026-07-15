// Workspace symbol search (LS navto provider) — prefix / substring / camelCase-initials, NOT
// arbitrary-subsequence fuzzy (the matcher is the LS's, not ours). One read-side
// query module among definitions/usages/type-expand. Results are proof-carrying SymbolViews
// anchored on the NAME token (where quickInfo/references resolve), with explicit total
// vs shown so a cap never reads as completeness (§3.4).

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import { passesPathFilter } from '../../common/glob/path-filter.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId } from './symbol-id.ts';
import { declarationNodeOf } from './declaration.ts';
import type { SymbolView } from './query-types.ts';
import type { TsProjectHost } from './ls-host.ts';

export type SearchView = {
  matches: SymbolView[];
  /** Eligible matches seen (post node_modules filter) — may exceed `matches.length`
   *  when the cap hit; the op surfaces that as explicit truncation (§3.4). The LS
   *  itself was asked for a bounded set, so this is a floor, not a guess. */
  total: number;
  /** Query+kind+export matches that were dropped SOLELY by pathInclude/pathExclude. Present only
   *  when a path filter was set. On `matches.length === 0` with this > 0, the empty answer is a
   *  self-defeating FILTER, not a symbol absence — the op surfaces that as a verdict-first note so
   *  a false "no such symbol" is never read (§3.4). Distinguishes a real typo'd path (matches
   *  nothing → note fires) from a genuine no-such-symbol (this is 0 → honest absence). Like `total`
   *  it is a navto-budget-bounded FLOOR (navto runs before the path filter), never over-reported. */
  filteredOutByPath?: number;
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
  // §12: at `verbosity:'full'` the op asks for a small header-only decl preview per match, so a
  // direct lookup reads the signature without a chained `source`/`find_definition`. OFF by default —
  // list-shaped answers (terse/normal) stay byte-identical, and the extra AST walk is only paid when
  // the agent opted into `full`.
  includeDecl = false,
): SearchView {
  // Across ALL loaded programs (spec Task G): a symbol DECLARED only in a sibling-program file (a
  // `test/**` helper under `tsconfig.test.json`) is invisible to the primary navto — so a name-
  // addressed `find_usages`/`find_definition` would falsely report "no symbol named". Union navto
  // over every program and dedup by declaration site (a symbol in a shared src file appears in
  // several programs). excludeDtsFiles: with it off, the LS spends the whole budget on lib.d.ts /
  // node_modules declarations and a small limit comes back EMPTY after our filter (an honest-
  // looking lie); project-local .d.ts symbols are out of search scope for now (Phase 3 schema).
  // A wildcard-less path entry (`src/daemon`) is expanded to ALSO match `src/daemon/**` — the
  // intended directory-prefix reading — so a bare dir isn't a self-defeating filter; an exact FILE
  // path still matches itself, a patterned entry is untouched (§3.4 ergonomics, expand-dir.ts).
  const include = filter?.pathInclude;
  const exclude = filter?.pathExclude;
  const pathFiltered = include !== undefined || exclude !== undefined;
  const views: SymbolView[] = [];
  const seen = new Set<string>(); // `fileName|textSpan.start` — one declaration counted once
  let total = 0;
  let filteredOutByPath = 0;
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
      // A query+kind+export candidate — counted exactly once (dedup by declaration site). The path
      // filter then routes it to `matches` or the dropped tally, so a self-defeating path filter is
      // observable (an empty `matches` with `filteredOutByPath > 0` is a filter miss, not absence).
      seen.add(key);
      const rel = host.relOf(item.fileName);
      const droppedByPath = !passesPathFilter(rel, { pathInclude: include, pathExclude: exclude });
      if (droppedByPath) {
        filteredOutByPath++;
        continue;
      }
      total++;
      if (views.length >= limit) continue; // keep counting — a silent cutoff is a lie
      const view = navigateToView(host, program, item, includeDecl);
      if (view !== undefined) views.push(view);
    }
  }
  return { matches: views, total, ...(pathFiltered ? { filteredOutByPath } : {}) };
}

function navigateToView(
  host: TsProjectHost,
  program: ts.Program,
  item: ts.NavigateToItem,
  includeDecl: boolean,
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
  const decl = includeDecl ? declHeaderSpan(sourceFile, rel, item.textSpan.start) : undefined;
  return {
    id: mintSymbolId(item.name, rel, span.line, span.col, host.rootTag),
    name: item.name,
    kind: item.kind,
    span,
    ...(decl !== undefined ? { decl } : {}),
    ...(item.containerName !== '' ? { container: item.containerName } : {}),
  };
}

/** A small HEADER-only preview span for the enclosing declaration at `namePos` — the first
 *  physical line (the signature), NOT the whole body (that is `source`/`find_definition`). When
 *  the declaration continues past that line the span is marked `elided:true` so the truncation is
 *  explicit (§3.4) — never an unmarked partial in `SymbolView.decl`, whose findDefinitions producer
 *  carries the FULL body. `undefined` when no declaration node encloses the name (a name-span
 *  fallback carries no useful preview). */
function declHeaderSpan(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  namePos: number,
): SymbolView['decl'] {
  const declNode = declarationNodeOf(sourceFile, namePos);
  if (declNode === undefined) return undefined;
  const start = declNode.getStart(sourceFile);
  const declEnd = declNode.getEnd();
  const nl = sourceFile.text.indexOf('\n', start);
  let end = nl === -1 ? declEnd : Math.min(declEnd, nl);
  if (end > start && sourceFile.text.charCodeAt(end - 1) === 13) end -= 1; // trim a CRLF '\r'
  const span = spanFromRange(sourceFile, rel, start, end);
  const more = declEnd > end; // the declaration body continues below the first line
  return more || span.elided === true ? { ...span, elided: true } : span;
}
