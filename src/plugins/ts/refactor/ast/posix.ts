// Pure posix path arithmetic shared across the refactor layer — no filesystem, no `path` module (so
// it stays deterministic on any OS and never disagrees with the tree's forward-slash `RepoRelPath`).

/** The directory portion of a posix path (`'a/b/c.ts'` → `'a/b'`, `'x.ts'` → `''`). */
export function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Resolve `.`/`..` segments in a posix path without touching the filesystem. Returns `undefined`
 *  when a `..` climbs above the root — resolving such a path would silently point at the wrong file
 *  (e.g. a same-named module at the repo root), so the caller must decline rather than guess. */
export function normalizePosix(p: string): string | undefined {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return undefined; // underflow above root
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}
