// The read-time freshness backstop (§3.5 / §8) — THE correctness guarantee; the
// watcher is only an optimization. Every op entry takes a cheap repo-global
// fingerprint: `git rev-parse HEAD` + `git status --porcelain` in a git repo, a
// file-mtime stat-walk rollup (racy-clean-aware, §19) otherwise. Repo-global on
// purpose: it catches the file an answer *omitted* but shouldn't have. On drift the
// changed set goes to every plugin's `reindex`; when the changed set itself can't be
// computed (e.g. the drift `git diff` fails) the op still answers from current plugin
// state but carries `DriftCheck.failure` → `FreshnessNote.unverified`, and no commit
// anchor is stamped — the staleness is stated outright, never silently assumed away (§3.6).

import type { Clock } from '../common/async/clock.ts';
import type { RepoRelPath } from '../core/brands.ts';
import type { ToolFailure } from '../core/result.ts';
import type { DebugSystem } from '../core/debug.ts';
import type { FileFingerprint } from '../common/fingerprint/fingerprint.ts';
import { compareFingerprints } from '../common/fingerprint/compare.ts';
import { isOk } from '../common/result/narrow.ts';
import { gitRepoFingerprint } from '../support/git/fingerprint.ts';
import { gitDiffNames } from '../support/git/diff-changed.ts';
import { runGit, type GitRunner } from '../support/git/run.ts';
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
  git: GitRunner = runGit,
): FreshnessGuard {
  const trace = debug.ns('resync');
  let state: GitState | WalkState | undefined;

  const checkGit = async (): Promise<DriftCheck | undefined> => {
    const captured = await gitRepoFingerprint(root, git);
    if (!isOk(captured)) return undefined;
    const next: GitState = { mode: 'git', ...captured.data };
    const cleanAtCommit =
      next.dirtyPaths.length === 0 && next.head !== 'no-head' ? next.head : undefined;

    const prev = state;
    if (prev === undefined) {
      // Cold first check: plugins index lazily from the current tree, so they start in sync.
      state = next;
      return { mode: 'git', changed: [], cleanAtCommit, failure: undefined };
    }
    if (prev.mode !== 'git') {
      // Mode transition (mtime-walk → git, git just recovered): the two baselines are not
      // comparable, so `changed: []` would be unproven — and the plugins may already be
      // stale from an edit that landed while we were in walk mode. Force a full reindex of
      // the tracked tree (a transition is rare; a stale answer dressed as fresh is the §3.5
      // lie). After the reindex the clean-commit anchor is honest.
      state = next;
      const all = walkFiles(root);
      const allPaths = (all.ok ? all.data : (all.data ?? [])).map((f) => f.path);
      return {
        mode: 'git',
        changed: allPaths,
        cleanAtCommit,
        failure: all.ok ? undefined : all.failure,
      };
    }
    if (prev.fingerprint === next.fingerprint) {
      state = next;
      return { mode: 'git', changed: [], cleanAtCommit, failure: undefined };
    }

    // Drift: committed delta ∪ both captures' dirty sets (a path dirty before and
    // clean now — checkout/stash — has changed too; only the captures know it).
    const changed = new Set<string>([...prev.dirtyPaths, ...next.dirtyPaths]);
    const diff = await gitDiffNames(root, prev.head, next.head, git);
    let failure: ToolFailure | undefined;
    if (isOk(diff)) {
      for (const p of diff.data) changed.add(p);
      // Drift fully resolved — commit the new baseline.
      state = next;
    } else {
      // The committed delta could NOT be computed. Do not advance the baseline: keep
      // `prev` so the next check re-detects this same drift and retries the diff.
      // Advancing here would lose the unresolved delta forever — the next check would see
      // an equal fingerprint, report clean, and stamp a commit anchor over stale plugin
      // data (the §3.5 silent-stale lie). `unverified` stays sticky until a diff succeeds.
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

    if (prev === undefined) {
      // Cold first check: plugins index lazily from the current tree (no reindex needed).
      return { mode: 'mtime-walk', changed: [], cleanAtCommit: undefined, failure };
    }
    if (prev.mode !== 'mtime-walk') {
      // Mode transition (git → mtime-walk, git just went unavailable): incomparable
      // baselines — force a full reindex of the walked tree so a stale plugin state from
      // git mode is never served as fresh (§3.5). walk mode never stamps a commit anchor.
      return {
        mode: 'mtime-walk',
        changed: [...next.files.keys()],
        cleanAtCommit: undefined,
        failure,
      };
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
