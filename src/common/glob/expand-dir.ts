// Bare-directory → prefix expansion for path-filter globs (§3.4 honesty ergonomics). An agent
// naturally passes `pathInclude: ['src/daemon']` meaning "under src/daemon", but a wildcard-less
// glob matches ONLY the exact path `src/daemon` (never a file beneath it), so the filter admits
// zero files and the answer reads as a false empty. So a glob entry with NO glob metacharacter is
// expanded to ALSO match `<entry>/**` — the intended directory-prefix reading — while the original
// entry is kept so an exact FILE path (`src/a.ts`, also wildcard-less) still matches itself.
//
// The metacharacter split is the subtle part. Only `*?[]{}` are UNAMBIGUOUS wildcards — an entry
// carrying one is an intentional pattern, passed through verbatim (its author meant `**/*.test.*`
// literally). The extglob/regex-group chars `()!+@|` are AMBIGUOUS: a literal directory name can
// contain them (a Next.js route group `src/(auth)`, a scoped dir `src/@scope`, `src/a+b`), yet
// picomatch would mis-read them as a regex group / extglob and match NOTHING — a dir with no working
// path-filter incantation (t-310874). So an entry with such chars but NO true wildcard is treated as
// a LITERAL path: its glob-special chars are picomatch-ESCAPED before both the literal match and the
// `/**` expansion, so it matches the real path. (Cost: a genuine extglob written WITHOUT a `*?[]{}` —
// `src/@(a|b)` — is now read literally; that trade favors the far-commoner literal-dir case, and the
// honesty note still fires when a filter matches nothing.)

/** True glob wildcards — presence of any means the author wrote an intentional pattern (verbatim). */
const TRUE_WILDCARD = /[*?[\]{}]/;
/** Glob metacharacters picomatch interprets; escaped when an entry is treated as a literal path. */
const GLOB_SPECIAL = /[\\^$.*+?()[\]{}|!@]/g;

/** Backslash-escape every glob metacharacter in `literal` so picomatch matches it as plain text
 *  (never `/`, which stays a path separator). The inverse of pattern-authoring — NOT hand-rolled
 *  glob semantics (match.ts's rule), just neutralizing picomatch's own metacharacters. */
export function escapeGlobLiteral(literal: string): string {
  return literal.replace(GLOB_SPECIAL, '\\$&');
}

/** Expand each wildcard-less entry `X` to `[escaped(X), escaped(X)/**]` (exact-or-under-dir);
 *  pass entries carrying a true wildcard through verbatim. Order-preserving. */
export function expandDirGlobs(globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    if (TRUE_WILDCARD.test(g)) {
      out.push(g); // an intentional pattern — verbatim, no escape, no expansion
      continue;
    }
    // A literal path/dir (possibly with ambiguous `()@!+|` chars): escape then expand.
    const base = g.endsWith('/') ? g.slice(0, -1) : g; // `src/daemon/` ≡ `src/daemon`
    const escaped = escapeGlobLiteral(base);
    out.push(escaped);
    if (base.length > 0) out.push(`${escaped}/**`);
  }
  return out;
}
