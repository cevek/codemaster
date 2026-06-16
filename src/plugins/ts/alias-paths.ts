// tsconfig `paths`/`baseUrl` alias mapping for the ts plugin — the EMIT/resolve side the TS
// resolver can't give us back (`ts.resolveModuleName` is one-way, and it declines non-TS
// specifiers like `.scss` entirely). Derived once from `compilerOptions.paths` as repo-relative
// prefixes, then used to (a) re-form an alias when emitting a moved import (`emit.ts`) and (b)
// map an aliased specifier to its target path when the TS resolver won't (`css-modules.ts`,
// `resolve.ts`). A plugin-root leaf so both the refactor engine and the cross-tier css scanner
// share ONE alias model — a second copy would let emit and resolve drift on what `@/x` means.

import * as path from 'node:path';
import type ts from 'typescript';
import type { TsProjectHost } from './ls-host.ts';
import type { RepoRelPath } from '../../core/brands.ts';

export interface AliasPrefix {
  /** A `*`-suffixed tsconfig `paths` key is a PREFIX match; a bare key is an EXACT
   *  full-specifier match (tsconfig semantics). Conflating them lets a bare `"@s"` key
   *  over-match an unrelated `@scss/x` specifier — a silent misidentification. */
  wildcard: boolean;
  /** Wildcard: the prefix matched by `startsWith` (e.g. `@/`). Exact: the full key (`@s`). */
  aliasPrefix: string;
  /** Wildcard: the repo-rel dir it maps to, trailing `/` (e.g. `src/`). Exact: the exact
   *  repo-rel target, no trailing `/` (e.g. `src/s`). */
  relPrefix: string;
}

/** Derive `{ aliasPrefix, relPrefix }` pairs from tsconfig `paths` (relative to `baseUrl`),
 *  as repo-relative directories so emit/resolve work in the tree's coordinate system. */
export function deriveAliasPrefixes(
  host: TsProjectHost,
  options: ts.CompilerOptions,
): AliasPrefix[] {
  const base = options.baseUrl ?? host.absOf('' as RepoRelPath);
  const out: AliasPrefix[] = [];
  for (const [key, values] of Object.entries(options.paths ?? {})) {
    const value = values?.[0];
    if (value === undefined) continue;
    const wildcard = key.endsWith('*');
    const aliasPrefix = wildcard ? key.slice(0, -1) : key;
    const valueBase = value.endsWith('*') ? value.slice(0, -1) : value;
    let relPrefix = String(host.relOf(path.resolve(base, valueBase)));
    // Wildcard maps a DIR → matched/emitted by prefix (trailing `/`). A bare key is an EXACT
    // mapping → keep its target verbatim (no `/`), matched by equality, never by prefix.
    if (wildcard && relPrefix.length > 0 && !relPrefix.endsWith('/')) relPrefix += '/';
    out.push({ wildcard, aliasPrefix, relPrefix });
  }
  // Most-specific alias first: with nested aliases (`@/`→`src/`, `@ui/`→`src/components/ui/`),
  // a target under the deeper one must emit the deeper alias, not the shallower prefix match.
  out.sort((a, b) => b.relPrefix.length - a.relPrefix.length);
  return out;
}

/** Map an aliased (non-relative) specifier to its repo-relative target via the WILDCARD-AWARE
 *  prefixes — a `*` key is a `startsWith` prefix, a bare key is an EXACT match (conflating them
 *  would over-match `@scss/x` under a bare `@s`). Selects the LONGEST matching `aliasPrefix` (the
 *  KEY), as the TS compiler resolves `paths` — NOT the `relPrefix`-length order `deriveAliasPrefixes`
 *  sorts for the EMIT direction (a nested alias whose more-specific key maps to a shorter target
 *  would otherwise resolve to the wrong sheet — a §3 lie). Returns the normalized repo-rel path the
 *  specifier names (extension preserved — the caller checks existence against its own index), or
 *  `null` for a relative / unmapped / root-escaping (`@/../..`) specifier. */
export function aliasMappedRel(
  aliasPrefixes: readonly AliasPrefix[],
  spec: string,
): RepoRelPath | null {
  if (spec.startsWith('.')) return null;
  let bestKeyLen = -1;
  let bestRel: string | null = null;
  for (const { wildcard, aliasPrefix, relPrefix } of aliasPrefixes) {
    let rel: string | null = null;
    if (wildcard) {
      if (spec.startsWith(aliasPrefix)) rel = relPrefix + spec.slice(aliasPrefix.length);
    } else if (spec === aliasPrefix) {
      rel = relPrefix;
    }
    if (rel !== null && aliasPrefix.length > bestKeyLen) {
      bestKeyLen = aliasPrefix.length;
      bestRel = rel;
    }
  }
  return bestRel === null ? null : normalizeNoEscape(bestRel);
}

/** Normalize a posix path, returning `null` if a `..` climbs above the repo root — resolving such
 *  a path would silently point outside the workspace (mirrors `move-to-file.ts`'s relative guard,
 *  so the alias and relative sides decline an escape identically). */
function normalizeNoEscape(p: string): RepoRelPath | null {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/') as RepoRelPath;
}
