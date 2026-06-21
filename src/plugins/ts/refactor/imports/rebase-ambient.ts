// After `extract_symbol` creates the new file at `dest` via the LS "Move to file" refactor, the LS
// has re-emitted every import it could RESOLVE relative to `dest` (TS modules, alias paths) — but it
// COPIED VERBATIM any specifier its resolver declines: an ambient / non-TS module (`*.module.scss`,
// `*.css`), which it never resolves to a real path. That copied specifier was valid from the SOURCE
// file's directory and now points nowhere from `dest` — a broken import the §2.8 typecheck waves
// through (the ambient `declare module '*.module.scss'` matches ANY such specifier). The legacy
// "Move to a new file" path masked this because it staged the file in the source dir then re-targeted,
// so `rewriteImports` rebased it; targeting `dest` directly (the alias-correct importer path) does not.
//
// We rebase EXACTLY those: a specifier that does NOT resolve from `dest` but DOES resolve from the
// SOURCE is re-emitted from `dest`'s dir, preserving its alias-vs-relative form via the shared
// `emitSpecifier`. TS/alias imports — which resolve from `dest` — are left as the LS wrote them.
// Conservative (§1): a specifier resolvable from NEITHER is untouched — a bare package (correctly
// left alone), but ALSO the narrow residual where a path-relative ambient import's sheet sits in an
// UNTRACKED source file (resolves from neither `dest` nor the tree-anchored `source`), so it is not
// rebased and stays broken from `dest` — the ambient `declare module '*'` keeps the §2.8 typecheck
// clean, so this surfaces no error (honest gap, tracked in docs/backlog.md).

import ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { applyEdits, type TextEdit } from '../../../../support/text-edits/apply.ts';
import { emitQuoted } from '../../../../support/text-edits/quote.ts';
import { deriveAliasPrefixes } from '../../alias-paths.ts';
import { resolveSpecifierToNode } from './resolve.ts';
import { emitSpecifier } from './emit.ts';
import { moduleSpecifierOf } from '../ast/specifier.ts';

const posixDirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** Rebase the new file's verbatim-copied ambient imports from the SOURCE's dir to `dest`'s dir.
 *  Mutates the `dest` node's content override in place; a no-op when it has no such import. */
export function rebaseAmbientImports(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  dest: RepoRelPath,
  sourceAbs: string,
): void {
  const node = tree.findByCurrentPath(dest);
  const content = node?.contentOverride();
  if (node === null || content === null || content === undefined) return;

  const aliasPrefixes = deriveAliasPrefixes(host, options);
  const destAbs = host.absOf(dest);
  const destDir = posixDirname(String(dest));
  const sf = ts.createSourceFile(destAbs, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits: TextEdit[] = [];

  const visit = (n: ts.Node): void => {
    const spec = moduleSpecifierOf(n);
    if (spec !== undefined) {
      // Resolves from the new file's OWN location → the LS emitted it correctly (TS / alias import).
      const fromDest = resolveSpecifierToNode(
        host,
        tree,
        options,
        aliasPrefixes,
        destAbs,
        spec.text,
      );
      if (fromDest === null) {
        // Declines from `dest` but resolves from SOURCE → a verbatim-copied ambient import; rebase.
        const fromSource = resolveSpecifierToNode(
          host,
          tree,
          options,
          aliasPrefixes,
          sourceAbs,
          spec.text,
        );
        if (fromSource !== null) {
          const newSpec = emitSpecifier(spec.text, destDir, fromSource, aliasPrefixes);
          if (newSpec !== spec.text) {
            const start = spec.getStart(sf);
            edits.push({ start, end: spec.getEnd(), text: emitQuoted(content, start, newSpec) });
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  if (edits.length > 0) node.setContent(applyEdits(content, edits));
}
