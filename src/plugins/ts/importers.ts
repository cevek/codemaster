// `importers_of` — the module-dependency primitive: who imports (or re-exports from)
// a given module. The requested module may be a repo-relative path or any specifier
// (aliased `@/…` included): both sides are resolved through the project's own
// compilerOptions via `ts.resolveModuleName`, so tsconfig `paths` behave exactly as
// the compiler sees them.

import ts from 'typescript';
import type { TsProjectHost } from './ls-host.ts';
import { resolveModuleArg, resolveSpecifier, samePath } from './resolve-module.ts';

export type ImporterRow = {
  /** Importing file + line of the import statement. */
  at: string;
  /** What is imported: named/default/namespace bindings, or 're-export'. */
  imports: string;
};

export type ImportersView = {
  /** The module as resolved (repo-relative), or the raw specifier when unresolvable. */
  module: string;
  importers: ImporterRow[];
  total: number;
  /** §3.4 FLOOR: repo tsconfigs NOT loaded as programs (nested-package config neither adjacent to
   *  the primary nor `references`d, and not loaded by read-path nearest-config discovery). An
   *  importer living ONLY under such a program is NOT scanned, so a non-empty set makes the list a
   *  LOWER BOUND — the op surfaces `complete:false` + a named `!!` note, never a false `0`. */
  undiscoveredPrograms?: string[];
};

export function findImporters(host: TsProjectHost, moduleArg: string): ImportersView {
  const primary = host.service.getProgram();
  if (primary === undefined) return { module: moduleArg, importers: [], total: 0 };

  // The target module is named once, resolved under the primary's options (the canonical config).
  const targetAbs = resolveModuleArg(host, moduleArg, primary.getCompilerOptions());
  // Read-path completeness (§5-L2): load the target's nearest enclosing tsconfig, so a consumer the
  // loose-root primary globs WITHOUT the alias is scanned under the nested config that defines it.
  if (targetAbs !== undefined) host.ensureProgramFor(targetAbs);

  const importers: ImporterRow[] = [];
  const seen = new Set<string>(); // `at` (file:line) — a statement two programs both see counts once

  // Resolve EACH loaded program's OWN files under ITS OWN compilerOptions, then row-dedup by `at`.
  // We deliberately do NOT use programFileGroups' primary-first FILE dedup: under a loose root the
  // consumer file is globbed by BOTH the root (no alias → miss) and the nested config (alias →
  // match); file-dedup would assign it to the root and silently drop the match (a §3.4 lie). Row
  // dedup keeps the match whichever program resolved it and collapses a statement two programs both
  // resolve to the target. A file is scanned once per containing program (bounded by program count,
  // typically 2-3 — fileDriven adds at most one). Matching is by RESOLVED target (identity, not raw
  // string), so a program whose options can't resolve the specifier yields no false row.
  for (const p of host.programs()) {
    const program = p.getProgram();
    if (program === undefined) continue;
    const options = program.getCompilerOptions();
    const cache = new Map<string, string | undefined>(); // per-program: options differ
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.fileName.includes('/node_modules/')) continue;
      for (const stmt of sourceFile.statements) {
        const spec = moduleSpecifierOf(stmt);
        if (spec === undefined) continue;
        if (!matches(spec, moduleArg, targetAbs, sourceFile.fileName, options, cache)) continue;
        const lc = sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile));
        const at = `${host.relOf(sourceFile.fileName)}:${lc.line + 1}`;
        if (seen.has(at)) continue;
        seen.add(at);
        importers.push({ at, imports: importedNames(stmt) });
      }
    }
  }
  const undiscovered = host.undiscoveredProgramLabels();
  return {
    module: targetAbs !== undefined ? host.relOf(targetAbs) : moduleArg,
    importers,
    total: importers.length,
    ...(undiscovered.length > 0 ? { undiscoveredPrograms: [...undiscovered] } : {}),
  };
}

function moduleSpecifierOf(stmt: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
    return stmt.moduleSpecifier.text;
  }
  if (
    ts.isExportDeclaration(stmt) &&
    stmt.moduleSpecifier !== undefined &&
    ts.isStringLiteral(stmt.moduleSpecifier)
  ) {
    return stmt.moduleSpecifier.text;
  }
  return undefined;
}

function matches(
  spec: string,
  moduleArg: string,
  targetAbs: string | undefined,
  containingFile: string,
  options: ts.CompilerOptions,
  cache: Map<string, string | undefined>,
): boolean {
  // When the target RESOLVES to a file, identity is decided by resolution alone — a raw-string
  // `spec === moduleArg` shortcut would mis-match two different modules that share a relative
  // specifier (`./x` in dirA vs dirB both "match" `importers_of './x'` — a false-live). The
  // exact-string match is the fallback ONLY for an unresolvable target (a `.scss` path, a package
  // specifier the TS resolver doesn't map to a file), where the literal string is all we have.
  if (targetAbs !== undefined) {
    const resolved = resolveSpecifier(spec, containingFile, options, cache);
    return resolved !== undefined && samePath(resolved, targetAbs);
  }
  return spec === moduleArg;
}

function importedNames(stmt: ts.Statement): string {
  if (ts.isExportDeclaration(stmt)) return 're-export';
  if (!ts.isImportDeclaration(stmt)) return '';
  const clause = stmt.importClause;
  if (clause === undefined) return 'side-effect';
  const names: string[] = [];
  if (clause.name !== undefined) names.push(`default as ${clause.name.text}`);
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) names.push(`* as ${bindings.name.text}`);
    else for (const el of bindings.elements) names.push(el.name.text);
  }
  if (clause.isTypeOnly) return `type ${names.join(',')}`;
  return names.join(',');
}
