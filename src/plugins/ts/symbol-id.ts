// Minting of `ts:` SymbolIds + the synthetic name for module-level enclosers. Shared by
// the query and search modules so the encoding lives in exactly one place (§6).

import type { RepoRelPath } from '../../core/brands.ts';
import { decodeSymbolId, encodeSymbolId } from '../../common/ids/codec.ts';
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

/** The decoded payload of a `ts:` SymbolId — the exact inverse of `mintSymbolId`. */
export type ParsedTsSymbolId = {
  name: string;
  rel: RepoRelPath;
  line: number;
  col: number;
  /** The `~<rootTag>` workspace marker, when the handle carries one (older/hand-built ids don't). */
  rootTag?: string;
};

/** Parse a `ts:` SymbolId, or say honestly why it is not one (§6). Lives next to `mintSymbolId`
 *  because a format with two parsers has two authorities on one question: the semantic handle path
 *  (`rebind-symbol-id.ts`) and the no-program syntactic one (`syntactic-decl.ts`) must agree on what
 *  a handle IS, and on the message an agent gets when it passed the wrong field. Pure — no host, no
 *  filesystem: it only decodes. */
export function parseTsSymbolId(
  id: string,
): { ok: true; parsed: ParsedTsSymbolId } | { ok: false; message: string } {
  const decoded = decodeSymbolId(id);
  // A real SymbolId's payload always carries the `@file` separator (`plugin:Name@rel:line:col`).
  // A value with no usable prefix (a bare name) — OR one whose first `:` is incidental and leaves
  // an `@`-less payload (a `file:line:col` position pasted into the field) — is not a SymbolId at
  // all. Both are known misplaced-input friction, so point the agent at the RIGHT field
  // (`name` / `file+line+col`), not at an opaque "not a SymbolId" or a phantom plugin.
  const looksLikeSymbolId = decoded !== undefined && decoded.payload.includes('@');
  if (decoded === undefined || (!looksLikeSymbolId && decoded.plugin !== 'ts')) {
    return {
      ok: false,
      message: `'${id}' is not a SymbolId (those look like 'ts:Name@file:line:col') — to search by name pass it under 'name', or to address by position pass file+line+col`,
    };
  }
  if (decoded.plugin !== 'ts') {
    return {
      ok: false,
      message: `SymbolId '${id}' belongs to plugin '${decoded.plugin}', not 'ts' — this op resolves ts symbols`,
    };
  }
  const m = decoded.payload.match(/^(.+)@(.+):(\d+):(\d+)(?:~([0-9a-f]+))?$/);
  const name = m?.[1];
  const rel = m?.[2];
  const lineStr = m?.[3];
  const colStr = m?.[4];
  if (name === undefined || rel === undefined || lineStr === undefined || colStr === undefined) {
    return { ok: false, message: `malformed ts SymbolId payload: '${id}'` };
  }
  const tag = m?.[5];
  return {
    ok: true,
    parsed: {
      name,
      rel: rel as RepoRelPath,
      line: Number(lineStr),
      col: Number(colStr),
      ...(tag !== undefined ? { rootTag: tag } : {}),
    },
  };
}

/** Display name for a top-level (module-scope) encloser — references not inside any
 *  named declaration roll up to this. */
export function moduleName(rel: RepoRelPath): string {
  const base = rel.split('/').pop() ?? rel;
  return `(top-level ${base})`;
}
