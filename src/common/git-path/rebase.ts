// git reports `status --porcelain` / `diff --name-only` paths relative to the repository TOPLEVEL,
// whatever the cwd; a workspace root may be a subdirectory of it (an explicit `root:<pkg>`), and
// every consumer keys by workspace-root-relative paths (t-835778).

export interface RebasedPaths {
  /** Paths under the workspace root, relative to it. */
  inside: string[];
  /** Paths outside the workspace root, relative to it (`../…`). */
  outside: string[];
}

/** Re-base toplevel-relative `paths` onto the workspace root that `git rev-parse --show-prefix`
 *  reported as `prefix` (`''` at the toplevel, else `dir/sub/`). */
export function rebaseOnPrefix(paths: readonly string[], prefix: string): RebasedPaths {
  const inside: string[] = [];
  const outside: string[] = [];
  const rootSegs = prefix.split('/').filter((s) => s.length > 0);
  for (const p of paths) {
    if (p.startsWith(prefix) && p.length > prefix.length) {
      inside.push(p.slice(prefix.length));
      continue;
    }
    const segs = p.split('/');
    let common = 0;
    while (common < rootSegs.length && common < segs.length && rootSegs[common] === segs[common]) {
      common++;
    }
    // The workspace root itself (a dirty submodule entry naming it) — not a file to key.
    if (common === segs.length) continue;
    outside.push([...rootSegs.slice(common).map(() => '..'), ...segs.slice(common)].join('/'));
  }
  return { inside, outside };
}
