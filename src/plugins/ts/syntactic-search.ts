// `search_symbol { syntactic: true }` — a raw AST symbol scan that answers WITHOUT building a
// TypeScript program (so it survives / avoids the multi-program navto OOM on huge monorepos,
// t-515730 / t-167395). Same declaration set (`getNamedDeclarations`) + same matcher
// (`createPatternMatcher` — bundled TS, project-agnostic) as navto, but WITHOUT navto's
// checker-based include/dedup — so it also surfaces the extra import / re-export re-mention sites
// navto folds away. "Not identical to the LS" = NOISIER + our own ranking, NEVER "may miss a symbol
// declared under the root" (guardrail 1).
//
// HONEST SCOPE (t-515730 BLOCK 1): the scan surface is the §10 git source surface UNDER the
// workspace root — every git-tracked source file (incl. submodules) plus untracked-not-ignored
// files. It is COMPLETE for declarations in that surface, but a tsconfig `include`/`reference`
// reaching OUTSIDE the root (e.g. `../shared`) is NOT scanned (a git listing at the root cannot see
// above it, and resolving which configs escape the root is program-discovery, out of this path's
// scope). navto DOES follow such includes — so for an outside-root symbol the default (navto) search
// is the complete one. The result note + the op schema/notes state this positively ("scanned all
// git-tracked source under <root>; outside-root include/reference not covered — use the default"),
// never "may have missed" (§3.6 report-capability).
//
// HONESTY (mechanics):
//  - no program is built and the LS never warms — the caller's plugin stays cold (asserted in tests).
//  - the parsed surface is cached (syntactic-cache.ts) keyed on a repo-state fingerprint the
//    SYNTACTIC path can trust (projectVersion can't — see that module). The HOT path is
//    O(changed+untracked), never a per-query whole-surface stat-walk (§1 hang-class); a re-parse
//    happens only on drift. Always current, so cold == warm (asserted with an untracked
//    add→modify→remove invalidation test).
//  - the @internal TS helpers are capability-guarded: if a TS bump ever drops them the path fails
//    with an honest ToolFailure, never a crash or a guessed empty (§3.6 / never-crash).
//  - every site carries provenance:'syntactic' + a name-token proof span; ranking puts real
//    declarations first so the result cap shows definitions and import noise falls into the
//    honest `… N more` tail (guardrail 5).

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { passesPathFilter } from '../../common/glob/path-filter.ts';
import { spanFromRange } from './spans.ts';
import { deriveRootTag, mintSymbolId } from './symbol-id.ts';
import type { SyntacticCache, SyntacticSources } from './syntactic-cache.ts';
import { surfaceSources } from './syntactic-surface.ts';
import { createPatternMatcher, type PatternMatcher } from './syntactic-matcher.ts';
import { isImportSite, isRealDeclaration, nameAnchor, nodeKindLabel } from './syntactic-nodes.ts';
import type { SearchFilter, SearchView } from './search.ts';
import type { SymbolView } from './query-types.ts';

// ── @internal TS surface (the ONE documented boundary) ───────────────────────────────────────
// `getNamedDeclarations` (below) and `createPatternMatcher` (syntactic-matcher.ts — shared with the
// `list_symbols` catalogue filter) are TS `@internal` (absent from the public typescript.d.ts) but
// are pure, project-agnostic functions navto itself is built on — reusing them is what guarantees
// identical recall (proven: 0 misses vs navto under-root over 25 queries × 2 repos). This is NOT a
// second parser or a standalone structural index ahead of the LS (the §4a concern): both helpers run
// on the SAME `ts.createSourceFile` AST, syntactic-only, and this path is an opt-in fallback populated
// only on `syntactic:true` — so it is only a note about @internal-API stability (distinct from the
// §4/§14 TS-fork edit-producer exception). Typed via a single boundary block of `as unknown as` casts
// (never `any`); their presence is capability-checked once so a TS bump that drops them fails
// honestly, and a shape drift is caught by the oracle test.
interface SourceFileNamedDecls {
  getNamedDeclarations(): Map<string, readonly ts.Declaration[]>;
}
function namedDeclarations(sf: ts.SourceFile): Map<string, readonly ts.Declaration[]> {
  return (sf as unknown as SourceFileNamedDecls).getNamedDeclarations();
}

/** One-shot capability probe (memoized): both @internal helpers must exist on the bundled TS, or the
 *  syntactic path is unavailable and fails honestly rather than crashing (§3.6 / never-crash). */
let capability: boolean | undefined;
function capabilityAvailable(): boolean {
  if (capability !== undefined) return capability;
  try {
    const hasMatcher =
      typeof (ts as unknown as { createPatternMatcher?: unknown }).createPatternMatcher ===
      'function';
    const probe = ts.createSourceFile('__probe.ts', 'export const x = 1;', ts.ScriptTarget.Latest);
    const hasDecls =
      typeof (probe as unknown as { getNamedDeclarations?: unknown }).getNamedDeclarations ===
      'function';
    capability = hasMatcher && hasDecls;
  } catch {
    capability = false;
  }
  return capability;
}

interface Match {
  view: SymbolView;
  isReal: boolean;
  matchKind: number;
}

export function searchSymbolsSyntactic(
  root: string,
  query: string,
  limit: number,
  filter: SearchFilter | undefined,
  cache: SyntacticCache,
): Result<SearchView> {
  if (!capabilityAvailable()) {
    return fail({
      tool: 'ts-internal',
      message:
        'the bundled TypeScript lacks the @internal getNamedDeclarations/createPatternMatcher — the syntactic scan is unavailable; use the default (navto) search',
    });
  }
  const matcher = createPatternMatcher(query);
  if (matcher === undefined) {
    // An empty/degenerate pattern (schema already enforces min length 1) — an honest empty, never a guess.
    return ok(emptyView(filter));
  }
  const sources = surfaceSources(root, cache);
  if (!isOk(sources)) return fail(sources.failure);
  return ok(searchOverSources(sources.data, deriveRootTag(root), matcher, limit, filter));
}

function searchOverSources(
  sources: SyntacticSources,
  rootTag: string,
  matcher: PatternMatcher,
  limit: number,
  filter: SearchFilter | undefined,
): SearchView {
  const include = filter?.pathInclude;
  const exclude = filter?.pathExclude;
  const pathFiltered = include !== undefined || exclude !== undefined;
  const matches: Match[] = [];
  const seen = new Set<string>(); // `rel|offset` — one declaration site counted once
  let filteredOutByPath = 0;
  for (const [rel, sf] of sources) {
    collectFromFile(sf, rel, rootTag, matcher, filter, seen, matches, (dropped) => {
      if (dropped) filteredOutByPath++;
    });
  }
  matches.sort(compareMatches);
  const total = matches.length;
  const views = matches.slice(0, limit).map((m) => m.view);
  return { matches: views, total, ...(pathFiltered ? { filteredOutByPath } : {}) };
}

function emptyView(filter: SearchFilter | undefined): SearchView {
  const pathFiltered = filter?.pathInclude !== undefined || filter?.pathExclude !== undefined;
  return { matches: [], total: 0, ...(pathFiltered ? { filteredOutByPath: 0 } : {}) };
}

function collectFromFile(
  sf: ts.SourceFile,
  rel: RepoRelPath,
  rootTag: string,
  matcher: PatternMatcher,
  filter: SearchFilter | undefined,
  seen: Set<string>,
  out: Match[],
  onDropped: (dropped: boolean) => void,
): void {
  const decls = namedDeclarations(sf);
  decls.forEach((nodes, name) => {
    const match = matcher.getMatchForLastSegmentOfPattern(name);
    if (match === undefined) return;
    const matchKind = match.kind;
    for (const node of nodes) {
      const anchor = nameAnchor(node, sf);
      const key = `${rel}|${anchor}`;
      if (seen.has(key)) continue;
      const kind = nodeKindLabel(node);
      if (filter?.kind !== undefined && filter.kind !== kind) continue;
      const real = isRealDeclaration(node);
      // `exportedOnly` best-effort: drop pure IMPORT re-mentions (never an export), but KEEP
      // export-specifiers (`export {X}` — genuine exports navto returns under exportedOnly) and real
      // decls. A non-exported LOCAL real decl is over-included (superset-safe noise) rather than risk
      // dropping a genuinely-exported one — a miss under a filter is worse than noise. The op
      // discloses this as best-effort; precise export detection is a filed follow-up (t-926410).
      if (filter?.exportedOnly === true && isImportSite(node)) continue;
      seen.add(key);
      if (
        !passesPathFilter(rel, {
          pathInclude: filter?.pathInclude,
          pathExclude: filter?.pathExclude,
        })
      ) {
        onDropped(true);
        continue;
      }
      const span = spanFromRange(sf, rel, anchor, anchor + name.length);
      out.push({
        view: {
          id: mintSymbolId(name, rel, span.line, span.col, rootTag),
          name,
          kind,
          span,
          provenance: 'syntactic',
        },
        isReal: real,
        matchKind,
      });
    }
  });
}

function compareMatches(a: Match, b: Match): number {
  if (a.isReal !== b.isReal) return a.isReal ? -1 : 1; // real declarations first
  if (a.matchKind !== b.matchKind) return a.matchKind - b.matchKind; // exact > prefix > substring > camelCase
  const byFile = a.view.span.file.localeCompare(b.view.span.file);
  if (byFile !== 0) return byFile; // stable, deterministic order (§16)
  return a.view.span.line - b.view.span.line;
}
