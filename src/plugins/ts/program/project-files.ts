// Shared cross-program file iteration (spec Task G). Every whole-program SYNTACTIC scan that feeds
// a usage / dead-code answer — css-module accesses, i18n `t()` calls, dynamic-import / `export *`
// module edges, `importers_of` — must visit ALL the repo's loaded programs, or a reference living
// only in a sibling (`test/**` under `tsconfig.test.json`) is missed and the dead-code verdict
// LIES (the §3.1 false-dead an agent acts on). This groups every non-node_modules source file by
// the program that FIRST surfaces it (primary preferred), each file appearing once, so:
//   - a file shared by two programs (src/** in both the app and test config) is scanned ONCE,
//     under the PRIMARY program's compilerOptions;
//   - a sibling-only file (test/**) is scanned under ITS program's compilerOptions — so a
//     per-file module-resolution (a `paths`/`baseUrl` alias defined only in the sibling) is honest.

import type ts from 'typescript';
import type { TsProjectHost } from '../ls-host.ts';

export interface ProgramFiles {
  /** The program that first surfaces these files — its `getCompilerOptions()` is the right resolver
   *  for module specifiers in them. */
  program: ts.Program;
  /** Non-node_modules source files first seen in this program (deduped across the whole set). */
  files: ts.SourceFile[];
}

/** Group every non-node_modules source file across all loaded programs by the program that first
 *  surfaces it (primary first). Warms the sibling programs (the lazy cross-program point, §9). */
export function programFileGroups(host: TsProjectHost): ProgramFiles[] {
  const seen = new Set<string>();
  const groups: ProgramFiles[] = [];
  for (const p of host.programs()) {
    const program = p.getProgram();
    if (program === undefined) continue;
    const files: ts.SourceFile[] = [];
    for (const sf of program.getSourceFiles()) {
      if (sf.fileName.includes('/node_modules/')) continue;
      if (seen.has(sf.fileName)) continue; // a file in several programs is scanned once
      seen.add(sf.fileName);
      files.push(sf);
    }
    if (files.length > 0) groups.push({ program, files });
  }
  return groups;
}
