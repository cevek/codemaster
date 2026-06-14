// Plan a single file/folder move: apply it to the tree (with `.module.scss`/`.css` sibling
// carry, §2.3.5), then hand off to `assemblePlan` (import rewrite + read tree → plain plan).

import type ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type { FsNode } from '../tree/node.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { messageOfThrown } from '../../../../common/result/construct.ts';
import type { RefactorPlan } from '../plan.ts';
import { assemblePlan } from './assemble.ts';

const TS_RE = /\.(tsx?|mts|cts)$/;
const posixDirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};
const posixBasename = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
};

/** Carry a moved TS file's `.module.scss`/`.module.css` neighbour to the same destination,
 *  renamed to match (a structural sibling lookup, §2.3.5). */
function carrySiblings(node: FsNode, destParent: FsNode, destName: string): void {
  if (node.kind !== 'file' || !TS_RE.test(node.initialName)) return;
  const oldBase = node.initialName.replace(TS_RE, '');
  const newBase = destName.replace(TS_RE, '');
  const parent = node.initialParent;
  if (parent === null) return;
  for (const ext of ['.module.scss', '.module.css']) {
    const sibling = parent.childByCurrent(oldBase + ext);
    if (sibling !== undefined) sibling.moveTo(destParent, newBase + ext);
  }
}

export function planMove(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  source: RepoRelPath,
  dest: RepoRelPath,
): RefactorPlan | string {
  const node = tree.findByCurrentPath(source);
  if (node === null) return `source not in the workspace: ${source}`;
  if (tree.findByCurrentPath(dest) !== null) return `destination already exists: ${dest}`;

  const destParent = tree.ensureDirAtCurrent(posixDirname(dest) as RepoRelPath);
  const destName = posixBasename(dest);
  try {
    node.moveTo(destParent, destName);
    // Inside the try: a carried `.module.scss`/`.css` sibling can collide at the dest (a
    // sibling whose dest name is already taken) and `moveTo` throws — return an honest
    // failure string, never let it escape past the op boundary (§3.6).
    carrySiblings(node, destParent, destName);
  } catch (thrown) {
    return `cannot move ${source} → ${dest}: ${messageOfThrown(thrown)}`;
  }
  return assemblePlan(host, tree, options);
}
