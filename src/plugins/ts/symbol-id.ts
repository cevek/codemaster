// Minting of `ts:` SymbolIds + the synthetic name for module-level enclosers. Shared by
// the query and search modules so the encoding lives in exactly one place (§6).

import type { RepoRelPath } from '../../core/brands.ts';
import { encodeSymbolId } from '../../common/ids/codec.ts';

export function mintSymbolId(name: string, rel: RepoRelPath, line: number, col: number): string {
  return encodeSymbolId('ts', `${name}@${rel}:${line}:${col}`);
}

/** Display name for a top-level (module-scope) encloser — references not inside any
 *  named declaration roll up to this. */
export function moduleName(rel: RepoRelPath): string {
  const base = rel.split('/').pop() ?? rel;
  return `(top-level ${base})`;
}
