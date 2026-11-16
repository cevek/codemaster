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
import { aliasMappedRel, type AliasPrefix } from '../../alias-paths.ts';
import { toPosix } from '../../../../support/fs/canonicalize.ts';
import { extendsOnlyBases } from '../../program-ownership.ts';

const MODULE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'] as const;

function moduleCandidates(baseAbs: string): string[] {
  if (/\.(tsx?|jsx?|mjs|cjs)$/.test(baseAbs)) return [baseAbs];
  const out: string[] = [];
  for (const ext of MODULE_EXTENSIONS) out.push(baseAbs + ext);
  for (const ext of MODULE_EXTENSIONS) out.push(path.join(baseAbs, `index${ext}`));
  return out;
}

/** Absolute base for a specifier the TS resolver declined (a CSS-module import, or any
 *  unmapped specifier). Relative → resolved against the importer's dir. Alias → re-mapped through
 *  the shared `aliasMappedRel` (longest-matching KEY, wildcard-aware, root-escape-guarded) — one
 *  alias model so resolve here and `css-modules` can't disagree on what `@/x` names. A bare package
 *  (`react`) maps to neither → null: never ours to move. */
function declinedSpecifierBase(
  host: TsProjectHost,
  aliasPrefixes: readonly AliasPrefix[],
  importerInitialAbs: string,
  spec: string,
): string | null {
  if (spec.startsWith('.')) return path.resolve(path.dirname(importerInitialAbs), spec);
  const rel = aliasMappedRel(aliasPrefixes, spec);
  return rel === null ? null : host.absOf(rel);
}

export function resolveSpecifierToNode(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  aliasPrefixes: readonly AliasPrefix[],
  importerInitialAbs: string,
  spec: string,
): FsNode | null {
  return resolveSpecifier(host, tree, options, aliasPrefixes, importerInitialAbs, spec).node;
}

/** `resolveSpecifierToNode` plus whether TS found the target through `node_modules` (a package —
 *  a pnpm workspace package resolves through its symlink to a node of the tree). */
export function resolveSpecifier(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  aliasPrefixes: readonly AliasPrefix[],
  importerInitialAbs: string,
  spec: string,
): { node: FsNode | null; viaPackage: boolean } {
  const module = ts.resolveModuleName(
    spec,
    importerInitialAbs,
    options,
    host.workspaceLinks().resolutionHost(options),
  ).resolvedModule;
  if (module !== undefined) {
    return {
      node: tree.findByInitialPath(host.relOf(module.resolvedFileName)),
      viaPackage: module.isExternalLibraryImport === true,
    };
  }
  return {
    node: declinedNode(host, tree, aliasPrefixes, importerInitialAbs, spec),
    viaPackage: false,
  };
}

function declinedNode(
  host: TsProjectHost,
  tree: VFSTree,
  aliasPrefixes: readonly AliasPrefix[],
  importerInitialAbs: string,
  spec: string,
): FsNode | null {
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

/** Does `spec`, written in a file at `importerAbs`, still land on `targetAbs` under the options of
 *  every program whose glob owns that path (the primary when none does)? A package specifier kept
 *  across a move is judged by the program the importer lands in, and its `paths` may map the same
 *  name elsewhere. */
export function resolvesSameUnderOwners(
  host: TsProjectHost,
  spec: string,
  importerAbs: string,
  targetAbs: string,
): boolean {
  const ctx = host.gateHostCtx();
  const bases = new Set(extendsOnlyBases(ctx));
  const owners = ctx.programs.filter((p) => !bases.has(p) && p.mayContain(importerAbs));
  for (const program of owners.length > 0 ? owners : [ctx.primary]) {
    const options = program.getProgram()?.getCompilerOptions();
    if (options === undefined) return false;
    const resolved = ts.resolveModuleName(
      spec,
      importerAbs,
      options,
      host.workspaceLinks().resolutionHost(options),
    ).resolvedModule;
    if (resolved === undefined || toPosix(resolved.resolvedFileName) !== toPosix(targetAbs)) {
      return false;
    }
  }
  return true;
}
