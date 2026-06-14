// Resolve a module specifier (as written in an importer) to its tree node. Forward resolution
// is the PROJECT'S OWN resolver — `ts.resolveModuleName`, which honours tsconfig
// `paths`/`baseUrl` exactly as the compiler sees them (the same call `importers.ts` uses; we
// do NOT stand up a second resolver). A path-probe fallback covers CSS-module / non-TS
// specifiers the TS resolver ignores — for relative AND alias forms, because TS never
// typechecks an `.scss` import, so a missed rewrite of an aliased stylesheet specifier would
// dangle silently past the §2.8 gate. Resolution runs against the importer's INITIAL path
// (dry-run disk is pre-move), so it lands on the target's initial location → its tree node.

import ts from 'typescript';
import * as path from 'node:path';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type { FsNode } from '../tree/node.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import type { AliasPrefix } from './emit.ts';

const MODULE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'] as const;

function moduleCandidates(baseAbs: string): string[] {
  if (/\.(tsx?|jsx?|mjs|cjs)$/.test(baseAbs)) return [baseAbs];
  const out: string[] = [];
  for (const ext of MODULE_EXTENSIONS) out.push(baseAbs + ext);
  for (const ext of MODULE_EXTENSIONS) out.push(path.join(baseAbs, `index${ext}`));
  return out;
}

/** Absolute base for a specifier the TS resolver declined (a CSS-module import, or any
 *  unmapped specifier). Relative → resolved against the importer's dir. Alias → re-mapped via
 *  the same WILDCARD-AWARE `paths` prefixes `emit` uses: a `*` key is a prefix match, a bare
 *  key is an EXACT match — conflating them would over-match `@scss/x` under a bare `@s` key (a
 *  silent misidentification). A bare package (`react`) maps to neither → null: never ours to move. */
function declinedSpecifierBase(
  host: TsProjectHost,
  aliasPrefixes: readonly AliasPrefix[],
  importerInitialAbs: string,
  spec: string,
): string | null {
  if (spec.startsWith('.')) return path.resolve(path.dirname(importerInitialAbs), spec);
  for (const { wildcard, aliasPrefix, relPrefix } of aliasPrefixes) {
    if (wildcard) {
      if (spec.startsWith(aliasPrefix)) {
        return host.absOf((relPrefix + spec.slice(aliasPrefix.length)) as RepoRelPath);
      }
    } else if (spec === aliasPrefix) {
      return host.absOf(relPrefix as RepoRelPath);
    }
  }
  return null;
}

export function resolveSpecifierToNode(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  aliasPrefixes: readonly AliasPrefix[],
  importerInitialAbs: string,
  spec: string,
): FsNode | null {
  const resolved = ts.resolveModuleName(spec, importerInitialAbs, options, ts.sys).resolvedModule
    ?.resolvedFileName;
  if (resolved !== undefined) return tree.findByInitialPath(host.relOf(resolved));
  // The TS resolver declined (a CSS-module import, or an unmapped specifier). Probe the tree
  // for the relative- OR alias-mapped base; a bare package is never ours to move.
  const baseAbs = declinedSpecifierBase(host, aliasPrefixes, importerInitialAbs, spec);
  if (baseAbs === null) return null;
  for (const candidate of moduleCandidates(baseAbs)) {
    const node = tree.findByInitialPath(host.relOf(candidate));
    if (node !== null) return node;
  }
  return tree.findByInitialPath(host.relOf(baseAbs));
}
