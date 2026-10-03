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
  for (const abs of absPaths) out.push(...(fileDiagnostics(service, relOf, abs) ?? []));
  return out;
}

/** One file's diagnostics, or `undefined` when the file is not in the program. getSemantic/
 *  SyntacticDiagnostics THROW on such a path (a moved-away old path, a stray check path), so it is
 *  skipped honestly — an absent file has no diagnostics, and a dangling import to it surfaces on
 *  the IMPORTER (which IS in the program) instead. */
export function fileDiagnostics(
  service: ts.LanguageService,
  relOf: (abs: string) => RepoRelPath,
  abs: string,
): TsDiagnostic[] | undefined {
  if (service.getProgram()?.getSourceFile(abs) === undefined) return undefined;
  const diags = [...service.getSyntacticDiagnostics(abs), ...service.getSemanticDiagnostics(abs)];
  return diags.map((d) => toTsDiagnostic(d, abs, relOf));
}

/** The one flattening every gate path uses, so the LS and builder paths are compared like for like. */
export function toTsDiagnostic(
  d: ts.Diagnostic,
  abs: string,
  relOf: (abs: string) => RepoRelPath,
): TsDiagnostic {
  return {
    file: relOf(d.file?.fileName ?? abs),
    line:
      d.file !== undefined && d.start !== undefined
        ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
        : 0,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  };
}
