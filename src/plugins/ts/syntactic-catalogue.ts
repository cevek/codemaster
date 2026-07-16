// `list_symbols` catalogue engine (t-143952 / t-960572) — the OOM-safe core: enumerate every declared
// NAME in the §10 git-source surface WITHOUT building a program or warming the LS (the whole point — a
// first-contact browse on a huge monorepo is exactly where the name-addressed navto path OOMs,
// t-167395). Rides the SAME no-program surface parse + `getNamedDeclarations` as the fuzzy syntactic
// search (t-515730), and shares its `createPatternMatcher` (syntactic-matcher.ts) for the `query`
// fuzzy filter — so it can neither OOM nor hang. Returns per file each name's KINDS + whether it has a
// real declaration; the op joins them to tsconfig membership (config-membership.ts), builds the kind
// histogram + cross-file collision set, and formats the flat catalogue.
//
// HONESTY: syntactic = names only, NOT type-verified — a re-export re-mention name may appear
// (disclosed by the op). Scope is the git source surface UNDER the root: an outside-root tsconfig
// include/reference is NOT scanned (t-515730's disclosed limit). Complete for declarations in that
// surface; noisier than a resolved index. `exportedOnly` reads the AST (no checker) — see
// syntactic-nodes.ts `isExportedDeclaration`. `query` reuses navto's own matcher, applied to each
// parsed name BEFORE the op's per-group cap, so a narrowed catalogue is still capped-with-honesty.

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { passesPathFilter } from '../../common/glob/path-filter.ts';
import type { SyntacticCache } from './syntactic-cache.ts';
import { surfaceSources } from './syntactic-surface.ts';
import { createPatternMatcher, type PatternMatcher } from './syntactic-matcher.ts';
import {
  isExportedDeclaration,
  isImportSite,
  isMemberDeclaration,
  isRealDeclaration,
  nodeKindLabel,
} from './syntactic-nodes.ts';

export interface CatalogueFilter {
  /** Keep only TOP-LEVEL declarations whose `nodeKindLabel` is (one of) this (`function`/`class`/
   *  `interface`/`type`/`const`/`let`/`var`/`enum`/`module`). An ARRAY matches ANY listed kind.
   *  Members (method/getter/setter/property/enum member) are not catalogued, and `component` is NOT a
   *  syntactic kind (needs react semantics) — an unmatched kind simply yields nothing, disclosed by
   *  the op. */
  kind?: string | readonly string[] | undefined;
  /** Default TRUE at the op — the public export surface only. `false` (op `all:true`) adds locals. */
  exportedOnly: boolean;
  /** navto fuzzy name filter (prefix / substring / CamelCase). Applied per parsed name. */
  query?: string | undefined;
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
}

/** One source file's distinct declared names with each name's top-level KIND(s) and whether it has a
 *  real (non re-export) declaration here. The op groups these by the file's owning tsconfig, dedups
 *  globally into the flat catalogue, builds the kind histogram, and flags cross-file collisions. */
export interface NamedEntry {
  name: string;
  /** Distinct top-level kinds for this name in this file (a name may value+type merge). */
  kinds: string[];
  /** Does this name have a REAL declaration here (vs only an `export {X}` re-export specifier)? Two
   *  distinct real-decl files = a genuine collision (a barrel re-export is NOT one). */
  real: boolean;
}
export interface FileNames {
  file: RepoRelPath;
  names: NamedEntry[];
}

/** True when `label` is (one of) the kind filter — a scalar equals, an array membership. */
function kindMatches(label: string, kind: string | readonly string[] | undefined): boolean {
  if (kind === undefined) return true;
  return typeof kind === 'string' ? label === kind : kind.includes(label);
}

/** Enumerate the catalogue over the parsed §10 surface. A git / @internal-TS failure comes back as a
 *  `ToolFailure` (never a false empty) — including a `query` whose @internal matcher is unavailable.
 *  Deterministic (files sorted, names sorted) → cold == warm. */
export function listCatalogue(
  root: string,
  cache: SyntacticCache,
  filter: CatalogueFilter,
): Result<FileNames[]> {
  // Build the fuzzy matcher ONCE (never per file). A `query` set but the @internal matcher missing (a
  // TS bump) is an honest failure, never a silently-unfiltered dump.
  let matcher: PatternMatcher | undefined;
  if (filter.query !== undefined) {
    matcher = createPatternMatcher(filter.query);
    if (matcher === undefined) {
      return fail({
        tool: 'ts-internal',
        message:
          'the bundled TypeScript lacks the @internal createPatternMatcher — the `query` fuzzy filter is unavailable; drop `query` or narrow by kind / pathInclude',
      });
    }
  }
  const sources = surfaceSources(root, cache);
  if (!isOk(sources)) return fail(sources.failure);
  const out: FileNames[] = [];
  for (const [rel, sf] of sources.data) {
    if (
      !passesPathFilter(rel, { pathInclude: filter.pathInclude, pathExclude: filter.pathExclude })
    )
      continue;
    const names = namesOf(sf, filter, matcher);
    if (names.length > 0) out.push({ file: rel, names });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return ok(out);
}

/** Distinct, sorted TOP-LEVEL declared names in one file that pass the kind / exportedOnly / query
 *  filters, each carrying its kind(s) + real-decl flag. */
function namesOf(
  sf: ts.SourceFile,
  filter: CatalogueFilter,
  matcher: PatternMatcher | undefined,
): NamedEntry[] {
  const decls = (
    sf as unknown as { getNamedDeclarations(): Map<string, readonly ts.Declaration[]> }
  ).getNamedDeclarations();
  const kept: NamedEntry[] = [];
  decls.forEach((nodes, name) => {
    // navto fuzzy filter first (cheap reject) — reuses the search path's matcher for identical recall.
    if (matcher !== undefined && matcher.getMatchForLastSegmentOfPattern(name) === undefined)
      return;
    // Consider only TOP-LEVEL declaration nodes for this name: drop pure import re-mentions (an
    // imported name is not THIS module's surface) and type/class/enum MEMBERS (sub-symbols — the
    // orientation catalogue lists the container, not its methods; a member also never carries an
    // export modifier, so under the default exportedOnly an advertised member `kind` would return a
    // confident empty — a §3.4 lie).
    const relevant = nodes.filter((n) => !isImportSite(n) && !isMemberDeclaration(n));
    if (relevant.length === 0) return;
    // Evaluate `kind` and `exportedOnly` across the name's whole node SET, not one node: a name
    // exported by a SEPARATE statement (`const Foo = 1; export { Foo }`) carries its kind on the decl
    // node and its export on the export-specifier node — requiring ONE node to satisfy BOTH silently
    // dropped it under a `kind` filter (a §3.4 completeness lie on the common barrel/re-export idiom).
    if (
      filter.kind !== undefined &&
      !relevant.some((n) => kindMatches(nodeKindLabel(n), filter.kind))
    )
      return;
    if (filter.exportedOnly && !relevant.some((n) => isExportedDeclaration(n))) return;
    // Kinds for the histogram: the name's top-level kinds, intersected with an active `kind` filter so
    // the histogram reflects the FILTERED view (a name kept via its `interface` node under
    // kind:['interface'] does not also count under a co-declared `const`).
    const allKinds = new Set(relevant.map((n) => nodeKindLabel(n)));
    const kinds = [...allKinds]
      .filter((k) => kindMatches(k, filter.kind))
      .sort((a, b) => a.localeCompare(b));
    kept.push({ name, kinds, real: relevant.some((n) => isRealDeclaration(n)) });
  });
  return kept.sort((a, b) => a.name.localeCompare(b.name));
}
