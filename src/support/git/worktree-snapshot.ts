// A mutation's drift fence (t-439159): the working tree's verdict-relevant state, captured before
// the §2.8 gate runs and again right before the write. A relevant difference means the tree the
// §2.8 gate verified is not the tree about to receive the write — the write is refused, never
// landed on unverified ground. Content-hashed rather than stat-compared: the set is bounded by the
// caller's relevance filter, and a hash needs no clock and has no racy-mtime window.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { hasIgnoredDirSegment } from '../fs/ignored-paths.ts';
import { gitRepoFingerprint } from './fingerprint.ts';
import { runGit, type GitRunner } from './run.ts';

export interface WorktreeSnapshot {
  head: string;
  /** Every git-dirty path under the workspace root (untracked included) — the dirty gate reads
   *  touched ∩ this. */
  dirtyPaths: readonly string[];
  /** Relevant dirty path (workspace-root-relative, `../…` outside a subdirectory root) → content
   *  hash, or `absent` for a deleted path. */
  relevant: ReadonlyMap<string, string>;
}

export interface DriftEntry {
  path: string;
  /** Present (or clean) at the first capture, gone at the second. */
  deleted: boolean;
}

const ABSENT = 'absent';

function hashOf(root: string, rel: string): string {
  try {
    return createHash('sha1')
      .update(readFileSync(path.join(root, ...rel.split('/'))))
      .digest('hex');
  } catch {
    return ABSENT;
  }
}

export async function captureWorktree(
  root: string,
  isRelevant: (rel: string) => boolean,
  git: GitRunner = runGit,
): Promise<Result<WorktreeSnapshot>> {
  const fp = await gitRepoFingerprint(root, git);
  if (!isOk(fp)) return fail(fp.failure);
  const relevant = new Map<string, string>();
  for (const rel of [...fp.data.dirtyPaths, ...fp.data.outsideRoot]) {
    if (hasIgnoredDirSegment(rel) || !isRelevant(rel)) continue;
    relevant.set(rel, hashOf(root, rel));
  }
  return ok({ head: fp.data.head, dirtyPaths: fp.data.dirtyPaths, relevant });
}

/** What changed between two captures: `HEAD` when the commit moved, else each relevant path whose
 *  dirtiness or content differs. Empty ⇒ no relevant drift. */
export function worktreeDrift(before: WorktreeSnapshot, after: WorktreeSnapshot): DriftEntry[] {
  const out: DriftEntry[] = before.head !== after.head ? [{ path: 'HEAD', deleted: false }] : [];
  for (const rel of new Set([...before.relevant.keys(), ...after.relevant.keys()])) {
    const was = before.relevant.get(rel);
    const now = after.relevant.get(rel);
    if (was !== now) out.push({ path: rel, deleted: now === ABSENT && was !== ABSENT });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
