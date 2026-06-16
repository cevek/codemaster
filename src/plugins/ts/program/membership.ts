// Glob-membership for a single program: "would THIS tsconfig include path P?" — independent of
// whether P exists on disk yet. The cross-program WRITE gate needs this: a move/extract creates a
// dest path that does NOT exist at gate time, so `containsFile` (built-program membership) is blind
// to it and the program whose glob OWNS the dest never joins the affected set → its diverging
// compilerOptions never typecheck the moved file → a missed cross-program dangle (a false success,
// the prime-directive catastrophe). `mayContain` answers the glob question existence-independently.
//
// We do NOT hand-roll glob matching (§4/§16) — picomatch (via `common/glob`) does the matching; this
// only normalizes tsconfig's include SHORTHAND (a bare directory means `dir/**/*`) and the
// default-include rule, then defers to picomatch. Conservative by construction: an EXPLICIT
// `exclude` is honoured and the supported-extension filter mirrors `allowJs`. tsconfig's IMPLICIT
// excludes (node_modules / outDir / declarationDir) are NOT modelled here — so `mayContain` can
// over-include such a path → at worst a false REFUSAL (the safe direction for a write gate), never
// a missed dangle; node_modules is independently filtered out of the built file list (single.ts).

import type ts from 'typescript';
import { toPosix } from '../../../support/fs/canonicalize.ts';
import { matchesAnyGlob } from '../../../common/glob/match.ts';

const TS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.d.ts'];
const JS_EXT = ['.js', '.jsx', '.mjs', '.cjs'];

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) if (typeof x === 'string') out.push(x);
  return out;
}

/** A tsconfig include entry with no wildcard and no recognized extension is a DIRECTORY → `dir/**\/*`
 *  (matching `tsc`'s own expansion); a literal file or an explicit glob is left as-is. */
function expandInclude(g: string): string {
  const clean = g.replace(/\/+$/, '');
  if (/[*?]/.test(clean)) return clean; // already a glob
  if (/\.(d\.ts|[cm]?[jt]sx?)$/i.test(clean)) return clean; // a literal file
  return `${clean}/**/*`;
}

function relTo(rootPosix: string, abs: string): string {
  if (abs === rootPosix) return ''; // the root itself
  const prefix = `${rootPosix}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

/** Build the `mayContain(absPosix)` predicate for one parsed tsconfig. `configDir` is the config's
 *  own directory (the base its include/exclude resolve against); `root` is the repo root the
 *  predicate's argument and the globs are normalized to (so picomatch matches repo-relative posix,
 *  its documented surface). Rebuilt on every re-glob (the parsed config changes). */
export function buildMembership(
  parsed: ts.ParsedCommandLine,
  configDir: string,
  root: string,
): (absPosix: string) => boolean {
  const exts =
    parsed.options.allowJs === true || parsed.options.checkJs === true
      ? [...TS_EXT, ...JS_EXT]
      : TS_EXT;
  const rootPosix = toPosix(root);
  // Files the cold glob already resolved — a fast, exact path for everything that exists today.
  const explicit = new Set(parsed.fileNames.map(toPosix));
  const raw = (parsed.raw ?? {}) as { include?: unknown; exclude?: unknown; files?: unknown };
  const include = asStringArray(raw.include);
  const files = asStringArray(raw.files);
  const exclude = asStringArray(raw.exclude) ?? [];
  const baseRel = relTo(rootPosix, toPosix(configDir));
  const join = (g: string): string =>
    baseRel === '' ? g.replace(/^\.\//, '') : `${baseRel}/${g.replace(/^\.\//, '')}`;
  // tsconfig default: when NEITHER `include` nor `files` is given, include everything under the
  // config dir; when only `files` is given there is no wildcard include (explicit covers it).
  const includeGlobs =
    include === undefined && files === undefined
      ? [baseRel === '' ? '**/*' : `${baseRel}/**/*`]
      : (include ?? []).map((g) => join(expandInclude(g)));
  const excludeGlobs = exclude.flatMap((g) => {
    const j = join(g.replace(/\/+$/, ''));
    return [j, `${j}/**`];
  });

  return (absInput: string): boolean => {
    const abs = toPosix(absInput);
    if (explicit.has(abs)) return true;
    const rel = relTo(rootPosix, abs);
    if (rel === abs) return false; // outside the repo root → never this config's
    if (!exts.some((e) => rel.endsWith(e))) return false;
    if (includeGlobs.length === 0) return false;
    if (!matchesAnyGlob(rel, includeGlobs)) return false;
    if (excludeGlobs.length > 0 && matchesAnyGlob(rel, excludeGlobs)) return false;
    return true;
  };
}
