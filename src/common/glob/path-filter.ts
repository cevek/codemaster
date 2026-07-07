// The ONE matcher every user-facing pathInclude/pathExclude filter routes through — so a bare
// directory (`src/daemon`) and a literal special-char directory (`src/(auth)`) filter IDENTICALLY
// everywhere (search_symbol, find_usages, find_unused_exports, construction_sites, list, impact).
// A filter that worked in search but silently no-op'd in find_usages (raw `matchesAnyGlob` skips the
// bare-dir expansion) was itself a partial-lie (§3.4) — this chokepoint removes that split.
//
// It is DISTINCT from `matchesAnyGlob` on purpose: the bare-dir expansion + literal-escape
// (`expandDirGlobs`) is correct ONLY for a user path FILTER, never for a tsconfig `include`
// membership glob / entrypoint / locale glob (those are authored patterns — escaping them would
// break `**/*`), so those keep raw `matchesAnyGlob`.

import { matchesAnyGlob } from './match.ts';
import { expandDirGlobs } from './expand-dir.ts';

/** True when `path` matches any path-filter `glob`, applying bare-dir → `/**` expansion and
 *  literal-escaping of glob-special chars (`expandDirGlobs`). The globs are tiny (a handful of
 *  filter entries); re-expanding per call is negligible beside picomatch's own per-call regex
 *  compile that `matchesAnyGlob` already pays. */
export function matchesPathFilter(path: string, globs: readonly string[]): boolean {
  return matchesAnyGlob(path, expandDirGlobs(globs));
}
