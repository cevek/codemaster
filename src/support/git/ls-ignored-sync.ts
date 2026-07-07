// SYNCHRONOUS ".gitignore-aware junk set" — the files a loose tsconfig `include` glob picks up but
// the project itself declares ignored (a repo-specific `generated/` / `coverage/` / build dir that
// no fixed name set covers). Complements the name-based §10 set (ignored-paths.ts): name-match is
// the reliable excluder for nested VCS checkouts, this is the excluder for arbitrary main-tree junk.
//
// IGNORE-semantics, NOT tracked-semantics: `--others --ignored` returns exactly the UNTRACKED +
// IGNORED files, so tracked source AND a freshly-written untracked-not-ignored file (the
// create-then-query workflow) are BOTH kept — only project-declared-ignored files are dropped.
//
// Why sync is allowed here: it is called ONLY from the TS program's `loadFileList`, which runs on
// init + STRUCTURAL reindex — never the LS hot path — at the SAME cadence as the synchronous
// tsconfig re-glob it sits beside; the host memoizes the result so it fires ONCE per reindex, never
// per-op/per-file (the §19 per-call-tree-scan hang class). Spawns through the one wrapped git
// chokepoint (`runGitSync`, bounded by maxBuffer + a timeout); a non-git root, a missing binary, and
// a timeout all fail there → an empty set (the name-based set still applies), never an escape (§3.6).

import { runGitSync } from './run.ts';

const TIMEOUT_MS = 10_000;

/** Repo-relative posix paths git considers ignored (untracked + matched by `.gitignore`), for
 *  `root`. Empty set on ANY failure — non-git root, missing binary, timeout — so the caller degrades
 *  to the name-based set, never crashes. */
export function gitIgnoredSync(root: string): ReadonlySet<string> {
  const result = runGitSync(
    root,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
    { timeoutMs: TIMEOUT_MS },
  );
  const set = new Set<string>();
  if (result.ok) {
    for (const p of result.data.split('\u0000')) {
      if (p.length > 0) set.add(p);
    }
  }
  return set;
}
