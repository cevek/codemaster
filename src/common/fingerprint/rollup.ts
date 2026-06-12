// Roll many file fingerprints into one repo-global string — the non-git fallback for
// the read-time freshness check (§3.5: repo-global, so an added/removed file trips it
// too, not just a touched one). FNV-1a over a stable ordering: this is change
// *detection*, not integrity — the strong guarantee is the git path; on a hash-quality
// concern the answer is "use git", not a heavier hash here.

import { fnv1a64Hex } from '../hash/fnv.ts';
import type { FileFingerprint } from './fingerprint.ts';

export function rollupFingerprint(files: readonly FileFingerprint[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const body = sorted
    .map((f) => `${f.path} ${f.size} ${f.mtimeMs} ${f.contentHash ?? ''}`)
    .join('\n');
  return `fnv1a64:${fnv1a64Hex(body)}:${files.length}`;
}
