// `importers_of` — the module-dependency primitive: who imports (or re-exports from)
// a given module. The requested module may be a repo-relative path or any specifier
// (aliased `@/…` included): both sides are resolved through the project's own
// compilerOptions via `ts.resolveModuleName`, so tsconfig `paths` behave exactly as
// the compiler sees them.

import ts from 'typescript';
import * as path from 'node:path';
import type { TsProjectHost } from './ls-host.ts';

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
};

export function findImporters(host: TsProjectHost, moduleArg: string): ImportersView {
  const program = host.service.getProgram();
  if (program === undefined) return { module: moduleArg, importers: [], total: 0 };
  const options = program.getCompilerOptions();

  const targetAbs = resolveTarget(host, moduleArg, options);
  const importers: ImporterRow[] = [];
  const cache = new Map<string, string | undefined>();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes('/node_modules/')) continue;
    for (const stmt of sourceFile.statements) {
      const spec = moduleSpecifierOf(stmt);
      if (spec === undefined) continue;
      if (!matches(spec, moduleArg, targetAbs, sourceFile.fileName, options, cache)) continue;
      const lc = sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile));
      importers.push({
        at: `${host.relOf(sourceFile.fileName)}:${lc.line + 1}`,
        imports: importedNames(stmt),
      });
    }
  }
  return {
    module: targetAbs !== undefined ? host.relOf(targetAbs) : moduleArg,
    importers,
    total: importers.length,
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
  if (spec === moduleArg) return true; // exact specifier match (works for .scss etc.)
  if (targetAbs === undefined) return false;
  const key = `${path.dirname(containingFile)}|${spec}`;
  let resolved = cache.get(key);
  if (!cache.has(key)) {
    resolved = ts.resolveModuleName(spec, containingFile, options, ts.sys).resolvedModule
      ?.resolvedFileName;
    cache.set(key, resolved);
  }
  return resolved !== undefined && samePath(resolved, targetAbs);
}

function resolveTarget(
  host: TsProjectHost,
  moduleArg: string,
  options: ts.CompilerOptions,
): string | undefined {
  // A repo-relative path that is part of the project wins outright.
  const asAbs = host.absOf(moduleArg as never);
  if (ts.sys.fileExists(asAbs)) return asAbs;
  // Otherwise resolve the specifier as if imported from a file at the repo root.
  const probe = path.join(path.dirname(asAbs), '__codemaster_probe__.ts');
  return ts.resolveModuleName(moduleArg, probe, options, ts.sys).resolvedModule?.resolvedFileName;
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b);
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
