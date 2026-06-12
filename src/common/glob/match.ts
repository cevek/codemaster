// Glob matching over repo-relative posix paths — thin facade over `picomatch` (the
// battle-tested matcher behind the chokidar/anymatch ecosystem; we do NOT hand-roll
// glob semantics). `dot: true` so `**/.storybook/**`-style filters work on dotted
// segments too.

import picomatch from 'picomatch';

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return picomatch.isMatch(path, globs as string[], { dot: true });
}
