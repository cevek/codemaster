// Aggregate per-plugin freshness notes into one envelope-level note (worst-of).
// An op that touches several plugins reports the union of their pending state —
// dropping any plugin's staleness would be a silent-stale lie (ARCHITECTURE.md §3.5).

import type { FreshnessNote } from '../../core/result.ts';
import type { RepoRelPath } from '../../core/brands.ts';

export function mergeFreshness(
  notes: ReadonlyArray<FreshnessNote | undefined>,
): FreshnessNote | undefined {
  const present = notes.filter((n): n is FreshnessNote => n !== undefined);
  if (present.length === 0) return undefined;
  const first = present[0];
  if (present.length === 1) return first;

  const plugins = present.flatMap((n) => n.plugins);
  const pending = present.reduce((sum, n) => sum + n.pending, 0);
  const staleFiles = dedupe(present.flatMap((n) => n.staleFiles ?? []));
  // A single commit only holds when every contributor reports the same one.
  const commits = new Set(present.map((n) => n.indexedAtCommit));
  const indexedAtCommit = commits.size === 1 ? first?.indexedAtCommit : undefined;

  return {
    plugins,
    pending,
    ...(staleFiles.length > 0 ? { staleFiles } : {}),
    ...(indexedAtCommit !== undefined ? { indexedAtCommit } : {}),
  };
}

function dedupe(paths: readonly RepoRelPath[]): RepoRelPath[] {
  return [...new Set(paths)];
}
