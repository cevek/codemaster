// The parsed §10 source surface shared by the no-program syntactic paths: the fuzzy
// `search_symbol { syntactic: true }` scan (t-515730), the `symbols_overview` catalogue (t-143952) and
// the `source { syntactic: true }` declaration reader (t-229522). Extracted here so every one of them
// builds the surface through one function (no duplicate parse / cache wiring) and each file stays
// under the line cap. NEVER warms the LS / builds a program — the whole point of the syntactic paths.
//
// A caller answering about SEVERAL targets must call this ONCE and reuse the returned map (§8: a reader
// pins the state at request entry). Per-target calls would re-take the repo fingerprint each time and
// could assemble one answer over two different surface states.
//
// TWO LISTING MECHANISMS, and every answer states which one it got (t-810757). The default is git — the
// tracked ∪ untracked-not-ignored listing, `.gitignore`-exact because git itself evaluates the rules. A
// workspace git cannot list (no repo at all, or git unavailable) degrades to the bounded filesystem walk
// (§19) — the same fallback `daemon/freshness.ts` and the §10 program file-set already take on a non-git
// root. Hard-failing here made the OOM-safe browse — the very call other ops' refusals redirect to — the
// one thing that could not answer where it was needed most. The two surfaces differ in BOTH directions,
// and the difference is named rather than smoothed into "roughly the same":
//   • WIDER   — no `.gitignore` evaluation, so build output under a non-standard directory name is
//               catalogued as project source.
//   • NARROWER — the walk applies the §10 name-ignore set (`node_modules`/`dist`/`build`/`.next`/…) and
//               skips files over 1 MB, while the git listing deliberately applies NO name filter (see the
//               in-loop comment below). So a real, tracked source file under `build/` IS on the git
//               surface and is NOT on the walk surface: a §3.4 miss, stated as one.
//
// The surface is memoized in the caller's `SyntacticCache` keyed on a repo-state fingerprint the
// syntactic path can trust (syntactic-cache.ts — NOT projectVersion). In git mode the hot path is
// O(changed), never a per-query whole-surface stat-walk (§1); in walk mode the key IS the walk, so each
// build costs one bounded walk — the same order of work non-git freshness already pays per op — and the
// expensive half (re-list + re-parse) still fires only on drift.

import ts from 'typescript';
import path from 'node:path';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { brandGitPath } from '../../support/fs/canonicalize.ts';
import { readTextFile } from '../../support/fs/read-file.ts';
import { gitSourceFilesSync } from '../../support/git/ls-source-files.ts';
import type {
  SurfaceSeams,
  SyntacticCache,
  SyntacticSources,
  SyntacticSurface,
} from './syntactic-cache.ts';
import { computeSurfaceKey, isScannedSourcePath } from './syntactic-cache.ts';

/** The parsed §10 surface, from cache when the repo-state key is unchanged (hot path), else re-listed
 *  + re-parsed (drift only). A listing failure surfaces — never a silent empty. */
export function surfaceSources(
  root: string,
  cache: SyntacticCache,
  seams?: SurfaceSeams,
): Result<SyntacticSurface> {
  const key = computeSurfaceKey(root, seams);
  if (!isOk(key)) return fail(key.failure);
  const cached = cache.current;
  if (cached?.key === key.data.key) return ok(cached.surface);

  // Walk mode already listed the files while computing the key (the walk IS the state) — reuse that
  // listing instead of walking the tree a second time.
  const walked = key.data.walked;
  let listed: readonly string[];
  if (walked !== undefined) listed = walked.files;
  else {
    const listing = gitSourceFilesSync(root);
    if (!isOk(listing)) return fail(listing.failure);
    listed = listing.data;
  }

  const sources: SyntacticSources = new Map();
  for (const rel of listed) {
    // NO name-based ignore-dir filter on the GIT listing: `git ls-files --exclude-standard` already
    // drops .gitignore'd files, and a nested-repo copy (.claude/worktrees/<id>) is a SEPARATE git repo
    // the outer listing never emits — so a name filter only ever OVER-excludes a tracked,
    // import-reached file in a name-ignored dir (a §3.4 miss). Over-inclusion of tracked junk is
    // superset-safe noise. The walk listing has no `.gitignore` oracle and DOES apply the name set;
    // that asymmetry is the narrower axis the surface's own note states.
    if (!isScannedSourcePath(rel)) continue;
    const abs = path.join(root, rel);
    const text = readTextFile(abs);
    if (!isOk(text)) continue; // a vanished/unreadable file is not a symbol source — skip, never throw
    sources.set(
      brandGitPath(rel),
      ts.createSourceFile(abs, text.data, ts.ScriptTarget.Latest, /*setParentNodes*/ true),
    );
  }
  const surface: SyntacticSurface = {
    sources,
    origin: key.data.origin,
    ...(walked !== undefined ? { gitUnavailable: walked.gitUnavailable } : {}),
    ...(walked?.incomplete !== undefined ? { incomplete: walked.incomplete } : {}),
  };
  cache.current = { key: key.data.key, surface };
  return ok(surface);
}
