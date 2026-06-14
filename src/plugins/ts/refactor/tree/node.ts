// FsNode — one node of the transient move/layout tree (spec §2.3). The NODE is the
// identity: `currentPath()` is computed by walking parent links (so an ancestor move
// carries every descendant for free), `initialPath()` is a frozen build-time snapshot, and
// content overrides are keyed by node identity so they survive moves and renames. A flat
// path→node map would key identity on the mutable location; the tree forecloses that bug
// class structurally.
//
// §2.4: this tree is transient scratch for ONE mutating invocation — serialized, never read
// concurrently — so in-place `rename`/`moveTo`/`setContent` is correct here. The
// build-new-never-mutate-old rule (§8) governs WARM shared plugin state, which this is not.

import type { RepoRelPath } from '../../../../core/brands.ts';

export type NodeKind = 'dir' | 'file';

/** Join repo-relative segments into a canonical `RepoRelPath` (posix `/`, no empty
 *  segments). Inputs are already-canonical names, so the result is canonical — the same
 *  brand-by-cast precedent as `plugins/ts/css-modules.ts`. `''` is the repo root. */
export function joinRel(...segments: string[]): RepoRelPath {
  return segments.filter((s) => s.length > 0).join('/') as RepoRelPath;
}

/** Split a `RepoRelPath` into segments (`''` → none, i.e. the repo root). */
export function splitRel(rel: RepoRelPath): string[] {
  return rel.length === 0 ? [] : rel.split('/');
}

export class FsNode {
  parent: FsNode | null;
  initialName: string;
  currentName: string;
  readonly kind: NodeKind;
  /** True for nodes with no disk backing (`addFileAtCurrent` / `ensureDirAtCurrent`):
   *  files to write fresh rather than git-mv. Replaces front-renamer's `existsSync` probe. */
  readonly synthetic: boolean;
  /** Parent reference AT BUILD TIME — unchanged even after the node is moved, so the
   *  commit plan can tell an ancestor-carried move from an explicit one (§2.3.1). */
  readonly initialParent: FsNode | null;
  private frozenInitialPath: RepoRelPath = '' as RepoRelPath;
  /** Children indexed by INITIAL name (build-time identity). */
  private readonly childrenByInitial = new Map<string, FsNode>();
  /** Children indexed by CURRENT name (updated on rename/move). */
  private readonly childrenByCurrent = new Map<string, FsNode>();
  /** In-memory content override; `null` = use the file on disk (git mv preserves it). */
  private content: string | null = null;

  constructor(name: string, kind: NodeKind, parent: FsNode | null, synthetic = false) {
    this.initialName = name;
    this.currentName = name;
    this.kind = kind;
    this.parent = parent;
    this.initialParent = parent;
    this.synthetic = synthetic;
  }

  /** Freeze this node's build-time path; called once parent linkage is final. */
  captureInitialPath(p: RepoRelPath): void {
    this.frozenInitialPath = p;
  }

  addChild(node: FsNode): void {
    if (this.kind !== 'dir') throw new Error(`addChild on non-dir: ${this.currentPath()}`);
    const colliding = this.childrenByCurrent.get(node.currentName);
    if (colliding && colliding !== node) {
      throw new Error(`addChild: name collision in ${this.currentPath()}: ${node.currentName}`);
    }
    node.parent = this;
    // Claim the initial-name key only when free — never silently overwrite a sibling that
    // re-used the key (a removed-then-re-added synthetic). (vfs.ts:74-79, killed bug.)
    if (!this.childrenByInitial.has(node.initialName)) {
      this.childrenByInitial.set(node.initialName, node);
    }
    this.childrenByCurrent.set(node.currentName, node);
  }

  removeChild(node: FsNode): void {
    // Evict only the map entries that ACTUALLY point at this node, so a sibling re-using
    // the same key is never wrongly removed. (vfs.ts:83-93 — invariant 7.)
    if (this.childrenByInitial.get(node.initialName) === node) {
      this.childrenByInitial.delete(node.initialName);
    }
    if (this.childrenByCurrent.get(node.currentName) === node) {
      this.childrenByCurrent.delete(node.currentName);
    }
  }

  childByInitial(name: string): FsNode | undefined {
    return this.childrenByInitial.get(name);
  }
  childByCurrent(name: string): FsNode | undefined {
    return this.childrenByCurrent.get(name);
  }

  *iterChildren(): IterableIterator<FsNode> {
    // Iterate the CURRENT-name index, the only complete one: two siblings can share an
    // initial name (one arrived via a move after the other vacated its current name), and
    // `childrenByInitial` holds at most one per initial name — iterating it would silently
    // drop the other (a mis-routed move). Current names are unique, enforced on every mutate.
    yield* this.childrenByCurrent.values();
  }

  /** Where the node currently lives (walks parents by CURRENT name). Excludes the root,
   *  so a top-level file is `'src/x.ts'`, not `'/abs/src/x.ts'`. */
  currentPath(): RepoRelPath {
    const segments: string[] = [];
    const seen = new Set<FsNode>();
    let cur: FsNode | null = this;
    while (cur && cur.parent) {
      if (seen.has(cur)) throw new Error(`currentPath: cycle at ${cur.currentName}`);
      seen.add(cur);
      segments.push(cur.currentName);
      cur = cur.parent;
    }
    segments.reverse();
    return joinRel(...segments);
  }

  /** Where the node lived when the tree was built. Stable across moves/renames. */
  initialPath(): RepoRelPath {
    return this.frozenInitialPath;
  }

  /** Rename in place (name only; parent unchanged). Collision-checked FIRST (§2.3.6). */
  rename(newName: string): void {
    if (newName === this.currentName) return;
    if (this.parent) {
      const colliding = this.parent.childByCurrent(newName);
      if (colliding && colliding !== this) {
        throw new Error(`rename: name collision in ${this.parent.currentPath()}: ${newName}`);
      }
      // Same-class private access: re-key only the entry that points at this node.
      if (this.parent.childrenByCurrent.get(this.currentName) === this) {
        this.parent.childrenByCurrent.delete(this.currentName);
      }
    }
    this.currentName = newName;
    if (this.parent) this.parent.childrenByCurrent.set(newName, this);
  }

  /** Move under a new parent (optionally renaming). Cycle- and collision-guarded FIRST. */
  moveTo(newParent: FsNode, newName?: string): void {
    if (newParent.kind !== 'dir') throw new Error('moveTo: new parent must be a dir');
    let walker: FsNode | null = newParent;
    while (walker) {
      if (walker === this) throw new Error(`moveTo: cannot move ${this.currentName} into itself`);
      walker = walker.parent;
    }
    const targetName = newName ?? this.currentName;
    if (this.parent === newParent && targetName === this.currentName) return;
    const colliding = newParent.childByCurrent(targetName);
    if (colliding && colliding !== this) {
      throw new Error(`moveTo: name collision in ${newParent.currentPath()}: ${targetName}`);
    }
    if (this.parent) this.parent.removeChild(this);
    if (newName !== undefined) this.currentName = newName;
    newParent.addChild(this);
    this.parent = newParent;
  }

  setContent(content: string): void {
    this.content = content;
  }
  contentOverride(): string | null {
    return this.content;
  }
  hasContentOverride(): boolean {
    return this.content !== null;
  }
}
