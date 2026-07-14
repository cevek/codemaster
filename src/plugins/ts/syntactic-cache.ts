// The projectVersion-independent cache behind `search_symbol { syntactic: true }` — a single-slot
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
// HOT PATH is O(changed+untracked), NEVER O(surface) — no per-query stat-walk of the whole tree
// (that is the ls-host per-call tree-scan hang-class §1). The key = HEAD ⊕ the porcelain string ⊕
// an mtimeNs+size tie-break taken ONLY over the porcelain dirty+untracked set (bounded, exactly the
// §19 "re-stat the dirty set" rule). The tie-break is what catches an untracked-file MODIFY whose
// porcelain line is unchanged. A full re-list + re-parse happens ONLY on a key change (drift).

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { fnv1a64Hex } from '../../common/hash/fnv.ts';
import { brandGitPath } from '../../support/fs/canonicalize.ts';
import { hashFileContent } from '../../support/fs/stat-fingerprint.ts';
import { runGitSync } from '../../support/git/run.ts';

const GIT_TIMEOUT_MS = 15_000;
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

/** Single-slot memo held per ts-plugin instance. `clear()` on dispose (a re-warm must not reuse a
 *  stale slot — same discipline as the scan memos). */
export interface SyntacticCache {
  current?: { key: string; sources: SyntacticSources };
}

export function createSyntacticCache(): SyntacticCache {
  return {};
}

export function clearSyntacticCache(cache: SyntacticCache): void {
  delete cache.current;
}

/** The repo-state fingerprint keying the parsed-surface cache. Bounded by the changed+untracked set
 *  (git's own porcelain scan + a stat per dirty path), NEVER the whole surface (§1 hot-path rule).
 *  A git failure surfaces honestly — the caller maps it to a `ToolFailure`, never a false empty. */
export function computeSurfaceKey(root: string): Result<string> {
  const head = runGitSync(root, ['rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  // A pre-first-commit repo has no HEAD; that is not a failure — fold an empty marker and rely on
  // porcelain (which lists every file as untracked in an unborn repo) for the state.
  const headKey = isOk(head) ? head.data.trim() : '<unborn>';
  const status = runGitSync(root, ['status', '--porcelain', '-z', '--untracked-files=all'], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!isOk(status)) return fail(status.failure);
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
  return ok(fnv1a64Hex(`${headKey}\n${porcelain}\n${content}`));
}
