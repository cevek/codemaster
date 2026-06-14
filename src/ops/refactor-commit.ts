// Execute / roll back a refactor plan on disk. `commitMove` git-mv's each move (history
// kept), then writes new files and content overrides at their current paths. `revertMove`
// restores the PRE-OP content of every touched path and removes everything the op created —
// it does NOT restore to HEAD, so a touched file that had uncommitted edits (a `dirtyOk`
// apply) is rolled back to those edits, not silently overwritten (data loss + false report).

import * as path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import type { Result } from '../core/result.ts';
import type { RepoRelPath } from '../core/brands.ts';
import { ok, fail, messageOfThrown } from '../common/result/construct.ts';
import { isOk } from '../common/result/narrow.ts';
import { gitMove, gitUnstage } from '../support/git/mutate.ts';
import { writeFileAtomic } from '../support/text-edits/write.ts';
import { absOf } from './mutation-support.ts';

export interface CommitMovePlan {
  moves: ReadonlyArray<{ from: RepoRelPath; to: RepoRelPath; kind: 'file' | 'dir' }>;
  newFiles: ReadonlyArray<{ path: RepoRelPath; content: string }>;
  contentWrites: ReadonlyArray<{ path: RepoRelPath; content: string }>;
}

/** What rollback needs: the pre-op bytes to write back, and the paths the op created. */
export interface RevertSpec {
  /** Pre-op content for each path that existed before the op (moved-from + edited-in-place). */
  restore: ReadonlyArray<{ path: RepoRelPath; content: string }>;
  /** Paths the op created (move targets + new files) — removed from index + worktree. */
  remove: ReadonlyArray<RepoRelPath>;
}

export async function commitMove(root: string, plan: CommitMovePlan): Promise<Result<true>> {
  for (const m of plan.moves) {
    try {
      mkdirSync(path.dirname(absOf(root, m.to)), { recursive: true }); // git mv won't create it
    } catch (thrown) {
      return fail({
        tool: 'fs',
        message: `could not create dir for ${m.to}: ${messageOfThrown(thrown)}`,
      });
    }
    const moved = await gitMove(root, m.from, m.to);
    if (!isOk(moved)) return moved;
  }
  for (const f of [...plan.newFiles, ...plan.contentWrites]) {
    const w = writeFileAtomic(absOf(root, f.path), f.content);
    if (!w.ok) return fail(w.failure);
  }
  return ok(true);
}

export async function revertMove(
  root: string,
  spec: RevertSpec,
): Promise<{ complete: boolean; failed: string[]; note?: string }> {
  const failed: string[] = [];

  // Unstage everything the op staged (the git-mv), so the index reflects the restored
  // worktree rather than a dangling rename. The worktree restore below is the DATA guarantee;
  // a failed unstage leaves only the index carrying the staged rename — report it (don't
  // overclaim a fully clean revert) but don't mark the revert incomplete (no data was lost).
  let note: string | undefined;
  const unstaged = await gitUnstage(root, [...spec.restore.map((r) => r.path), ...spec.remove]);
  if (!isOk(unstaged))
    note = `git index not reset (${unstaged.failure.message}); worktree restored`;

  // Remove created paths (move targets + new files) from the worktree.
  for (const p of spec.remove) {
    try {
      rmSync(absOf(root, p), { recursive: true, force: true });
    } catch {
      failed.push(String(p));
    }
  }
  // Restore pre-op bytes to each pre-op path (dirty-safe — `before` is what was actually
  // there when the op started, uncommitted edits included).
  for (const r of spec.restore) {
    if (!writeFileAtomic(absOf(root, r.path), r.content).ok) failed.push(String(r.path));
  }
  return { complete: failed.length === 0, failed, ...(note !== undefined ? { note } : {}) };
}
