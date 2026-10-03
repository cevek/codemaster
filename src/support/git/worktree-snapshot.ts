// A mutation's drift fence (t-439159): the working tree's verdict-relevant state, captured when a
// mutating op starts and again right before it writes. Any difference means the tree the §2.8 gate
// verified is not the tree about to receive the write — the write is refused, never landed on
// unverified ground. Content-hashed rather than stat-compared: the set is bounded by the caller's
// relevance filter, and a hash needs no clock and has no racy-mtime window.

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
  /** Every git-dirty path (untracked included) — the dirty gate reads touched ∩ this. */
  dirtyPaths: readonly string[];
  /** Relevant dirty path → content hash, or `absent` for a deleted path. */
  relevant: ReadonlyMap<string, string>;
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
  for (const rel of fp.data.dirtyPaths) {
    if (hasIgnoredDirSegment(rel) || !isRelevant(rel)) continue;
    relevant.set(rel, hashOf(root, rel));
  }
  return ok({ head: fp.data.head, dirtyPaths: fp.data.dirtyPaths, relevant });
}

/** What changed between two captures: `HEAD` when the commit moved, else each relevant path whose
 *  dirtiness or content differs. Empty ⇒ no verdict-relevant drift. */
export function worktreeDrift(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
  const out: string[] = before.head !== after.head ? ['HEAD'] : [];
  for (const rel of new Set([...before.relevant.keys(), ...after.relevant.keys()])) {
    if (before.relevant.get(rel) !== after.relevant.get(rel)) out.push(rel);
  }
  return out.sort();
}
