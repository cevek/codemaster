// The reverse-import index behind `importersOf` (module mode): one pass over a `ts.Program`'s own
// files maps every import / re-export statement to the file its specifier resolves to, so "who
// imports M" is a lookup instead of a whole-repo re-resolution per call. `affected` calls
// `importersOf` once per closure node; re-resolving every import of the repo on each call scaled as
// nodes × imports (759 calls × ~290 ms on a pnpm monorepo with node_modules — t-006194, §1).
//
// Resolution is the shared `resolveSpecifier` (the one every import-scanning reader goes through), not
// the Program's own `getResolvedModule`: TS reuses a Program — and the module resolutions inside it —
// across a reindex that changes no TS file, so an edited `package.json` `types`/`exports` would keep
// answering the old target, while a fresh resolve sees the new one.
//
// Invalidation authority: the `ts.Program` object AND `projectVersion()`. A new Program (an edit, an
// overlay) gets a new entry; every reindex bumps `projectVersion`, which catches a resolution input
// that does not rebuild the Program (that `package.json`). A program loaded mid-life (`ensureProgramFor`,
// `programs:`) gets its own entry. The gap: a change no reindex reports (an install under gitignored
// `node_modules`) leaves the index as stale as the warm LS itself — the t-710809 class.

import type ts from 'typescript';
import type { TsProjectHost } from './ls-host.ts';
import type { ImporterRow } from './importers.ts';
import { importedNames, moduleSpecifierOf } from './importers.ts';
import { canonPath, resolveSpecifier } from './resolve-module.ts';

export interface ProgramImportIndex {
  /** Canonical (realpath) resolved target → its importer rows, in file → statement order. */
  readonly byTarget: ReadonlyMap<string, readonly ImporterRow[]>;
  /** Raw specifier → rows, for a target that does not resolve to a file (the literal fallback). */
  readonly bySpec: ReadonlyMap<string, readonly ImporterRow[]>;
}

export interface ImportIndexCache {
  of(host: TsProjectHost, program: ts.Program): ProgramImportIndex;
  /** Plugin dispose: drop every entry so nothing outlives the host that built it. */
  clear(): void;
}

function push(map: Map<string, ImporterRow[]>, key: string, row: ImporterRow): void {
  const rows = map.get(key);
  if (rows === undefined) map.set(key, [row]);
  else rows.push(row);
}

function buildIndex(host: TsProjectHost, program: ts.Program): ProgramImportIndex {
  const options = program.getCompilerOptions();
  const resolved = new Map<string, string | undefined>(); // resolveSpecifier's (dir|spec) memo
  const canon = new Map<string, string>();
  const byTarget = new Map<string, ImporterRow[]>();
  const bySpec = new Map<string, ImporterRow[]>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.includes('/node_modules/')) continue;
    for (const stmt of sourceFile.statements) {
      const spec = moduleSpecifierOf(stmt);
      if (spec === undefined) continue;
      const lc = sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile));
      const row: ImporterRow = {
        at: `${host.relOf(sourceFile.fileName)}:${lc.line + 1}`,
        imports: importedNames(stmt),
      };
      push(bySpec, spec, row);
      const target = resolveSpecifier(spec, sourceFile.fileName, options, resolved);
      if (target === undefined) continue;
      let key = canon.get(target);
      if (key === undefined) {
        key = canonPath(target);
        canon.set(target, key);
      }
      push(byTarget, key, row);
    }
  }
  return { byTarget, bySpec };
}

export function createImportIndexCache(): ImportIndexCache {
  let indexes = new WeakMap<ts.Program, { version: number; index: ProgramImportIndex }>();
  return {
    of(host, program) {
      const version = host.projectVersion();
      const hit = indexes.get(program);
      if (hit?.version === version) return hit.index;
      const index = buildIndex(host, program);
      indexes.set(program, { version, index });
      return index;
    },
    clear() {
      indexes = new WeakMap();
    },
  };
}
