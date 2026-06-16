// Rewrite every importer's specifiers to follow the tree's moves. For each TS file: parse,
// walk import/export/dynamic-import specifiers, resolve each to a tree node, and — when that
// node moved (or this importer moved) — emit a new specifier from the importer's current dir.
// Edits go through Stage A's `applyEdits` (overlap/ordering guarantees), the new content is
// stored as the node's override (so the commit plan writes it). The moved file's OWN imports
// are rewritten here too (it is iterated like any other) — the central move_file case.

import ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { applyEdits, type TextEdit } from '../../../../support/text-edits/apply.ts';
import { emitQuoted } from '../../../../support/text-edits/quote.ts';
import type { RewrittenImport } from '../capture/imports.ts';
import { resolveSpecifierToNode } from './resolve.ts';
import { deriveAliasPrefixes } from '../../alias-paths.ts';
import { emitSpecifier } from './emit.ts';
import { moduleSpecifierOf } from '../ast/specifier.ts';

export interface ImportRewrite {
  /** Files whose import text changed, keyed by current path. */
  changed: Map<string, { before: string; after: string }>;
  /** Per-specifier capture-detection metadata (§ capture-safety): each rewritten import with the
   *  target it was pointed at, so the move/extract gate can confirm it still resolves there. */
  rewrites: RewrittenImport[];
}

const posixDirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

export function rewriteImports(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
): ImportRewrite {
  const aliasPrefixes = deriveAliasPrefixes(host, options);
  const program = host.service.getProgram();
  const changed = new Map<string, { before: string; after: string }>();
  const rewrites: RewrittenImport[] = [];

  for (const node of tree.iterFiles()) {
    // Include .js/.jsx/.mjs/.cjs importers, not just TS: an allowJs project has them in the
    // program, and TS never `checkJs`-typechecks them, so a missed rewrite of a .js importer
    // of a moved module dangles silently past the §2.8 gate. A .js NOT in the program is
    // skipped below (its `before` is undefined) — so this is safe in a TS-only repo too.
    if (!/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(node.currentName)) continue;
    const initialAbs = host.absOf(node.initialPath());
    // Prefer an existing content override (an extract already edited this file via the LS) —
    // so we rewrite the post-edit text, not the stale program text. For a plain move no
    // override exists yet, so this reads the program exactly as before.
    const before = node.contentOverride() ?? program?.getSourceFile(initialAbs)?.text;
    if (before === undefined) continue; // not in the program — nothing to parse
    const sf = ts.createSourceFile(
      initialAbs,
      before,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const importerCurrentDir = posixDirname(String(node.currentPath()));
    const importerMoved = node.currentPath() !== node.initialPath();
    const edits: TextEdit[] = [];

    const visit = (n: ts.Node): void => {
      const spec = moduleSpecifierOf(n);
      if (spec !== undefined) {
        const target = resolveSpecifierToNode(
          host,
          tree,
          options,
          aliasPrefixes,
          initialAbs,
          spec.text,
        );
        if (target !== null) {
          const targetMoved = target.currentPath() !== target.initialPath();
          if (targetMoved || importerMoved) {
            const newSpec = emitSpecifier(spec.text, importerCurrentDir, target, aliasPrefixes);
            if (newSpec !== spec.text) {
              const start = spec.getStart(sf);
              edits.push({ start, end: spec.getEnd(), text: emitQuoted(before, start, newSpec) });
              // Record the rewrite so the move/extract gate can confirm the EMITTED specifier
              // still resolves to `target` post-move (a path-capture the typecheck can't see).
              // Line/col read off the BEFORE text — a specifier rewrite never adds/removes lines.
              const lc = sf.getLineAndCharacterOfPosition(start);
              rewrites.push({
                importerCurrentAbs: host.absOf(node.currentPath()),
                importerCurrentPath: node.currentPath() as RepoRelPath,
                newSpec,
                expectedTargetCurrentAbs: host.absOf(target.currentPath()),
                line: lc.line + 1,
                col: lc.character + 1,
              });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);

    if (edits.length > 0) {
      const after = applyEdits(before, edits);
      node.setContent(after);
      changed.set(String(node.currentPath()), { before, after });
    }
  }
  return { changed, rewrites };
}
