// Compute the ordered on-disk mutation plan from the tree's final layout (spec §2.3) —
// PURE: it emits a `{ moves, newFiles, contentWrites }` plan; the actual `git mv` / writes
// live in the op via `support/git` + `support/text-edits`. Ports the `explainedBy` /
// `actualOnDiskPath` ancestor computation from front-renamer's `engine.commit` (the
// computation, not its `execFileSync`/`fs` side effects).
//
// Key shape decision (§2.3): `moves` and `contentWrites` are NOT disjoint. A moved-AND-
// edited file (the central `move_file` case — its own relative specifiers get rewritten)
// appears in BOTH: git-mv it, then write its override at the CURRENT path. Only synthetic
// `newFiles` are carved out of `contentWrites`.

import { joinRel, type FsNode, type NodeKind } from './node.ts';
import type { VFSTree } from './tree.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';

interface PlannedMove {
  from: RepoRelPath;
  to: RepoRelPath;
  kind: NodeKind;
}
interface PlannedWrite {
  path: RepoRelPath;
  content: string;
}
export interface CommitPlan {
  /** Ordered `git mv` list (dirs before files, shallow before deep). */
  moves: PlannedMove[];
  /** Synthetic files to write fresh (no disk history). */
  newFiles: PlannedWrite[];
  /** Content overrides to write at each file's CURRENT path (independent of `moves`). */
  contentWrites: PlannedWrite[];
}

export const UNSAFE_MOVE_PLAN = 'unsafe move plan:';

export function computeCommitPlan(tree: VFSTree): CommitPlan {
  const movers: FsNode[] = [];
  const newFiles: PlannedWrite[] = [];

  for (const node of tree.iterDirs()) {
    if (node === tree.root || node.synthetic) continue;
    if (node.currentPath() !== node.initialPath()) movers.push(node);
  }
  for (const node of tree.iterFiles()) {
    if (node.synthetic) {
      newFiles.push({ path: node.currentPath(), content: node.contentOverride() ?? '' });
      continue;
    }
    if (node.currentPath() !== node.initialPath()) movers.push(node);
  }

  const moversSet = new Set(movers);
  // A relocation is "explained" by an ancestor move when the node still sits under its
  // INITIAL parent and kept its name — the ancestor's git-mv carries it along (vfs §2.3.1).
  const explainedBy = (n: FsNode): boolean => {
    if (n.parent !== n.initialParent) return false;
    if (n.currentName !== n.initialName) return false;
    let p: FsNode | null = n.initialParent;
    while (p) {
      if (moversSet.has(p)) return true;
      if (p.parent !== p.initialParent) return false; // an ancestor moved away — can't inherit
      p = p.initialParent;
    }
    return false;
  };

  const explicit = movers.filter((n) => !explainedBy(n));
  // Dirs first (so a parent move lands before any inner file rename), then by depth.
  explicit.sort((a, b) => {
    const da = a.kind === 'dir' ? 0 : 1;
    const db = b.kind === 'dir' ? 0 : 1;
    if (da !== db) return da - db;
    return a.initialPath().length - b.initialPath().length;
  });

  // The on-disk `from` of a node is computed off the nearest ALREADY-MOVED ancestor — as
  // moves apply in order, a child's source path shifts under its relocated parent.
  const moved = new Set<FsNode>();
  const actualOnDiskPath = (node: FsNode): RepoRelPath => {
    const trail: string[] = [];
    let cursor: FsNode | null = node;
    while (cursor && cursor.initialParent) {
      if (moved.has(cursor.initialParent)) {
        return joinRel(cursor.initialParent.currentPath(), cursor.initialName, ...trail.reverse());
      }
      trail.push(cursor.initialName);
      cursor = cursor.initialParent;
    }
    return node.initialPath();
  };

  const moves: PlannedMove[] = [];
  for (const node of explicit) {
    const from = actualOnDiskPath(node);
    const to = node.currentPath();
    if (from === to) continue; // no-op move — and crucially NOT marked `moved` (vfs commit)
    moves.push({ from, to, kind: node.kind });
    moved.add(node);
  }

  // A run of moves on one tree (`planMoves`) can stage a path that is BOTH a move source and a
  // destination (refilling a vacated path, or a swap a↔b). The commit applies moves in path-length
  // order, NOT topologically, and synthesizes no temp file — so the first git-mv would clobber
  // bytes a later move needs. `planMoves` refuses the exact-path shapes per move; this catches the
  // rest (e.g. a vacated DIRECTORY refilled) — refuse honestly over corrupting.
  const fromPaths = new Set(moves.map((m) => String(m.from)));
  const clobber = moves.find((m) => fromPaths.has(String(m.to)));
  if (clobber !== undefined) {
    throw new Error(
      `${UNSAFE_MOVE_PLAN} ${clobber.to} is both a source and a destination (chain/cycle needs temp-file ordering, not implemented)`,
    );
  }

  const newPaths = new Set(newFiles.map((f) => f.path));
  const contentWrites: PlannedWrite[] = [];
  for (const node of tree.iterFiles()) {
    if (!node.hasContentOverride() || node.synthetic) continue;
    const at = node.currentPath();
    if (newPaths.has(at)) continue; // a synthetic already writes here
    contentWrites.push({ path: at, content: node.contentOverride() ?? '' });
  }

  return { moves, newFiles, contentWrites };
}
