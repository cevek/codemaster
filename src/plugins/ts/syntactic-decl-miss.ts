// Why a `file` arg is not on the no-program surface — the ONE message that must not guess (§3.6).
//
// All the lookup itself establishes is "this key is not in the surface map". Naming a CAUSE for that
// ("gitignored, or outside the root") without probing is the `importers_of resolved:false` defect
// inverted: a wrong cause carries a wrong remedy, and a plainly git-tracked in-root file whose path the
// agent merely spelled differently was told to stop using the flag. So the cause is probed on disk, and
// where neither branch is established the message states the fact and no cause at all.

import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { mintRepoRelPath } from '../../support/fs/canonicalize.ts';
// The AUTHORITATIVE predicate for what the surface parses — imported, never re-spelled: a near copy here
// would drift from the real one and the miss message would then explain the wrong thing.
import { isScannedSourcePath } from './syntactic-cache.ts';

/** State what is true of `file`, probing before attributing a cause. */
export function missingFileReason(root: string, file: string): string {
  const minted = mintRepoRelPath(root, file);
  if (!minted.ok) {
    return `${file} resolves outside the workspace root — the syntactic path scans source under the root only; pass a repo-relative path, or drop syntactic:true`;
  }
  const abs = path.join(root, minted.path);
  let exists = false;
  let isDir = false;
  try {
    exists = existsSync(abs);
    isDir = exists && statSync(abs).isDirectory();
  } catch {
    // A racing delete / permission error: unknowable, so claim nothing about the cause below.
  }
  if (isDir) {
    return `${minted.path} is a directory, not a file — pass the file that declares the symbol`;
  }
  if (!exists) {
    return `no such file under the workspace root: ${minted.path} — check the path spelling`;
  }
  if (!isScannedSourcePath(minted.path)) {
    return `${minted.path} exists but is not TypeScript source the scan parses (.ts/.tsx/.mts/.cts, excluding .d.ts) — drop syntactic:true for the type-verified path`;
  }
  return `${minted.path} exists but is not on the scanned surface — the scan covers git-tracked plus untracked-not-ignored source, so a gitignored file is absent from it; drop syntactic:true for the type-verified path`;
}
