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
import { isExportedDeclaration, isImportSite, nodeKindLabel } from './syntactic-nodes.ts';

export interface CatalogueFilter {
  /** Keep only declarations whose `nodeKindLabel` equals this (`function`/`class`/`interface`/
   *  `type`/`const`/`enum`/…). `component` is NOT a syntactic kind (it needs react semantics) — an
   *  unknown kind simply matches nothing, disclosed by the op. */
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

/** Distinct, sorted names declared in one file that pass the kind / exportedOnly filters. A name with
 *  ANY declaration node satisfying the filters is kept once (a name with a const + a type merge, or a
 *  local decl + a separate `export {X}`, appears once). */
function namesOf(sf: ts.SourceFile, filter: CatalogueFilter): string[] {
  const decls = (
    sf as unknown as { getNamedDeclarations(): Map<string, readonly ts.Declaration[]> }
  ).getNamedDeclarations();
  const kept = new Set<string>();
  decls.forEach((nodes, name) => {
    if (kept.has(name)) return;
    for (const node of nodes) {
      // A pure import re-mention is never part of THIS module's declared/exported surface — drop it
      // regardless of `exportedOnly` (it would otherwise pollute the catalogue with imported names).
      if (isImportSite(node)) continue;
      if (filter.kind !== undefined && nodeKindLabel(node) !== filter.kind) continue;
      if (filter.exportedOnly && !isExportedDeclaration(node)) continue;
      kept.add(name);
      break;
    }
  });
  return [...kept].sort((a, b) => a.localeCompare(b));
}
