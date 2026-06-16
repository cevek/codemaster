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
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import { matchesAnyGlob } from '../../common/glob/match.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId } from './symbol-id.ts';
import { classifyRole } from './usage-roles.ts';
import type { TsProjectHost } from './ls-host.ts';

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

type Candidate = {
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
  // The warm LS loads ONE tsconfig (host.configPath). A repo with a SIBLING tsconfig (the near-
  // universal `tsconfig.test.json` / Vite's `tsconfig.app.json`+`tsconfig.node.json`) compiles other
  // files we never see — an export used ONLY from that other program would read as unreferenced
  // here. Claiming `certain` dead then invites deleting LIVE code (the §3.1 lie an agent acts on).
  // So when a sibling project exists we cap every otherwise-`certain` verdict to `partial`.
  const siblingProject = hasSiblingTsProject(host.configPath);
  const projectFiles = program
    .getSourceFiles()
    .filter((sf) => !sf.fileName.includes('/node_modules/') && !sf.isDeclarationFile);

  // Pass 1: module-graph edges findReferences can't be trusted to trace through — dynamic
  // `import()` targets (literal → which files; computed → any file) and `export *` targets.
  const edges = collectModuleEdges(host, program, projectFiles);

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
    const verdict = classifyExport(host, program, c, edges, siblingProject);
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

/** Decide a candidate's verdict, or `undefined` when it is USED (any real reference anywhere).
 *  Demotion order is most-specific-first; every demotion is `partial` with a stated reason. */
function classifyExport(
  host: TsProjectHost,
  program: ts.Program,
  c: Candidate,
  edges: ModuleEdges,
  siblingProject: boolean,
): UnusedExportView | undefined {
  let barrelReexport = false;
  const refs = host.service.findReferences(c.abs, c.namePos);
  for (const group of refs ?? []) {
    for (const ref of group.references) {
      if (ref.isDefinition === true) continue; // the declaration itself is not a use
      if (ref.fileName.includes('/node_modules/')) continue;
      const refSf = program.getSourceFile(ref.fileName);
      // An in-repo reference we can't load (a path-form mismatch — symlink/case/separator) is a
      // real use we just can't classify; count it as USED. NEVER `continue` into a possible
      // `certain` dead — dropping the only use is the false-certain lie this op forbids (§3.4).
      if (refSf === undefined) return undefined;
      const role = classifyRole(refSf, ref.textSpan.start, {
        isDefinition: false,
        isWrite: ref.isWriteAccess === true,
      });
      if (ref.fileName === c.abs) {
        // Same file: the symbol's own `export { X }` specifier is the export, not a use; any
        // other in-file reference (a local read/call/type) means the symbol IS used.
        if (role === 'reexport') continue;
        return undefined;
      }
      // Another file: a barrel `export { X } from` is a demotion signal (consumers may reach
      // it through the barrel); anything else — an import or a direct use — is a real use.
      if (role === 'reexport') barrelReexport = true;
      else return undefined;
    }
  }

  const demotion = demote(c.abs, barrelReexport, edges, siblingProject);
  const span = spanFromRange(c.sourceFile, c.rel, c.namePos, c.nameEnd);
  return {
    name: c.name,
    kind: c.kind,
    file: c.rel,
    span,
    symbol: mintSymbolId(c.name, c.rel, span.line, span.col, host.rootTag),
    confidence: demotion.confidence,
    ...(demotion.note !== undefined ? { note: demotion.note } : {}),
  };
}

/** "Could not prove dead" is always `partial`, never `certain` unused (§3.3/§3.4). Only an
 *  export with no reference of any kind, in a module no barrel / star / dynamic-import can
 *  reach, stays `certain`. */
function demote(
  abs: string,
  barrelReexport: boolean,
  edges: ModuleEdges,
  siblingProject: boolean,
): { confidence: Confidence; note?: string } {
  if (barrelReexport) {
    return {
      confidence: 'partial',
      note: 're-exported by a barrel (export … from) — consumers may reach it through the barrel; could not prove dead',
    };
  }
  if (edges.dynamicTargets.has(abs)) {
    return {
      confidence: 'partial',
      note: 'module is dynamically imported (import()) — its exports may be accessed via the namespace; could not prove dead',
    };
  }
  if (edges.starReexportTargets.has(abs)) {
    return {
      confidence: 'partial',
      note: 're-exported via `export *` — findReferences may not trace star re-exports; could not prove dead',
    };
  }
  if (edges.computedDynamicImport) {
    return {
      confidence: 'partial',
      note: 'a computed import(expr) exists in the repo — it could load any module; could not prove dead',
    };
  }
  if (siblingProject) {
    return {
      confidence: 'partial',
      note: 'a sibling tsconfig (e.g. tsconfig.test.json) is not in the analyzed program — an export used only there would read as unreferenced; could not prove dead',
    };
  }
  return { confidence: 'certain' };
}

/** True when a tsconfig OTHER than the loaded one sits beside it (`tsconfig.test.json`,
 *  `tsconfig.app.json`, …). The warm LS compiles only `configPath`, so a sibling project's files
 *  are invisible here — a `certain` dead claim would be a lie if such a file uses the export. */
function hasSiblingTsProject(configPath: string | undefined): boolean {
  if (configPath === undefined) return false;
  try {
    const dir = path.dirname(configPath);
    const self = path.basename(configPath);
    return readdirSync(dir).some(
      (f) => /^tsconfig\..+\.json$|^tsconfig\.json$/.test(f) && f !== self,
    );
  } catch {
    return false; // can't read the dir → don't fabricate a demotion (the typecheck still guards)
  }
}

interface ModuleEdges {
  /** Abs paths reached by a literal `import('./x')`. */
  dynamicTargets: Set<string>;
  /** Abs paths re-exported by some `export * from './x'`. */
  starReexportTargets: Set<string>;
  /** A computed `import(expr)` exists — it could target any module. */
  computedDynamicImport: boolean;
}

/** One walk over every project file collecting the module-graph edges `findReferences` is
 *  unreliable across: dynamic `import()` (literal targets + the computed flag) and `export *`. */
function collectModuleEdges(
  host: TsProjectHost,
  program: ts.Program,
  projectFiles: readonly ts.SourceFile[],
): ModuleEdges {
  const options = program.getCompilerOptions();
  const cache = new Map<string, string | undefined>();
  const dynamicTargets = new Set<string>();
  const starReexportTargets = new Set<string>();
  let computedDynamicImport = false;

  const resolve = (spec: string, containing: string): string | undefined => {
    const key = `${path.dirname(containing)}|${spec}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        ts.resolveModuleName(spec, containing, options, ts.sys).resolvedModule?.resolvedFileName,
      );
    }
    return cache.get(key);
  };

  for (const sourceFile of projectFiles) {
    // `export * from './x'` is a top-level statement.
    for (const stmt of sourceFile.statements) {
      if (
        ts.isExportDeclaration(stmt) &&
        stmt.exportClause === undefined &&
        stmt.moduleSpecifier !== undefined &&
        ts.isStringLiteral(stmt.moduleSpecifier)
      ) {
        const target = resolve(stmt.moduleSpecifier.text, sourceFile.fileName);
        if (target !== undefined) starReexportTargets.add(target);
      }
    }
    // Dynamic `import()` can be nested anywhere — recurse.
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg !== undefined && ts.isStringLiteral(arg)) {
          const target = resolve(arg.text, sourceFile.fileName);
          if (target !== undefined) dynamicTargets.add(target);
        } else {
          computedDynamicImport = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { dynamicTargets, starReexportTargets, computedDynamicImport };
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
