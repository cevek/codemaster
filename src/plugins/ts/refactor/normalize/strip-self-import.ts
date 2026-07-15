// Post-LS normalizer that removes a SELF-IMPORT from a relocated file: an `import … from '<self>'`
// whose specifier resolves to the file it sits in. The TS "Move to file" refactor emits one when the
// moved symbol references another symbol that ALREADY lives in the destination — it naively carries the
// reference's import and retargets it to the dep's home file, which is now the dest (co-move of
// mutually-referencing symbols into one module: `move_symbol X → dest` where dest already declares X's
// dep). The result is `import { Dep } from './dest'` INSIDE `./dest` → `Import declaration conflicts with
// local declaration of 'Dep'`, a typecheck error the §2.8 gate correctly REFUSES on — so the co-move
// can't complete. An import from a module that IS this file is always redundant (the names are local),
// so dropping the whole declaration is safe and correct; the gate remains the backstop for anything else.
//
// Self-resolution is LEXICAL (relative join+normalize, or an alias re-map) rather than tree/disk lookup:
// the dest may be a NEW file (extract) not yet on disk, and a not-yet-tracked node has no initial path
// for the module resolver to find — a lexical compare against the dest's own path works for both.

import ts from 'typescript';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { applyEdits, type TextEdit } from '../../../../support/text-edits/apply.ts';
import { aliasMappedRel, type AliasPrefix } from '../../alias-paths.ts';
import { deleteWholeLine } from '../ast/delete-line.ts';
import { normalizePosix, posixDirname } from '../ast/posix.ts';

const MODULE_EXT_RE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

/** The extensionless module key(s) a specifier could resolve to `destRel` as. A `.../index` file is
 *  also addressable by its directory, so both forms count as self. */
function selfKeys(destRel: string): ReadonlySet<string> {
  const noExt = destRel.replace(MODULE_EXT_RE, '');
  const keys = new Set<string>([noExt]);
  if (noExt.endsWith('/index')) keys.add(noExt.slice(0, -'/index'.length));
  return keys;
}

/** Whether `spec`, written in `destRel`, resolves back to `destRel` itself. */
function resolvesToSelf(
  spec: string,
  destRel: string,
  keys: ReadonlySet<string>,
  aliasPrefixes: readonly AliasPrefix[],
): boolean {
  let candidate: string | undefined;
  if (spec.startsWith('.')) {
    const dir = posixDirname(destRel);
    candidate = normalizePosix(dir === '' ? spec : `${dir}/${spec}`);
  } else {
    const mapped = aliasMappedRel(aliasPrefixes, spec);
    candidate = mapped ?? undefined;
  }
  if (candidate === undefined) return false;
  return keys.has(candidate.replace(MODULE_EXT_RE, ''));
}

/** Remove every `import … from '<self>'` declaration from `content` (dest at `destRel`). Only static
 *  import declarations are touched — a self re-export / dynamic import is out of scope (and not the
 *  observed defect). No self-import → returned byte-for-byte. */
export function stripSelfImports(
  content: string,
  destRel: RepoRelPath,
  aliasPrefixes: readonly AliasPrefix[],
): string {
  const sf = ts.createSourceFile(
    '__self__.tsx',
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const keys = selfKeys(destRel);
  const edits: TextEdit[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!resolvesToSelf(stmt.moduleSpecifier.text, destRel, keys, aliasPrefixes)) continue;
    edits.push(deleteWholeLine(content, sf, stmt));
  }
  return edits.length === 0 ? content : applyEdits(content, edits);
}
