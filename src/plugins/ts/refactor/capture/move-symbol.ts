// Capture-safety for `move_symbol` (§7). Unlike `extract_symbol`/`move_file`, the importer
// rewrites here are emitted by the LS "Move to file" refactor itself — `rewriteImports` never
// runs, so `assemblePlan` records no capture metadata. We reconstruct it: for every importer the
// move TOUCHED, find the import/export specifiers it newly added/changed to bring in the moved
// symbol, and re-resolve each over the POST-EDIT file set through the shared `detectImportCaptures`
// gate. A specifier that now lands on a DIFFERENT same-named, type-compatible export than the
// intended dest (invisible to the §2.8 typecheck) is flagged; one that lands on dest is clean.
//
// CONSERVATIVE (the §1 over-refusal guard): only specifiers the move INTRODUCED are considered —
// an unrelated, pre-existing `import { foo } from './other'` that happens to share the moved name
// is left alone (it was unchanged by the move, so it is not ours to police). Identity is proven by
// a before/after diff of each touched file's moved-name imports, never guessed.

import ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import type { RefactorPlan } from '../plan.ts';
import { detectImportCaptures, type PriorStepState, type RewrittenImport } from './imports.ts';
import type { Capture } from './types.ts';

/** The module specifier string-literal of an import/export/dynamic-import node, if any. */
function moduleSpecifierOf(node: ts.Node): ts.StringLiteral | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier;
  }
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  return undefined;
}

/** Whether an import/export declaration brings in a binding named `name` (default, named, or
 *  aliased `{ name as x }` / re-exported `{ name }`). Two deliberate skips, both UNDER-detection
 *  (the §7-safe direction — a missed rare capture beats a false refusal), with the §2.8 typecheck
 *  the backstop for a true dangle: (1) a namespace import (`* as ns`) is opaque to a name match;
 *  (2) a LOCALLY-RENAMED default import (`import renamed from './dest'` for a moved
 *  `export default name`) matches only on the local name, which differs from `name` — but the LS
 *  "Move to file" does not rewrite default-export importers anyway (it leaves them dangling → the
 *  gate refuses), so this gap is not reachable through this op today. */
function declImportsName(node: ts.Node, name: string): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined) return false;
    if (clause.name !== undefined && clause.name.text === name) return true; // default import (same local name)
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamedImports(named)) {
      return named.elements.some(
        (el) => el.name.text === name || (el.propertyName?.text ?? '') === name,
      );
    }
    return false;
  }
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause;
    if (clause !== undefined && ts.isNamedExports(clause)) {
      return clause.elements.some(
        (el) => el.name.text === name || (el.propertyName?.text ?? '') === name,
      );
    }
    return false;
  }
  return false;
}

/** Specifier texts in `content` that import `name` (one entry per matching declaration). */
function movedNameSpecifiers(fileName: string, content: string, name: string): Set<string> {
  const sf = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    if (declImportsName(stmt, name)) {
      const spec = moduleSpecifierOf(stmt);
      if (spec !== undefined) out.add(spec.text);
    }
  }
  return out;
}

/** Build the `RewrittenImport` set: each before→after-NEW specifier bringing in the moved name,
 *  with the dest as its intended target. */
function reconstructRewrites(
  host: TsProjectHost,
  plan: RefactorPlan,
  destAbs: string,
  movedName: string,
): RewrittenImport[] {
  const out: RewrittenImport[] = [];
  const destPosix = destAbs;
  for (const d of plan.diff) {
    if (d.before === d.after) continue;
    // dest itself receives the declaration, not an import of it — never an importer to police.
    if (host.absOf(d.to) === destAbs) continue;
    const beforeSpecs = movedNameSpecifiers(String(d.from), d.before, movedName);
    const afterSf = ts.createSourceFile(
      String(d.to),
      d.after,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const importerCurrentAbs = host.absOf(d.to);
    for (const stmt of afterSf.statements) {
      if (!declImportsName(stmt, movedName)) continue;
      const spec = moduleSpecifierOf(stmt);
      if (spec === undefined) continue;
      // Only specifiers the move INTRODUCED/CHANGED — a pre-existing same-name import is not ours.
      if (beforeSpecs.has(spec.text)) continue;
      const start = spec.getStart(afterSf);
      const lc = afterSf.getLineAndCharacterOfPosition(start);
      out.push({
        importerCurrentAbs,
        importerCurrentPath: d.to,
        newSpec: spec.text,
        expectedTargetCurrentAbs: destPosix,
        line: lc.line + 1,
        col: lc.character + 1,
      });
    }
  }
  return out;
}

export function detectMoveSymbolCaptures(
  host: TsProjectHost,
  options: ts.CompilerOptions,
  plan: RefactorPlan,
  destArg: RepoRelPath,
  movedName: string | undefined,
  // Cumulative prior-step state when this move is a `transaction` step ≥2 — seeds the resolver so a
  // rewritten specifier re-resolves against prior moves/edits, not pre-transaction disk (E-g, parity
  // with `assemblePlan`'s forward-capture). Absent for the standalone op.
  prior?: PriorStepState,
): Capture[] {
  // No single moved name (unnamed/multi-binding statement) → no name-anchored reconstruction; the
  // §2.8 typecheck remains the backstop. Never fabricate a capture we can't prove (§3).
  if (movedName === undefined) return [];
  const destAbs = host.absOf(destArg);
  const rewrites = reconstructRewrites(host, plan, destAbs, movedName);
  return detectImportCaptures(
    options,
    rewrites,
    plan.overlayFiles,
    plan.removed,
    (rel) => host.absOf(rel),
    prior,
  );
}
