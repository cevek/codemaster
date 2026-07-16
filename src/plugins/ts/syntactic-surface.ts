// The parsed §10 git-source surface shared by the no-program syntactic paths (t-515730): the
// fuzzy `search_symbol { syntactic: true }` scan AND the `symbols_overview` catalogue. Extracted here so
// BOTH build the surface through one function (no duplicate parse / cache wiring) and both files stay
// under the line cap. NEVER warms the LS / builds a program — the whole point of the syntactic paths.
//
// The surface is memoized in the caller's `SyntacticCache` keyed on a repo-state fingerprint the
// syntactic path can trust (syntactic-cache.ts — NOT projectVersion). The hot path is O(changed),
// never a per-query whole-surface stat-walk (§1); a re-list + re-parse fires only on drift.

import ts from 'typescript';
import path from 'node:path';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { brandGitPath } from '../../support/fs/canonicalize.ts';
import { readTextFile } from '../../support/fs/read-file.ts';
import { gitSourceFilesSync } from '../../support/git/ls-source-files.ts';
import type { SyntacticCache, SyntacticSources } from './syntactic-cache.ts';
import { computeSurfaceKey, isScannedSourcePath } from './syntactic-cache.ts';

/** The parsed §10 surface, from cache when the repo-state key is unchanged (hot path, O(changed)),
 *  else re-listed + re-parsed (drift only). A git failure surfaces — never a silent empty. */
export function surfaceSources(root: string, cache: SyntacticCache): Result<SyntacticSources> {
  const key = computeSurfaceKey(root);
  if (!isOk(key)) return fail(key.failure);
  if (cache.current?.key === key.data) return ok(cache.current.sources);
  const listing = gitSourceFilesSync(root);
  if (!isOk(listing)) return fail(listing.failure);
  const sources: SyntacticSources = new Map();
  for (const gitPath of listing.data) {
    // NO name-based ignore-dir filter: `git ls-files --exclude-standard` already drops .gitignore'd
    // files, and a nested-repo copy (.claude/worktrees/<id>) is a SEPARATE git repo the outer listing
    // never emits — so a name filter only ever OVER-excludes a tracked, import-reached file in a
    // name-ignored dir (a §3.4 miss). Over-inclusion of tracked junk is superset-safe noise.
    if (!isScannedSourcePath(gitPath)) continue;
    const abs = path.join(root, gitPath);
    const text = readTextFile(abs);
    if (!isOk(text)) continue; // a vanished/unreadable file is not a symbol source — skip, never throw
    sources.set(
      brandGitPath(gitPath),
      ts.createSourceFile(abs, text.data, ts.ScriptTarget.Latest, /*setParentNodes*/ true),
    );
  }
  cache.current = { key: key.data, sources };
  return ok(sources);
}
