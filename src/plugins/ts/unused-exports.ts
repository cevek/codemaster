// `find_unused_exports` machinery (§5-L2): the locally-declared TS exports with no
// importer/usage anywhere, proven through the live LS (`findReferences`) — the same oracle
// `find_usages`/`importers_of` use, so an aliased import that text-grep would miss still
// counts as a use. MIRRORS the honesty of `find_unused_scss_classes`/`find_unused_i18n_keys`:
// an export reached only via a barrel re-export, `export *`, or a dynamic `import()` demotes
// to `partial` ("could not prove dead"), NEVER "definitely unused" (§3.3/§3.4).
//
// Bounded by DESIGN (§19 "scope inputs"): we run one `findReferences` per candidate, so the cap
// bounds the NUMBER of reference searches (not wall-time — each search is O(import-graph) for that
// symbol). The candidate set is scoped (pathInclude/pathExclude) + hard-capped, and the cap is
// reported as explicit truncation, never a silent undercount. The HARD wall-time guarantee is the
// §19 engine kill-on-deadline backstop (process mode, roadmap) — shared by every sync TS op
// (`find_usages` has the same exposure on a widely-imported symbol), not this op's to invent.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { matchesAnyGlob } from '../../common/glob/match.ts';
import type { TsProjectHost } from './ls-host.ts';
import { classifyExport, collectModuleEdges } from './unused-exports-classify.ts';

export type UnusedExportView = {
  /** The exported name (the declaration's name token). */
  name: string;
  kind: string;
  file: RepoRelPath;
  /** The name-token span — proof, and the §6 rebind anchor. */
  span: Span;
  /** Chainable SymbolId (→ find_usages / find_definition / rename_symbol). */
  symbol: string;
  /** `certain` = no reference of any kind anywhere; `partial` = could not prove dead. */
  confidence: Confidence;
  /** Why a `partial` claim could not be proven dead. */
  note?: string;
};

export type UnusedExportsView = {
  unused: UnusedExportView[];
  /** Candidate exports actually examined (`findReferences` run). */
  scannedExports: number;
  /** In-scope source files walked for candidates. */
  scannedFiles: number;
  /** Set when a computed `import(expr)` exists anywhere — it could load any module, so every
   *  otherwise-`certain` claim is demoted (the i18n-degraded precedent). */
  computedDynamicImport: boolean;
  /** Present when the candidate cap was hit: `examined` of `candidates` total. */
  truncated?: { examined: number; candidates: number };
};

export interface TsUnusedExportsFilter {
  pathInclude?: readonly string[] | undefined;
  pathExclude?: readonly string[] | undefined;
  /** Hard cap on candidate exports examined — the compute bound (§1/§19). */
  limit?: number | undefined;
}

/** Default candidate cap: enough to cover a feature directory's exports in one call, bounding
 *  the number of per-candidate reference searches on a whole-repo call (each is one
 *  `findReferences`, O(import-graph) for that symbol). Narrow further with pathInclude. */
const DEFAULT_UNUSED_EXPORTS_CAP = 200;

export type Candidate = {
  name: string;
  kind: string;
  rel: RepoRelPath;
  abs: string;
  sourceFile: ts.SourceFile;
  namePos: number;
  /** The name token's END offset — `getEnd()`, NOT `namePos + name.length`: an escaped-Unicode
   *  identifier (`fooBar`) has a decoded `name` shorter than its raw source token, so a
   *  length-derived end would slice a wrong, drifted proof span (bug-reviewer §1). */
  nameEnd: number;
};

export function findUnusedExports(
  host: TsProjectHost,
  filter?: TsUnusedExportsFilter,
): UnusedExportsView {
  const program = host.service.getProgram();
  if (program === undefined) {
    return { unused: [], scannedExports: 0, scannedFiles: 0, computedDynamicImport: false };
  }
  const checker = program.getTypeChecker();
  // Usage discovery spans ALL the repo's loaded programs (spec Task G): an export used only from a
  // SIBLING program (a `test/**` file under `tsconfig.test.json`, Vite's app/node split, a build
  // script) is now SEEN as used via the cross-program fan-out in `classifyExport`, so it is never
  // falsely reported. This replaces the old blanket sibling-tsconfig demotion (every `certain`→
  // `partial` whenever any sibling existed) — a genuinely-dead export reads `certain` again.
  const projectFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.fileName.includes('/node_modules/') && !sf.isDeclarationFile);

  // Pass 1: module-graph edges findReferences can't be trusted to trace through — dynamic
  // `import()` targets (literal → which files; computed → any file) and `export *` targets.
  // Collected ACROSS ALL programs (Task G): a dynamic import / `export *` living only in a
  // `test/**` file must still demote, or a live dynamically-loaded export reads `certain` dead.
  const edges = collectModuleEdges(host);

  // Pass 2: enumerate locally-declared exported symbols in the in-scope files.
  const inScope = scopePredicate(host, filter);
  const candidates: Candidate[] = [];
  let scannedFiles = 0;
  for (const sourceFile of projectFiles) {
    const rel = host.relOf(sourceFile.fileName);
    if (!inScope(rel)) continue;
    scannedFiles++;
    const moduleSym = checker.getSymbolAtLocation(sourceFile);
    if (moduleSym === undefined) continue; // not an external module (a script) — no exports
    for (const exp of checker.getExportsOfModule(moduleSym)) {
      const candidate = candidateOf(host, checker, sourceFile, rel, exp);
      if (candidate !== undefined) candidates.push(candidate);
    }
  }

  // Compute bound (§1/§19): examine at most `cap` candidates; the rest are reported as
  // truncation, never silently dropped (§3.4).
  const cap = filter?.limit ?? DEFAULT_UNUSED_EXPORTS_CAP;
  const examined = candidates.slice(0, cap);

  const unused: UnusedExportView[] = [];
  for (const c of examined) {
    const verdict = classifyExport(host, program, c, edges);
    if (verdict !== undefined) unused.push(verdict);
  }

  return {
    unused,
    scannedExports: examined.length,
    scannedFiles,
    computedDynamicImport: edges.computedDynamicImport,
    ...(candidates.length > examined.length
      ? { truncated: { examined: examined.length, candidates: candidates.length } }
      : {}),
  };
}

/** A scope predicate over the declaration file's repo-relative path. Usage discovery still
 *  scans the whole program (findReferences), so scoping the REPORTED set never invents a
 *  false dead — exactly the `find_unused_scss_classes` contract. */
function scopePredicate(
  host: TsProjectHost,
  filter?: TsUnusedExportsFilter,
): (rel: RepoRelPath) => boolean {
  const inc = filter?.pathInclude;
  const exc = filter?.pathExclude;
  return (rel) => {
    if (inc !== undefined && inc.length > 0 && !matchesAnyGlob(rel, inc)) return false;
    if (exc !== undefined && exc.length > 0 && matchesAnyGlob(rel, exc)) return false;
    return true;
  };
}

/** Build a candidate from one export symbol, or `undefined` when there is nothing local to
 *  classify here. Two skip cases, both the safe under-report direction:
 *   - a CROSS-file re-export alias (`export { X } from './y'`) — evaluated at its home file `y`,
 *     never here, so it is neither double-counted nor falsely blamed on the barrel;
 *   - an anonymous `export default () => …` / `export default {…}` — no identifier name token to
 *     anchor findReferences on, so skipped rather than guessed at.
 *  A SAME-file re-export alias (`const a = …; export { a }`) IS resolved to its local declaration
 *  and classified — without this it would be silently missed (bug-reviewer §2/§3). */
function candidateOf(
  host: TsProjectHost,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  exp: ts.Symbol,
): Candidate | undefined {
  const decl = localDeclarationOf(checker, sourceFile, exp);
  if (decl === undefined) return undefined;
  const nameNode = ts.getNameOfDeclaration(decl);
  if (nameNode === undefined || !ts.isIdentifier(nameNode)) return undefined;
  return {
    name: nameNode.text,
    kind: kindOf(decl),
    rel,
    abs: sourceFile.fileName,
    sourceFile,
    namePos: nameNode.getStart(sourceFile),
    nameEnd: nameNode.getEnd(),
  };
}

/** The export symbol's REAL local declaration in this file (a `const`/`function`/`class`/…),
 *  resolving a same-file `export { local }` alias to the thing it re-exports. Returns
 *  `undefined` for a cross-file re-export (home is another module) — that export is classified
 *  at its home, not here. */
function localDeclarationOf(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  exp: ts.Symbol,
): ts.Declaration | undefined {
  const target =
    (exp.flags & ts.SymbolFlags.Alias) !== 0 ? (aliasedSymbol(checker, exp) ?? exp) : exp;
  // A real declaration LIVING in this file — never an export/import specifier (the export
  // mechanism, not the declaration) — so the name token anchors on the actual `const a`/etc.
  return target.declarations?.find(
    (d) =>
      d.getSourceFile() === sourceFile &&
      !ts.isExportSpecifier(d) &&
      !ts.isImportSpecifier(d) &&
      !ts.isImportClause(d) &&
      !ts.isNamespaceImport(d),
  );
}

/** `checker.getAliasedSymbol`, guarded — it throws on a symbol that isn't actually an alias
 *  target (never a crash that escapes to the agent, §3.6). */
function aliasedSymbol(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol | undefined {
  try {
    return checker.getAliasedSymbol(sym);
  } catch {
    return undefined;
  }
}

function kindOf(decl: ts.Node): string {
  if (ts.isFunctionDeclaration(decl)) return 'function';
  if (ts.isClassDeclaration(decl)) return 'class';
  if (ts.isInterfaceDeclaration(decl)) return 'interface';
  if (ts.isTypeAliasDeclaration(decl)) return 'type';
  if (ts.isEnumDeclaration(decl)) return 'enum';
  if (ts.isVariableDeclaration(decl)) {
    const init = decl.initializer;
    if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      return 'function';
    }
    return 'const';
  }
  return 'export';
}
