// The node_modules bare-import scan behind `find_phantom_deps` (t-272300). Emits every STATIC
// import/export whose specifier is a BARE package (not relative/absolute/`#`-subpath/node-builtin)
// AND resolves — through the project's OWN compilerOptions — to a file UNDER `/node_modules/`. That
// node_modules gate is load-bearing: it is exactly the "resolves locally, breaks on a clean install"
// class, and it excludes every tsconfig `paths`/`baseUrl` alias (bare-looking but resolving to
// workspace SOURCE) so the phantom check never false-flags the alias surface.
//
// This is the PLUGIN half (parse + per-program module resolution, §5-L2); the op does the join —
// diffing each site's package name against the importer's nearest-enclosing `package.json` deps. A
// site here is NOT yet a phantom (an import of a correctly-DECLARED dep also resolves to node_modules).

import { isBuiltin } from 'node:module';
import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { TsProjectHost } from './ls-host.ts';
import { resolveSpecifier } from './resolve-module.ts';
import { moduleSpecifierOf } from './importers.ts';

export interface NodeModuleImportSite {
  /** The importing file (repo-relative). */
  importer: RepoRelPath;
  /** The raw module specifier as written (`@mui/material/styles`). */
  specifier: string;
  /** The package name the specifier addresses (`@mui/material`). */
  packageName: string;
  /** The package directory the specifier RESOLVED into (repo-relative when under the root — e.g.
   *  `node_modules/@mui/material` for a root-hoisted dep, or `apps/x/node_modules/@mui/material` for a
   *  package-local one; an absolute path when the install lives outside the repo root). A verifiable
   *  physical location — NEVER an inferred "which manifest declares it" (pnpm hoisting makes that a
   *  guess). */
  resolvedFrom: string;
  /** A whole-statement `import type` / `export type` — the op treats an `@types/<pkg>` declaration as
   *  satisfying it (a types-only dep needs no runtime package). */
  typeOnly: boolean;
  line: number;
  col: number;
}

/** Every static bare-package import/export across all loaded programs that resolves under
 *  `/node_modules/`. Scanned per-program under ITS OWN options (a package's alias resolves only under
 *  its own config — the `importers.ts` precedent), row-deduped by `importer:line:col` so a statement
 *  two overlapping programs both see counts once. Bounded by the loaded program × file set (no repo
 *  walk); resolution is memoized per (dir|spec). Static import/export only — a dynamic
 *  `import()`/`require()` is not traced (disclosed by the op). */
export function nodeModuleImports(host: TsProjectHost): NodeModuleImportSite[] {
  const out: NodeModuleImportSite[] = [];
  const seen = new Set<string>(); // `importer:line:col`
  for (const p of host.programs()) {
    const program = p.getProgram();
    if (program === undefined) continue;
    const options = program.getCompilerOptions();
    const cache = new Map<string, string | undefined>(); // per-program: options differ
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.fileName.includes('/node_modules/')) continue;
      for (const stmt of sourceFile.statements) {
        const spec = moduleSpecifierOf(stmt);
        if (spec === undefined || !isBarePackage(spec)) continue;
        const resolved = resolveSpecifier(spec, sourceFile.fileName, options, cache);
        if (resolved === undefined || !resolved.includes('/node_modules/')) continue;
        const lc = sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile));
        const importer = host.relOf(sourceFile.fileName);
        const key = `${importer}:${lc.line + 1}:${lc.character + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const packageName = packageNameOf(spec);
        out.push({
          importer,
          specifier: spec,
          packageName,
          resolvedFrom: host.relOf(resolvedPackageDir(resolved, packageName)),
          typeOnly: isTypeOnly(stmt),
          line: lc.line + 1,
          col: lc.character + 1,
        });
      }
    }
  }
  return out;
}

/** A bare PACKAGE specifier: not a relative (`./`, `../`) or absolute (`/`) path, not a Node
 *  `#`-subpath import (the package's own `imports` field — always internal), and not a Node builtin
 *  (`fs`, `node:fs` — never a declared dep, and `fs` can otherwise resolve to `@types/node` under
 *  node_modules → a false phantom). */
function isBarePackage(spec: string): boolean {
  if (spec.length === 0) return false;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return false;
  if (isBuiltin(spec)) return false;
  return true;
}

/** The package name a specifier addresses: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
export function packageNameOf(spec: string): string {
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? spec;
}

/** The resolved package's directory: the text up to and including the LAST `/node_modules/` segment,
 *  plus the package name — so `…/node_modules/@mui/material/styles/index.d.ts` → `…/node_modules/@mui/material`. */
function resolvedPackageDir(resolvedAbs: string, packageName: string): string {
  const marker = '/node_modules/';
  const idx = resolvedAbs.lastIndexOf(marker);
  if (idx === -1) return resolvedAbs;
  return `${resolvedAbs.slice(0, idx + marker.length)}${packageName}`;
}

/** A whole-statement type-only import/export (`import type … from` / `export type … from`). A
 *  named-specifier-level `import { type X }` is treated as a value import (conservative — the module
 *  is still a runtime dependency for the non-type bindings). */
function isTypeOnly(stmt: ts.Statement): boolean {
  if (ts.isImportDeclaration(stmt)) return stmt.importClause?.isTypeOnly === true;
  if (ts.isExportDeclaration(stmt)) return stmt.isTypeOnly;
  return false;
}
