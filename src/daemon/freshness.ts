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
import { walkFiles, type WalkRunner } from '../support/fs/walk.ts';
import { hashFileContent, statFingerprint } from '../support/fs/stat-fingerprint.ts';

export type FreshnessMode = 'git' | 'mtime-walk';

/** The non-git mtime-walk is coalesced: within this window of the last walk a burst of ops
 *  reuses the prior fingerprint instead of re-walking the tree per call (a §1 hazard — work
 *  scaling with repo size). Short, because non-git freshness is best-effort anyway (§19). */
const WALK_TTL_MS = 1000;

/** Wall-clock budget for a single freshness walk. On overrun the walk returns an honest
 *  `timeout` (§1) and the op carries `unverified`, never a silently-stale clean answer. */
const WALK_DEADLINE_MS = 5000;

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
  /** Stat fingerprint of each dirty path at capture. `git status --porcelain` is
   *  content-INSENSITIVE for an already-dirty tracked file (` M path` both before and after a
   *  second edit), so the (head, porcelain) fingerprint alone misses a re-modification. This
   *  lets the equal-fingerprint case catch it by content, hashing only on a racy tie (§3.5/§19). */
  dirtyFps: Map<RepoRelPath, FileFingerprint>;
}

interface WalkState {
  mode: 'mtime-walk';
  files: Map<RepoRelPath, FileFingerprint>;
}

export interface FreshnessGuard {
  check(): Promise<DriftCheck>;
}

/** Did `path`'s content change between two stat fingerprints? A racy size+mtime tie (§19)
 *  escalates to a content hash; a known hash is carried forward so a later tie resolves to
 *  'same'. Mutates `nextFp.contentHash`. A hash read failure counts as changed — never miss a
 *  dirty file (§3.5). Shared by the git and mtime-walk drift checks. */
function fileContentChanged(
  root: string,
  prevFp: FileFingerprint,
  nextFp: FileFingerprint,
): boolean {
  const comparison = compareFingerprints(prevFp, nextFp);
  if (comparison === 'changed') return true;
  if (comparison === 'tie') {
    const hashed = hashFileContent(root, nextFp.path);
    if (!hashed.ok) return true;
    nextFp.contentHash = hashed.hash;
    return prevFp.contentHash === undefined || prevFp.contentHash !== hashed.hash;
  }
  if (prevFp.contentHash !== undefined) nextFp.contentHash = prevFp.contentHash;
  return false;
}

/** Stat every dirty path (cheap, bounded by the dirty set — never a whole-repo walk). A
 *  deleted path is skipped — its removal already shifts porcelain into the drift branch. A
 *  still-present but unstat-able path is also skipped (it just left no baseline fp); rare —
 *  git stat'd it moments ago — and never a false-clean of a content change git can still see. */
function statDirty(
  root: string,
  dirtyPaths: readonly string[],
  nowMs: number,
): Map<RepoRelPath, FileFingerprint> {
  const map = new Map<RepoRelPath, FileFingerprint>();
  for (const p of dirtyPaths) {
    const rel = brandGitPath(p);
    const outcome = statFingerprint(root, rel, nowMs);
    if (outcome.state === 'present') map.set(rel, outcome.fingerprint);
  }
  return map;
}

export function createFreshnessGuard(
  root: string,
  clock: Clock,
  debug: DebugSystem,
  git: GitRunner = runGit,
  walk: WalkRunner = walkFiles,
): FreshnessGuard {
  const trace = debug.ns('resync');
  let state: GitState | WalkState | undefined;
  /** Debounce bookkeeping for the non-git walk (§1). `lastWalkFailure` rides a debounce-hit
   *  so a coalesced answer never launders a timed-out/partial baseline into clean (§3.5). */
  let lastWalkAtMs = 0;
  let lastWalkFailure: ToolFailure | undefined;

  const checkGit = async (): Promise<DriftCheck | undefined> => {
    const captured = await gitRepoFingerprint(root, git);
    if (!isOk(captured)) return undefined;
    const dirtyFps = statDirty(root, captured.data.dirtyPaths, clock.now());
    const next: GitState = { mode: 'git', ...captured.data, dirtyFps };
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
      const all = walk(root, { now: clock.now, deadlineMs: clock.now() + WALK_DEADLINE_MS });
      const allPaths = (all.ok ? all.data : (all.data ?? [])).map((f) => f.path);
      return {
        mode: 'git',
        changed: allPaths,
        cleanAtCommit,
        failure: all.ok ? undefined : all.failure,
      };
    }
    if (prev.fingerprint === next.fingerprint) {
      // HEAD + porcelain identical — but an already-dirty tracked file can be re-modified with
      // NO porcelain-visible change (` M path` both times). Without this content check a warm
      // watcher-OFF daemon serves a stale program for that path: a refactor's `before` then lies
      // and `apply+dirtyOk` silently drops the second edit (§3.5). Stat each dirty path, hashing
      // only a racy size+mtime tie (§19) — bounded by the dirty set, content read only on a tie.
      const changed = new Set<RepoRelPath>();
      for (const [p, nextFp] of next.dirtyFps) {
        const prevFp = prev.dirtyFps.get(p);
        if (prevFp !== undefined && fileContentChanged(root, prevFp, nextFp)) changed.add(p);
      }
      state = next;
      if (changed.size === 0)
        return { mode: 'git', changed: [], cleanAtCommit, failure: undefined };
      trace('git re-dirty', () => ({ changed: changed.size }));
      return { mode: 'git', changed: [...changed].sort(), cleanAtCommit, failure: undefined };
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
    const nowMs = clock.now();
    const prev = state;
    // Debounce (§1): a full re-walk of a non-git tree on every op is itself "per-call work that
    // scales with repo size". Within a short TTL of the last walk, reuse the prior fingerprint —
    // coalescing an op burst into ONE walk. Gated on an existing mtime-walk baseline: a cold start
    // and a git→walk transition MUST walk (to seed / force the reindex). The last walk's failure
    // rides along, so a debounce-hit never dresses a timed-out/partial baseline as clean (§3.5).
    if (prev?.mode === 'mtime-walk' && nowMs - lastWalkAtMs < WALK_TTL_MS) {
      return {
        mode: 'mtime-walk',
        changed: [],
        cleanAtCommit: undefined,
        failure: lastWalkFailure,
      };
    }

    const walked = walk(root, { now: clock.now, deadlineMs: nowMs + WALK_DEADLINE_MS });
    lastWalkAtMs = nowMs;
    lastWalkFailure = walked.ok ? undefined : walked.failure;
    const files = new Map<RepoRelPath, FileFingerprint>();
    const walkedFiles = walked.ok ? walked.data : (walked.data ?? []);
    for (const f of walkedFiles) {
      files.set(f.path, { path: f.path, size: f.size, mtimeMs: f.mtimeMs, recordedAtMs: nowMs });
    }
    const next: WalkState = { mode: 'mtime-walk', files };
    state = next;
    const failure = lastWalkFailure;

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
      // Racy-clean (§19) tie-break + hash carry-forward live in the shared helper.
      if (fileContentChanged(root, prevFp, nextFp)) changed.add(path);
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
