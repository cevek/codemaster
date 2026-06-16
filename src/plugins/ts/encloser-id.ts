// The id-vs-display split every encloser rollup needs, in ONE place (§6). An encloser's
// SymbolId MUST be minted on its BARE name token (`idName@line:col`) — never on a qualified
// display string like `Class.method`. Two failures follow a qualified mint: the §6
// same-symbol check (`text.startsWith(idName, offset)`) is false at the bare token, and the
// rebind filter (`searchSymbols(...).filter(c => c.name === idName)`) is empty because navto
// only ever reports the bare member name — so the handle resolves `{status:'gone'}` and the
// rollup hands back a DEAD handle. Minting on the bare token keeps the handle chainable
// (`find_usages → find_definition / source / rename`); the qualified string is display only.
//
// Both encloser-minting sites — `usages.ts`'s `groupBy:'enclosing'` rollup and
// `construction-sites.ts` — route through here, so the id encoding never drifts between them.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import { mintSymbolId } from './symbol-id.ts';

/** A minted encloser handle + the 1-based line/col it anchors on (the bare name token). */
export interface EncloserId {
  id: string;
  line: number;
  col: number;
}

/** Mint a chainable encloser SymbolId on the BARE name token. `idName` is the bare
 *  identifier text (`method`, never `Class.method`); `nameStart` is that token's 0-based
 *  offset in `sourceFile`. The qualified display name is the caller's concern, kept off the
 *  id so re-resolution lands on the exact identifier (§6). */
export function mintEncloserId(
  sourceFile: ts.SourceFile,
  rel: RepoRelPath,
  idName: string,
  nameStart: number,
  rootTag?: string,
): EncloserId {
  const lc = sourceFile.getLineAndCharacterOfPosition(nameStart);
  const line = lc.line + 1;
  const col = lc.character + 1;
  return { id: mintSymbolId(idName, rel, line, col, rootTag), line, col };
}

/** The qualified DISPLAY name of a class member: `Class.member` when the owner is a named
 *  class (declaration OR expression — `const C = class Named { m(){} }`), the bare member
 *  otherwise. Shared by BOTH encloser paths (`usage-roles.ts`'s rollup and
 *  `construction-encloser.ts`) so the two never disagree on how a member reads — the same
 *  no-drift discipline the id mint follows. `isClassLike` (not `isClassDeclaration`) so a
 *  class-expression member qualifies identically in both. */
export function qualifyMember(owner: ts.Node, member: string): string {
  return ts.isClassLike(owner) && owner.name !== undefined
    ? `${owner.name.text}.${member}`
    : member;
}
