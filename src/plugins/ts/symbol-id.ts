// Minting of `ts:` SymbolIds + the synthetic name for module-level enclosers. Shared by
// the query and search modules so the encoding lives in exactly one place (§6).

import type { RepoRelPath } from '../../core/brands.ts';
import { encodeSymbolId } from '../../common/ids/codec.ts';
import { fnv1a64Hex } from '../../common/hash/fnv.ts';
import { toPosix } from '../../support/fs/canonicalize.ts';

/** The workspace-scoping tag baked into every `ts:` SymbolId (`~<rootTag>`) — a stable short hash
 *  of the canonical root. Single-sourced here so a handle minted off the syntactic (host-independent)
 *  path is byte-identical to one the LS host mints (ls-host.ts derives the same). */
export function deriveRootTag(root: string): string {
  return fnv1a64Hex(toPosix(root)).slice(0, 8);
}

export function mintSymbolId(
  name: string,
  rel: RepoRelPath,
  line: number,
  col: number,
  rootTag?: string,
): string {
  // `~<rootTag>` (never present in a name/path/number) marks the workspace the handle was minted
  // in, so resolution can refuse a cross-root rebind (§6 / spec-stresstest §4b). Optional: an
  // untagged id (older handle, hand-built test input) still resolves — it just skips the guard.
  const tag = rootTag !== undefined ? `~${rootTag}` : '';
  return encodeSymbolId('ts', `${name}@${rel}:${line}:${col}${tag}`);
}

/** Display name for a top-level (module-scope) encloser — references not inside any
 *  named declaration roll up to this. */
export function moduleName(rel: RepoRelPath): string {
  const base = rel.split('/').pop() ?? rel;
  return `(top-level ${base})`;
}
