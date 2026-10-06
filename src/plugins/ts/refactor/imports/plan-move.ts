// Plan a RUN of file/folder moves on ONE tree: apply each move in order (with `.module.scss`/`.css`
// sibling carry, §2.3.5), then hand off to `assemblePlan` ONCE (import rewrite + read tree → plain
// plan). A single `move_file` is a run of one; a `transaction`'s consecutive `move_file` steps are
// one run, so the whole-tree import rewrite + capture pass is paid once, not per step.

import type ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import type { VFSTree } from '../tree/tree.ts';
import type { FsNode } from '../tree/node.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';
import { messageOfThrown } from '../../../../common/result/construct.ts';
import type { RefactorPlan, PlanningOverlay } from '../plan.ts';
import { assemblePlan } from './assemble.ts';
import { UNSAFE_MOVE_PLAN } from '../tree/commit-plan.ts';

const TS_RE = /\.(tsx?|mts|cts)$/;
const posixDirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};
const posixBasename = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
};

export interface MovePair {
  source: RepoRelPath;
  dest: RepoRelPath;
}

/** A run that could not be planned. `index` is the run position of the move at fault; `undefined`
 *  when the refusal belongs to the run as a whole (the commit plan / import rewrite). */
export interface MoveRunRefusal {
  index: number | undefined;
  message: string;
}

/** Carry a moved TS file's `.module.scss`/`.module.css` neighbour to the same destination,
 *  renamed to match (a structural sibling lookup, §2.3.5). Looked up where the file sits BEFORE
 *  this move, not where the tree was built: a file moved twice in one run has already taken its
 *  neighbour along on the first move. */
function carrySiblings(
  fromParent: FsNode,
  fromName: string,
  destParent: FsNode,
  destName: string,
): void {
  if (!TS_RE.test(fromName)) return;
  const oldBase = fromName.replace(TS_RE, '');
  const newBase = destName.replace(TS_RE, '');
  for (const ext of ['.module.scss', '.module.css']) {
    const sibling = fromParent.childByCurrent(oldBase + ext);
    if (sibling !== undefined) sibling.moveTo(destParent, newBase + ext);
  }
}

function applyMove(tree: VFSTree, source: RepoRelPath, dest: RepoRelPath): string | undefined {
  const node = tree.findByCurrentPath(source);
  if (node === null) return `source not in the workspace: ${source}`;
  if (tree.findByCurrentPath(dest) !== null) return `destination already exists: ${dest}`;
  const fromParent = node.parent;
  const fromName = node.currentName;
  const destParent = tree.ensureDirAtCurrent(posixDirname(dest) as RepoRelPath);
  const destName = posixBasename(dest);
  try {
    node.moveTo(destParent, destName);
    // Inside the try: a carried `.module.scss`/`.css` sibling can collide at the dest (a
    // sibling whose dest name is already taken) and `moveTo` throws — return an honest
    // failure string, never let it escape past the op boundary (§3.6).
    if (node.kind === 'file' && fromParent !== null)
      carrySiblings(fromParent, fromName, destParent, destName);
  } catch (thrown) {
    return `cannot move ${source} → ${dest}: ${messageOfThrown(thrown)}`;
  }
  return undefined;
}

export function planMoves(
  host: TsProjectHost,
  tree: VFSTree,
  options: ts.CompilerOptions,
  moves: readonly MovePair[],
  // The cumulative prior-step overlay when this run follows other `transaction` steps — forwarded
  // to the import-capture gate so it re-resolves against prior moves/edits, not pre-transaction
  // disk (E-g). The run's own moves ride its own `overlayFiles`/`removed`, as for a single move.
  overlay?: PlanningOverlay,
): RefactorPlan | MoveRunRefusal {
  for (const [index, m] of moves.entries()) {
    // The commit applies `git mv` in path order with no temp file, so a path one move vacates and
    // a later move fills (or a swap) would clobber bytes; refuse it at the move that asks for it.
    // `transaction` never reaches this: `moveRunFrom` ends the run before such a move.
    const vacated = moves.slice(0, index).find((prior) => prior.source === m.dest);
    if (vacated !== undefined) {
      return {
        index,
        message: `moves into ${m.dest}, a path an earlier move in this run vacated — a chain that refills a vacated path (or a swap) is not supported; choose a different destination`,
      };
    }
    const error = applyMove(tree, m.source, m.dest);
    if (error !== undefined) return { index, message: error };
  }
  try {
    const plan = assemblePlan(host, tree, options, overlay);
    return typeof plan === 'string' ? { index: undefined, message: plan } : plan;
  } catch (thrown) {
    // Only the commit plan's own refusal is a planning outcome; a cancellation must still reach the
    // deadline boundary as a timeout, and any other throw is a tool fault, not a refusal.
    if (thrown instanceof Error && thrown.message.startsWith(UNSAFE_MOVE_PLAN)) {
      return { index: undefined, message: thrown.message };
    }
    throw thrown;
  }
}
