// SUBTREE-scoped importers (T3) — "who imports ANYTHING under this folder", the engine behind the
// "is it safe to delete this folder?" question. Split out of `importers.ts` (§300-line rule).
//
// Honesty core (§3.4):
//   - EXTERNAL importer (own file OUTSIDE the tree) = a deletion BLOCKER — the headline.
//   - INTERNAL importer (own file INSIDE the tree) = counted + kept, marked non-blocking, never
//     silently dropped.
//   - a spec that does NOT resolve to a file can't be CONFIRMED under the tree → it is FLAGGED
//     `unconfirmed` (only when its relative-lexical target lands under the tree), never raw-string
//     matched (backlog 446a false-LIVE), never counted as a confirmed blocker.
//
// Matching is by RESOLVED target (identity, path-containment under the tree) under EACH program's
// own compilerOptions — never a raw-string compare. A statement two programs both resolve counts
// once (keyed by `at` = file:line). A statement CONFIRMED in any program is never also flagged
// unconfirmed (confirmed wins).

import * as path from 'node:path';
import { toPosix } from '../../support/fs/canonicalize.ts';
import type { TsProjectHost } from './ls-host.ts';
import type { ImporterRow, ImportersView, UnconfirmedRef } from './importers.ts';
import { importedNames, moduleSpecifierOf } from './importers.ts';
import { resolveSpecifier } from './resolve-module.ts';

/** Scan every loaded program for imports whose resolved target sits under `subAbs/`. */
export function findImportersSubtree(
  host: TsProjectHost,
  subRel: string,
  subAbs: string,
): ImportersView {
  const prefix = subAbs.endsWith('/') ? subAbs : `${subAbs}/`;

  // Read-path completeness (§5-L2): load the tree's nearest enclosing tsconfig, so a consumer the
  // loose-root primary globs WITHOUT the alias is searched under the config that defines it. A
  // synthetic probe path under the tree drives `ensureProgramFor`'s dirname-based nearest-config.
  host.ensureProgramFor(`${prefix}__codemaster_subtree_probe__.ts`);

  const external: ImporterRow[] = [];
  const internal: ImporterRow[] = [];
  const confirmedAt = new Set<string>(); // `at` (file:line) — statement identity across programs
  const unconfMap = new Map<string, UnconfirmedRef>(); // at → flag (deduped; dropped if later confirmed)

  for (const p of host.programs()) {
    const program = p.getProgram();
    if (program === undefined) continue;
    const options = program.getCompilerOptions();
    const cache = new Map<string, string | undefined>(); // per-program: options differ
    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.fileName.includes('/node_modules/')) continue;
      const importerInside = toPosix(sourceFile.fileName).startsWith(prefix);
      const importerRel = host.relOf(sourceFile.fileName);
      for (const stmt of sourceFile.statements) {
        const spec = moduleSpecifierOf(stmt);
        if (spec === undefined) continue;
        const lc = sourceFile.getLineAndCharacterOfPosition(stmt.getStart(sourceFile));
        const at = `${importerRel}:${lc.line + 1}`;
        if (confirmedAt.has(at)) continue;

        const resolved = resolveSpecifier(spec, sourceFile.fileName, options, cache);
        if (resolved !== undefined) {
          if (!toPosix(resolved).startsWith(prefix)) continue; // resolves, but not under the tree
          confirmedAt.add(at);
          unconfMap.delete(at); // a confirmed statement is never also unconfirmed
          const row: ImporterRow = {
            at,
            imports: importedNames(stmt),
            target: host.relOf(resolved),
            scope: importerInside ? 'internal' : 'external',
          };
          (importerInside ? internal : external).push(row);
          continue;
        }
        // Unresolvable: flag ONLY a relative spec whose lexical target lands under the tree. An
        // alias/bare spec that fails resolution is NOT lexically expanded — a named limitation
        // (docs/backlog.md), erring toward under-report, never a raw-string false-LIVE.
        if (!isRelative(spec)) continue;
        const lexical = toPosix(path.resolve(path.dirname(sourceFile.fileName), spec));
        if (!lexical.startsWith(prefix)) continue;
        if (!unconfMap.has(at)) {
          unconfMap.set(at, {
            at,
            spec,
            reason: 'spec did not resolve to a file — cannot confirm it imports under the subtree',
          });
        }
      }
    }
  }

  const unconfirmed = [...unconfMap.values()];
  const importers = [...external, ...internal];
  const undiscovered = host.undiscoveredProgramLabels();
  return {
    mode: 'subtree',
    module: subRel,
    subtree: subRel,
    importers,
    external,
    internal,
    unconfirmed,
    total: importers.length,
    ...(undiscovered.length > 0 ? { undiscoveredPrograms: [...undiscovered] } : {}),
  };
}

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}
