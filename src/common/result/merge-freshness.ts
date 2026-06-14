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
  const reindexed = present.reduce((sum, n) => sum + (n.reindexed ?? 0), 0);
  const staleFiles = dedupe(present.flatMap((n) => n.staleFiles ?? []));
  // Worst-of: if ANY contributor could not verify its freshness, the merged answer is
  // unverified too — and no commit anchor may be stamped (same coupling as
  // `buildFreshnessNote`), or a cross-root join would read as fresh while one engine was
  // silent-stale (§3.5/§3.6).
  const unverified = present.find((n) => n.unverified !== undefined)?.unverified;
  // A single commit only holds when every contributor reports the same one AND none is unverified.
  const commits = new Set(present.map((n) => n.indexedAtCommit));
  const indexedAtCommit =
    unverified === undefined && commits.size === 1 ? first?.indexedAtCommit : undefined;

  return {
    plugins,
    pending,
    ...(reindexed > 0 ? { reindexed } : {}),
    ...(staleFiles.length > 0 ? { staleFiles } : {}),
    ...(indexedAtCommit !== undefined ? { indexedAtCommit } : {}),
    ...(unverified !== undefined ? { unverified } : {}),
  };
}

function dedupe(paths: readonly RepoRelPath[]): RepoRelPath[] {
  return [...new Set(paths)];
}
