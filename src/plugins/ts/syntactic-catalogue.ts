// `list_symbols` catalogue engine (t-143952) — the OOM-safe core: enumerate every declared NAME in
// the §10 git-source surface WITHOUT building a program or warming the LS (the whole point — a
// first-contact browse on a huge monorepo is exactly where the name-addressed navto path OOMs,
// t-167395). Rides the SAME no-program surface parse + `getNamedDeclarations` as the fuzzy syntactic
// search (t-515730), so it can neither OOM nor hang. Returns NAMES per file; the op joins them to
// tsconfig membership (config-membership.ts) and formats the flat catalogue.
//
// HONESTY: syntactic = names only, NOT type-verified — a re-export re-mention name may appear
// (disclosed by the op). Scope is the git source surface UNDER the root: an outside-root tsconfig
// include/reference is NOT scanned (t-515730's disclosed limit). Complete for declarations in that
// surface; noisier than a resolved index. `exportedOnly` reads the AST (no checker) — see
// syntactic-nodes.ts `isExportedDeclaration`.

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { passesPathFilter } from '../../common/glob/path-filter.ts';
import type { SyntacticCache } from './syntactic-cache.ts';
import { surfaceSources } from './syntactic-surface.ts';
import {
  isExportedDeclaration,
  isImportSite,
  isMemberDeclaration,
  nodeKindLabel,
} from './syntactic-nodes.ts';

export interface CatalogueFilter {
  /** Keep only TOP-LEVEL declarations whose `nodeKindLabel` equals this (`function`/`class`/
   *  `interface`/`type`/`const`/`let`/`var`/`enum`/`module`). Members (method/getter/setter/property/
   *  enum member) are not catalogued, and `component` is NOT a syntactic kind (needs react semantics)
   *  — an unmatched kind simply yields nothing, disclosed by the op. */
  kind?: string | undefined;
  /** Default TRUE at the op — the public export surface only. `false` (op `all:true`) adds locals. */
  exportedOnly: boolean;
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
}

/** One source file's distinct declared names (already sorted, filtered). The op groups these by the
 *  file's owning tsconfig and dedups globally into the flat catalogue. */
export interface FileNames {
  file: RepoRelPath;
  names: string[];
}

/** Enumerate the catalogue over the parsed §10 surface. A git / @internal-TS failure comes back as a
 *  `ToolFailure` (never a false empty). Deterministic (files sorted, names sorted) → cold == warm. */
export function listCatalogue(
  root: string,
  cache: SyntacticCache,
  filter: CatalogueFilter,
): Result<FileNames[]> {
  const sources = surfaceSources(root, cache);
  if (!isOk(sources)) return fail(sources.failure);
  const out: FileNames[] = [];
  for (const [rel, sf] of sources.data) {
    if (
      !passesPathFilter(rel, { pathInclude: filter.pathInclude, pathExclude: filter.pathExclude })
    )
      continue;
    const names = namesOf(sf, filter);
    if (names.length > 0) out.push({ file: rel, names });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return ok(out);
}

/** Distinct, sorted TOP-LEVEL declared names in one file that pass the kind / exportedOnly filters. */
function namesOf(sf: ts.SourceFile, filter: CatalogueFilter): string[] {
  const decls = (
    sf as unknown as { getNamedDeclarations(): Map<string, readonly ts.Declaration[]> }
  ).getNamedDeclarations();
  const kept = new Set<string>();
  decls.forEach((nodes, name) => {
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
    if (filter.kind !== undefined && !relevant.some((n) => nodeKindLabel(n) === filter.kind))
      return;
    if (filter.exportedOnly && !relevant.some((n) => isExportedDeclaration(n))) return;
    kept.add(name);
  });
  return [...kept].sort((a, b) => a.localeCompare(b));
}
