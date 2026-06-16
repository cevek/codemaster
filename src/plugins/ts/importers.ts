// `importers_of` — the module-dependency primitive: who imports (or re-exports from)
// a given module. The requested module may be a repo-relative path or any specifier
// (aliased `@/…` included): both sides are resolved through the project's own
// compilerOptions via `ts.resolveModuleName`, so tsconfig `paths` behave exactly as
// the compiler sees them.

import ts from 'typescript';
import type { TsProjectHost } from './ls-host.ts';
import { resolveModuleArg, resolveSpecifier, samePath } from './resolve-module.ts';
import { programFileGroups } from './program/project-files.ts';

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
  const primary = host.service.getProgram();
  if (primary === undefined) return { module: moduleArg, importers: [], total: 0 };

  // The target module is named once, resolved under the primary's options (the canonical config).
  const targetAbs = resolveModuleArg(host, moduleArg, primary.getCompilerOptions());
  const importers: ImporterRow[] = [];

  // Fan out across every loaded program (spec Task G): a `test/**` file under a sibling tsconfig
  // that imports the module is a real importer the primary never sees. Each file's specifier is
  // resolved under ITS OWN program's options — so an import via a `paths`/`baseUrl` alias defined
  // only in the sibling tsconfig still resolves (else a real importer is silently dropped, a §3.4
  // completeness lie). Files shared by several programs are visited once (primary preferred).
  for (const { program, files } of programFileGroups(host)) {
    const options = program.getCompilerOptions();
    const cache = new Map<string, string | undefined>(); // per-program: options differ
    for (const sourceFile of files) {
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
