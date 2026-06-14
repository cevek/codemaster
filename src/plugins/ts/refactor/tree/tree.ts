// VFSTree — the move/layout container over `FsNode`s (spec §2.3). Lookups go through the
// tree (by initial OR current path), never a flat path map, so chained renames and
// ancestor moves resolve for free. Keyed on `RepoRelPath` (canonical, §2.5) — a robustness
// upgrade over front-renamer's raw case-sensitive string compare (latent miss on APFS/NTFS).

import { FsNode, joinRel, splitRel, type NodeKind } from './node.ts';
import type { RepoRelPath } from '../../../../core/brands.ts';

const ROOT = '' as RepoRelPath;

export class VFSTree {
  readonly root: FsNode;
  /** Every node indexed by its frozen INITIAL path — survives any later move/rename. */
  private readonly byInitialPath = new Map<string, FsNode>();

  constructor() {
    this.root = new FsNode('', 'dir', null);
    this.root.captureInitialPath(ROOT);
    this.byInitialPath.set(ROOT, this.root);
  }

  /** Attach a freshly-created build-time child under `parent` (reusing an existing dir
   *  node when the chain is already built), capturing its frozen initial path and indexing
   *  it. The builder's one primitive (§2.6 seeds from the tracked listing, not `readdir`). */
  attachInitial(parent: FsNode, name: string, kind: NodeKind): FsNode {
    const existing = parent.childByInitial(name);
    if (existing) return existing;
    const node = new FsNode(name, kind, parent);
    parent.addChild(node);
    node.captureInitialPath(joinRel(parent.initialPath(), name));
    this.byInitialPath.set(node.initialPath(), node);
    return node;
  }

  /** Look up by the path a node had at build time (stable identity). */
  findByInitialPath(initialRel: RepoRelPath): FsNode | null {
    return this.byInitialPath.get(initialRel) ?? null;
  }

  /** Look up by following CURRENT names from the root. */
  findByCurrentPath(currentRel: RepoRelPath): FsNode | null {
    let cur: FsNode | null = this.root;
    for (const seg of splitRel(currentRel)) {
      if (!cur) return null;
      cur = cur.childByCurrent(seg) ?? null;
    }
    return cur;
  }

  /** Create a NEW (synthetic) file node under `parent` — e.g. an extract target. Its
   *  initial path equals its current path; the commit plan writes it fresh, not git-mv.
   *  A `byInitialPath` collision is SURFACED, not silently overwritten: a synth file whose
   *  current path matches a node that earlier moved AWAY from that disk location would, on a
   *  blind overwrite, hijack `findByInitialPath` and re-target the moved node's importers
   *  (vfs.ts:262-303). The caller picks a different name and retries. */
  addFileAtCurrent(parent: FsNode, name: string, content: string): FsNode {
    if (parent.kind !== 'dir') throw new Error('addFileAtCurrent: parent must be a dir');
    if (parent.childByCurrent(name)) {
      throw new Error(
        `addFileAtCurrent: file already exists at ${joinRel(parent.currentPath(), name)}`,
      );
    }
    const synthPath = joinRel(parent.currentPath(), name);
    if (this.byInitialPath.has(synthPath)) {
      throw new Error(
        `addFileAtCurrent: byInitialPath collision at ${synthPath} — another node already ` +
          `claims this initial path (likely an earlier move-away from the same disk location). ` +
          `Use a different name and retry.`,
      );
    }
    const node = new FsNode(name, 'file', parent, true);
    parent.addChild(node);
    node.captureInitialPath(synthPath);
    node.setContent(content);
    this.byInitialPath.set(synthPath, node);
    return node;
  }

  /** Make a node findable by an ADDITIONAL `byInitialPath` key, without changing its own
   *  frozen initial path. The extract refactor synthesises a file under the LS-chosen name,
   *  then re-targets it to the requested dest; relative-import resolution inside the file is
   *  anchored at the original (LS-chosen) path, so we KEEP that initial path and add a key
   *  for the final path so external `findByInitialPath(dest)` lookups resolve (vfs.ts:317). */
  rekeyByInitialPath(node: FsNode, newKey: RepoRelPath): void {
    this.byInitialPath.set(newKey, node);
  }

  /** Ensure a directory chain exists at the given CURRENT path, creating synthetic dir
   *  nodes as needed (no disk presence at this location). */
  ensureDirAtCurrent(currentRel: RepoRelPath): FsNode {
    let cur: FsNode = this.root;
    for (const seg of splitRel(currentRel)) {
      let next = cur.childByCurrent(seg);
      if (!next) {
        next = new FsNode(seg, 'dir', cur, true);
        cur.addChild(next);
        next.captureInitialPath(joinRel(cur.currentPath(), seg));
      }
      cur = next;
    }
    return cur;
  }

  /** Every file node, depth-first. */
  *iterFiles(): IterableIterator<FsNode> {
    const stack: FsNode[] = [this.root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      for (const child of node.iterChildren()) {
        if (child.kind === 'file') yield child;
        else stack.push(child);
      }
    }
  }

  /** Every dir node (including the root), depth-first. */
  *iterDirs(): IterableIterator<FsNode> {
    const stack: FsNode[] = [this.root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      yield node;
      for (const child of node.iterChildren()) {
        if (child.kind === 'dir') stack.push(child);
      }
    }
  }
}
