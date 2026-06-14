// Seed a VFSTree from the tracked file listing (§2.6) — git `ls-files`, the exact
// gitignore-aware set, NOT `fs.readdir`. ls-files yields files only, so the directory
// chain is SYNTHESISED by splitting each path. Empty dirs never appear; they matter only
// to commit-time pruning, which runs on the real tree at apply.

import type { Result } from '../../../../core/result.ts';
import { fail, ok } from '../../../../common/result/construct.ts';
import { isOk } from '../../../../common/result/narrow.ts';
import { gitLsFiles } from '../../../../support/git/ls-files.ts';
import { brandGitPath } from '../../../../support/fs/canonicalize.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { splitRel } from './node.ts';
import { VFSTree } from './tree.ts';

/** Build a tree from a repo-relative file listing. Pure — the I/O (git) is the caller's. */
export function buildTree(listing: readonly RepoRelPath[]): VFSTree {
  const tree = new VFSTree();
  for (const rel of listing) {
    const segments = splitRel(rel);
    let parent = tree.root;
    for (const [index, segment] of segments.entries()) {
      const kind = index === segments.length - 1 ? 'file' : 'dir';
      parent = tree.attachInitial(parent, segment, kind);
    }
  }
  return tree;
}

/** Build the tree from the workspace's git `ls-files`. Wrapped → `ToolFailure` on a git
 *  failure (§3.6), never a throw. */
export async function loadTreeFromGit(root: string): Promise<Result<VFSTree>> {
  const listing = await gitLsFiles(root);
  if (!isOk(listing)) return fail(listing.failure);
  return ok(buildTree(listing.data.map(brandGitPath)));
}
