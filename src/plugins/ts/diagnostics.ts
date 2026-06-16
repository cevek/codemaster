// Collect TS diagnostics for a set of files — the §2.8 typecheck gate behind both the
// dry-run overlay check and the post-apply disk check. Semantic + syntactic, from the same
// LanguageService that drives every other fact (so an apply is verified by the project's
// own TS, not a second opinion). Pure read over the host; the caller wraps → ToolFailure.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { TsProjectHost } from './ls-host.ts';

export interface TsDiagnostic {
  file: RepoRelPath;
  /** 1-based line (editor-clickable), or 0 when the diagnostic has no position. */
  line: number;
  message: string;
}

/** Every semantic + syntactic diagnostic across `absPaths`, flattened to `{file,line,message}`. */
export function collectDiagnostics(
  host: TsProjectHost,
  absPaths: readonly string[],
): TsDiagnostic[] {
  return collectFromService(host.service, (abs) => host.relOf(abs), absPaths);
}

/** Diagnostics from a SPECIFIC program's LanguageService (not necessarily the primary) — the
 *  per-program unit the cross-program write-gate fan-out (§2.8) collects from each affected
 *  program. `relOf` maps absolute → repo-relative for the host's display paths. */
export function collectFromService(
  service: ts.LanguageService,
  relOf: (abs: string) => RepoRelPath,
  absPaths: readonly string[],
): TsDiagnostic[] {
  const out: TsDiagnostic[] = [];
  const program = service.getProgram();
  for (const abs of absPaths) {
    // getSemantic/SyntacticDiagnostics THROW on a path not in the program (a moved-away old
    // path, a stray check path). Skip it honestly — an absent file has no diagnostics, and a
    // dangling import to it surfaces on the IMPORTER (which IS in the program) instead.
    if (program?.getSourceFile(abs) === undefined) continue;
    const diags = [...service.getSyntacticDiagnostics(abs), ...service.getSemanticDiagnostics(abs)];
    for (const d of diags) {
      const line =
        d.file !== undefined && d.start !== undefined
          ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
          : 0;
      out.push({
        file: relOf(d.file?.fileName ?? abs),
        line,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      });
    }
  }
  return out;
}
