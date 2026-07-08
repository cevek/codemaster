// The §10 default ignore set — directories that are NEVER project source (VCS internals, package
// output, build output, editor/tool/agent state) and the editor-temp file churn. Shared by every
// engine-wide file-set decision so they can't drift apart: the non-git `walkFiles` fallback
// (scss/i18n/schema + freshness), the chokidar watcher, AND the TS program file-set (single.ts).
//
// This set is NAME-based and applies regardless of git: it is the reliable excluder for a nested
// VCS checkout (`.claude/worktrees/<id>` — a whole-tree COPY with its OWN `.git`, which the OUTER
// repo's `.gitignore` does NOT see across the nested working-tree boundary — proven: outer
// `git check-ignore` reports such a path as NOT-ignored unless `.claude` itself is gitignored). The
// gitignore-aware listing (`git ls-files`) is the COMPLEMENT — it catches arbitrary project-declared
// junk in the MAIN tree (a repo-specific `generated/` / `coverage/` dir) that no fixed name set can.

export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.codemaster',
  // Other tools' state dirs — may contain sockets/locks that must not be watched.
  '.codegraph',
  '.idea',
  '.vscode',
  '.turbo',
  '.cache',
  // Agent state — `.claude/worktrees/<id>` holds whole-tree COPIES of the repo; indexing them
  // surfaces every source file N times over (a `find_usages` doubles / turns to an `ambiguous`
  // failure, a minified bundle surfaces as a symbol — the never-lie violation this set prevents).
  '.claude',
]);

/** Editor atomic-save / swap / backup churn (§19). */
export const DEFAULT_IGNORED_FILES = /(\.swp|\.swx|~|\.tmp)$/;

/** True when any `/`-separated segment of `posixPath` is a §10-ignored directory. Operates on a
 *  REPO-RELATIVE posix path — never an absolute one: an absolute path whose ROOT lies under a
 *  same-named ancestor dir (e.g. a repo checked out at `/home/me/build/proj`) would else match
 *  `build` on the root prefix and exclude the WHOLE repo. Callers strip the root first. */
export function hasIgnoredDirSegment(posixPath: string): boolean {
  let start = 0;
  const len = posixPath.length;
  while (start < len) {
    const end = posixPath.indexOf('/', start);
    if (end === -1) break; // the last segment is the FILE name — never a dir, skip it
    if (end > start && DEFAULT_IGNORED_DIRS.has(posixPath.slice(start, end))) return true;
    start = end + 1;
  }
  return false;
}

/** The composed §10 junk predicate over a REPO-RELATIVE posix path: a name-based ignored dir segment
 *  OR a member of the project's git-ignored set. The single source of truth for "is this git-tracked
 *  path project junk", shared by the TS program file-set (`single.ts`) and the undiscovered-floor
 *  coverage/stray pass (`program/coverage.ts`) so the two can never drift — a drift would make coverage
 *  count a file the program excludes (phantom coverage) or vice-versa (phantom strays). The
 *  `/node_modules/` pre-filter callers apply on the ABSOLUTE path is orthogonal and stays local. */
export function isJunkRelPath(rel: string, gitIgnored: ReadonlySet<string>): boolean {
  return hasIgnoredDirSegment(rel) || gitIgnored.has(rel);
}
