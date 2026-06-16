// Cross-program reference fan-out (spec Task G scope-IN 2). The single warm LS sees only its own
// tsconfig's files, so `findReferences` anchored at a `src/**` declaration misses a usage living
// in a SIBLING program (a `test/**` file under `tsconfig.test.json`, a build script). The fix:
// run `findReferences` on EVERY loaded program that contains the declaration file, then merge +
// dedup the reference sites. A src reference surfaces from both programs and dedups to one; a
// test-only reference surfaces from the test program and is KEPT — the usage that read as dead.
//
// Each surfaced ref carries the SourceFile from the program that produced it (a test-file ref's
// SourceFile lives only in the test program), so callers build proof spans without a second,
// possibly-missing `getSourceFile` lookup. Semantic answers still come only from the live LS —
// the only oracle (§3.1); this just unions across the repo's own programs.

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { TsProjectHost } from './ls-host.ts';

/** One reference site, resolved against the program that surfaced it. */
interface CrossRef {
  /** Absolute file name as the producing program reports it. */
  fileName: string;
  rel: RepoRelPath;
  start: number;
  length: number;
  isDefinition: boolean;
  isWriteAccess: boolean;
  /** The SourceFile from the producing program — for span construction. */
  sourceFile: ts.SourceFile;
  /** Provenance: the label of the program that surfaced this ref (`tsconfig.test.json`, …). The
   *  primary program's label when a ref is seen by several programs (primary is preferred). */
  program: string;
}

export interface CrossReferences {
  /** The first non-node_modules definition seen, with its SourceFile + producing program
   *  (primary preferred) — the program supplies the checker for callable detection. */
  definition:
    | { info: ts.ReferencedSymbolDefinitionInfo; sourceFile: ts.SourceFile; program: ts.Program }
    | undefined;
  /** Every reference site across all programs containing the decl, deduped by file+offset. */
  refs: CrossRef[];
}

/** Union of `findReferences(abs, offset)` over every loaded program containing `abs`, deduped.
 *  `undefined` when NO containing program resolves a symbol there (matches the single-program
 *  `findReferences === undefined` contract callers already branch on). */
export function findReferencesAcross(
  host: TsProjectHost,
  abs: string,
  offset: number,
): CrossReferences | undefined {
  const programs = host.programsContaining(abs);
  // No program contains the decl file — fall back to the primary so a position that resolves only
  // via the primary (e.g. a `file+line+col` the caller already validated) still answers.
  const fanout = programs.length > 0 ? programs : host.programs().slice(0, 1);

  let anyGroups = false;
  let definition: CrossReferences['definition'];
  const refs: CrossRef[] = [];
  const seen = new Set<string>(); // `fileName|start` — a ref two programs both surface counts once

  for (const program of fanout) {
    const groups = program.service.findReferences(abs, offset);
    if (groups === undefined) continue;
    anyGroups = true;
    const tsProgram = program.getProgram();
    if (tsProgram === undefined) continue;
    for (const group of groups) {
      if (definition === undefined && !group.definition.fileName.includes('/node_modules/')) {
        const defSf = tsProgram.getSourceFile(group.definition.fileName);
        if (defSf !== undefined) {
          definition = { info: group.definition, sourceFile: defSf, program: tsProgram };
        }
      }
      for (const ref of group.references) {
        if (ref.fileName.includes('/node_modules/')) continue;
        const key = `${ref.fileName}|${ref.textSpan.start}`;
        if (seen.has(key)) continue;
        const sourceFile = tsProgram.getSourceFile(ref.fileName);
        // A ref the FINDING program can't load is the near-impossible case (it came from that
        // program's own findReferences). We do NOT mark it `seen`, so another containing program
        // gets to load + emit it — only a ref no program can load is dropped, and a span can't be
        // built without a SourceFile anyway. (unused-exports' fan-out, which needs no span, takes
        // the opposite safe default — `used:true` — for the same unloadable case.)
        if (sourceFile === undefined) continue;
        seen.add(key);
        refs.push({
          fileName: ref.fileName,
          rel: host.relOf(ref.fileName),
          start: ref.textSpan.start,
          length: ref.textSpan.length,
          isDefinition: ref.isDefinition === true,
          isWriteAccess: ref.isWriteAccess === true,
          sourceFile,
          program: program.label,
        });
      }
    }
  }

  return anyGroups ? { definition, refs } : undefined;
}
