// `importers_of` — the module-dependency primitive: who imports (or re-exports from)
// a given module. The requested module may be a repo-relative path or any specifier
// (aliased `@/…` included): both sides are resolved through the project's own
// compilerOptions via `ts.resolveModuleName`, so tsconfig `paths` behave exactly as
// the compiler sees them.

import ts from 'typescript';
import { realpathSync } from 'node:fs';
import type { RepoRelPath } from '../../core/brands.ts';
import { toPosix } from '../../support/fs/canonicalize.ts';
import type { TsProjectHost } from './ls-host.ts';
import { resolveModuleArg, resolveSpecifier, samePath } from './resolve-module.ts';
import { findImportersSubtree } from './importers-subtree.ts';

export type ImporterRow = {
  /** Importing file + line of the import statement. */
  at: string;
  /** What is imported: named/default/namespace bindings, or 're-export'. */
  imports: string;
  /** SUBTREE mode only: the specific file UNDER the tree this importer pulls (per-row, varies). */
  target?: string;
  /** SUBTREE mode only: 'external' (importer's own file is OUTSIDE the tree = a deletion BLOCKER) |
   *  'internal' (importer lives inside the tree — counted, not blocking). */
  scope?: 'external' | 'internal';
};

/** SUBTREE mode: an import whose spec did NOT resolve to a file but whose LEXICAL target (a relative
 *  `./`/`../` spec) lands under the tree — it cannot be CONFIRMED an importer (no raw-string match,
 *  backlog 446a false-LIVE), so it is FLAGGED here, never silently dropped (§3.4) and never counted
 *  as a confirmed blocker. */
export type UnconfirmedRef = {
  /** Importing file + line. */
  at: string;
  /** The unresolvable specifier. */
  spec: string;
  reason: string;
};

export type ImportersView = {
  /** The module as resolved (repo-relative), or the raw specifier when unresolvable; in SUBTREE
   *  mode, the subtree directory (repo-relative). */
  module: string;
  /** MODULE mode only: did the specifier resolve to a real file under the project's own module
   *  resolution? `false` ⇒ the arg is a typo'd / out-of-project path — importers (if any) are
   *  literal-string fallback matches, and a `0` count is almost certainly a bad arg, NOT proof
   *  nothing depends on the module. The op surfaces this explicitly so an unresolved arg reads as a
   *  loud non-resolution, distinct from an honest resolved-0 (§3.6). Omitted in SUBTREE mode (a
   *  directory, with its own `safe`/blocker semantics). */
  resolved?: boolean;
  /** MODULE mode: the importers. SUBTREE mode: external ∪ internal (the full set, so a generic
   *  consumer — `affected` — still sees every importer). */
  importers: ImporterRow[];
  total: number;
  /** §3.4 FLOOR: repo tsconfigs NOT loaded as programs (nested-package config neither adjacent to
   *  the primary nor `references`d, and not loaded by read-path nearest-config discovery). An
   *  importer living ONLY under such a program is NOT scanned, so a non-empty set makes the list a
   *  LOWER BOUND — the op surfaces `complete:false` + a named `!!` note, never a false `0`. */
  undiscoveredPrograms?: string[];
  // ── SUBTREE mode only (present iff the arg named a directory) ──────────────────────────────────
  /** Set to `'subtree'` when the arg named a directory (`ts.sys.directoryExists` / trailing slash):
   *  "who imports ANYTHING under this folder" — the explicit-in-output mode flag. */
  mode?: 'subtree';
  /** The subtree directory (repo-relative). */
  subtree?: string;
  /** Importers whose own file is OUTSIDE the tree — deletion BLOCKERS (the headline; 0 ⇒ candidate-safe). */
  external?: ImporterRow[];
  /** Importers whose own file is INSIDE the tree — counted + kept, not blocking. */
  internal?: ImporterRow[];
  /** Unresolvable specs lexically under the tree — flagged, never raw-matched (no false-LIVE). */
  unconfirmed?: UnconfirmedRef[];
};

/** Detect SUBTREE mode (fork1, directory-wins): a trailing slash OR a real directory under the
 *  repo root makes the arg a folder, checked BEFORE module resolution — so an index-bearing folder
 *  is never collapsed to its barrel (which would silently drop deep importers, a §3.4 omission). The
 *  dir/file collision (`foo` with both `foo/` and `foo.ts`) resolves to the DIRECTORY; name `foo.ts`
 *  to target the file. Returns the repo-relative + canonical-abs dir, or `undefined` for a file/
 *  out-of-repo arg. */
function detectSubtree(
  host: TsProjectHost,
  moduleArg: string,
): { rel: string; abs: string } | undefined {
  const cleaned = moduleArg.replace(/\/+$/, '');
  if (cleaned.length === 0) return undefined;
  const rawAbs = toPosix(host.absOf(cleaned as RepoRelPath));
  if (!ts.sys.directoryExists(rawAbs)) return undefined;
  // §19 path-canon: `ts.sys.directoryExists` is case-INSENSITIVE on APFS/NTFS, but the containment
  // scan in `findImportersSubtree` is a case-SENSITIVE `startsWith` — so a mis-cased dir arg
  // ('src/Feature' for 'src/feature') would enable subtree mode yet match ZERO on-disk files → a
  // FALSE `safe:true`. Fold to the true on-disk casing (the root is already realpath-canonicalized,
  // §19, so `relOf` stays consistent). `realpathSync.native` also resolves symlinks; a vanished
  // path mid-call keeps the syntactic form (directoryExists just passed) rather than crashing.
  let abs = rawAbs;
  try {
    abs = toPosix(realpathSync.native(rawAbs));
  } catch {
    /* race: dir removed between the existence check and realpath — keep the syntactic form */
  }
  const rel = host.relOf(abs);
  // Guard against a `../` arg escaping the repo root (relOf returns a non-repo-relative spelling).
  if (rel.length === 0 || rel.startsWith('/') || rel.startsWith('..')) return undefined;
  return { rel, abs };
}

export function findImporters(host: TsProjectHost, moduleArg: string): ImportersView {
  const primary = host.service.getProgram();
  if (primary === undefined) return { module: moduleArg, resolved: false, importers: [], total: 0 };

  const sub = detectSubtree(host, moduleArg);
  if (sub !== undefined) return findImportersSubtree(host, sub.rel, sub.abs);

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
    resolved: targetAbs !== undefined,
    importers,
    total: importers.length,
    ...(undiscovered.length > 0 ? { undiscoveredPrograms: [...undiscovered] } : {}),
  };
}

export function moduleSpecifierOf(stmt: ts.Statement): string | undefined {
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

export function importedNames(stmt: ts.Statement): string {
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
