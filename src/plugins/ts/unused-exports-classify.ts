// The classification half of `find_unused_exports` (split from `./unused-exports.ts` for the
// 300-line cap): given an enumerated candidate, decide whether it is USED — across ALL the repo's
// loaded programs (spec Task G) — or report it with an honest confidence. "Could not prove dead"
// is always `partial` (barrel re-export / `export *` / dynamic `import()`), never `certain` unused
// (§3.3/§3.4). The module-graph edge collection those demotions key on lives here too.

import ts from 'typescript';
import * as path from 'node:path';
import type { Confidence } from '../../core/span.ts';
import { spanFromRange } from './spans.ts';
import { mintSymbolId } from './symbol-id.ts';
import { classifyRole } from './usage-roles.ts';
import type { TsProjectHost } from './ls-host.ts';
import { programFileGroups } from './program/project-files.ts';
import type { Candidate, UnusedExportView } from './unused-exports.ts';

/** Decide a candidate's verdict, or `undefined` when it is USED (any real reference anywhere).
 *  Demotion order is most-specific-first; every demotion is `partial` with a stated reason. */
export function classifyExport(
  host: TsProjectHost,
  program: ts.Program,
  c: Candidate,
  edges: ModuleEdges,
  undiscovered: readonly string[],
): UnusedExportView | undefined {
  // Primary first — the cheap common case (most exports are used in-program). Only a candidate
  // DEAD in the primary pays the sibling-program searches (spec Task G cost short-circuit: one
  // findReferences per program would otherwise be N× the work on every candidate).
  const primary = scanRefsInProgram(host.service, program, c);
  if (primary.used) return undefined;
  let barrelReexport = primary.barrelReexport;

  // Dead-in-primary: fan out to the sibling programs containing this decl file. A real use in a
  // `test/**` file under `tsconfig.test.json` makes the export USED — the false-dead this fixes.
  for (const sibling of host.programsContaining(c.abs)) {
    if (sibling.service === host.service) continue; // primary already scanned
    const siblingProgram = sibling.getProgram();
    if (siblingProgram === undefined) continue;
    const verdict = scanRefsInProgram(sibling.service, siblingProgram, c);
    if (verdict.used) return undefined;
    if (verdict.barrelReexport) barrelReexport = true;
  }

  const demotion = demote(c.abs, barrelReexport, edges, undiscovered);
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

/** Scan one program's references for `c` and decide whether THIS program proves the export used,
 *  plus whether it is reached by a barrel re-export (a demotion signal). The per-program half of
 *  the cross-program fan-out — identical classification logic run against each program's own LS +
 *  SourceFiles (a test-file ref's SourceFile lives only in the test program). */
function scanRefsInProgram(
  service: ts.LanguageService,
  program: ts.Program,
  c: Candidate,
): { used: boolean; barrelReexport: boolean } {
  let barrelReexport = false;
  const refs = service.findReferences(c.abs, c.namePos);
  for (const group of refs ?? []) {
    for (const ref of group.references) {
      if (ref.isDefinition === true) continue; // the declaration itself is not a use
      if (ref.fileName.includes('/node_modules/')) continue;
      const refSf = program.getSourceFile(ref.fileName);
      // An in-repo reference we can't load (a path-form mismatch — symlink/case/separator) is a
      // real use we just can't classify; count it as USED. NEVER drop it into a possible
      // `certain` dead — dropping the only use is the false-certain lie this op forbids (§3.4).
      if (refSf === undefined) return { used: true, barrelReexport };
      const role = classifyRole(refSf, ref.textSpan.start, {
        isDefinition: false,
        isWrite: ref.isWriteAccess === true,
      });
      if (ref.fileName === c.abs) {
        // Same file: the symbol's own `export { X }` specifier is the export, not a use; any
        // other in-file reference (a local read/call/type) means the symbol IS used.
        if (role === 'reexport') continue;
        return { used: true, barrelReexport };
      }
      // Another file: a barrel `export { X } from` is a demotion signal (consumers may reach
      // it through the barrel); anything else — an import or a direct use — is a real use.
      if (role === 'reexport') barrelReexport = true;
      else return { used: true, barrelReexport };
    }
  }
  return { used: false, barrelReexport };
}

/** "Could not prove dead" is always `partial`, never `certain` unused (§3.3/§3.4). Only an
 *  export with no reference of any kind, in a module no barrel / star / dynamic-import can
 *  reach, stays `certain`. */
function demote(
  abs: string,
  barrelReexport: boolean,
  edges: ModuleEdges,
  undiscovered: readonly string[],
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
  // Repo has a tsconfig codemaster did NOT load as a program (a nested package, neither adjacent to
  // the primary nor `references`d) — its files could reference this export and are not searched, so
  // a `certain`-dead here would be a false dead (§3.4). Name the config(s) — proof of WHY partial.
  if (undiscovered.length > 0) {
    const named = undiscovered.slice(0, 3).join(', ');
    const more = undiscovered.length > 3 ? `, +${undiscovered.length - 3} more` : '';
    return {
      confidence: 'partial',
      note: `repo has TS program(s) codemaster did not load (${named}${more}) — a nested-package tsconfig may reference this export; could not prove dead`,
    };
  }
  return { confidence: 'certain' };
}

export interface ModuleEdges {
  /** Abs paths reached by a literal `import('./x')`. */
  dynamicTargets: Set<string>;
  /** Abs paths re-exported by some `export * from './x'`. */
  starReexportTargets: Set<string>;
  /** A computed `import(expr)` exists — it could target any module. */
  computedDynamicImport: boolean;
}

/** One walk over every project file — ACROSS ALL loaded programs (spec Task G) — collecting the
 *  module-graph edges `findReferences` is unreliable across: dynamic `import()` (literal targets +
 *  the computed flag) and `export *`. Walking only the primary program would miss a dynamic import
 *  / `export *` / computed import that lives in a `test/**` file, so a dynamically-loaded export
 *  would falsely read `certain` dead — the cardinal false-dead lie. Each file is resolved under ITS
 *  owning program's compilerOptions (a sibling-only `paths` alias resolves correctly). */
export function collectModuleEdges(host: TsProjectHost): ModuleEdges {
  const dynamicTargets = new Set<string>();
  const starReexportTargets = new Set<string>();
  let computedDynamicImport = false;

  for (const { program, files } of programFileGroups(host)) {
    const options = program.getCompilerOptions();
    const cache = new Map<string, string | undefined>(); // per-program: options differ across programs
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

    for (const sourceFile of files) {
      if (sourceFile.isDeclarationFile) continue;
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
  }

  return { dynamicTargets, starReexportTargets, computedDynamicImport };
}
