// The read-time freshness backstop (§3.5 / §8) — THE correctness guarantee; the
// watcher is only an optimization. Every op entry takes a cheap repo-global
// fingerprint: `git rev-parse HEAD` + `git status --porcelain` in a git repo, a
// file-mtime stat-walk rollup (racy-clean-aware, §19) otherwise. Repo-global on
// purpose: it catches the file an answer *omitted* but shouldn't have. On drift the
// changed set goes to every plugin's `reindex`; on total failure the drift is
// reported as a `ToolFailure` — never silently assumed away.

import type { Clock } from '../common/async/clock.ts';
import type { RepoRelPath } from '../core/brands.ts';
import type { ToolFailure } from '../core/result.ts';
import type { DebugSystem } from '../core/debug.ts';
import type { FileFingerprint } from '../common/fingerprint/fingerprint.ts';
import { compareFingerprints } from '../common/fingerprint/compare.ts';
import { isOk } from '../common/result/narrow.ts';
import { gitRepoFingerprint } from '../support/git/fingerprint.ts';
import { gitDiffNames } from '../support/git/diff-changed.ts';
import { brandGitPath } from '../support/fs/canonicalize.ts';
import { walkFiles } from '../support/fs/walk.ts';
import { hashFileContent } from '../support/fs/stat-fingerprint.ts';

export type FreshnessMode = 'git' | 'mtime-walk';

export interface DriftCheck {
  mode: FreshnessMode;
  /** Paths changed since the previous check (empty on first check — plugins start
   *  from the current tree anyway). */
  changed: readonly RepoRelPath[];
  /** HEAD commit when the tree is clean — feeds `FreshnessNote.indexedAtCommit`. */
  cleanAtCommit: string | undefined;
  /** Set when neither git nor the walk could establish freshness. The op proceeds
   *  but must carry this failure — an unverified answer must say so. */
  failure: ToolFailure | undefined;
}

interface GitState {
  mode: 'git';
  fingerprint: string;
  head: string;
  dirtyPaths: readonly string[];
}

interface WalkState {
  mode: 'mtime-walk';
  files: Map<RepoRelPath, FileFingerprint>;
}

export interface FreshnessGuard {
  check(): Promise<DriftCheck>;
}

export function createFreshnessGuard(
  root: string,
  clock: Clock,
  debug: DebugSystem,
): FreshnessGuard {
  const trace = debug.ns('resync');
  let state: GitState | WalkState | undefined;

  const checkGit = async (): Promise<DriftCheck | undefined> => {
    const captured = await gitRepoFingerprint(root);
    if (!isOk(captured)) return undefined;
    const next: GitState = { mode: 'git', ...captured.data };
    const cleanAtCommit =
      next.dirtyPaths.length === 0 && next.head !== 'no-head' ? next.head : undefined;

    const prev = state;
    state = next;
    if (prev === undefined || prev.mode !== 'git') {
      return { mode: 'git', changed: [], cleanAtCommit, failure: undefined };
    }
    if (prev.fingerprint === next.fingerprint) {
      return { mode: 'git', changed: [], cleanAtCommit, failure: undefined };
    }

    // Drift: committed delta ∪ both captures' dirty sets (a path dirty before and
    // clean now — checkout/stash — has changed too; only the captures know it).
    const changed = new Set<string>([...prev.dirtyPaths, ...next.dirtyPaths]);
    const diff = await gitDiffNames(root, prev.head, next.head);
    let failure: ToolFailure | undefined;
    if (isOk(diff)) {
      for (const p of diff.data) changed.add(p);
    } else {
      failure = diff.failure;
    }
    trace('git drift', () => ({ from: prev.head, to: next.head, changed: changed.size }));
    return {
      mode: 'git',
      changed: [...changed].sort().map(brandGitPath),
      cleanAtCommit,
      failure,
    };
  };

  const checkWalk = (): DriftCheck => {
    const walked = walkFiles(root);
    const files = new Map<RepoRelPath, FileFingerprint>();
    const nowMs = clock.now();
    const walkedFiles = walked.ok ? walked.data : (walked.data ?? []);
    for (const f of walkedFiles) {
      files.set(f.path, { path: f.path, size: f.size, mtimeMs: f.mtimeMs, recordedAtMs: nowMs });
    }
    const next: WalkState = { mode: 'mtime-walk', files };
    const prev = state;
    state = next;
    const failure = walked.ok ? undefined : walked.failure;

    if (prev === undefined || prev.mode !== 'mtime-walk') {
      return { mode: 'mtime-walk', changed: [], cleanAtCommit: undefined, failure };
    }

    const changed = new Set<RepoRelPath>();
    for (const [path, prevFp] of prev.files) {
      const nextFp = next.files.get(path);
      if (nextFp === undefined) {
        changed.add(path); // removed
        continue;
      }
      const comparison = compareFingerprints(prevFp, nextFp);
      if (comparison === 'changed') changed.add(path);
      else if (comparison === 'tie') {
        // Racy-clean (§19): same size+mtime recorded within the FS resolution
        // window — only content decides. Hash now; compare to a stored hash when we
        // have one, else treat as changed (reindexing a clean file is cheap; missing
        // a dirty one is a lie).
        const hashed = hashFileContent(root, path);
        if (!hashed.ok) {
          changed.add(path);
          continue;
        }
        nextFp.contentHash = hashed.hash;
        if (prevFp.contentHash === undefined || prevFp.contentHash !== hashed.hash) {
          changed.add(path);
        }
      } else if (prevFp.contentHash !== undefined) {
        // Carry forward known hashes so future ties can resolve to 'same'.
        nextFp.contentHash = prevFp.contentHash;
      }
    }
    for (const path of next.files.keys()) {
      if (!prev.files.has(path)) changed.add(path); // added
    }
    if (changed.size > 0) trace('walk drift', () => ({ changed: changed.size }));
    return {
      mode: 'mtime-walk',
      changed: [...changed].sort(),
      cleanAtCommit: undefined,
      failure,
    };
  };

  return {
    async check() {
      const git = await checkGit();
      if (git !== undefined) return git;
      return checkWalk();
    },
  };
}
