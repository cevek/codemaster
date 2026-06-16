// Shared module-specifier resolution for the ts plugin (§5-L2): turn a module ARG or an
// import SPECIFIER into the absolute file it points at, through the project's OWN
// compilerOptions — so tsconfig `paths` / `baseUrl` behave exactly as the compiler sees them.
// Used by `importers_of` (who imports module M) and the i18n symbol-identity scan (which
// imports name the configured i18n module). One implementation, no per-consumer copy.

import ts from 'typescript';
import * as path from 'node:path';
import type { TsProjectHost } from './ls-host.ts';

/** Resolve a module ARG — a repo-relative path OR any specifier the project uses (`@/lib/i18n`,
 *  a bare package, a relative import) — to an absolute file path. A repo-relative path that is a
 *  real file wins outright; otherwise the specifier is resolved as if imported from a file at the
 *  repo root. `undefined` when it resolves to nothing (a typo'd / out-of-project module). */
export function resolveModuleArg(
  host: TsProjectHost,
  moduleArg: string,
  options: ts.CompilerOptions,
): string | undefined {
  const asAbs = host.absOf(moduleArg as never);
  if (ts.sys.fileExists(asAbs)) return asAbs;
  const probe = path.join(path.dirname(asAbs), '__codemaster_probe__.ts');
  return ts.resolveModuleName(moduleArg, probe, options, ts.sys).resolvedModule?.resolvedFileName;
}

/** Resolve an import SPECIFIER from its containing file, memoized by `(dir|spec)` — the same
 *  specifier from the same directory always resolves identically, so the cache bounds the cost
 *  to O(distinct dir×spec) instead of O(imports). */
export function resolveSpecifier(
  spec: string,
  containingFile: string,
  options: ts.CompilerOptions,
  cache: Map<string, string | undefined>,
): string | undefined {
  const key = `${path.dirname(containingFile)}|${spec}`;
  const cached = cache.get(key);
  if (cached !== undefined || cache.has(key)) return cached;
  const resolved = ts.resolveModuleName(spec, containingFile, options, ts.sys).resolvedModule
    ?.resolvedFileName;
  cache.set(key, resolved);
  return resolved;
}

/** True when `a` and `b` are the SAME file. Canonicalize through `realpath` first: the module-arg
 *  fast-path (`resolveModuleArg`) returns the arg's raw form, while `resolveSpecifier` returns TS's
 *  realpath-resolved `resolvedFileName` — so a symlinked `node_modules`/pnpm path, or a wrong-case
 *  arg on a case-insensitive volume, would compare unequal and silently report ZERO usages
 *  (moduleResolved=true, calls=[]) — a quiet mislead (bug-review). realpath collapses both. */
export function samePath(a: string, b: string): boolean {
  const canon = (p: string): string => {
    try {
      return ts.sys.realpath ? ts.sys.realpath(p) : path.normalize(p);
    } catch {
      return path.normalize(p);
    }
  };
  return canon(a) === canon(b);
}
