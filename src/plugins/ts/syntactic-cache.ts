// The projectVersion-independent cache behind the no-program syntactic paths (`search_symbol
// { syntactic: true }`, `symbols_overview`, `source { syntactic: true }`) — a single-slot
// memo of the parsed §10 source surface, keyed on a repo-state fingerprint the SYNTACTIC path can
// trust (t-515730 dir.2). It lives at the ts-plugin boundary (created + `clear()`-ed with the
// plugin, mirroring the `literalCalls`/`functionDeclarations` scan memos §3.1); the engine stays
// host-independent and receives it as a parameter.
//
// WHY NOT projectVersion: that stamp only bumps on a host reindex, and a reindex only fires when the
// daemon's (HEAD, porcelain) freshness drifts — which is CONTENT-INSENSITIVE for a re-modified
// already-untracked file (porcelain reads `?? f` before AND after). The §10 surface INCLUDES such
// files (untracked-not-ignored, .mts/.cts, member-only) — outside any program — so a projectVersion
// key would serve a stale parse = a silent miss (§3.4/§3.5). So we key on our own fingerprint.
//
// GIT-MODE HOT PATH is O(changed+untracked), with no per-query stat-walk of the whole tree (that is
// the ls-host per-call tree-scan hang-class §1). The key = HEAD ⊕ the porcelain string ⊕ an
// mtimeNs+size tie-break taken ONLY over the porcelain dirty+untracked set (bounded, exactly the §19
// "re-stat the dirty set" rule). The tie-break is what catches an untracked-file MODIFY whose
// porcelain line is unchanged.
//
// WALK MODE (no git to ask) has no cheap fingerprint available: the walk IS the state, so a bounded
// tree walk runs per call — deadline-capped like the freshness walk it mirrors, and keyed on its own
// BOUND as well as its files, so a scan that missed a subtree can never be cached as a complete one.
// In either mode a full re-list + re-parse happens ONLY on a key change (drift).

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { fnv1a64Hex } from '../../common/hash/fnv.ts';
import { DEFAULT_MTIME_RESOLUTION_MS } from '../../common/fingerprint/compare.ts';
import { brandGitPath } from '../../support/fs/canonicalize.ts';
import { hashFileContent } from '../../support/fs/stat-fingerprint.ts';
import { walkFiles, type WalkRunner } from '../../support/fs/walk.ts';
import { runGitSync } from '../../support/git/run.ts';

const GIT_TIMEOUT_MS = 15_000;
/** Wall-clock budget for one surface walk — the value `daemon/freshness.ts` uses for the same walk on
 *  the same trees, so the two non-git paths degrade at the same point rather than at two. */
const WALK_DEADLINE_MS = 5000;
const NUL = String.fromCharCode(0);

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts)$/;
const DECLARATION_EXT = /\.d\.(?:ts|mts|cts)$/; // navto excludeDtsFiles:true — .d.ts carry no user symbols in scope

/** The files the syntactic scan actually parses: `.ts/.tsx/.mts/.cts`, minus `.d.ts`. SINGLE-SOURCED
 *  here so the surface build (`surfaceSources`) and the cache-key content hash (`computeSurfaceKey`)
 *  cover EXACTLY the same set — a dirty non-source file (a multi-MB lockfile, a data dump) is never
 *  read/hashed on the hot path (§1: no per-call work scaling with dirty-content size), and its
 *  content cannot change what the scan returns anyway. Add/remove of ANY file still moves the key via
 *  the raw porcelain string; only the content-hash loop is scoped to the parsed set. */
export function isScannedSourcePath(rel: string): boolean {
  return SOURCE_EXT.test(rel) && !DECLARATION_EXT.test(rel);
}

/** The cached, parsed §10 surface: repo-relative path → its parsed SourceFile. `getNamedDeclarations`
 *  memoizes on the SourceFile itself, so a repeat query over an unchanged surface is cheap. */
export type SyntacticSources = Map<RepoRelPath, ts.SourceFile>;

/** WHICH mechanism listed the surface. `git` is the default and the one the static scope prose
 *  describes; `walk` is the non-git degrade (a bounded filesystem walk, §19) whose coverage differs
 *  in BOTH directions, so every answer built on it says so (§3.6). Never inferred by a consumer —
 *  it is carried, because the absence of a mode line must not read as a claim we did not establish. */
export type SurfaceOrigin = 'git' | 'walk';

/** Where the surface came from and what it could not reach — everything an answer needs to state its
 *  own scope, WITHOUT the parsed sources (an op states provenance; it never re-reads the surface). */
export interface SurfaceProvenance {
  origin: SurfaceOrigin;
  /** Walk mode: git's own refusal, so "why the degrade" is a fact, not a guess. */
  gitUnavailable?: string;
  /** A bound the listing hit (un-followed symlink, entry/depth cap, unreadable subtree) — carried
   *  verbatim to the answer. Swallowing it would make an incomplete scan read as a complete one. */
  incomplete?: string;
}

/** The parsed surface plus its provenance. */
export interface SyntacticSurface extends SurfaceProvenance {
  sources: SyntacticSources;
}

/** The provenance of the surface currently memoized, or `undefined` when none is — read by an op
 *  AFTER the call that built the surface, so it reports the mechanism that produced THAT answer. The
 *  engine serializes a workspace's requests (§8), so nothing rebuilds the slot in between. */
export function surfaceProvenance(cache: SyntacticCache): SurfaceProvenance | undefined {
  const current = cache.current;
  if (current === undefined) return undefined;
  const { origin, gitUnavailable, incomplete } = current.surface;
  return {
    origin,
    ...(gitUnavailable !== undefined ? { gitUnavailable } : {}),
    ...(incomplete !== undefined ? { incomplete } : {}),
  };
}

/** Single-slot memo held per ts-plugin instance. `clear()` on dispose (a re-warm must not reuse a
 *  stale slot — same discipline as the scan memos). */
export interface SyntacticCache {
  current?: { key: string; surface: SyntacticSurface };
}

export function createSyntacticCache(): SyntacticCache {
  return {};
}

export function clearSyntacticCache(cache: SyntacticCache): void {
  delete cache.current;
}

/** The repo-state fingerprint keying the parsed-surface cache, plus WHICH mechanism established it.
 *  In `walk` mode the same walk that produced the key also produced the listing — carried here so the
 *  surface build reuses it instead of walking the tree twice. */
/** Test seams for the non-git branch (§16: fault/pin through a seam, never by breaking the host).
 *  Production passes neither — the real walk and the real clock. */
export interface SurfaceSeams {
  walk?: WalkRunner;
  now?: () => number;
}

export interface SurfaceKey {
  key: string;
  origin: SurfaceOrigin;
  /** Walk mode only: the listing + why git was unavailable + any bound the walk hit. */
  walked?: { files: readonly string[]; gitUnavailable: string; incomplete?: string };
}

/** The repo-state fingerprint keying the parsed-surface cache. In a git repo it is bounded by the
 *  changed+untracked set (git's own porcelain scan + a content hash per dirty source path), NEVER the
 *  whole surface (§1 hot-path rule).
 *
 *  A git failure is NOT a dead end: a non-git workspace (or a repo git cannot read) degrades to the
 *  same bounded filesystem walk `daemon/freshness.ts` already falls back to (§3.5/§19) — the §10
 *  program file-set degrades to the name-ignore set on a non-git root too, so hard-failing here would
 *  be the outlier, not the rule. The mode rides on the result; it is never silently absorbed.
 *  Walk mode costs one bounded walk per CALL — the walk IS the state, so the key cannot be taken
 *  without it, and the expensive half (re-listing + re-parsing) still fires only on drift. Non-git
 *  freshness runs its own walk per op and coalesces it behind a short TTL, which this one does not;
 *  sharing a single walk is t-950675. Bounded four ways: no symlink is followed, depth and entry
 *  count are capped, and a wall-clock deadline stops it. */
export function computeSurfaceKey(root: string, seams?: SurfaceSeams): Result<SurfaceKey> {
  const head = runGitSync(root, ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  // A pre-first-commit repo has no HEAD; that is not a failure — fold an empty marker and rely on
  // porcelain (which lists every file as untracked in an unborn repo) for the state.
  const headKey = isOk(head) ? head.data.trim() : '<unborn>';
  const status = runGitSync(root, ['status', '--porcelain', '-z', '--untracked-files=all'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!isOk(status)) return walkSurfaceKey(root, status.failure.message, seams);
  const porcelain = status.data;
  // CONTENT-hash each path porcelain already enumerated (bounded by the changed+untracked set, never
  // the surface — §1 hot-path rule): so an untracked-file MODIFY (unchanged porcelain line) still
  // moves the key. Content — not mtime+size — is what the §19 racy-clean rule requires (compare.ts /
  // stat-fingerprint.ts): a same-size same-tick edit on a coarse-mtime FS (darwin/HFS+/FAT/network)
  // keeps an identical stamp, so mtime cannot decide; a content hash always can. An unreadable path
  // (deleted, or a submodule DIRECTORY) folds its stable error marker.
  // KNOWN BOUND (shared with the daemon's own freshness, NOT syntactic-specific): a dirty SUBMODULE
  // shows as ONE path-level porcelain line (` M sub`), so an edit to a file INSIDE an already-dirty
  // submodule is not enumerated here and its content is not re-hashed → a stale parse until the
  // submodule's porcelain status itself flips. daemon/freshness.ts re-stats the SAME dir-level dirty
  // path, so navto is stale in the identical case; tracked as platform-freshness follow-up t-948614.
  let content = '';
  for (const entry of porcelain.split(NUL)) {
    if (entry.length === 0) continue;
    const rel = entry.slice(3); // strip the 2-char XY status + its trailing space
    if (rel.length === 0) continue;
    // Hash ONLY the files the scan parses (§1 hot-path): a dirty non-source file's content cannot
    // change the result, so reading a multi-MB dirty lockfile/data-dump every query is pure waste.
    if (!isScannedSourcePath(rel)) continue;
    const h = hashFileContent(root, brandGitPath(rel));
    content += h.ok ? `${rel}:${h.hash}\n` : `${rel}:${h.message}\n`;
  }
  return ok({ key: fnv1a64Hex(`${headKey}\n${porcelain}\n${content}`), origin: 'git' });
}

/** The non-git state key: one bounded walk (§19) whose (path, size, mtime) rollup IS the key, with
 *  the §19 racy-clean escalation applied by the SAME window `compareFingerprints` uses — a file
 *  modified within that window of the walk cannot be distinguished by its stamp (a same-tick,
 *  same-size edit keeps it), so its content is hashed instead. Bounded by the recently-touched set,
 *  the walk-mode analogue of git mode hashing exactly the porcelain-dirty paths.
 *
 *  A walk that reaches NO source file while reporting a bound FAILS the call; one that reached some
 *  answers and carries its bound. The test is the SOURCE FILES produced, not the shape of the
 *  envelope: `walkFiles` degrades an unreadable root to `partial([], …)` rather than a bare failure,
 *  so a data-presence check passes it through and an unlistable root would answer `names: 0` — a
 *  proven-looking absence built on a directory nobody could read (§3.4). A CLEAN walk finding no
 *  source is a different fact and stays an honest empty. */
function walkSurfaceKey(
  root: string,
  gitUnavailable: string,
  seams: SurfaceSeams | undefined,
): Result<SurfaceKey> {
  const walk = seams?.walk ?? walkFiles;
  const now = seams?.now ?? Date.now;
  // The same wall-clock bound `daemon/freshness.ts` gives its own non-git walk (§19). This walk is
  // SYNCHRONOUS, so the op's cooperative `Deadline` cannot cut it and, in-process, it blocks the loop
  // for every workspace — the depth/entry caps bound it in the abstract, but a slow or network mount
  // reaches them in minutes. An overrun degrades through `incomplete`, which is keyed below, so a
  // timed-out scan can never be cached as a complete one.
  const walked = walk(root, { now, deadlineMs: now() + WALK_DEADLINE_MS });
  const incomplete = walked.ok ? undefined : walked.failure.message;
  const nowMs = now();
  const files: string[] = [];
  let rollup = '';
  for (const f of walked.data ?? []) {
    if (!isScannedSourcePath(f.path)) continue;
    files.push(f.path);
    const racy = nowMs - f.mtimeMs < DEFAULT_MTIME_RESOLUTION_MS;
    if (racy) {
      const h = hashFileContent(root, f.path);
      rollup += h.ok ? `${f.path}:${h.hash}\n` : `${f.path}:${h.message}\n`;
    } else rollup += `${f.path}:${f.size}:${f.mtimeMs}\n`;
  }
  if (incomplete !== undefined && files.length === 0) {
    return fail({
      tool: 'fs',
      message: `cannot list ${root}: git is unavailable (${gitUnavailable}) and the filesystem walk reached no source file: ${incomplete}`,
    });
  }
  return ok({
    // The BOUND is keyed, not merely carried. `walkFiles` skips a symlink (or a too-deep dir) WITHOUT
    // emitting an entry, so a symlinked source subtree appearing beside the tree leaves the file
    // rollup byte-identical while flipping `incomplete` — key hit, cached surface, and the answer
    // states the full scope for a scan that missed a subtree. The inverse is the same lie inverted:
    // remove the symlink and a cached bound would keep claiming an incompleteness that no longer
    // exists. Neither is rescued by freshness, which skips symlinks too, so there is no drift to
    // notice. `gitUnavailable` rides along for the same reason — the answer states it.
    key: fnv1a64Hex(`<walk>\n${gitUnavailable}\n${incomplete ?? ''}\n${rollup}`),
    origin: 'walk',
    walked: {
      files,
      gitUnavailable,
      ...(incomplete !== undefined ? { incomplete } : {}),
    },
  });
}
