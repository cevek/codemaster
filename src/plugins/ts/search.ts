// Workspace symbol search (LS navto provider) — prefix / substring / camelCase-initials, NOT
// arbitrary-subsequence fuzzy (the matcher is the LS's, not ours). One read-side
// query module among definitions/usages/type-expand. Results are proof-carrying SymbolViews
// anchored on the NAME token (where quickInfo/references resolve), with explicit total
// vs shown so a cap never reads as completeness (§3.4).

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import { passesPathFilter } from '../../common/glob/path-filter.ts';
import { coversInRootSurface } from './discovery-prune.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId } from './symbol-id.ts';
import { declarationNodeOf } from './declaration.ts';
import { ALIAS_KIND, type SymbolView } from './query-types.ts';
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
  /** The LS's OWN result cap bit — some program returned a full `limit * 4` page, so navto sorted
   *  and SLICED before we ever saw the rest. This is the truncation our own filters cannot see: TS
   *  ranks by matchKind + name with no case tie-break, so a case-insensitive near-match (`span` for
   *  `Span`) sits in the same `exact` bucket and can push real declarations off the page BEFORE
   *  `nameExact` runs. A consumer that reports a count or an emptiness MUST treat its answer as a
   *  lower bound / an honest "couldn't" when this is set — `total === matches.length` proves
   *  nothing here (§3.4/§3.6). */
  searchTruncated: boolean;
};

export type SearchFilter = {
  kind?: string | undefined;
  exportedOnly?: boolean | undefined;
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
};

/** The extra contract of a name→DECLARATION RESOLVE (`resolveByName` / the §6 rebind), as opposed to
 *  a browse (`search_symbol`). Deliberately NOT part of `SearchFilter`: that type is the public
 *  browse filter (re-exported from `src/index.ts`, and shared with the syntactic search, which
 *  implements none of this) — advertising a field one implementor silently ignores is the §3.6 lie.
 *  `nameExact` is REQUIRED, so ranking can never be requested without the narrowing that bounds what
 *  the ranking retains. */
export type ResolveNarrowing = {
  /** Keep ONLY candidates whose name is exactly this (navto's matcher is fuzzy — prefix / substring
   *  / camelCase). Applied INSIDE the loop, before the view cap and before `total`, so the budget is
   *  spent on the name that was asked for and `total` is the honest count of its declarations — a
   *  post-filter over a fuzzy-capped page silently drops exact matches and miscounts the rest (§3.4). */
  nameExact: string;
  /** Spend the view budget on real declarations before alias (re-export / import) specifiers, so a
   *  barrel chain longer than the budget cannot crowd the declaration out of the answer. */
  preferDeclarations?: boolean | undefined;
};

export function searchSymbols(
  host: TsProjectHost,
  query: string,
  limit: number,
  /** The workspace root — threaded explicitly (the plugin's `root`, the established idiom for every
   *  no-program surface helper) so the t-167395 discovery-prune coverage test measures the git
   *  surface against the SAME root the programs are built with, never an implicit
   *  `getCurrentDirectory()` invariant that a future host refactor could silently invert. */
  root: string,
  filter?: SearchFilter,
  // §12: at `verbosity:'full'` the op asks for a small header-only decl preview per match, so a
  // direct lookup reads the signature without a chained `source`/`find_definition`. OFF by default —
  // list-shaped answers (terse/normal) stay byte-identical, and the extra AST walk is only paid when
  // the agent opted into `full`.
  includeDecl = false,
  /** Present only on a RESOLVE path; a browse leaves navto's own matcher and ranking untouched. */
  narrow?: ResolveNarrowing,
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
  const prefer = narrow?.preferDeclarations === true;
  const eligible: { program: ts.Program; item: ts.NavigateToItem }[] = [];
  const seen = new Set<string>(); // `fileName|textSpan.start` — one declaration counted once
  let total = 0;
  let filteredOutByPath = 0;
  let searchTruncated = false;
  // Discovery pruning (t-167395): when the PRIMARY program already covers the in-root git source
  // surface, every sibling/member program's declarations are a subset (declarations are
  // resolution-independent; dedup below drops the rest anyway) — so navto over the primary alone
  // is byte-identical while skipping the member builds that OOM a loose-root monorepo. All-or-
  // nothing: a proper `references` monorepo's primary does NOT cover → prune nothing → unchanged
  // full fan-out. The prune sits on the name→DECLARATION step only (this navto): under coverage the
  // primary holds every in-root decl, so the resolved set — and resolveByName's ambiguity detection
  // — is identical pruned or not. The decl→USAGE-site fan-out (find_usages) runs via
  // `programsContaining`/`findReferencesAcross`, which are NEVER pruned (§3.4).
  const programs = host.programs();
  const primary = programs[0];
  const active =
    primary !== undefined && programs.length > 1 && coversInRootSurface(programs, host, root)
      ? [primary]
      : programs;
  const navtoBudget = limit * 4;
  for (const p of active) {
    const program = p.getProgram();
    if (program === undefined) continue;
    // Ask for ONE more than we will use: a page of exactly `navtoBudget` is then provably complete,
    // while `budget + 1` proves the LS had more and sliced. Testing `>= budget` instead would stamp
    // an exactly-full page as truncated — a false incompleteness, which is the same class of lie
    // inverted (§3.4/§3.6).
    const items = p.service.getNavigateToItems(query, navtoBudget + 1, undefined, true);
    const kept = items.slice(0, navtoBudget);
    // A cut page only matters for the class of candidate the CALLER asked about. navto sorts by
    // matchKind ascending (exact → prefix → substring → camelCase), so when the last RETAINED item
    // is already past `exact`, every exact-name candidate is on the page and a narrowed resolve is
    // complete no matter how much fuzzy tail was sliced. Reporting that as truncated made a common
    // prefix (200 `SpannerThing`s beside one `Spanner`) refuse an unambiguous rename — a false
    // incompleteness (§3.6), the same lie inverted. A browse has no such class: any cut is a cut.
    if (items.length > navtoBudget && (narrow === undefined || lastIsExact(kept))) {
      searchTruncated = true;
    }
    for (const item of kept) {
      if (item.fileName.includes('/node_modules/')) continue;
      const key = `${item.fileName}|${item.textSpan.start}`;
      if (seen.has(key)) continue;
      if (narrow !== undefined && item.name !== narrow.nameExact) continue;
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
      // Retained in navto order; the view (spans, SymbolId) is built later for the kept slice only,
      // so a large budget costs list-keeping, not AST work. Without re-ranking, retention order IS
      // the spend order — so stop retaining at `limit` and keep only counting (the list never grows
      // with the repo, §1). Re-ranking needs the whole eligible set (a declaration may sit last),
      // which stays bounded by the exact-name filter above and navto's own per-program budget.
      if (prefer || eligible.length < limit) eligible.push({ program, item });
    }
  }
  for (const { program, item } of order(eligible, prefer)) {
    if (views.length >= limit) break; // `total` above keeps counting — a silent cutoff is a lie
    const view = navigateToView(host, program, item, includeDecl);
    if (view !== undefined) views.push(view);
  }
  return { matches: views, total, searchTruncated, ...(pathFiltered ? { filteredOutByPath } : {}) };
}

/** Which eligible candidates the view budget is spent on. Default: navto's own order, unchanged.
 *  With `preferDeclarations`, real declarations are taken BEFORE alias specifiers — a name whose
 *  barrel chain out-numbers the budget would otherwise return an all-alias page with the one
 *  declaration the caller means dropped off the end (unpickable, §3.4). Stable within each group,
 *  so the answer stays deterministic (cold == warm). */
function order<T extends { item: ts.NavigateToItem }>(
  eligible: readonly T[],
  prefer: boolean,
): readonly T[] {
  if (!prefer) return eligible;
  return [...eligible].sort((a, b) => Number(isAliasItem(a.item)) - Number(isAliasItem(b.item)));
}

/** Did the retained page still end inside navto's `exact` bucket? Then the slice may have hidden
 *  exact-name candidates. `matchKind` is navto's own ranking label — the LS sorted by it, so reading
 *  the last item decides the whole page. */
function lastIsExact(kept: readonly ts.NavigateToItem[]): boolean {
  return kept[kept.length - 1]?.matchKind === 'exact';
}

function isAliasItem(item: ts.NavigateToItem): boolean {
  return item.kind === ALIAS_KIND;
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
