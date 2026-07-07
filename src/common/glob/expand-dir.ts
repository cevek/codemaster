// Bare-directory → prefix expansion for path-filter globs (§3.4 honesty ergonomics). An agent
// naturally passes `pathInclude: ['src/daemon']` meaning "under src/daemon", but a wildcard-less
// glob matches ONLY the exact path `src/daemon` (never a file beneath it), so the filter admits
// zero files and the answer reads as a false empty. So a glob entry with NO glob metacharacter is
// expanded to ALSO match `<entry>/**` — the intended directory-prefix reading — while the original
// entry is kept so an exact FILE path (`src/a.ts`, also wildcard-less) still matches itself. An
// entry that already carries a wildcard is passed through untouched (its author meant it literally).

/** picomatch metacharacters — presence of any means the author wrote an intentional pattern. */
const GLOB_META = /[*?[\]{}()!+@|]/;

/** Expand each wildcard-less entry `X` to `[X, X/**]` (exact-or-under-dir); pass patterned entries
 *  through. Order-preserving, deduped only within a single entry's expansion. */
export function expandDirGlobs(globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    out.push(g);
    if (!GLOB_META.test(g)) {
      // Strip a trailing slash so `src/daemon/` and `src/daemon` expand identically.
      const base = g.endsWith('/') ? g.slice(0, -1) : g;
      if (base.length > 0) out.push(`${base}/**`);
    }
  }
  return out;
}
