// The one minting chokepoint for `RepoRelPath` (ARCHITECTURE.md §19). Two spellings of
// one file MUST brand to one value, or freshness and rebind silently misfire:
//
// - forward slashes always (never `\`);
// - true on-disk casing via `realpathSync.native` — on case-insensitive volumes
//   (APFS/NTFS) it folds `SRC/button.TSX` → `src/Button.tsx` without the lossy
//   lowercase-everything alternative; on case-sensitive volumes it is a no-op;
// - symlinks resolved by policy: the repo *root* is realpathed once; paths inside the
//   repo resolve through the root's real location. A path whose real location escapes
//   the root (a symlink out of the worktree) is refused, not mis-keyed.
// - paths that do not exist (deleted, or about to be created) canonicalize
//   syntactically — stated in the result so callers can treat the casing as unproven.

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { RepoRelPath } from '../../core/brands.ts';

export type MintResult =
  | { ok: true; path: RepoRelPath; casing: 'on-disk' | 'syntactic-only' }
  | { ok: false; message: string };

/** Canonicalize a repo root to its real, absolute, forward-slash form. Throws never —
 *  a vanished root is an expected state (worktree removal, §9). */
export function canonicalizeRoot(
  dir: string,
): { ok: true; root: string } | { ok: false; message: string } {
  try {
    const real = realpathSync.native(path.resolve(dir));
    return { ok: true, root: toPosix(real) };
  } catch (thrown) {
    return { ok: false, message: `cannot canonicalize root '${dir}': ${describe(thrown)}` };
  }
}

/** Mint a `RepoRelPath` for `input` (absolute, or relative to `canonRoot`).
 *  `canonRoot` must come from `canonicalizeRoot`. */
export function mintRepoRelPath(canonRoot: string, input: string): MintResult {
  const absolute = path.isAbsolute(input)
    ? path.normalize(input)
    : path.resolve(fromPosix(canonRoot), input);

  // Resolve true casing / symlinks when the file exists.
  let resolved = absolute;
  let casing: 'on-disk' | 'syntactic-only' = 'syntactic-only';
  try {
    resolved = realpathSync.native(absolute);
    casing = 'on-disk';
  } catch {
    // Path doesn't exist (yet/anymore) — keep the syntactic form, honestly labelled.
  }

  const rel = path.relative(fromPosix(canonRoot), resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      message: `path '${input}' resolves outside the repo root '${canonRoot}' (resolved: '${resolved}')`,
    };
  }
  return { ok: true, path: toPosix(rel) as RepoRelPath, casing };
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Brand a path that came out of git (`status --porcelain`, `diff --name-only`,
 *  `ls-files`). Git already reports repo-relative, forward-slash, on-disk-spelled
 *  paths — exactly the canonical form — so re-minting through `realpath` would only
 *  cost a syscall (and fail for deleted files, which git legitimately reports). */
export function brandGitPath(gitPath: string): RepoRelPath {
  return gitPath as RepoRelPath;
}

function fromPosix(p: string): string {
  return p.split('/').join(path.sep);
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
